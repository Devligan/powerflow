-- =====================================================================
-- PowerFlow — multi-leg execution engine
--
-- Trades are no longer always one leg of one price series. An instrument
-- reduces one or more leg prices to a single scalar — its own price — and that
-- scalar is what the position is held at. Because every instrument collapses
-- to one number, the weighted-average accounting from 0002/0006 applies
-- unchanged to spreads, convergence trades and period averages.
--
-- The rules (mirrored, and unit-tested, in src/lib/trading/instruments.ts):
--   POINT        leg A's price for the interval
--   DIFFERENCE   leg B − leg A  (sink minus source; congesting A→B pays a long)
--   CONVERGENCE  real-time − day-ahead
--   AVERAGE      leg A's price averaged over the settlement window
-- and an OPTION floors at zero where an OBLIGATION pays both ways.
--
-- Legless instruments (a virtual INC/DEC) still name a settlement point and
-- interval to settle against — what they lack is a *delivery* leg.
--
-- Deliberately NOT here: auto-settlement. Per product direction a delivered
-- interval stays open until the user closes it, so this engine prices and marks
-- but never force-realises.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A composed instrument has no single market price row, so the hard link to
-- one has to become optional (it is still recorded for single-leg fills).
-- ---------------------------------------------------------------------
alter table public.trades alter column market_price_id drop not null;

-- ---------------------------------------------------------------------
-- Price resolution helpers
-- ---------------------------------------------------------------------

-- Latest price for a product, preferring the exact interval and falling back to
-- the most recently published price for that series.
create or replace function public.price_at(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz
)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v numeric;
begin
  select mp.price into v
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
  order by mp.ingested_at desc
  limit 1;
  if v is not null then
    return v;
  end if;

  select mp.price into v
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
  order by mp.delivery_timestamp desc
  limit 1;
  return v;
end;
$$;

-- The price row behind price_at, for trade provenance.
create or replace function public.price_row_id(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz
)
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v uuid;
begin
  select mp.id into v
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
  order by mp.ingested_at desc
  limit 1;
  if v is not null then
    return v;
  end if;

  select mp.id into v
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
  order by mp.delivery_timestamp desc
  limit 1;
  return v;
end;
$$;

