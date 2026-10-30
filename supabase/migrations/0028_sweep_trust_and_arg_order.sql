-- =====================================================================
-- 0028 — The sweep may execute on the book's behalf
--
-- Two corrections to 0026's wiring, found by the live suite:
--
-- 1. execute_trade's authorization guard reads auth.uid(), which is NULL
--    for a service-role caller — so the sweep could place orders but
--    every fill was refused FORBIDDEN. The guard is amended IN DATABASE
--    (the transform below runs against the deployed definition, so any
--    formatting drift between migration files and the live catalog is
--    irrelevant): the service_role role claim is admitted, because the
--    limit-order sweep is the same trust tier as settlement — a system
--    job executing a user's own stored order. Every human caller is
--    still pinned to auth.uid() = p_user_id exactly as before; auth.role()
--    reads the JWT role claim, which survives the definer context switch.
--
-- 2. The sweep passed execute_trade's arguments in the wrong order
--    (counter market sits SECOND in the deployed signature). The sweep
--    is rewritten below with the correct order; its other semantics
--    (print crossing, fill at the print, per-order idempotency key,
--    bounded error handling) are unchanged from 0026.
-- =====================================================================

do $transform$
declare
  v_def   text;
  v_new   text;
  v_guard_old text;
  v_guard_new text;
begin
  if current_user <> 'postgres' and current_user <> 'service_role' then
    raise exception 'FORBIDDEN: 0028 transforms a SECURITY DEFINER function and must run as the migration role';
  end if;

  select pg_get_functiondef(
    'public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamp with time zone,timestamp with time zone,text)'::regprocedure
  ) into v_def;

  v_guard_old := $g$  -- 0. Authorization.
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;$g$;

  v_guard_new := $g$  -- 0. Authorization. A service-role system job (the
  -- limit-order sweep, 0026/0028) may execute on a user's behalf, passing
  -- the order's own stored user_id; auth.role() reads the JWT role claim,
  -- which is valid across the definer context switch. Every human caller
  -- is still pinned to their own session.
  if coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null or auth.uid() <> p_user_id then
      raise exception 'FORBIDDEN';
    end if;
  end if;$g$;

  if position(v_guard_old in v_def) = 0 then
    raise exception '0028: execute_trade authorization guard not found verbatim — the deployed definition has drifted; migrate by hand';
  end if;

  v_new := replace(v_def, v_guard_old, v_guard_new);
  execute v_new;
end;
$transform$;

-- ---------------------------------------------------------------------
-- The sweep, corrected argument order (semantics as 0026).
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

  -- Expire first: the open-order book stays honest.
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

      -- The SAME visibility rule the instant engine fills under: latest
      -- observation of the interval published at or before now. No print
      -- visible yet → the order keeps waiting.
      v_price := public.price_at(
        v_order.market_id, v_order.product,
        v_order.delivery_start, v_now
      );
      if v_price is null then
        continue;
      end if;

      -- Crossing: BUY fills when the print is at or below the limit, SELL
      -- when at or above; ties fill. The fill price is the print itself.
      if (v_order.side = 'BUY' and v_price <= v_order.limit_price)
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
