-- =====================================================================
-- PowerFlow — product catalog, markets and interval-correct pricing
--
-- ERCOT publishes different prices for the same delivery interval: day-ahead
-- hourly SPPs from the DAM, real-time SPPs on 15-minute settlement intervals,
-- ancillary-service clearing prices, and congestion rights that price a
-- source/sink pair. A price is therefore only meaningful as
-- (settlement point, product, interval) — never as "the price" of a market.
--
-- The previous schema hard-coded `product in ('RTH')`, which made every
-- ERCOT instrument except one real-time hourly series unrepresentable, and
-- execute_trade priced every fill off `order by delivery_timestamp desc limit
-- 1` — the furthest-out row of whatever series happened to exist. This
-- migration gives products a catalog and makes execution price the interval
-- and product that were actually traded.
--
-- Recorded product decisions: positions are NOT auto-settled when their
-- delivery interval ends (they remain open until the user closes them, per
-- product direction), so no settlement job is introduced here.
-- =====================================================================

-- ---------------------------------------------------------------------
-- products: every price series ERCOT publishes that the desk can represent
-- ---------------------------------------------------------------------
create table if not exists public.products (
  code text primary key,
  label text not null,
  kind text not null,
  venue text not null,
  interval_minutes integer not null,
  -- Ancillary services clear as capacity prices ($/MW-hr), not energy
  -- prices ($/MWh), so the unit has to travel with the price.
  priced_per text not null default 'MWH',
  tradable boolean not null default false,
  created_at timestamptz not null default now(),
  constraint product_kind_valid check (kind in ('ENERGY', 'ANCILLARY', 'CONGESTION')),
  constraint product_venue_valid check (venue in ('DAM', 'RTM', 'AS', 'CRR')),
  constraint product_interval_valid check (interval_minutes in (15, 60)),
  constraint product_unit_valid check (priced_per in ('MWH', 'MW'))
);

insert into public.products (code, label, kind, venue, interval_minutes, priced_per, tradable)
values
  ('DAM_HOURLY', 'Day-ahead hourly energy', 'ENERGY', 'DAM', 60, 'MWH', true),
  ('RTM_15MIN', 'Real-time 15-minute energy', 'ENERGY', 'RTM', 15, 'MWH', true),
  ('RTM_HOURLY', 'Real-time hourly average (RTH)', 'ENERGY', 'RTM', 60, 'MWH', true),
  -- Post-RTC+B ancillary services: RRS and ECRS were each split into service
  -- tiers, so the older five-product list is no longer what ERCOT procures.
  ('REGUP', 'Regulation Up', 'ANCILLARY', 'AS', 60, 'MW', false),
  ('REGDN', 'Regulation Down', 'ANCILLARY', 'AS', 60, 'MW', false),
  ('RRSPFR', 'Responsive Reserve - Primary Frequency Response', 'ANCILLARY', 'AS', 60, 'MW', false),
  ('RRSFFR', 'Responsive Reserve - Fast Frequency Response', 'ANCILLARY', 'AS', 60, 'MW', false),
  ('RRSUFR', 'Responsive Reserve - Sustained Frequency Response', 'ANCILLARY', 'AS', 60, 'MW', false),
  ('NSPIN', 'Non-Spinning Reserve', 'ANCILLARY', 'AS', 60, 'MW', false),
  ('ECRSS', 'ERCOT Contingency Reserve Service (ECRSS)', 'ANCILLARY', 'AS', 60, 'MW', false),
  ('ECRSM', 'ERCOT Contingency Reserve Service (ECRSM)', 'ANCILLARY', 'AS', 60, 'MW', false),
  ('CRR_OBLIGATION', 'Congestion revenue right (PTP obligation)', 'CONGESTION', 'CRR', 60, 'MWH', false),
  ('CRR_OPTION', 'Congestion revenue right (PTP option)', 'CONGESTION', 'CRR', 60, 'MWH', false)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- market_prices: product becomes a catalog reference, and the venue and