-- The delivery timestamp of the price price_at would use, so a mark can be
-- reported "as of" the interval it was actually taken from.
create or replace function public.price_as_of(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v timestamptz;
begin
  select mp.delivery_timestamp into v
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
  order by mp.ingested_at desc
  limit 1;
  if v is not null then
    return v;
  end if;

  select mp.delivery_timestamp into v
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
  order by mp.delivery_timestamp desc
  limit 1;
  return v;
end;
$$;

-- Whether the price for an interval had to fall back to the most recently
-- published row of the series (i.e. no price exists for the exact interval).
-- Recorded on the trade so a fallback fill is disclosed rather than disguised.
create or replace function public.price_is_stale(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz
)
returns boolean
language sql
stable
set search_path = public
as $$
  select not exists (
    select 1 from public.market_prices mp
    where mp.market_id = p_market_id
      and mp.product = p_product
      and mp.delivery_timestamp = p_ts
  );
$$;

-- Average of a series across a settlement window [p_from, p_to).
create or replace function public.price_average(
  p_market_id uuid,
  p_product text,
  p_from timestamptz,
  p_to timestamptz
)
returns numeric
language sql
stable
set search_path = public
as $$
  select avg(mp.price)
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp >= p_from
    and mp.delivery_timestamp < p_to;
$$;

-- Reduce an instrument's legs to its own price. NULL means "cannot be priced",
-- which callers must treat as a rejection rather than a zero fill.
create or replace function public.instrument_price(
  p_market_id uuid,
  p_counter_market_id uuid,
  p_instrument text,
  p_product text,
  p_from timestamptz,
  p_to timestamptz
)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_rule text;
  v_option text;
  v_a numeric;
  v_b numeric;
  v_da numeric;
  v_rt numeric;
  v_price numeric;
begin
  select i.settlement_rule, i.option_type
    into v_rule, v_option
  from public.instruments i
  where i.code = p_instrument;
  if v_rule is null then
    return null;
  end if;

  if v_rule = 'POINT' then
    v_a := public.price_at(p_market_id, p_product, p_from);
    v_price := v_a;

  elsif v_rule = 'AVERAGE' then
    v_a := public.price_average(p_market_id, p_product, p_from, p_to);
    v_price := v_a;

  elsif v_rule = 'DIFFERENCE' then
    if p_counter_market_id is null then
      return null;
    end if;
    v_a := public.price_at(p_market_id, p_product, p_from);
    v_b := public.price_at(p_counter_market_id, p_product, p_from);
    if v_a is null or v_b is null then
      return null;
    end if;
    v_price := v_b - v_a; -- sink minus source

  elsif v_rule = 'CONVERGENCE' then
    v_da := public.price_at(p_market_id, 'DAM_HOURLY', p_from);
    v_rt := public.price_at(p_market_id, 'RTM_HOURLY', p_from);
    if v_da is null or v_rt is null then
      return null;
    end if;
    v_price := v_rt - v_da;

  else
    return null;
  end if;

  if v_price is null then
    return null;
  end if;
  -- An option can only pay out; an obligation is two-way.
  if v_option = 'OPTION' and v_price < 0 then
    return 0;
  end if;
  return v_price;
end;
$$;

-- ---------------------------------------------------------------------
-- execute_trade: fills every instrument shape
-- ---------------------------------------------------------------------
drop function if exists public.execute_trade(uuid, uuid, text, text, numeric, timestamptz, timestamptz);
drop function if exists public.execute_trade(uuid, uuid, text, numeric, timestamptz, timestamptz);

create or replace function public.execute_trade(
  p_user_id uuid,
  p_market_id uuid,
  p_counter_market_id uuid,
  p_instrument text,
  p_product text,
  p_side text,
  p_quantity_mwh numeric,
  p_delivery_start timestamptz,
  p_delivery_end timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market    public.markets%rowtype;
  v_counter   public.markets%rowtype;
  v_product   public.products%rowtype;
  v_instr     public.instruments%rowtype;
  v_account   public.paper_accounts%rowtype;
  v_pos       public.positions%rowtype;
  v_other     public.positions%rowtype;
  v_price     numeric;
  v_other_price numeric;
  v_leg_price_id uuid;
  v_price_stale boolean := false;
  v_prev_qty  numeric;
  v_prev_avg  numeric;
  v_new_qty   numeric;
  v_new_avg   numeric;
  v_closed    numeric;
  v_realized_delta numeric := 0;
  v_notional  numeric;
  v_gross_others numeric := 0;
  v_gross_new numeric;
  v_trade_id  uuid;
  v_exec_at   timestamptz := now();
  v_window_ms numeric;
  v_interval_ms numeric;
begin
  -- 0. Authorization.
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  -- 1. Settlement point (leg A) must exist and be active.
  select * into v_market
  from public.markets
  where id = p_market_id and active
  for share;
  if not found then
    raise exception 'MARKET_INVALID';
  end if;

  -- 2. Instrument must be catalogued and open to trading.
  select * into v_instr
  from public.instruments
  where code = p_instrument;
  if not found then
    raise exception 'INSTRUMENT_INVALID';
  end if;
  if not v_instr.tradable then
    raise exception 'INSTRUMENT_NOT_TRADABLE';
  end if;

  -- 3. Product. A single-leg instrument prices whatever series the caller
  --    names. A legless or path instrument has no series of its own — it
  --    settles off the market it clears in — so its product is derived rather
  --    than accepted from the caller. That keeps the identity canonical: two
  --    virtual trades on the same point and interval cannot land in different
  --    positions because the caller passed a different product.
  select * into v_product
  from public.products
  where code = case
                 when v_instr.product_from_trade then p_product
                 else 'DAM_HOURLY'
               end;
  if not found then
    raise exception 'PRODUCT_INVALID';
  end if;
  if v_instr.product_from_trade and not v_product.tradable then
    raise exception 'PRODUCT_NOT_TRADABLE';
  end if;

  -- 4. Second leg, for path instruments.
  if v_instr.settlement_rule = 'DIFFERENCE' then
    if p_counter_market_id is null then
      raise exception 'COUNTER_POINT_REQUIRED';
    end if;
    if p_counter_market_id = p_market_id then
      raise exception 'COUNTER_POINT_INVALID';
    end if;
    select * into v_counter
    from public.markets
    where id = p_counter_market_id and active
    for share;
    if not found then
      raise exception 'COUNTER_POINT_INVALID';
    end if;
  elsif p_counter_market_id is not null then
    raise exception 'COUNTER_POINT_INVALID';
  end if;

  -- 5. Validate the delivery side. Interval instruments settle exactly one
  --    product interval; AVERAGE instruments settle a whole number of them.
  if p_side is null or p_side not in ('BUY', 'SELL') then
    raise exception 'SIDE_INVALID';
  end if;
  if p_quantity_mwh is null or p_quantity_mwh <= 0 then
    raise exception 'QUANTITY_INVALID';
  end if;
  if p_delivery_start is null or p_delivery_end is null then
    raise exception 'DELIVERY_INVALID';
  end if;
  if p_delivery_start >= p_delivery_end then
    raise exception 'DELIVERY_INVALID';
  end if;

  v_interval_ms := v_product.interval_minutes * 60 * 1000;
  v_window_ms := extract(epoch from (p_delivery_end - p_delivery_start)) * 1000;

  if v_instr.settlement_rule = 'AVERAGE' then
    if v_window_ms <= 0 or mod(v_window_ms, v_interval_ms) <> 0 then
      raise exception 'DELIVERY_WINDOW_INVALID';
    end if;
  else
    if v_window_ms <> v_interval_ms then
      raise exception 'DELIVERY_INTERVAL_INVALID';
    end if;
  end if;

  -- Both ends must sit on the product's own interval boundary.
  if mod(extract(epoch from p_delivery_start) * 1000, v_interval_ms) <> 0
     or mod(extract(epoch from p_delivery_end) * 1000, v_interval_ms) <> 0 then
    raise exception 'DELIVERY_MUST_BE_ALIGNED';
  end if;

  if p_delivery_end <= v_exec_at then
    raise exception 'DELIVERY_IN_PAST';
  end if;
  if p_delivery_start > v_exec_at + interval '35 days' then
    raise exception 'DELIVERY_TOO_FAR_OUT';
  end if;

  -- 6. Authoritative instrument price: reduce the legs to the scalar this
  --    position is held at. No price, no fill.
  v_price := public.instrument_price(
    p_market_id, p_counter_market_id, p_instrument, p_product,
    p_delivery_start, p_delivery_end
  );
  if v_price is null then
    raise exception 'PRICE_UNAVAILABLE';
  end if;

  -- Provenance for single-leg fills; composed instruments have no single row.
  if v_instr.legs = 1 and v_instr.settlement_rule <> 'AVERAGE' then
    if v_instr.settlement_rule = 'CONVERGENCE' then
      v_leg_price_id := public.price_row_id(p_market_id, 'DAM_HOURLY', p_delivery_start);
      v_price_stale := public.price_is_stale(p_market_id, 'DAM_HOURLY', p_delivery_start);
    else
      v_leg_price_id := public.price_row_id(p_market_id, p_product, p_delivery_start);
      v_price_stale := public.price_is_stale(p_market_id, p_product, p_delivery_start);
    end if;
  end if;

  -- 7. Serialize per-user trade execution.
  select * into v_account
  from public.paper_accounts
  where user_id = p_user_id
  for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  v_notional := v_price * p_quantity_mwh;

  -- 8a. Capital check: BUY must be fully covered by virtual cash.
  if p_side = 'BUY' and v_notional > v_account.cash_balance then
    raise exception 'INSUFFICIENT_CAPITAL';
  end if;

  -- 8b. Existing position in this exact instrument.
  select * into v_pos
  from public.positions
  where user_id = p_user_id
    and instrument = v_instr.code
    and market_id = p_market_id
    and product = v_product.code
    and coalesce(counter_market_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_counter_market_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and delivery_start = p_delivery_start
    and delivery_end = p_delivery_end
  for update;

  -- 8c. Gross exposure, marking every other open position at *its own*
  --     instrument price rather than at a point price.
  for v_other in
    select *
    from public.positions pos
    where pos.user_id = p_user_id
      and pos.quantity_mwh <> 0
      and (v_pos.id is null or pos.id <> v_pos.id)
  loop
    v_other_price := public.instrument_price(
      v_other.market_id, v_other.counter_market_id, v_other.instrument,
      v_other.product, v_other.delivery_start, v_other.delivery_end
    );
    if v_other_price is not null then
      v_gross_others := v_gross_others + abs(v_other.quantity_mwh) * v_other_price;
    end if;
  end loop;

  v_new_qty := coalesce(v_pos.quantity_mwh, 0)
    + case when p_side = 'BUY' then p_quantity_mwh else - p_quantity_mwh end;

  v_gross_new := v_gross_others + abs(v_new_qty) * v_price;
  if v_gross_new > v_account.max_gross_notional then
    raise exception 'EXPOSURE_LIMIT_EXCEEDED';
  end if;

  -- 9. Position accounting (weighted-average cost, signed quantity) — applied
  --    to the instrument's own price.
  v_prev_qty := coalesce(v_pos.quantity_mwh, 0);
  v_prev_avg := coalesce(v_pos.average_entry_price, 0);
  v_new_avg  := v_prev_avg;

  if v_prev_qty = 0 then
    v_new_avg := v_price;
  elsif v_prev_qty > 0 then
    if p_side = 'BUY' then
      v_new_avg := (v_prev_qty * v_prev_avg + p_quantity_mwh * v_price)
                   / (v_prev_qty + p_quantity_mwh);
    else
      v_closed := least(p_quantity_mwh, v_prev_qty);
      v_realized_delta := v_realized_delta + (v_price - v_prev_avg) * v_closed;
      if v_new_qty < 0 then
        v_new_avg := v_price;
      end if;
    end if;
  else
    if p_side = 'SELL' then
      v_new_avg := (abs(v_prev_qty) * v_prev_avg + p_quantity_mwh * v_price)
                   / (abs(v_prev_qty) + p_quantity_mwh);
    else
      v_closed := least(p_quantity_mwh, abs(v_prev_qty));
      v_realized_delta := v_realized_delta + (v_prev_avg - v_price) * v_closed;
      if v_new_qty > 0 then
        v_new_avg := v_price;
      end if;
    end if;
  end if;

  -- 10. Cash moves with the trade.
  if p_side = 'BUY' then
    update public.paper_accounts
       set cash_balance = cash_balance - v_notional, updated_at = v_exec_at
     where id = v_account.id;
  else
    update public.paper_accounts
       set cash_balance = cash_balance + v_notional, updated_at = v_exec_at
     where id = v_account.id;
  end if;

  -- 11. Immutable trade record.
  insert into public.trades (
    user_id, market_id, product, venue, instrument, counter_market_id, side,
    quantity_mwh, delivery_start, delivery_end,
    execution_price, price_timestamp, market_price_id,
    status, created_at, executed_at
  ) values (
    p_user_id, p_market_id, v_product.code, v_product.venue, v_instr.code,
    p_counter_market_id, p_side,
    p_quantity_mwh, p_delivery_start, p_delivery_end,
    v_price, p_delivery_start, v_leg_price_id,
    'EXECUTED', v_exec_at, v_exec_at
  )
  returning id into v_trade_id;

  -- 12. Position upsert on the widened identity.
  insert into public.positions (
    user_id, market_id, product, instrument, counter_market_id,
    delivery_start, delivery_end,
    quantity_mwh, average_entry_price, realized_pnl, updated_at
  ) values (
    p_user_id, p_market_id, v_product.code, v_instr.code, p_counter_market_id,
    p_delivery_start, p_delivery_end,
    v_new_qty, v_new_avg,
    coalesce(v_pos.realized_pnl, 0) + v_realized_delta,
    v_exec_at
  )
  on conflict (
    user_id, instrument, market_id, product, leg_key,
    delivery_start, delivery_end
  )
  do update set
    quantity_mwh        = excluded.quantity_mwh,
    average_entry_price = excluded.average_entry_price,
    realized_pnl        = excluded.realized_pnl,
    updated_at          = excluded.updated_at;

  -- 13. Audit (immutable).
  insert into public.audit_events (
    user_id, event_type, entity_type, entity_id, metadata
  ) values (
    p_user_id, 'TRADE_EXECUTED', 'trade', v_trade_id,
    jsonb_build_object(
      'side', p_side,
      'instrument', v_instr.code,
      'settlement_rule', v_instr.settlement_rule,
      'option_type', v_instr.option_type,
      'product', v_product.code,
      'venue', v_product.venue,
      'market_id', p_market_id,
      'counter_market_id', p_counter_market_id,
      'quantity_mwh', p_quantity_mwh,
      'execution_price', v_price,
      'price_stale', v_price_stale,
      'delivery_start', to_char(p_delivery_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'delivery_end', to_char(p_delivery_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'notional', v_notional,
      'realized_delta', v_realized_delta,
      'position_quantity', v_new_qty
    )
  );

  return jsonb_build_object(
    'trade_id', v_trade_id,
    'instrument', v_instr.code,
    'settlement_rule', v_instr.settlement_rule,
    'option_type', v_instr.option_type,
    'product', v_product.code,
    'venue', v_product.venue,
    'side', p_side,
    'quantity_mwh', p_quantity_mwh,
    'execution_price', v_price,
    'price_timestamp', p_delivery_start,
    'price_stale', v_price_stale,
    'market_price_id', v_leg_price_id,
    'counter_market_id', p_counter_market_id,
    'notional', v_notional,
    'realized_delta', v_realized_delta,
    'cash_balance', (select cash_balance from public.paper_accounts where id = v_account.id),
    'position_quantity', v_new_qty,
    'position_average_entry_price', v_new_avg,
    'executed_at', v_exec_at
  );
end;
$$;

-- Ready-only mark for the read side: each open position valued at its own
-- instrument price, so a spread is never marked off a point price, and a
-- window instrument is marked off a window average.
--
-- SECURITY DEFINER because it resolves prices for the caller's own positions
-- and must not widen the caller's read access to market data.
create or replace function public.position_marks(p_user_id uuid)
returns table (position_id uuid, mark_price numeric, mark_timestamp timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  return query
  select pos.id,
         public.instrument_price(
           pos.market_id, pos.counter_market_id, pos.instrument,
           pos.product, pos.delivery_start, pos.delivery_end
         ),
         -- The anchor series a mark is taken from: the day-ahead leg for a
         -- convergence instrument, otherwise leg A.
         public.price_as_of(
           pos.market_id,
           case when pos.instrument in ('VIRTUAL', 'DART_SPREAD')
                then 'DAM_HOURLY' else pos.product end,
           pos.delivery_start
         )
  from public.positions pos
  where pos.user_id = p_user_id
    and pos.quantity_mwh <> 0;
end;
$$;

-- ---------------------------------------------------------------------
-- Leaderboard, corrected for instruments
--
-- Two instrument bugs in the 0006 version:
--   1. it marked a position at its leg A point price, so a spread or a virtual
--      trade was valued off a price it does not settle at;
--   2. it summed |quantity| across every product into one "open_notional_mwh",
--      so MW of capacity were added to MWh of energy as if they were the same
--      dimension.
-- Now each position is marked at its own instrument price, and open notional
-- is reported per unit.
-- ---------------------------------------------------------------------
-- open_notional_mw is a new OUT column, and `create or replace` cannot change
-- a function's return type, so the 0006/0003 signature is dropped first.
drop function if exists public.get_leaderboard(int);

create or replace function public.get_leaderboard(p_top int default 100)
returns table (
  user_id uuid,
  username text,
  display_name text,
  starting_cash numeric,
  cash_balance numeric,
  realized_pnl numeric,
  marked_value numeric,
  equity numeric,
  return_bps numeric,
  open_notional_mwh numeric,
  open_notional_mw numeric,
  positions_count bigint,
  trades_count bigint,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with marked as (
    select pos.user_id,
           sum(mark.mark_price * abs(pos.quantity_mwh)) as marked_value,
           sum(abs(pos.quantity_mwh))
             filter (where pr.priced_per = 'MWH') as open_notional_mwh,
           sum(abs(pos.quantity_mwh))
             filter (where pr.priced_per = 'MW') as open_notional_mw,
           count(*) as positions_count
    from public.positions pos
    join public.products pr on pr.code = pos.product
    cross join lateral (
      select public.instrument_price(
               pos.market_id, pos.counter_market_id, pos.instrument,
               pos.product, pos.delivery_start, pos.delivery_end
             ) as mark_price
    ) mark
    where pos.quantity_mwh <> 0
      and mark.mark_price is not null
    group by pos.user_id
  ),
  closed as (
    select pos.user_id, sum(pos.realized_pnl) as realized_pnl
    from public.positions pos
    group by pos.user_id
  ),
  trades as (
    select tr.user_id, count(*) as trades_count
    from public.trades tr
    group by tr.user_id
  )
  select
    pr.id,
    pr.username,
    pr.display_name,
    ac.starting_cash,
    ac.cash_balance,
    coalesce(cl.realized_pnl, 0),
    coalesce(mk.marked_value, 0),
    ac.cash_balance + coalesce(mk.marked_value, 0),
    case when ac.starting_cash > 0 then
      ((ac.cash_balance + coalesce(mk.marked_value, 0) - ac.starting_cash)
        / ac.starting_cash) * 10000
    else 0 end,
    coalesce(mk.open_notional_mwh, 0),
    coalesce(mk.open_notional_mw, 0),
    coalesce(mk.positions_count, 0),
    coalesce(tr.trades_count, 0),
    pr.created_at
  from public.profiles pr
  join public.paper_accounts ac on ac.user_id = pr.id
  left join closed cl on cl.user_id = pr.id
  left join marked mk on mk.user_id = pr.id
  left join trades tr on tr.user_id = pr.id
  where pr.leaderboard_opt_in
  order by 8 desc
  limit greatest(1, least(p_top, 500))
$$;

revoke execute on function public.get_leaderboard(int) from public;
grant execute on function public.get_leaderboard(int) to anon, authenticated;

-- ---------------------------------------------------------------------
-- ACLs
-- ---------------------------------------------------------------------
revoke execute on function public.price_at(uuid, text, timestamptz) from public;
revoke execute on function public.price_row_id(uuid, text, timestamptz) from public;
revoke execute on function public.price_as_of(uuid, text, timestamptz) from public;
revoke execute on function public.price_is_stale(uuid, text, timestamptz) from public;
revoke execute on function public.price_average(uuid, text, timestamptz, timestamptz) from public;
revoke execute on function public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz) from public;
revoke execute on function public.position_marks(uuid) from public;

grant execute on function public.price_at(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_row_id(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_as_of(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_is_stale(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_average(uuid, text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.position_marks(uuid) to authenticated, service_role;

revoke execute on function public.execute_trade(uuid, uuid, uuid, text, text, text, numeric, timestamptz, timestamptz) from public;
grant execute on function public.execute_trade(uuid, uuid, uuid, text, text, text, numeric, timestamptz, timestamptz)
  to authenticated;
