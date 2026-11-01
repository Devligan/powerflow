-- =====================================================================
-- 0038 — Day-ahead positions are bids made before the market clears
--
-- In ERCOT's day-ahead market, bids and offers (virtuals included) for an
-- operating day are accepted until 10:00 Central on the day before. The
-- market then clears and publishes its prices (~13:30). Nobody knows the
-- price when they bid, and nobody can add a day-ahead position afterwards.
--
-- Until now the desk let anyone buy or sell a day-ahead interval at its
-- ALREADY-PUBLISHED clearing price, right up to delivery. A convergence
-- position opened that way is a bet made with the day-ahead side known and
-- hours of real-time prints visible: the edge behind the October demo-book
-- trades. Every orderable instrument prices off DAM_HOURLY (the only
-- tradable product), so the rule covers the whole desk.
--
--   1. dam_gate(delivery_start): 10:00 Central on the day before the
--      delivery's operating day (Central date of its start, so HE24 belongs
--      to the day it starts in).
--   2. execute_trade: a user can no longer fill a day-ahead interval
--      directly — before the deadline it is DAM_ORDER_REQUIRED (no price
--      exists yet), after it DAM_CLOSED. The service-role order sweep is the
--      only path that fills day-ahead positions, and only orders placed
--      before the deadline exist to be filled.
--   3. paper_orders gains MARKET orders: no limit, filled at whatever the
--      market clears at ("price-taker" bids). LIMIT orders are unchanged.
--   4. place_limit_order: accepts a NULL limit (MARKET) and refuses an order
--      at or after the deadline (DAM_CLOSED), on the account's own clock.
--   5. fill_crossing_limit_orders, rewritten:
--      - each order is judged on its OWN account's clock (replay accounts
--        included) for expiry, price visibility and the delivery cutoff;
--      - the crossing test uses instrument_entry_price — the price the fill
--        will actually be made at — not the first interval's print (a block
--        order compared one hour against its limit and filled at the
--        window's average);
--      - orders are taken soonest-delivery first, so a large book of
--        not-yet-priced orders cannot starve the ones that can fill.
--
-- Positions already open are unaffected, and so is settlement.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The deadline
-- ---------------------------------------------------------------------
create or replace function public.dam_gate(p_delivery_start timestamptz)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select ((((p_delivery_start at time zone 'America/Chicago')::date - 1)::timestamp
           + time '10:00') at time zone 'America/Chicago')
$$;