-- interval end are carried explicitly
-- ---------------------------------------------------------------------
alter table public.market_prices add column if not exists venue text;

-- The pre-product schema pinned product to the single series 'RTH'
-- (`product in ('RTH')`, 0001). That constraint must be dropped *before* the
-- rename below: an update to a catalogued code violates it while it still
-- exists, which made this migration impossible to apply to any database on
-- 0001-0005. The new FK to `products` is added further down.
alter table public.market_prices drop constraint if exists market_price_product_valid;

update public.market_prices
   set product = 'RTM_HOURLY'
 where product = 'RTH';

update public.market_prices mp
   set venue = p.venue,
       delivery_end = coalesce(
         mp.delivery_end,
         mp.delivery_timestamp + (p.interval_minutes || ' minutes')::interval
       )
  from public.products p
 where p.code = mp.product
   and (mp.venue is null or mp.delivery_end is null);

alter table public.market_prices alter column venue set not null;

alter table public.market_prices drop constraint if exists market_price_venue_valid;
alter table public.market_prices
  add constraint market_price_venue_valid check (venue in ('DAM', 'RTM', 'AS', 'CRR'));

alter table public.market_prices drop constraint if exists market_price_product_fk;
alter table public.market_prices
  add constraint market_price_product_fk foreign key (product) references public.products (code);

-- Representation bounds. ERCOT's system-wide offer caps are *offer* caps, not
-- price caps: LMP can exceed them under extreme congestion, so the storage
-- bound stays deliberately wider than the $2,000 RT / $5,000 DA caps.
alter table public.market_prices drop constraint if exists market_price_sane;
alter table public.market_prices
  add constraint market_price_sane check (price > -2000 and price < 20000);

-- ---------------------------------------------------------------------
-- trades / positions gain the instrument dimensions
-- ---------------------------------------------------------------------
alter table public.trades
  add column if not exists product text not null default 'RTM_HOURLY',
  add column if not exists venue text not null default 'RTM';

alter table public.trades drop constraint if exists trade_product_fk;
alter table public.trades
  add constraint trade_product_fk foreign key (product) references public.products (code);

alter table public.positions
  add column if not exists product text not null default 'RTM_HOURLY';

alter table public.positions drop constraint if exists position_product_fk;
alter table public.positions
  add constraint position_product_fk foreign key (product) references public.products (code);

-- A day-ahead position and a real-time position for the same market and hour
-- are different instruments, so the position identity must include product.
alter table public.positions drop constraint if exists positions_identity_key;
alter table public.positions
  add constraint positions_identity_key
    unique (user_id, market_id, product, delivery_start, delivery_end);

create index if not exists trades_user_product_idx
  on public.trades (user_id, product, created_at desc);

-- ---------------------------------------------------------------------
-- latest price per (market, product), and the current-price view
-- ---------------------------------------------------------------------
-- The return type gains `product`, and `create or replace` cannot change a
-- function's OUT-parameter row type, so the old one must be dropped first.
drop function if exists public.latest_price_timestamps(uuid[]);

create or replace function public.latest_price_timestamps(p_market_ids uuid[])
returns table (market_id uuid, product text, delivery_timestamp timestamptz)
language sql
stable
as $$
  select distinct on (mp.market_id, mp.product)
         mp.market_id, mp.product, mp.delivery_timestamp
  from public.market_prices mp
  where mp.market_id = any(p_market_ids)
  order by mp.market_id, mp.product, mp.delivery_timestamp desc;
$$;
grant execute on function public.latest_price_timestamps(uuid[]) to authenticated;

-- One row per (market, product): the headline price of a market is no longer
-- well-defined without saying which series it came from.
drop view if exists public.current_prices;
create view public.current_prices as
select
  m.id as market_id,
  m.settlement_point,
  m.settlement_point_type,
  m.description,
  m.active,
  lp.delivery_timestamp,
  lp.delivery_end,
  lp.price,
  lp.product,
  lp.venue,
  lp.source,
  lp.ingested_at
