-- =====================================================================
-- 0022 — Marks, settlement, margin and leaderboard on the as-of engine
--
-- The read and settlement sides move onto the same clock the fill side
-- got in 0021:
--
--   marks        each open position is valued at its instrument price
--                AS OF ITS OWNER'S SIMULATION TIME. Two accounts with
--                different clocks see two different marks of the same
--                position — which is the point: each sees the market
--                its clock says exists.
--   settlement   the sweep prices a delivered position from FINAL
--                observations only (price_final): the ERCOT settlement
--                value for the interval, not an interim observation.
--                "Due" is also clock-aware — delivery_end must have
--                passed ON THE ACCOUNT'S CLOCK, so replayed accounts
--                do not settle intervals their clock has not reached.
--   margin       account_margin evaluates requirements as of the
--                account's clock, so a replayed account can genuinely
--                hit a margin call as its market moves.
--
-- Unchanged from 0014/0015: funding via liquidate_to_fund, deficits,
-- provenance resets, SKIP LOCKED idempotency, subtransaction failure
-- isolation. Only the price resolution and the due test change.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The settlement price: final observations, per rule
-- ---------------------------------------------------------------------
-- instrument_price answers "what did the desk know at T". Settlement
-- answers a different question — "what did ERCOT ultimately settle?" —
-- so it reads price_final per leg. Same five rules, same optionality
-- floor, different lookup.
create or replace function public.instrument_settlement_price(
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
  v_a numeric; v_b numeric;
  v_rt numeric;
  v_price numeric;
  -- Window-coverage locals for the AVERAGE rule.
  v_interval_min int;
  v_expected int;
  v_rows int;
begin
  select i.settlement_rule, i.option_type
    into v_rule, v_option
  from public.instruments i
  where i.code = p_instrument;
  if v_rule is null then
    return null;
  end if;

  if v_rule = 'POINT' then
    v_price := public.price_final(p_market_id, p_product, p_from);

  elsif v_rule = 'AVERAGE' then
    -- Final value of the window: mean of each interval's final observation.
    -- Coverage is counted in intervals, not rows (a revision is another row
    -- on the same interval), and an incomplete window is not a price — the
    -- sweep defers the position until the day closes and every interval has
    -- its final ERCOT value.
    select p.interval_minutes into v_interval_min
    from public.products p
    where p.code = p_product;
    if v_interval_min is null or v_interval_min <= 0 then
      return null;
    end if;
    v_expected :=
      (extract(epoch from (p_to - p_from)) / 60 / v_interval_min)::int;
    if v_expected <= 0 then
      return null;
    end if;

    select count(*), avg(f.price)
      into v_rows, v_price
    from (
      select distinct on (mp.delivery_timestamp) mp.price
      from public.market_prices mp
      where mp.market_id = p_market_id
        and mp.product = p_product
        and mp.delivery_timestamp >= p_from
        and mp.delivery_timestamp < p_to
        and mp.is_final
      order by mp.delivery_timestamp, mp.published_at desc
    ) f;
    if v_rows <> v_expected then
      return null;
    end if;

  elsif v_rule = 'DIFFERENCE' then
    if p_counter_market_id is null then
      return null;
    end if;
    v_a := public.price_final(p_market_id, p_product, p_from);
    v_b := public.price_final(p_counter_market_id, p_product, p_from);
    if v_a is null or v_b is null then
      return null;
    end if;
    v_price := v_b - v_a;

  elsif v_rule = 'CONVERGENCE' then
    -- Settlement is the FINAL real-time leg. The position was entered at
    -- its day-ahead leg (instrument_entry_price), so realized P&L =
    -- RT_final − DA_entry: the DA→RT convergence, realized once — not
    -- recomputed against both legs of an already-known spread.
    v_rt := public.price_final(p_market_id, 'RTM_HOURLY', p_from);
    if v_rt is null then
      return null;
    end if;
    v_price := v_rt;

  elsif v_rule = 'CONGESTION_CONVERGENCE' then
    -- Day-ahead PTP: bought at the day-ahead spread, settled at the final
    -- real-time spread across the path.
    if p_counter_market_id is null then
      return null;
    end if;
    v_a := public.price_final(p_market_id, 'RTM_HOURLY', p_from);
    v_b := public.price_final(p_counter_market_id, 'RTM_HOURLY', p_from);
    if v_a is null or v_b is null then
      return null;
    end if;
    v_price := v_b - v_a;
  else
    return null;
  end if;

  if v_price is null then
    return null;
  end if;
  if v_option = 'OPTION' and v_price < 0 then
    return 0;
  end if;
  return v_price;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. position_marks: per-owner clock
-- ---------------------------------------------------------------------
create or replace function public.position_marks(p_user_id uuid)
returns table (position_id uuid, mark_price numeric, mark_timestamp timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_as_of timestamptz;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  -- The owner's clock, resolved once. Marks are as of it, so a
  -- replayed account's marks move as its clock moves.
  v_as_of := public.sim_now(p_user_id);

  return query
  select pos.id,
         public.instrument_price(
           pos.market_id, pos.counter_market_id, pos.instrument,
           pos.product, pos.delivery_start, pos.delivery_end, v_as_of
         ),
         public.price_as_of(
           pos.market_id,
           case when pos.instrument in ('VIRTUAL', 'DART_SPREAD')
                then 'DAM_HOURLY' else pos.product end,
           pos.delivery_start,
           v_as_of
         )
  from public.positions pos
  where pos.user_id = p_user_id
    and pos.quantity_mwh <> 0;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. liquidate_to_fund: sales priced at the account's market state
-- ---------------------------------------------------------------------
-- Body from 0015 with the two instrument_price calls made as-of the
-- sweep instant it is already passed. The caller (the sweep) passes
-- the account's simulation time, so liquidation never sees a future
-- observation and never sells at a price the desk could not have seen.
create or replace function public.liquidate_to_fund(
  p_user_id uuid,
  p_need numeric,
  p_as_of timestamptz,
  p_exclude_position_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pos          public.positions%rowtype;
  v_instr        public.instruments%rowtype;
  v_prod         public.products%rowtype;
  v_price        numeric;
  v_cash         numeric;
  v_realized     numeric;
  v_cash_delta   numeric;
  v_delivered    boolean;
  v_status       text;
  v_trade_id     uuid;
  v_market_price uuid;
  v_loss         numeric := 0;
  v_raised       numeric := 0;
  v_count        int := 0;
  v_closed       jsonb := '[]'::jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'FORBIDDEN: liquidate_to_fund is a service_role job';
  end if;
  if p_need is null or p_need <= 0 then
    return jsonb_build_object(
      'liquidated', 0, 'raised', 0, 'covered', true, 'closed', v_closed
    );
  end if;

  select cash_balance into v_cash
  from public.paper_accounts where user_id = p_user_id;
  if v_cash is null then
    raise exception 'ACCOUNT_NOT_FOUND: %', p_user_id;
  end if;

  for v_pos in
    select pos.*
    from public.positions pos
    where pos.user_id = p_user_id
      and pos.quantity_mwh > 0
      and pos.settled_at is null
      and (p_exclude_position_id is null or pos.id <> p_exclude_position_id)
    order by
      abs(pos.quantity_mwh) * coalesce(
        public.instrument_price(
          pos.market_id, pos.counter_market_id, pos.instrument,
          pos.product, pos.delivery_start, pos.delivery_end, p_as_of
        ), 0
      ) desc,
      pos.delivery_end,
      pos.id
    for update skip locked
  loop
    exit when v_cash >= p_need;

    v_price := public.instrument_price(
      v_pos.market_id, v_pos.counter_market_id, v_pos.instrument,
      v_pos.product, v_pos.delivery_start, v_pos.delivery_end, p_as_of
    );
    if v_price is null then
      continue;
    end if;

    select * into v_instr from public.instruments where code = v_pos.instrument;
    select * into v_prod from public.products where code = v_pos.product;
    if not found then
      raise exception 'PRODUCT_MISSING: %', v_pos.product;
    end if;

    -- Delivered on the account's clock — the caller passed it.
    v_delivered := v_pos.delivery_end <= p_as_of;
    v_status := case when v_delivered then 'SETTLED' else 'LIQUIDATED' end;
    v_realized := (v_price - v_pos.average_entry_price) * v_pos.quantity_mwh;
    v_cash_delta := v_price * v_pos.quantity_mwh;

    update public.paper_accounts
       set cash_balance = cash_balance + v_cash_delta,
           updated_at   = p_as_of
     where user_id = p_user_id
     returning cash_balance into v_cash;

    v_market_price := null;
    if v_instr.legs = 1 and v_instr.settlement_rule <> 'AVERAGE' then
      v_market_price := public.price_row_id(
        v_pos.market_id,
        case when v_instr.settlement_rule = 'CONVERGENCE'
             then 'DAM_HOURLY' else v_pos.product end,
        v_pos.delivery_start,
        p_as_of
      );
    end if;

    insert into public.trades (
      user_id, market_id, product, venue, instrument, counter_market_id, side,
      quantity_mwh, delivery_start, delivery_end,
      execution_price, price_timestamp, market_price_id,
      status, created_at, executed_at
    ) values (
      p_user_id, v_pos.market_id, v_pos.product, v_prod.venue, v_instr.code,
      v_pos.counter_market_id, 'SELL',
      abs(v_pos.quantity_mwh), v_pos.delivery_start, v_pos.delivery_end,
      v_price, v_pos.delivery_start, v_market_price,
      v_status, p_as_of, p_as_of
    )
    returning id into v_trade_id;

    update public.positions
       set quantity_mwh          = 0,
           realized_pnl          = realized_pnl + v_realized,
           settled_at            = case when v_delivered then p_as_of end,
           settlement_trade_id   = case when v_delivered then v_trade_id end,
           updated_at            = p_as_of
     where id = v_pos.id;

    if v_realized < 0 then
      v_loss := v_loss + v_realized;
    end if;

    insert into public.audit_events (
      user_id, event_type, entity_type, entity_id, metadata
    ) values (
      p_user_id, 'FORCED_LIQUIDATION', 'position', v_pos.id,
      jsonb_build_object(
        'reason', 'FUND_SETTLEMENT',
        'trade_id', v_trade_id,
        'trade_status', v_status,
        'instrument', v_instr.code,
        'product', v_pos.product,
        'venue', v_prod.venue,
        'market_id', v_pos.market_id,
        'counter_market_id', v_pos.counter_market_id,
        'quantity_mwh', v_pos.quantity_mwh,
        'exit_price', v_price,
        'average_entry_price', v_pos.average_entry_price,
        'realized_delta', v_realized,
        'cash_delta', v_cash_delta,
        'cash_balance', v_cash,
        'delivered', v_delivered,
        'as_of', to_char(p_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )
    );

    v_count := v_count + 1;
    v_raised := v_raised + v_cash_delta;
    v_closed := v_closed || jsonb_build_object(
      'position_id', v_pos.id,
      'trade_id', v_trade_id,
      'status', v_status,
      'instrument', v_instr.code,
      'quantity_mwh', v_pos.quantity_mwh,
      'price', v_price,
      'cash_delta', v_cash_delta
    );
  end loop;

  return jsonb_build_object(
    'liquidated', v_count,
    'raised', v_raised,
    'cash_after', v_cash,
    'need', p_need,
    'covered', v_cash >= p_need,
    'realized_loss', v_loss,
    'closed', v_closed
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 4. The sweep: due on the clock, priced from finals
-- ---------------------------------------------------------------------
create or replace function public.settle_delivered_positions(
  p_as_of timestamptz default null,
  p_limit int default 500,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pos          public.positions%rowtype;
  v_instr        public.instruments%rowtype;
  v_prod         public.products%rowtype;
  v_price        numeric;
  v_realized     numeric;
  v_notional     numeric;
  v_cash_before  numeric;
  v_cash_after   numeric;
  v_required     numeric;
  v_shortfall    numeric;
  v_repay        numeric;
  v_liq          jsonb;
  v_liq_count    int;
  v_side         text;
  v_trade_id     uuid;
  v_leg_price_id uuid;
  v_due          timestamptz;
  v_considered   int := 0;
  v_settled      int := 0;
  v_deferred     int := 0;
  v_failed       int := 0;
  v_funded       int := 0;
  v_liquidated   int := 0;
  v_deficits     int := 0;
  v_raised       numeric := 0;
  v_remaining    int := 0;
  v_deferred_ids uuid[] := '{}';
  v_called       uuid[] := '{}';
  v_errors       jsonb := '[]'::jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'FORBIDDEN: settle_delivered_positions is a service_role job';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'LIMIT_INVALID';
  end if;

  for v_pos in
    select *
    from public.positions pos
    where pos.settled_at is null
      and pos.quantity_mwh <> 0
      -- Due on the reader's clock: an explicit p_as_of (tests) pins it,
      -- otherwise each account's own simulation time decides.
      and pos.delivery_end <= coalesce(p_as_of, public.sim_now(pos.user_id))
      and (p_user_id is null or pos.user_id = p_user_id)
    order by pos.delivery_end, pos.id
    limit p_limit
    for update skip locked
  loop
    v_considered := v_considered + 1;

    -- The clock this position settles against.
    v_due := coalesce(p_as_of, public.sim_now(v_pos.user_id));

    -- A position settled earlier in this same sweep must not settle twice.
    if (select pos.settled_at is not null
        from public.positions pos where pos.id = v_pos.id) then
      continue;
    end if;

    -- The settlement price: FINAL observations of the intervals the
    -- instrument settles. An interim observation is not a settlement
    -- value; a missing final leaves the position open and reported.
    v_price := public.instrument_settlement_price(
      v_pos.market_id, v_pos.counter_market_id, v_pos.instrument,
      v_pos.product, v_pos.delivery_start, v_pos.delivery_end
    );

    if v_price is null then
      v_deferred := v_deferred + 1;
      if array_length(v_deferred_ids, 1) is null
         or array_length(v_deferred_ids, 1) < 50 then
        v_deferred_ids := v_deferred_ids || v_pos.id;
      end if;
      continue;
    end if;

    begin
      select * into v_instr
      from public.instruments where code = v_pos.instrument;

      select * into v_prod
      from public.products where code = v_pos.product;
      if not found then
        raise exception 'PRODUCT_MISSING: %', v_pos.product;
      end if;

      v_notional := v_price * v_pos.quantity_mwh;
      v_realized := (v_price - v_pos.average_entry_price) * v_pos.quantity_mwh;
      v_side := case when v_pos.quantity_mwh > 0 then 'SELL' else 'BUY' end;

      select cash_balance into v_cash_before
      from public.paper_accounts where user_id = v_pos.user_id;
      if v_cash_before is null then
        raise exception 'ACCOUNT_NOT_FOUND: %', v_pos.user_id;
      end if;

      -- ---- Funding the obligation (unchanged from 0014/0015) --------
      v_required  := greatest(0, -v_notional);
      v_shortfall := 0;
      v_liq_count := 0;

      if v_required > v_cash_before then
        if not (v_pos.user_id = any(v_called)) then
          insert into public.audit_events (
            user_id, event_type, entity_type, entity_id, metadata
          ) values (
            v_pos.user_id, 'MARGIN_CALL', 'paper_account', null,
            jsonb_build_object(
              'reason', 'SETTLEMENT_UNCASHED',
              'required_cash', v_required,
              'cash_balance', v_cash_before,
              'position_id', v_pos.id,
              'as_of', to_char(v_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
          );
          v_called := v_called || v_pos.user_id;
        end if;

        v_liq := public.liquidate_to_fund(
          v_pos.user_id, v_required - v_cash_before, v_due, v_pos.id
        );
        v_funded := v_funded + 1;
        v_raised := v_raised + coalesce((v_liq ->> 'raised')::numeric, 0);
        v_liq_count := coalesce((v_liq ->> 'liquidated')::int, 0);
        v_liquidated := v_liquidated + v_liq_count;

        select cash_balance into v_cash_before
        from public.paper_accounts where user_id = v_pos.user_id;

        if v_cash_before < v_required then
          v_shortfall := v_required - v_cash_before;
          v_deficits := v_deficits + 1;
        end if;
      end if;

      -- A receipt is applied against an outstanding deficit first.
      v_repay := 0;
      if v_notional > 0 then
        select coalesce(least(v_notional, acct.deficit), 0) into v_repay
        from public.paper_accounts acct where acct.user_id = v_pos.user_id;
        v_repay := coalesce(v_repay, 0);
      end if;

      update public.paper_accounts
         set cash_balance = cash_balance + v_notional - v_repay + v_shortfall,
             deficit      = deficit - v_repay + v_shortfall,
             updated_at   = v_due
       where user_id = v_pos.user_id;
      if not found then
        raise exception 'ACCOUNT_NOT_FOUND: %', v_pos.user_id;
      end if;

      -- Provenance: the FINAL observation behind a single-interval leg.
      v_leg_price_id := null;
      if v_instr.legs = 1 and v_instr.settlement_rule <> 'AVERAGE' then
        select mp.id into v_leg_price_id
        from public.market_prices mp
        where mp.market_id = v_pos.market_id
          and mp.product = case when v_instr.settlement_rule = 'CONVERGENCE'
                                then 'DAM_HOURLY' else v_pos.product end
          and mp.delivery_timestamp = v_pos.delivery_start
          and mp.is_final
        order by
          case when mp.source like '%GENERATED%' then 1 else 0 end,
          mp.published_at desc
        limit 1;
      end if;

      insert into public.trades (
        user_id, market_id, product, venue, instrument, counter_market_id, side,
        quantity_mwh, delivery_start, delivery_end,
        execution_price, price_timestamp, market_price_id,
        status, created_at, executed_at
      ) values (
        v_pos.user_id, v_pos.market_id, v_pos.product, v_prod.venue,
        v_instr.code, v_pos.counter_market_id, v_side,
        abs(v_pos.quantity_mwh), v_pos.delivery_start, v_pos.delivery_end,
        v_price, v_pos.delivery_start, v_leg_price_id,
        'SETTLED', v_due, v_due
      )
      returning id into v_trade_id;

      update public.positions
         set quantity_mwh         = 0,
             realized_pnl         = realized_pnl + v_realized,
             settled_at           = v_due,
             settlement_trade_id  = v_trade_id,
             updated_at           = v_due
       where id = v_pos.id;

      select cash_balance into v_cash_after
      from public.paper_accounts where user_id = v_pos.user_id;

      insert into public.audit_events (
        user_id, event_type, entity_type, entity_id, metadata
      ) values (
        v_pos.user_id, 'POSITION_SETTLED', 'position', v_pos.id,
        jsonb_build_object(
          'trade_id', v_trade_id,
          'instrument', v_instr.code,
          'settlement_rule', v_instr.settlement_rule,
          'option_type', v_instr.option_type,
          'product', v_pos.product,
          'venue', v_prod.venue,
          'market_id', v_pos.market_id,
          'counter_market_id', v_pos.counter_market_id,
          'settlement_side', v_side,
          'quantity_mwh', v_pos.quantity_mwh,
          'settlement_price', v_price,
          'average_entry_price', v_pos.average_entry_price,
          'realized_delta', v_realized,
          'cash_delta', v_notional,
          'cash_balance', v_cash_after,
          'cash_required', v_required,
          'funded_by_liquidation', v_liq_count > 0,
          'liquidated_positions', v_liq_count,
          'shortfall', v_shortfall,
          'deficit_repaid', v_repay,
          'delivery_start', to_char(v_pos.delivery_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'delivery_end', to_char(v_pos.delivery_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'settled_at', to_char(v_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
      );

      if v_shortfall > 0 then
        insert into public.audit_events (
          user_id, event_type, entity_type, entity_id, metadata
        ) values (
          v_pos.user_id, 'ACCOUNT_DEFICIT', 'position', v_pos.id,
          jsonb_build_object(
            'reason', 'SETTLEMENT_UNPAID',
            'position_id', v_pos.id,
            'trade_id', v_trade_id,
            'required_cash', v_required,
            'shortfall', v_shortfall,
            'cash_balance', v_cash_after,
            'deficit_after', v_shortfall,
            'as_of', to_char(v_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          )
        );
      end if;

      if v_repay > 0 then
        insert into public.audit_events (
          user_id, event_type, entity_type, entity_id, metadata
        ) values (
          v_pos.user_id, 'DEFICIT_REPAID', 'position', v_pos.id,
          jsonb_build_object(
            'position_id', v_pos.id,
            'trade_id', v_trade_id,
            'repaid', v_repay,
            'cash_balance', v_cash_after,
            'as_of', to_char(v_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          )
        );
      end if;

      v_settled := v_settled + 1;
    exception when others then
      v_failed := v_failed + 1;
      v_errors := v_errors || jsonb_build_object(
        'position_id', v_pos.id,
        'error', SQLERRM
      );
    end;
  end loop;

  select count(*) into v_remaining
  from public.positions pos
  where pos.settled_at is null
    and pos.quantity_mwh <> 0
    and pos.delivery_end <= coalesce(p_as_of, public.sim_now(pos.user_id))
    and (p_user_id is null or pos.user_id = p_user_id);

  return jsonb_build_object(
    'as_of', coalesce(p_as_of, v_due),
    'user_id', p_user_id,
    'considered', v_considered,
    'settled', v_settled,
    'deferred', v_deferred,
    'failed', v_failed,
    'funded', v_funded,
    'liquidated', v_liquidated,
    'raised', v_raised,
    'deficits', v_deficits,
    'settlement_due_remaining', v_remaining,
    'deferred_position_ids', to_jsonb(v_deferred_ids),
    'errors', v_errors
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 5. account_margin: requirements as of the account's clock
-- ---------------------------------------------------------------------
create or replace function public.account_margin(p_user_id uuid)
returns table (
  cash_balance        numeric,
  marked_value        numeric,
  deficit             numeric,
  equity              numeric,
  used_margin         numeric,
  maintenance_margin  numeric,
  available_margin    numeric,
  margin_ratio        numeric,
  unpriced_positions  bigint,
  tier                text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_as_of timestamptz;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  if not exists (select 1 from public.paper_accounts ac where ac.user_id = p_user_id) then
    raise exception 'ACCOUNT_NOT_FOUND: %', p_user_id;
  end if;

  -- Requirements are evaluated at the owner's market state.
  v_as_of := public.sim_now(p_user_id);

  return query
  with acct as (
    select ac.user_id,
           ac.cash_balance,
           ac.deficit,
           ac.initial_margin_rate,
           ac.maintenance_margin_rate
    from public.paper_accounts ac
    where ac.user_id = p_user_id
  )
  select
    a.cash_balance,
    coalesce(agg.marked_value, 0),
    a.deficit,
    a.cash_balance + coalesce(agg.marked_value, 0) - a.deficit,
    coalesce(agg.used_margin, 0),
    coalesce(agg.maintenance_margin, 0),
    a.cash_balance + coalesce(agg.marked_value, 0) - a.deficit
      - coalesce(agg.used_margin, 0),
    case when coalesce(agg.used_margin, 0) > 0
         then (a.cash_balance + coalesce(agg.marked_value, 0) - a.deficit)
              / agg.used_margin
    end,
    coalesce(agg.unpriced, 0),
    case
      when a.deficit > 0
        or a.cash_balance + coalesce(agg.marked_value, 0) - a.deficit <= 0
        then 'DEFICIT'
      when a.cash_balance + coalesce(agg.marked_value, 0) - a.deficit
           < coalesce(agg.maintenance_margin, 0)
        then 'CALL'
      when a.cash_balance + coalesce(agg.marked_value, 0) - a.deficit
           < coalesce(agg.used_margin, 0)
        then 'WARNING'
      else 'OK'
    end
  from acct a
  left join lateral (
    select
      sum(p.quantity_mwh * m.mark) filter (where m.mark is not null) as marked_value,
      sum(abs(p.quantity_mwh) * m.mark * a.initial_margin_rate)
        filter (where m.mark is not null) as used_margin,
      sum(abs(p.quantity_mwh) * m.mark * a.maintenance_margin_rate)
        filter (where m.mark is not null) as maintenance_margin,
      count(*) filter (where m.mark is null) as unpriced
    from public.positions p
    cross join lateral (
      select public.instrument_price(
               p.market_id, p.counter_market_id, p.instrument,
               p.product, p.delivery_start, p.delivery_end, v_as_of
             ) as mark
    ) m
    where p.user_id = a.user_id
      and p.quantity_mwh <> 0
  ) agg on true;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Leaderboard: each account ranked in its own market state
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
               pos.product, pos.delivery_start, pos.delivery_end,
               public.sim_now(pos.user_id)
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
    ac.cash_balance + coalesce(mk.marked_value, 0) - ac.deficit,
    case when ac.starting_cash > 0 then
      ((ac.cash_balance + coalesce(mk.marked_value, 0) - ac.deficit
        - ac.starting_cash) / ac.starting_cash) * 10000
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

-- ---------------------------------------------------------------------
-- 7. ACLs — new signatures re-granted, anon revoked everywhere
-- ---------------------------------------------------------------------
revoke execute on function public.price_at(uuid, text, timestamptz, timestamptz) from public;
revoke execute on function public.price_final(uuid, text, timestamptz) from public;
revoke execute on function public.price_row_id(uuid, text, timestamptz, timestamptz) from public;
revoke execute on function public.price_as_of(uuid, text, timestamptz, timestamptz) from public;
revoke execute on function public.price_is_stale(uuid, text, timestamptz, timestamptz) from public;
revoke execute on function public.price_average(uuid, text, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.instrument_settlement_price(uuid, uuid, text, text, timestamptz, timestamptz) from public;
revoke execute on function public.position_marks(uuid) from public;

grant execute on function public.price_at(uuid, text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.price_final(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_row_id(uuid, text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.price_as_of(uuid, text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.price_is_stale(uuid, text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.price_average(uuid, text, timestamptz, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.instrument_settlement_price(uuid, uuid, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.position_marks(uuid) to authenticated, service_role;

revoke execute on function public.settle_delivered_positions(timestamptz, int, uuid) from public;
revoke execute on function public.settle_delivered_positions(timestamptz, int, uuid) from anon;
revoke execute on function public.settle_delivered_positions(timestamptz, int, uuid) from authenticated;
grant execute on function public.settle_delivered_positions(timestamptz, int, uuid) to service_role;

revoke execute on function public.liquidate_to_fund(uuid, numeric, timestamptz, uuid) from public;
revoke execute on function public.liquidate_to_fund(uuid, numeric, timestamptz, uuid) from anon;
revoke execute on function public.liquidate_to_fund(uuid, numeric, timestamptz, uuid) from authenticated;
grant execute on function public.liquidate_to_fund(uuid, numeric, timestamptz, uuid) to service_role;

revoke execute on function public.account_margin(uuid) from public;
revoke execute on function public.account_margin(uuid) from anon;
grant execute on function public.account_margin(uuid) to authenticated, service_role;

revoke execute on function public.get_leaderboard(int) from public;
revoke execute on function public.get_leaderboard(int) from anon;
revoke execute on function public.get_leaderboard(int) from authenticated;
grant execute on function public.get_leaderboard(int) to service_role;
