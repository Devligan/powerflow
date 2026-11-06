-- =====================================================================
-- 0043 — What a review of the engine against ERCOT's calendar turned up
--
-- Each of these was reproduced first; src/lib/trading/sql-audit.test.ts pins
-- them.
--
--   1. A bid could be withdrawn after bids closed. cancel_order had no
--      deadline, and a bid lives until the sweep sees the clearing, so it was
--      a free option: read ERCOT's published prices during the gap before the
--      next ingest, cancel the losers, keep the winners. ERCOT takes no
--      withdrawals after 10:00 Central, so neither does this.
--   2. A bid more than a week out never filled. Orders defaulted to 7 days of
--      life, and the ticket offers delivery up to 35 days out, so any such bid
--      expired before its market had opened. An order now lives until its
--      delivery starts.
--   3. A bid was judged at the moment the sweep ran, not when the market
--      cleared. Replay's clock jumping past delivery, or live ingestion
--      catching up after an outage, expired a bid ERCOT had cleared the day
--      before. The sweep now asks what cleared while the order stood, and
--      execute_trade takes that instant from the sweep (p_as_of,
--      service-role only).
--   4. A limit bid the market cleared through stayed OPEN, holding collateral
--      and a sweep slot until delivery with no way left to fill. It ends at
--      the clearing.
--   5. liquidate_to_fund was handed the GAP (required - cash) and compares it
--      to total cash, so an account with more cash than the gap sold nothing
--      and booked a deficit it could have covered. It now gets the requirement.
--   6. One global LIMIT on the settlement sweep took the oldest due positions
--      first, deferred ones included, so 500 positions waiting on a missing
--      real-time print stopped everything behind them forever. The limit now
--      counts positions actually settled.
--   7. trades.execution_price was bounded like a point price, but a path
--      instrument's price is a SPREAD, which reaches past -2000 in a scarcity
--      hour. The position could then neither fill nor settle: the sweep failed
--      it on every run and it stayed open with its loss unrealised.
--   8. A PTP had no mark between its fill and the hour's real-time post, so
--      every open PTP read as unpriced and left the margin requirement. It now
--      marks the way a virtual does (0023): the day-ahead spread, then the
--      hour's newest 15-minute prints, then the hourly value.
--   9. Bid credit looked at cash alone, so a position already deep under water
--      left the account's buying power untouched. It now posts against the
--      lesser of cash and equity, which also brings in any deficit.
--  10. The gross-exposure check summed signed marks, so a negative path mark
--      reduced exposure.
--  11. instrument_price(6 args) and price_average(4 args) are leftovers from
--      before the as-of engine (0021): each calls a price function that no
--      longer exists, and the first makes a 6-argument call ambiguous.
--
-- Function bodies are patched in place, as 0028/0037/0041/0042 did, and every
-- patch is checked: missing text fails the migration; a re-run is a no-op.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 7. A trade's price may be a spread between two points
-- ---------------------------------------------------------------------
-- Widest a spread can be: market_price_sane's bounds, either way round.
alter table public.trades drop constraint if exists trade_execution_price_sane;
alter table public.trades
  add constraint trade_execution_price_sane
  check (execution_price > -22000 and execution_price < 22000);

-- ---------------------------------------------------------------------
-- 11. Leftover overloads
-- ---------------------------------------------------------------------
drop function if exists public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz);
drop function if exists public.price_average(uuid, text, timestamptz, timestamptz);

-- ---------------------------------------------------------------------
-- 3, 10. execute_trade: the sweep may name the instant it fills at
-- ---------------------------------------------------------------------
do $$
declare
  v_fn regprocedure;
  v_def text;
  r record;
