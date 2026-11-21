-- =====================================================================
-- 0057 — Placing an order is idempotent
--
-- 0010 made a fill idempotent: execute_trade takes a client_order_id and a
-- retry replays the stored result. Since 0038 every position starts as a
-- bid, and placing the bid took no key. A request retried after a timeout or
-- a reconnect placed the bid twice, and an Idempotency-Key header sent three
-- times made three orders.
--
--   1. paper_orders.client_order_id, unique per account when present.
--   2. place_limit_order takes p_client_order_id (last, defaulted, so
--      existing callers are unchanged). With a key it has already seen, it
--      returns that order's id and places nothing, as 0010 does for fills:
--      checked under the account lock that serializes an account's orders,
--      before any validation, because the state that made the original valid
--      (an open bid window) may have changed since.
--   3. The same key with a different order is a client bug, not a retry:
--      IDEMPOTENCY_KEY_REUSED, rather than quietly returning an order that
--      is not the one asked for.
--
-- The body is otherwise 0043's as production has it (with 0055's challenge
-- guard removed). A new signature is a new function, so the old one is
-- dropped and the grants restated: a session may still call exactly six.
-- =====================================================================

-- 1. Where the key lives.
alter table public.paper_orders add column if not exists client_order_id text;

alter table public.paper_orders drop constraint if exists paper_orders_client_order_id_valid;
alter table public.paper_orders add constraint paper_orders_client_order_id_valid
  check (client_order_id is null or char_length(client_order_id) between 1 and 128);

create unique index if not exists paper_orders_user_client_order_id_key
  on public.paper_orders (user_id, client_order_id)
  where client_order_id is not null;

comment on column public.paper_orders.client_order_id is
  'The client''s idempotency key for placing this order (0057). Unique per account; a retry with it returns this order.';

-- 2. The function, with its key.
drop function if exists public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz);

