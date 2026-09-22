-- =====================================================================
-- 0010 — Order idempotency
--
-- A trade had no way to tell "the same order sent twice" from "two orders".
-- A retry after a timeout, a double-clicked submit button, or a client that
-- reconnects mid-request would each create a second fill and move cash twice.
-- Nothing in 0002/0006/0008 prevented that: every call inserts a new trade.
--
-- An order now carries a client-chosen `client_order_id`. Re-sending the same
-- id returns the *stored result of the original execution* instead of filling
-- again.
--
-- Why the check is inside the function rather than in the API route: a
-- route-level "claim then execute" is two transactions, so a crash in between
-- loses the order and a concurrent duplicate can be admitted in the window.
-- The per-user `for update` lock on paper_accounts is already the
-- serialization point for every trade, so the key is checked twice around it:
--   before  → the ordinary retry (cheap, no re-validation)
--   after   → the concurrent duplicate, which only becomes visible once this
--             call holds the lock that serializes it
-- The unique index is the backstop, so even a path that bypassed the lock
-- cannot produce a second fill.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The key, and the original result it replays.
-- ---------------------------------------------------------------------
alter table public.trades add column if not exists client_order_id text;

-- The response of the original execution, so a replay returns exactly what
-- the first call returned rather than a value recomputed from a position
-- that has since moved. NULL on rows written before this migration.
alter table public.trades add column if not exists execution_result jsonb;

-- Partial: rows written before this migration have no key and must not
-- collide with each other. `leg_key` in 0007 solved the same problem the
-- other way round; here the key simply does not exist for old rows.
create unique index if not exists trades_user_client_order_id_key
  on public.trades (user_id, client_order_id)
  where client_order_id is not null;

-- ---------------------------------------------------------------------
-- execute_trade: unchanged settlement, now exactly-once per order id
-- ---------------------------------------------------------------------
drop function if exists public.execute_trade(uuid, uuid, uuid, text, text, text, numeric, timestamptz, timestamptz);

create or replace function public.execute_trade(
  p_user_id uuid,
  p_market_id uuid,
  p_counter_market_id uuid,
  p_instrument text,
  p_product text,
  p_side text,
  p_quantity_mwh numeric,
  p_delivery_start timestamptz,
  p_delivery_end timestamptz,
  p_client_order_id text default null
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
  v_existing  public.trades%rowtype;
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
  v_coid      text;
  v_result    jsonb;
begin
  -- 0. Authorization.
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  -- 0b. Idempotency key. A malformed id is rejected rather than coerced, so
  --     two different intents can never collide on a sanitized value.
  v_coid := nullif(btrim(coalesce(p_client_order_id, '')), '');
  if v_coid is not null and length(v_coid) > 128 then
    raise exception 'CLIENT_ORDER_ID_INVALID';
  end if;

  -- 0c. Ordinary retry: this order already executed, so return its result.
  --     Checked before any validation, because the state that made the
  --     original call valid (its interval price, its delivery window) may
  --     legitimately have changed since.
  if v_coid is not null then
    select * into v_existing
    from public.trades
    where user_id = p_user_id and client_order_id = v_coid;
    if found then
      return coalesce(v_existing.execution_result, '{}'::jsonb)
             || jsonb_build_object('trade_id', v_existing.id, 'replayed', true);
    end if;
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

  -- 7b. This call now holds the lock that serializes every trade for this
  --     user, so a concurrent duplicate of this order can no longer be
  --     in flight: either it committed while we waited (and is visible here),
  --     or it is still waiting behind us and will find ours. Exactly one of
  --     the two proceeds past this point.
  if v_coid is not null then
    select * into v_existing
    from public.trades
    where user_id = p_user_id and client_order_id = v_coid;
    if found then
      return coalesce(v_existing.execution_result, '{}'::jsonb)
             || jsonb_build_object('trade_id', v_existing.id, 'replayed', true);
    end if;
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

  -- 11. The execution result, computed once and stored. It carries no
  --     trade_id because trades is insert-only (0005's trigger forbids
  --     updating it), so the id is added to the returned copy only.
  v_result := jsonb_build_object(
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
    'executed_at', v_exec_at,
    'replayed', false
  );

  -- 12. Immutable trade record. The idempotency key is written here; if it
  --     somehow already exists this raises and the whole function rolls back,
  --     which is the correct failure mode — a second fill is never a
  --     recoverable outcome.
  insert into public.trades (
    user_id, market_id, product, venue, instrument, counter_market_id, side,
    quantity_mwh, delivery_start, delivery_end,
    execution_price, price_timestamp, market_price_id,
    status, created_at, executed_at,
    client_order_id, execution_result
  ) values (
    p_user_id, p_market_id, v_product.code, v_product.venue, v_instr.code,
    p_counter_market_id, p_side,
    p_quantity_mwh, p_delivery_start, p_delivery_end,
    v_price, p_delivery_start, v_leg_price_id,
    'EXECUTED', v_exec_at, v_exec_at,
    v_coid, v_result
  )
  returning id into v_trade_id;

  -- 13. Position upsert on the widened identity.
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

  -- 14. Audit (immutable).
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
      'client_order_id', v_coid,
      'delivery_start', to_char(p_delivery_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'delivery_end', to_char(p_delivery_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'notional', v_notional,
      'realized_delta', v_realized_delta,
      'position_quantity', v_new_qty
    )
  );

  return v_result || jsonb_build_object('trade_id', v_trade_id);
end;
$$;

revoke execute on function public.execute_trade(uuid, uuid, uuid, text, text, text, numeric, timestamptz, timestamptz, text) from public;
grant execute on function public.execute_trade(uuid, uuid, uuid, text, text, text, numeric, timestamptz, timestamptz, text)
  to authenticated;