from public.markets m
cross join lateral (
  select distinct on (mp.product)
         mp.delivery_timestamp, mp.delivery_end, mp.price,
         mp.product, mp.venue, mp.source, mp.ingested_at
  from public.market_prices mp
  where mp.market_id = m.id
  order by mp.product, mp.delivery_timestamp desc
) lp;

-- ---------------------------------------------------------------------
-- Leaderboard: mark each position against the latest price of its *own*
-- product, so a day-ahead position is never valued off a real-time curve
-- ---------------------------------------------------------------------
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
  positions_count bigint,
  trades_count bigint,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with latest_price as (
    select distinct on (mp.market_id, mp.product)
           mp.market_id, mp.product, mp.price
    from public.market_prices mp
    order by mp.market_id, mp.product, mp.delivery_timestamp desc
  ),
  marked as (
    select pos.user_id,
           sum(lp.price * abs(pos.quantity_mwh)) as marked_value,
           sum(abs(pos.quantity_mwh)) as open_notional_mwh,
           count(*) as positions_count
    from public.positions pos
    join latest_price lp
      on lp.market_id = pos.market_id and lp.product = pos.product
    where pos.quantity_mwh <> 0
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

-- ---------------------------------------------------------------------
-- execute_trade: price the interval and product actually traded
-- ---------------------------------------------------------------------
create or replace function public.execute_trade(
  p_user_id uuid,
  p_market_id uuid,
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
  v_product   public.products%rowtype;
  v_price     public.market_prices%rowtype;
  v_account   public.paper_accounts%rowtype;
  v_pos       public.positions%rowtype;
  v_prev_qty  numeric;
  v_prev_avg  numeric;
  v_new_qty   numeric;
  v_new_avg   numeric;
  v_closed    numeric;
  v_realized_delta numeric := 0;
  v_notional  numeric;
  v_gross_others numeric;
  v_gross_new numeric;
  v_trade_id  uuid;
  v_exec_at   timestamptz := now();
  v_price_stale boolean := false;
begin
  -- 0. Authorization: callers may only trade their own account.
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  -- 1. Market must exist and be active.
  select * into v_market
  from public.markets
  where id = p_market_id and active
  for share;
  if not found then
    raise exception 'MARKET_INVALID';
  end if;

  -- 2. The product must be catalogued and open to trading.
  select * into v_product
  from public.products
  where code = p_product;
  if not found then
    raise exception 'PRODUCT_INVALID';
  end if;
  if not v_product.tradable then
    raise exception 'PRODUCT_NOT_TRADABLE';
  end if;

  -- 3. Validate inputs.
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
  -- The window must be exactly the product's settlement interval: hourly for
  -- the hourly energy products, 15 minutes for the real-time interval series.
  if extract(epoch from (p_delivery_end - p_delivery_start))
       <> v_product.interval_minutes * 60 then
    raise exception 'DELIVERY_INTERVAL_INVALID';
  end if;
  if extract(minute from p_delivery_start) * 60
       % (v_product.interval_minutes * 60) <> 0
     or extract(second from p_delivery_start) <> 0 then
    raise exception 'DELIVERY_MUST_BE_ALIGNED';
  end if;
  -- Don't allow trading already-settled past intervals.
  if p_delivery_end <= v_exec_at then
    raise exception 'DELIVERY_IN_PAST';
  end if;
  if p_delivery_start > v_exec_at + interval '35 days' then
    raise exception 'DELIVERY_TOO_FAR_OUT';
  end if;

  -- 4. Authoritative execution price: the persisted price for THIS interval
  --    and THIS product. Day-ahead and real-time prices for the same hour are
  --    different instruments, so the newest row of any series is never a
  --    substitute for the traded one.
  select * into v_price
  from public.market_prices
  where market_id = p_market_id
    and product = v_product.code
    and delivery_timestamp = p_delivery_start
  order by ingested_at desc
  limit 1
  for share;

  if not found then
    -- Fall back to the most recently published price for this product. The
    -- fill is still recorded against the delivery timestamp of the price that
    -- was actually used (price_timestamp), so a stale fill is detectable
    -- rather than disguised.
    select * into v_price
    from public.market_prices
    where market_id = p_market_id and product = v_product.code
    order by delivery_timestamp desc
    limit 1
    for share;
    if not found then
      raise exception 'PRICE_UNAVAILABLE';
    end if;
    v_price_stale := true;
  end if;

  -- 5. Serialize per-user trade execution.
  select * into v_account
  from public.paper_accounts
  where user_id = p_user_id
  for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  v_notional := v_price.price * p_quantity_mwh;

  -- 6a. Capital check: BUY must be fully covered by virtual cash.
  if p_side = 'BUY' and v_notional > v_account.cash_balance then
    raise exception 'INSUFFICIENT_CAPITAL';
  end if;

  -- 6b. Exposure check against the configured gross margin limit, marking
  --     every open position at the latest price of its own product.
  select * into v_pos
  from public.positions
  where user_id = p_user_id
    and market_id = p_market_id
    and product = v_product.code
    and delivery_start = p_delivery_start
    and delivery_end = p_delivery_end
  for update;

  with latest as (
    select distinct on (mp.market_id, mp.product)
           mp.market_id, mp.product, mp.price
    from public.market_prices mp
    order by mp.market_id, mp.product, mp.delivery_timestamp desc
  )
  select coalesce(sum(abs(pos.quantity_mwh) * l.price), 0)
    into v_gross_others
  from public.positions pos
  join latest l on l.market_id = pos.market_id and l.product = pos.product
  where pos.user_id = p_user_id
    and pos.quantity_mwh <> 0
    and not (
      pos.market_id = p_market_id
      and pos.product = v_product.code
      and pos.delivery_start = p_delivery_start
      and pos.delivery_end = p_delivery_end
    );

  v_new_qty := coalesce(v_pos.quantity_mwh, 0)
    + case when p_side = 'BUY' then p_quantity_mwh else - p_quantity_mwh end;

  v_gross_new := v_gross_others + abs(v_new_qty) * v_price.price;
  if v_gross_new > v_account.max_gross_notional then
    raise exception 'EXPOSURE_LIMIT_EXCEEDED';
  end if;

  -- 7. Position accounting (weighted-average cost, signed quantity).
  v_prev_qty := coalesce(v_pos.quantity_mwh, 0);
  v_prev_avg := coalesce(v_pos.average_entry_price, 0);
  v_new_avg  := v_prev_avg;

  if v_prev_qty = 0 then
    v_new_avg := v_price.price;
  elsif v_prev_qty > 0 then
    if p_side = 'BUY' then
      v_new_avg := (v_prev_qty * v_prev_avg + p_quantity_mwh * v_price.price)
                   / (v_prev_qty + p_quantity_mwh);
    else
      v_closed := least(p_quantity_mwh, v_prev_qty);
      v_realized_delta := v_realized_delta + (v_price.price - v_prev_avg) * v_closed;
      if v_new_qty < 0 then
        v_new_avg := v_price.price;
      end if;
    end if;
  else
    if p_side = 'SELL' then
      v_new_avg := (abs(v_prev_qty) * v_prev_avg + p_quantity_mwh * v_price.price)
                   / (abs(v_prev_qty) + p_quantity_mwh);
    else
      v_closed := least(p_quantity_mwh, abs(v_prev_qty));
      v_realized_delta := v_realized_delta + (v_prev_avg - v_price.price) * v_closed;
      if v_new_qty > 0 then
        v_new_avg := v_price.price;
      end if;
    end if;
  end if;

  -- 8. Update cash transactionally with the trade.
  if p_side = 'BUY' then
    update public.paper_accounts
       set cash_balance = cash_balance - v_notional, updated_at = v_exec_at
     where id = v_account.id;
  else
    update public.paper_accounts
       set cash_balance = cash_balance + v_notional, updated_at = v_exec_at
     where id = v_account.id;
  end if;

  -- 9. Insert the immutable trade record.
  insert into public.trades (
    user_id, market_id, product, venue, side,
    quantity_mwh, delivery_start, delivery_end,
    execution_price, price_timestamp, market_price_id,
    status, created_at, executed_at
  ) values (
    p_user_id, p_market_id, v_product.code, v_product.venue, p_side,
    p_quantity_mwh, p_delivery_start, p_delivery_end,
    v_price.price, v_price.delivery_timestamp, v_price.id,
    'EXECUTED', v_exec_at, v_exec_at
  )
  returning id into v_trade_id;

  -- 10. Upsert the position.
  insert into public.positions (
    user_id, market_id, product, delivery_start, delivery_end,
    quantity_mwh, average_entry_price, realized_pnl, updated_at
  ) values (
    p_user_id, p_market_id, v_product.code, p_delivery_start, p_delivery_end,
    v_new_qty, v_new_avg,
    coalesce(v_pos.realized_pnl, 0) + v_realized_delta,
    v_exec_at
  )
  on conflict (user_id, market_id, product, delivery_start, delivery_end)
  do update set
    quantity_mwh        = excluded.quantity_mwh,
    average_entry_price = excluded.average_entry_price,
    realized_pnl        = excluded.realized_pnl,
    updated_at          = excluded.updated_at;

  -- 11. Audit the event (immutable).
  insert into public.audit_events (
    user_id, event_type, entity_type, entity_id, metadata
  ) values (
    p_user_id, 'TRADE_EXECUTED', 'trade', v_trade_id,
    jsonb_build_object(
      'side', p_side,
      'product', v_product.code,
      'venue', v_product.venue,
      'quantity_mwh', p_quantity_mwh,
      'execution_price', v_price.price,
      'price_timestamp', v_price.delivery_timestamp,
      'price_stale', v_price_stale,
      'market_price_id', v_price.id,
      'market_id', p_market_id,
      'delivery_start', to_char(p_delivery_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'delivery_end', to_char(p_delivery_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'notional', v_notional,
      'realized_delta', v_realized_delta,
      'position_quantity', v_new_qty
    )
  );

  return jsonb_build_object(
    'trade_id', v_trade_id,
    'product', v_product.code,
    'venue', v_product.venue,
    'side', p_side,
    'quantity_mwh', p_quantity_mwh,
    'execution_price', v_price.price,
    'price_timestamp', v_price.delivery_timestamp,
    'price_stale', v_price_stale,
    'market_price_id', v_price.id,
    'notional', v_notional,
    'realized_delta', v_realized_delta,
    'cash_balance', (select cash_balance from public.paper_accounts where id = v_account.id),
    'position_quantity', v_new_qty,
    'position_average_entry_price', v_new_avg,
    'executed_at', v_exec_at
  );
end;
$$;

-- ---------------------------------------------------------------------
-- ACLs: products are public reference data; the trade engine is
-- authenticated-only and its old signature is retired
-- ---------------------------------------------------------------------
alter table public.products enable row level security;

drop policy if exists "products public read" on public.products;
create policy "products public read" on public.products
  for select to anon, authenticated using (true);

grant select on public.products to anon, authenticated;

revoke execute on function public.latest_price_timestamps(uuid[]) from public;
grant execute on function public.latest_price_timestamps(uuid[]) to authenticated;

revoke execute on function public.get_leaderboard(int) from public;
grant execute on function public.get_leaderboard(int) to anon, authenticated;

-- Retire the pre-product signature so a stale caller cannot price a fill off
-- the old "newest row of any series" rule.
drop function if exists public.execute_trade(uuid, uuid, text, numeric, timestamptz, timestamptz);

revoke execute on function public.execute_trade(uuid, uuid, text, text, numeric, timestamptz, timestamptz) from public;
grant execute on function public.execute_trade(uuid, uuid, text, text, numeric, timestamptz, timestamptz)
  to authenticated;
