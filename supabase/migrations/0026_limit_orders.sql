-- =====================================================================
-- 0026 — Working limit orders: commit now, fill at your price
--
-- Until now the only order was an immediate fill: the ticket submitted,
-- the engine priced the actual print of the named interval, and the
-- trade either executed at that instant's price or was refused. A real
-- day-ahead desk works orders — "buy tomorrow 09:00 below $35" — and
-- waits. This migration adds that waiting order:
--
--   paper_orders: a stored intent, priced as a LIMIT on an orderable
--   product, validated with the SAME rules the instant engine applies
--   (instrument, product tradability, path legs, interval alignment,
--   delivery horizon). Placement reserves nothing; the account is
--   checked when the order fills, exactly like a live desk's margin
--   check at fill time.
--
--   place_limit_order(p_user_id, ...): authenticated placement. Same
--   error vocabulary as execute_trade.
--
--   cancel_order(p_user_id, p_order_id): authenticated cancel. An order
--   belongs to its owner; cancellation is idempotent and refuses to
--   cancel something already filled.
--
--   fill_crossing_limit_orders(p_limit): the system sweep, service_role
--   only, run from the ingestion cron's tail. For every OPEN order it
--   prices the order's interval through the SAME visibility rule the
--   instant engine uses (price_at, publication ≤ as-of) and fills
--   through execute_trade when the price crosses. A BUY with
--   limit >= price fills; a SELL with limit <= price fills; ties fill.
--   The fill is the actual crossing print — never the limit itself.
--
-- Trust model: execute_trade's auth guard accepts the sweep because the
-- sweep runs as service_role (same trust tier as settlement). User
-- placements/cancels are pinned to auth.uid(); the sweep passes the
-- order's stored user_id.
--
-- Non-goals (kept honest): no stop orders (needs last-trade semantics a
-- print series does not have), no reserved capital (fills re-check the
-- account; a failing fill stays open), no partial fills (MWh sizes here
-- are small; the whole order fills or stays open).
-- =====================================================================

create table if not exists public.paper_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  market_id uuid not null references public.markets(id),
  product text not null,
  instrument text not null,
  counter_market_id uuid references public.markets(id),
  side text not null check (side in ('BUY', 'SELL')),
  quantity_mwh numeric not null check (quantity_mwh > 0),
  -- The order type vocabulary is one entry today, stated so the column
  -- cannot silently mean something else later.
  order_type text not null default 'LIMIT' check (order_type in ('LIMIT')),
  limit_price numeric not null check (limit_price > 0),
  delivery_start timestamptz not null,
  delivery_end timestamptz not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'FILLED', 'CANCELLED', 'EXPIRED')),
  -- Set when the sweep fills the order; mirrors trades.created_at.
  filled_trade_id uuid references public.trades(id),
  -- Where the sweep stopped seeing this order as open (idempotency for
  -- the EXPIRED transition).
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists paper_orders_open_idx
  on public.paper_orders (status, expires_at);
create index if not exists paper_orders_user_idx
  on public.paper_orders (user_id, status, created_at desc);