create function public.place_limit_order(
  p_user_id uuid,
  p_market_id uuid,
  p_instrument text,
  p_product text,
  p_counter_market_id uuid,
  p_side text,
  p_quantity_mwh numeric,
  p_limit_price numeric,
  p_delivery_start timestamptz,
  p_delivery_end timestamptz,
  p_expires_at timestamptz default null,
  p_client_order_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.paper_accounts%rowtype;
  v_instr   public.instruments%rowtype;
  v_product public.products%rowtype;
  v_counter public.markets%rowtype;
  v_existing public.paper_orders%rowtype;
  v_coid    text;
  v_as_of   timestamptz;
  v_expiry  timestamptz;
  v_type    text;
  v_order_id uuid;
  v_window_ms numeric;
  v_interval_ms numeric;
begin
  if auth.uid() is null or not public.acts_for(p_user_id) then
    raise exception 'FORBIDDEN';
  end if;

  -- A malformed key is refused rather than coerced, so two different intents
  -- can never collide on a sanitized value (0010).
  v_coid := nullif(btrim(coalesce(p_client_order_id, '')), '');
  if v_coid is not null and length(v_coid) > 128 then
    raise exception 'CLIENT_ORDER_ID_INVALID';
  end if;

  -- One order at a time per account: the credit and open-order checks below
  -- read the book and then add to it. The same lock makes a concurrent retry
  -- wait for the original and then find it.
  select * into v_account
  from public.paper_accounts
  where user_id = p_user_id
  for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  -- 0057: a retry returns the order it already placed.
  if v_coid is not null then
    select * into v_existing
    from public.paper_orders
    where user_id = p_user_id and client_order_id = v_coid;
    if found then
      if v_existing.market_id is distinct from p_market_id
         or v_existing.instrument is distinct from p_instrument
         or v_existing.counter_market_id is distinct from p_counter_market_id
         or v_existing.side is distinct from p_side
         or v_existing.quantity_mwh is distinct from p_quantity_mwh
         or v_existing.limit_price is distinct from p_limit_price
         or v_existing.delivery_start is distinct from p_delivery_start
         or v_existing.delivery_end is distinct from p_delivery_end then
        raise exception 'IDEMPOTENCY_KEY_REUSED';
      end if;
      return v_existing.id;
    end if;
  end if;

  v_as_of := public.sim_now(p_user_id);

  -- Instrument + product: the same catalog rules execute_trade enforces.
  select * into v_instr from public.instruments where code = p_instrument;
  if not found then
    raise exception 'INSTRUMENT_INVALID';
  end if;
  if not v_instr.tradable or not v_instr.orderable then
    raise exception 'INSTRUMENT_NOT_TRADABLE';
  end if;

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

  -- The source point must be open too, not only the sink.
  if not exists (select 1 from public.markets where id = p_market_id and active) then
    raise exception 'MARKET_INVALID';
  end if;

  -- Path legs.
  if v_instr.settlement_rule in ('DIFFERENCE', 'CONGESTION_CONVERGENCE') then
    if p_counter_market_id is null then
      raise exception 'COUNTER_POINT_REQUIRED';
    end if;
    if p_counter_market_id = p_market_id then
      raise exception 'COUNTER_POINT_INVALID';
    end if;
    select * into v_counter
    from public.markets
    where id = p_counter_market_id and active;
    if not found then
      raise exception 'COUNTER_POINT_INVALID';
    end if;
  elsif p_counter_market_id is not null then
    raise exception 'COUNTER_POINT_INVALID';
  end if;

  -- Sides, size, price. No limit = a MARKET order: fill at the clearing price.
  if p_side is null or p_side not in ('BUY', 'SELL') then
    raise exception 'SIDE_INVALID';
  end if;
  if p_quantity_mwh is null or p_quantity_mwh <= 0 or p_quantity_mwh > 1000
     or p_quantity_mwh <> round(p_quantity_mwh, 6) then
    raise exception 'QUANTITY_INVALID';
  end if;
  -- 0045: ERCOT takes bid quantities in steps of 0.1 MW.
  if p_quantity_mwh <> round(p_quantity_mwh, 1) then
    raise exception 'QUANTITY_INCREMENT';
  end if;
  if p_limit_price is not null and (p_limit_price < -250 or p_limit_price > 5000) then
    raise exception 'LIMIT_PRICE_INVALID';
  end if;
  v_type := case when p_limit_price is null then 'MARKET' else 'LIMIT' end;

  -- Delivery: the instant engine's rules, so what is accepted here can fill.
  -- The order commits to an interval; if no price ever prints for it, the
  -- order expires unfilled rather than filling at an invented price.
  if p_delivery_start is null or p_delivery_end is null
     or p_delivery_end <= p_delivery_start then
    raise exception 'DELIVERY_INVALID';
  end if;

  v_interval_ms := v_product.interval_minutes * 60 * 1000;
  v_window_ms := extract(epoch from (p_delivery_end - p_delivery_start)) * 1000;
  if v_instr.settlement_rule = 'AVERAGE' then
    if mod(v_window_ms, v_interval_ms) <> 0 then
      raise exception 'DELIVERY_WINDOW_INVALID';
    end if;
  elsif v_window_ms <> v_interval_ms then
    raise exception 'DELIVERY_INTERVAL_INVALID';
  end if;
  if mod(extract(epoch from p_delivery_start) * 1000, v_interval_ms) <> 0
     or mod(extract(epoch from p_delivery_end) * 1000, v_interval_ms) <> 0 then
    raise exception 'DELIVERY_MUST_BE_ALIGNED';
  end if;

  if p_delivery_start <= v_as_of then
    raise exception 'DELIVERY_IN_PAST';
  end if;
  if p_delivery_start > v_as_of + interval '35 days' then
    raise exception 'DELIVERY_TOO_FAR_OUT';
  end if;
  -- 0038: day-ahead bids close at 10:00 Central the day before.
  if v_product.code like 'DAM%' and v_as_of >= public.dam_gate(p_delivery_start) then
    raise exception 'DAM_CLOSED';
  end if;
  -- 0045: and open fourteen days before the operating day.
  if v_product.code like 'DAM%' and v_as_of < public.dam_bid_window_opens(p_delivery_start) then
    raise exception 'DAM_NOT_OPEN';
  end if;

  -- A bounded book: every open order is sweep work, and a dust order holds
  -- next to no collateral, so collateral alone does not bound them.
  if (select count(*) from public.paper_orders
      where user_id = p_user_id and status = 'OPEN') >= 500 then
    raise exception 'OPEN_ORDER_LIMIT';
  end if;

  -- 0040: collateral. Every open bid, and this one, holds MW x the point's
  -- exposure factor; together they must fit within the account's cash.
  if (select coalesce(sum(x.q * public.bid_exposure_factor(x.m)), 0)
      from (select market_id m, sum(quantity_mwh) q
            from public.paper_orders
            where user_id = p_user_id and status = 'OPEN'
            group by market_id) x)
     + p_quantity_mwh * public.bid_exposure_factor(p_market_id)
     -- 0041: every open margined position holds its collateral too.
     + (select coalesce(sum(abs(pos.quantity_mwh) * public.bid_exposure_factor(pos.market_id)), 0)
        from public.positions pos
        where pos.user_id = p_user_id and pos.quantity_mwh <> 0
          and public.is_margined_instrument(pos.instrument))
     -- 0043: an open loss or a deficit is already owed; a gain is not cash yet.
     > least(v_account.cash_balance,
             (select m.equity from public.account_margin(p_user_id) m)) then
    raise exception 'CREDIT_LIMIT_EXCEEDED';
  end if;

  -- Expiry: the order stands until its delivery starts, which the 35-day
  -- horizon bounds; an explicit value must be in the future.
  v_expiry := coalesce(p_expires_at, p_delivery_start);
  if v_expiry <= v_as_of then
    raise exception 'EXPIRY_INVALID';
  end if;

  -- A bid placed on a displaced clock is replay practice, not a live result.
  if v_account.sim_clock_offset <> 0 and v_account.replay_tainted_at is null then
    update public.paper_accounts
       set replay_tainted_at = clock_timestamp()
     where id = v_account.id;
  end if;

  insert into public.paper_orders (
    user_id, market_id, product, instrument, counter_market_id,
    side, quantity_mwh, order_type, limit_price,
    delivery_start, delivery_end, expires_at, client_order_id
  ) values (
    p_user_id, p_market_id, v_product.code, v_instr.code, p_counter_market_id,
    p_side, p_quantity_mwh, v_type, p_limit_price,
    p_delivery_start, p_delivery_end, v_expiry, v_coid
  )
  returning id into v_order_id;

  insert into public.audit_events (
    user_id, event_type, entity_type, entity_id, metadata
  ) values (
    p_user_id, 'ORDER_PLACED', 'paper_order', v_order_id,
    jsonb_build_object(
      'side', p_side,
      'instrument', v_instr.code,
      'product', v_product.code,
      'order_type', v_type,
      'limit_price', p_limit_price,
      'quantity_mwh', p_quantity_mwh,
      'delivery_start', to_char(p_delivery_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'delivery_end', to_char(p_delivery_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'expires_at', v_expiry,
      'client_order_id', v_coid
    )
  );

  return v_order_id;
end;
$$;

-- 3. Grants: a session may call it, nothing anonymous may (0046).
revoke execute on function public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz, text) to authenticated, service_role;