revoke execute on function public.dam_gate(timestamptz) from public, anon;
grant execute on function public.dam_gate(timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. execute_trade: no direct day-ahead fills by users
-- ---------------------------------------------------------------------
do $$
declare
  v_fn regprocedure :=
    'public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text)'::regprocedure;
  v_def text := pg_get_functiondef(v_fn);
  v_anchor text := E'  if p_delivery_start > v_as_of + interval ''35 days'' then\n    raise exception ''DELIVERY_TOO_FAR_OUT'';\n  end if;\n';
  v_gate text := E'\n  -- 0038: a day-ahead interval is bid for before the market clears, never\n'
    || E'  -- bought at its published price. Users place orders (place_limit_order);\n'
    || E'  -- only the service-role sweep fills them.\n'
    || E'  if coalesce(auth.role(), '''') <> ''service_role'' and v_product.code like ''DAM%'' then\n'
    || E'    if v_as_of >= public.dam_gate(p_delivery_start) then\n'
    || E'      raise exception ''DAM_CLOSED'';\n'
    || E'    end if;\n'
    || E'    raise exception ''DAM_ORDER_REQUIRED'';\n'
    || E'  end if;\n';
begin
  if position('DAM_ORDER_REQUIRED' in v_def) > 0 then
    return; -- already applied
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception '0038: execute_trade horizon check not found';
  end if;
  execute replace(v_def, v_anchor, v_anchor || v_gate);
end
$$;

-- ---------------------------------------------------------------------
-- 3. MARKET orders
-- ---------------------------------------------------------------------
alter table public.paper_orders alter column limit_price drop not null;
alter table public.paper_orders drop constraint if exists paper_orders_order_type_check;
alter table public.paper_orders
  add constraint paper_orders_order_type_check check (order_type in ('LIMIT', 'MARKET'));
alter table public.paper_orders drop constraint if exists paper_orders_limit_matches_type;
alter table public.paper_orders
  add constraint paper_orders_limit_matches_type
  check ((order_type = 'LIMIT') = (limit_price is not null));

-- ---------------------------------------------------------------------
-- 4. place_limit_order: the deadline, and MARKET orders
-- ---------------------------------------------------------------------
create or replace function public.place_limit_order(
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
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_instr   public.instruments%rowtype;
  v_product public.products%rowtype;
  v_counter public.markets%rowtype;
  v_as_of   timestamptz;
  v_expiry  timestamptz;
  v_type    text;
  v_order_id uuid;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  v_as_of := public.sim_now(p_user_id);
  if v_as_of is null then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  -- Instrument + product: the same catalog rules execute_trade enforces.
  select * into v_instr from public.instruments where code = p_instrument;
  if not found then
    raise exception 'INSTRUMENT_INVALID';
  end if;
  if not v_instr.tradable then
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
  if p_quantity_mwh is null or p_quantity_mwh <= 0 then
    raise exception 'QUANTITY_INVALID';
  end if;
  if p_limit_price is not null and p_limit_price <= 0 then
    raise exception 'LIMIT_PRICE_INVALID';
  end if;
  v_type := case when p_limit_price is null then 'MARKET' else 'LIMIT' end;

  -- Delivery: same horizon rules as the instant engine. The order commits
  -- to an interval; if no price ever prints for it, the order expires
  -- unfilled rather than filling at an invented price.
  if p_delivery_start is null or p_delivery_end is null
     or p_delivery_end <= p_delivery_start then
    raise exception 'DELIVERY_INVALID';
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

  -- Expiry: bounded so a forgotten order cannot live forever. Default is
  -- 7 days out; an explicit value must be in the future.
  v_expiry := coalesce(p_expires_at, v_as_of + interval '7 days');
  if v_expiry <= v_as_of then
    raise exception 'EXPIRY_INVALID';
  end if;

  insert into public.paper_orders (
    user_id, market_id, product, instrument, counter_market_id,
    side, quantity_mwh, order_type, limit_price,
    delivery_start, delivery_end, expires_at
  ) values (
    p_user_id, p_market_id, v_product.code, v_instr.code, p_counter_market_id,
    p_side, p_quantity_mwh, v_type, p_limit_price,
    p_delivery_start, p_delivery_end, v_expiry
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
      'expires_at', v_expiry
    )
  );

  return v_order_id;
end;
$$;

revoke execute on function public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz) from public, anon;
grant execute on function public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- 5. The fill sweep
-- ---------------------------------------------------------------------
create or replace function public.fill_crossing_limit_orders(p_limit integer default 200)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_wall       timestamptz := clock_timestamp();
  v_clock      timestamptz;
  v_considered int := 0;
  v_filled     int := 0;
  v_expired    int := 0;
  v_errors     int := 0;
  v_error_samples jsonb := '[]'::jsonb;
  v_order      public.paper_orders%rowtype;
  v_market     public.markets%rowtype;
  v_price      numeric;
  v_result     jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'FORBIDDEN: fill_crossing_limit_orders is a service_role job';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'LIMIT_INVALID';
  end if;

  -- Expire first, each on its own account's clock: past its expiry, or its
  -- delivery has started (0037) — an order never fills into a live period.
  update public.paper_orders o
  set status = 'EXPIRED', updated_at = v_wall
  where o.status = 'OPEN'
    and (o.expires_at <= public.sim_now(o.user_id)
         or o.delivery_start <= public.sim_now(o.user_id));
  get diagnostics v_expired = row_count;

  for v_order in
    select *
    from public.paper_orders
    where status = 'OPEN'
    order by delivery_start, created_at
    limit p_limit
  loop
    v_considered := v_considered + 1;

    begin
      v_clock := public.sim_now(v_order.user_id);
      if v_clock is null or v_order.delivery_start <= v_clock then
        continue;
      end if;

      select * into v_market
      from public.markets
      where id = v_order.market_id and active;
      if not found then
        raise exception 'MARKET_INVALID';
      end if;

      -- The price the fill would be made at, as visible on the account's
      -- clock: the same rule execute_trade applies. Not cleared yet → wait.
      v_price := public.instrument_entry_price(
        v_order.market_id, v_order.counter_market_id, v_order.instrument,
        v_order.product, v_order.delivery_start, v_order.delivery_end, v_clock
      );
      if v_price is null then
        continue;
      end if;

      -- MARKET fills at whatever cleared. LIMIT: BUY at or below, SELL at or
      -- above; ties fill. The fill price is the clearing price itself.
      if v_order.order_type = 'MARKET'
         or (v_order.side = 'BUY' and v_price <= v_order.limit_price)
         or (v_order.side = 'SELL' and v_price >= v_order.limit_price) then

        v_result := public.execute_trade(
          v_order.user_id,
          v_order.market_id,
          v_order.counter_market_id,
          v_order.instrument,
          v_order.product,
          v_order.side,
          v_order.quantity_mwh,
          v_order.delivery_start,
          v_order.delivery_end,
          -- Per-order idempotency key: a sweep retry replays the fill
          -- instead of re-executing (execute_trade step 0c).
          'sweep-' || v_order.id::text
        );

        update public.paper_orders
        set status = 'FILLED',
            filled_trade_id = (v_result->>'trade_id')::uuid,
            updated_at = v_wall
        where id = v_order.id and status = 'OPEN';

        if found then
          v_filled := v_filled + 1;

          insert into public.audit_events (
            user_id, event_type, entity_type, entity_id, metadata
          ) values (
            v_order.user_id, 'ORDER_FILLED', 'paper_order', v_order.id,
            jsonb_build_object(
              'trade_id', v_result->>'trade_id',
              'fill_price', v_result->>'execution_price',
              'order_type', v_order.order_type,
              'limit_price', v_order.limit_price,
              'side', v_order.side,
              'quantity_mwh', v_order.quantity_mwh
            )
          );
        end if;
      end if;
    exception when others then
      -- One bad order must not stall the book; samples go to the summary.
      v_errors := v_errors + 1;
      if v_errors <= 5 then
        v_error_samples := v_error_samples
          || jsonb_build_object('order_id', v_order.id, 'error', sqlerrm);
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'considered', v_considered,
    'filled', v_filled,
    'expired', v_expired,
    'errors', v_errors,
    'error_samples', v_error_samples
  );
end;
$$;

revoke execute on function public.fill_crossing_limit_orders(integer) from public, anon, authenticated;
grant execute on function public.fill_crossing_limit_orders(integer) to service_role;