begin
  if to_regprocedure('public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,timestamptz)') is not null then
    return; -- already applied
  end if;

  v_fn := 'public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text)'::regprocedure;
  v_def := pg_get_functiondef(v_fn);

  for r in
    select * from (values
      (E'p_client_order_id text DEFAULT NULL::text)',
       E'p_client_order_id text DEFAULT NULL::text, p_as_of timestamp with time zone DEFAULT NULL::timestamp with time zone)'),
      (E'  -- 0. Authorization. A service-role system job (the\n',
       E'  -- 0043: only the sweep may fill at an instant other than the account''s\n'
       || E'  -- clock, because only it knows when an order''s market cleared.\n'
       || E'  if p_as_of is not null and coalesce(auth.role(), '''') <> ''service_role'' then\n'
       || E'    raise exception ''FORBIDDEN'';\n'
       || E'  end if;\n\n'
       || E'  -- 0. Authorization. A service-role system job (the\n'),
      (E'  v_as_of := public.sim_now(p_user_id);\n',
       E'  v_as_of := coalesce(p_as_of, public.sim_now(p_user_id));\n'),
      (E'v_gross_others := v_gross_others + abs(v_other.quantity_mwh) * v_other_price;',
       E'v_gross_others := v_gross_others + abs(v_other.quantity_mwh) * abs(v_other_price);'),
      (E'v_gross_new := v_gross_others + abs(v_new_qty) * v_price;',
       E'v_gross_new := v_gross_others + abs(v_new_qty) * abs(v_price);')
    ) as t(old_text, new_text)
  loop
    if position(r.old_text in v_def) = 0 then
      raise exception '0043: expected text not found in execute_trade: %', left(r.old_text, 80);
    end if;
    v_def := replace(v_def, r.old_text, r.new_text);
  end loop;

  -- A new argument is a new signature, and the old one must not stay behind.
  execute 'drop function ' || v_fn::text;
  execute v_def;
end
$$;

revoke execute on function public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,timestamptz) from public, anon;
grant execute on function public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2, 5, 6, 8, 9. The rest of the patches
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select * from (values
      -- 2. An order lives until its delivery.
      ('public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure,
       E'  -- Expiry: bounded so a forgotten order cannot live forever. Default is\n'
       || E'  -- 7 days out; an explicit value must be in the future.\n'
       || E'  v_expiry := coalesce(p_expires_at, v_as_of + interval ''7 days'');\n',
       E'  -- Expiry: the order stands until its delivery starts, which the 35-day\n'
       || E'  -- horizon bounds; an explicit value must be in the future.\n'
       || E'  v_expiry := coalesce(p_expires_at, p_delivery_start);\n'),
      -- 9. Credit is the lesser of cash and equity.
      ('public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure,
       E'     > v_account.cash_balance then\n    raise exception ''CREDIT_LIMIT_EXCEEDED'';',
       E'     -- 0043: an open loss or a deficit is already owed; a gain is not cash yet.\n'
       || E'     > least(v_account.cash_balance,\n'
       || E'             (select m.equity from public.account_margin(p_user_id) m)) then\n'
       || E'    raise exception ''CREDIT_LIMIT_EXCEEDED'';'),
      -- 5. Pass the requirement, which is what liquidate_to_fund compares cash to.
      ('public.settle_delivered_positions(timestamptz,integer,uuid)'::regprocedure,
       E'          v_pos.user_id, v_required - v_cash_before, v_due, v_pos.id\n',
       E'          v_pos.user_id, v_required, v_due, v_pos.id\n'),
      -- 6. The limit counts work done, not rows looked at.
      ('public.settle_delivered_positions(timestamptz,integer,uuid)'::regprocedure,
       E'    order by pos.delivery_end, pos.id\n'
       || E'    limit p_limit\n'
       || E'    for update skip locked\n'
       || E'  loop\n'
       || E'    v_considered := v_considered + 1;\n',
       E'    order by pos.delivery_end, pos.id\n'
       || E'    for update skip locked\n'
       || E'  loop\n'
       || E'    -- 0043: a position waiting on a price costs one look and is passed\n'
       || E'    -- over; only positions dealt with count against the limit.\n'
       || E'    exit when v_settled + v_failed >= p_limit;\n'
       || E'    v_considered := v_considered + 1;\n'),
      -- 8. A path's value through the life of the position.
      ('public.instrument_price(uuid,uuid,text,text,timestamptz,timestamptz,timestamptz)'::regprocedure,
       E'    v_b := public.price_at(p_counter_market_id, ''RTM_HOURLY'', p_from, v_as_of);\n'
       || E'    if v_a is null or v_b is null then\n'
       || E'      return null;\n'
       || E'    end if;\n'
       || E'    v_price := v_b - v_a;\n',
       E'    v_b := public.price_at(p_counter_market_id, ''RTM_HOURLY'', p_from, v_as_of);\n'
       || E'    -- 0043, as 0023 does for a virtual. The hour is running: its newest\n'
       || E'    -- 15-minute print on each leg.\n'
       || E'    v_a := coalesce(v_a, public.price_latest_in_window(\n'
       || E'      p_market_id, ''RTM_15MIN'', p_from, p_from + interval ''1 hour'', v_as_of));\n'
       || E'    v_b := coalesce(v_b, public.price_latest_in_window(\n'
       || E'      p_counter_market_id, ''RTM_15MIN'', p_from, p_from + interval ''1 hour'', v_as_of));\n'
       || E'    -- Before real time: the day-ahead spread it cleared at, so unrealized\n'
       || E'    -- P&L is zero until real time moves.\n'
       || E'    if v_a is null or v_b is null then\n'
       || E'      v_a := public.price_at(p_market_id, ''DAM_HOURLY'', p_from, v_as_of);\n'
       || E'      v_b := public.price_at(p_counter_market_id, ''DAM_HOURLY'', p_from, v_as_of);\n'
       || E'    end if;\n'
       || E'    if v_a is null or v_b is null then\n'
       || E'      return null;\n'
       || E'    end if;\n'
       || E'    v_price := v_b - v_a;\n')
    ) as t(fn, old_text, new_text)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position(r.new_text in v_def) > 0 then
      continue; -- already applied
    end if;
    if position(r.old_text in v_def) = 0 then
      raise exception '0043: expected text not found in %: %', r.fn, left(r.old_text, 80);
    end if;
    execute replace(v_def, r.old_text, r.new_text);
  end loop;
end
$$;

-- Bids already resting on the old default: they would expire before clearing.
update public.paper_orders
set expires_at = delivery_start, updated_at = now()
where status = 'OPEN' and expires_at < delivery_start;

-- ---------------------------------------------------------------------
-- 1. No withdrawing a bid once bids have closed
-- ---------------------------------------------------------------------
create or replace function public.cancel_order(p_user_id uuid, p_order_id uuid)
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

  -- 0043: on the account's clock, as the deadline is everywhere else.
  if v_order.product like 'DAM%'
     and public.sim_now(p_user_id) >= public.dam_gate(v_order.delivery_start) then
    raise exception 'DAM_CLOSED';
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

revoke execute on function public.cancel_order(uuid, uuid) from public, anon;
grant execute on function public.cancel_order(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3, 4. The sweep judges an order at its market, not at the sweep
-- ---------------------------------------------------------------------
create or replace function public.fill_crossing_limit_orders(
  p_limit integer default 500,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_wall       timestamptz := clock_timestamp();
  v_clock      timestamptz;
  v_at         timestamptz;
  v_considered int := 0;
  v_filled     int := 0;
  v_expired    int := 0;
  v_errors     int := 0;
  v_error_samples jsonb := '[]'::jsonb;
  v_order      public.paper_orders%rowtype;
  v_open       public.paper_orders%rowtype;
  v_price      numeric;
  v_result     jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'FORBIDDEN: fill_crossing_limit_orders is a service_role job';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'LIMIT_INVALID';
  end if;

  -- Accounts are served in turn: every account's soonest order, then every
  -- account's next, so a large book cannot take the whole limit.
  for v_order in
    select o.*
    from public.paper_orders o
    join (
      select id,
             row_number() over (partition by user_id
                                order by delivery_start, created_at) as turn
      from public.paper_orders
      where status = 'OPEN'
        and (p_user_id is null or user_id = p_user_id)
    ) q on q.id = o.id
    order by q.turn, o.delivery_start, o.created_at
    limit p_limit
  loop
    v_considered := v_considered + 1;
    v_clock := null;

    begin
      -- A fill and a cancel must exclude each other.
      select * into v_open
      from public.paper_orders
      where id = v_order.id and status = 'OPEN'
      for update skip locked;
      if not found then
        continue;
      end if;

      v_clock := public.sim_now(v_open.user_id);
      if v_clock is null then
        continue;
      end if;

      -- The last instant the order stood in the market: the account's clock,
      -- unless it has already expired or reached delivery. Whatever had cleared
      -- by then is what it was exposed to, however much later this runs. A
      -- replay clock can jump past delivery, and ingestion can catch up after
      -- an outage; neither changes what ERCOT cleared.
      v_at := least(v_clock, v_open.expires_at,
                    v_open.delivery_start - interval '1 microsecond');

      -- The price the fill would be made at: the rule execute_trade applies.
      v_price := public.instrument_entry_price(
        v_open.market_id, v_open.counter_market_id, v_open.instrument,
        v_open.product, v_open.delivery_start, v_open.delivery_end, v_at
      );

      if v_price is null then
        -- Not cleared. It waits, unless its time in the market is over.
        if v_at < v_clock then
          update public.paper_orders
          set status = 'EXPIRED', updated_at = v_wall
          where id = v_open.id;
          v_expired := v_expired + 1;
        end if;
        continue;
      end if;

      -- MARKET fills at whatever cleared. LIMIT: BUY at or below, SELL at or
      -- above; ties fill. The fill price is the clearing price itself.
      if v_open.order_type = 'MARKET'
         or (v_open.side = 'BUY' and v_price <= v_open.limit_price)
         or (v_open.side = 'SELL' and v_price >= v_open.limit_price) then

        v_result := public.execute_trade(
          v_open.user_id,
          v_open.market_id,
          v_open.counter_market_id,
          v_open.instrument,
          v_open.product,
          v_open.side,
          v_open.quantity_mwh,
          v_open.delivery_start,
          v_open.delivery_end,
          -- Per-order idempotency key: a sweep retry replays the fill
          -- instead of re-executing (execute_trade step 0c).
          'sweep-' || v_open.id::text,
          v_at
        );

        update public.paper_orders
        set status = 'FILLED',
            filled_trade_id = (v_result->>'trade_id')::uuid,
            updated_at = v_wall
        where id = v_open.id;

        v_filled := v_filled + 1;

        insert into public.audit_events (
          user_id, event_type, entity_type, entity_id, metadata
        ) values (
          v_open.user_id, 'ORDER_FILLED', 'paper_order', v_open.id,
          jsonb_build_object(
            'trade_id', v_result->>'trade_id',
            'fill_price', v_result->>'execution_price',
            'order_type', v_open.order_type,
            'limit_price', v_open.limit_price,
            'side', v_open.side,
            'quantity_mwh', v_open.quantity_mwh
          )
        );
      else
        -- The market cleared through it: this bid will never fill.
        update public.paper_orders
        set status = 'EXPIRED', updated_at = v_wall
        where id = v_open.id;
        v_expired := v_expired + 1;
      end if;
    exception when others then
      -- One bad order must not stall the book; samples go to the summary.
      v_errors := v_errors + 1;
      if v_errors <= 5 then
        v_error_samples := v_error_samples
          || jsonb_build_object('order_id', v_order.id, 'error', sqlerrm);
      end if;
      -- Past its time in the market it cannot be retried into a fill.
      update public.paper_orders
      set status = 'EXPIRED', updated_at = v_wall
      where id = v_order.id and status = 'OPEN'
        and least(expires_at, delivery_start) <= v_clock;
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

revoke execute on function public.fill_crossing_limit_orders(integer, uuid) from public, anon, authenticated;
grant execute on function public.fill_crossing_limit_orders(integer, uuid) to service_role;