-- ---------------------------------------------------------------------
-- Placement
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

  -- Sides, size, price.
  if p_side is null or p_side not in ('BUY', 'SELL') then
    raise exception 'SIDE_INVALID';
  end if;
  if p_quantity_mwh is null or p_quantity_mwh <= 0 then
    raise exception 'QUANTITY_INVALID';
  end if;
  if p_limit_price is null or p_limit_price <= 0 then
    raise exception 'LIMIT_PRICE_INVALID';
  end if;

  -- Delivery: same horizon rules as the instant engine. The order commits
  -- to an interval; if no price ever prints for it, the order expires
  -- unfilled rather than filling at an invented price.
  if p_delivery_start is null or p_delivery_end is null
     or p_delivery_end <= p_delivery_start then
    raise exception 'DELIVERY_INVALID';
  end if;
  if p_delivery_end <= v_as_of then
    raise exception 'DELIVERY_IN_PAST';
  end if;
  if p_delivery_start > v_as_of + interval '35 days' then
    raise exception 'DELIVERY_TOO_FAR_OUT';
  end if;

  -- Expiry: bounded so a forgotten order cannot live forever. Default is
  -- 7 days out; an explicit value must be in the future.
  v_expiry := coalesce(p_expires_at, v_as_of + interval '7 days');
  if v_expiry <= v_as_of then
    raise exception 'EXPIRY_INVALID';
  end if;

  insert into public.paper_orders (
    user_id, market_id, product, instrument, counter_market_id,
    side, quantity_mwh, limit_price,
    delivery_start, delivery_end, expires_at
  ) values (
    p_user_id, p_market_id, v_product.code, v_instr.code, p_counter_market_id,
    p_side, p_quantity_mwh, p_limit_price,
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

-- ---------------------------------------------------------------------
-- Cancel
-- ---------------------------------------------------------------------

create or replace function public.cancel_order(
  p_user_id uuid,
  p_order_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.paper_orders%rowtype;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_order
  from public.paper_orders
  where id = p_order_id and user_id = p_user_id
  for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if v_order.status <> 'OPEN' then
    raise exception 'ORDER_NOT_OPEN';
  end if;

  update public.paper_orders
  set status = 'CANCELLED', updated_at = now()
  where id = p_order_id;

  insert into public.audit_events (
    user_id, event_type, entity_type, entity_id, metadata
  ) values (
    p_user_id, 'ORDER_CANCELLED', 'paper_order', p_order_id,
    jsonb_build_object('status', 'CANCELLED')
  );

  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------

create or replace function public.fill_crossing_limit_orders(
  p_limit integer default 200
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_now        timestamptz := clock_timestamp();
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

  -- Expire first: a stale order leaves the desk's open-order book honest.
  update public.paper_orders
  set status = 'EXPIRED', updated_at = v_now
  where status = 'OPEN' and expires_at <= v_now;
  get diagnostics v_expired = row_count;

  for v_order in
    select *
    from public.paper_orders
    where status = 'OPEN'
      and delivery_end > v_now
    order by created_at
    limit p_limit
  loop
    v_considered := v_considered + 1;

    begin
      select * into v_market
      from public.markets
      where id = v_order.market_id and active;
      if not found then
        raise exception 'MARKET_INVALID';
      end if;

      -- The SAME visibility rule the instant engine fills under:
      -- latest observation of the interval published at or before now,
      -- ERCOT sources preferred. No print visible yet → the order waits.
      v_price := public.price_at(
        v_order.market_id, v_order.product,
        v_order.delivery_start, v_now
      );
      if v_price is null then
        continue; -- nothing published for the interval yet: keep waiting
      end if;

      -- Crossing rule: BUY fills when the print is at or below the limit,
      -- SELL when at or above. Ties fill. The fill price is the print.
      if (v_order.side = 'BUY' and v_price <= v_order.limit_price)
         or (v_order.side = 'SELL' and v_price >= v_order.limit_price) then

        v_result := public.execute_trade(
          v_order.user_id,
          v_order.market_id,
          v_order.instrument,
          v_order.product,
          v_order.counter_market_id,
          v_order.side,
          v_order.quantity_mwh,
          v_order.delivery_start,
          v_order.delivery_end,
          -- Idempotency key derived from the order id: a sweep retry after a
          -- partial failure replays the original fill instead of re-executing.
          'sweep-' || v_order.id::text
        );

        update public.paper_orders
        set status = 'FILLED',
            filled_trade_id = (v_result->>'trade_id')::uuid,
            updated_at = v_now
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
              'limit_price', v_order.limit_price,
              'side', v_order.side,
              'quantity_mwh', v_order.quantity_mwh
            )
          );
        end if;
      end if;
    exception when others then
      -- One bad order must not stop the book; the sample goes to the log.
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

revoke execute on function public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz) from anon;
grant execute on function public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz) to authenticated, service_role;

revoke execute on function public.cancel_order(uuid, uuid) from public;
revoke execute on function public.cancel_order(uuid, uuid) from anon;
grant execute on function public.cancel_order(uuid, uuid) to authenticated, service_role;

revoke execute on function public.fill_crossing_limit_orders(integer) from public;
revoke execute on function public.fill_crossing_limit_orders(integer) from anon;
revoke execute on function public.fill_crossing_limit_orders(integer) from authenticated;
grant execute on function public.fill_crossing_limit_orders(integer) to service_role;

-- RLS: a user sees only their own orders; the service role bypasses RLS.
alter table public.paper_orders enable row level security;
drop policy if exists paper_orders_select_own on public.paper_orders;
create policy paper_orders_select_own on public.paper_orders
  for select using (auth.uid() = user_id);
drop policy if exists paper_orders_insert_own on public.paper_orders;
create policy paper_orders_insert_own on public.paper_orders
  for insert with check (auth.uid() = user_id);
drop policy if exists paper_orders_update_own on public.paper_orders;
create policy paper_orders_update_own on public.paper_orders
  for update using (auth.uid() = user_id);
