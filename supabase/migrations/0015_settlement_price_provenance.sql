-- =====================================================================
-- 0015 — Settlement price provenance: reset the resolution per position
--
-- 0014's sweep resolved each settlement's provenance with a single local
-- variable:
--
--   if v_instr.legs = 1 and v_instr.settlement_rule <> 'AVERAGE' then
--     v_leg_price_id := public.price_row_id(...);
--   end if;
--
-- There was no else branch, so the variable kept the *previous* iteration's
-- value. The first position in a sweep that produced a price row id handed it
-- to every composed instrument after it, and the SETTLED trade for a spread
-- was written with a `market_price_id` pointing at one leg's single-interval
-- price — provenance that is simply wrong. It is invisible until a spread
-- happens to settle in the same sweep as a point position, which is why it
-- survived 0013 and 0014.
--
-- The fix is local: resolve provenance in both branches. Nothing else in the
-- sweep changes, so the money movement is unaffected.
--
-- Privileges are preserved by `create or replace`; the function is re-created
-- rather than altered because a plpgsql body cannot be patched in place.
-- =====================================================================

create or replace function public.settle_delivered_positions(
  p_as_of timestamptz default now(),
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
  -- Service-role job: it acts across every user's book. See header.
  if current_user <> 'service_role' then
    raise exception 'FORBIDDEN: settle_delivered_positions is a service_role job';
  end if;
  if p_as_of is null then
    raise exception 'AS_OF_REQUIRED';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'LIMIT_INVALID';
  end if;

  for v_pos in
    select *
    from public.positions pos
    where pos.settled_at is null
      and pos.quantity_mwh <> 0
      and pos.delivery_end <= p_as_of
      and (p_user_id is null or pos.user_id = p_user_id)
    order by pos.delivery_end, pos.id
    limit p_limit
    for update skip locked
  loop
    v_considered := v_considered + 1;

    -- A position settled earlier in this same sweep (as collateral for another
    -- position's obligation) must not be settled twice.
    if (select pos.settled_at is not null
        from public.positions pos where pos.id = v_pos.id) then
      continue;
    end if;

    -- The settlement price: the instrument's own price for its own window,
    -- resolved only against prices that exist for the intervals it settles.
    v_price := public.instrument_price(
      v_pos.market_id, v_pos.counter_market_id, v_pos.instrument,
      v_pos.product, v_pos.delivery_start, v_pos.delivery_end
    );

    if v_price is null then
      -- Due but unpriced. Leave it open and report it; a guess here would be
      -- a stale-price settlement.
      v_deferred := v_deferred + 1;
      if array_length(v_deferred_ids, 1) is null
         or array_length(v_deferred_ids, 1) < 50 then
        v_deferred_ids := v_deferred_ids || v_pos.id;
      end if;
      continue;
    end if;

    -- Per position, so one bad row cannot abort the whole sweep. The
    -- subtransaction also means a failure undoes that row's cash movement.
    begin
      select * into v_instr
      from public.instruments where code = v_pos.instrument;

      select * into v_prod
      from public.products where code = v_pos.product;
      if not found then
        raise exception 'PRODUCT_MISSING: %', v_pos.product;
      end if;

      -- One signed expression covers both directions.
      v_notional := v_price * v_pos.quantity_mwh;
      v_realized := (v_price - v_pos.average_entry_price) * v_pos.quantity_mwh;
      v_side := case when v_pos.quantity_mwh > 0 then 'SELL' else 'BUY' end;

      select cash_balance into v_cash_before
      from public.paper_accounts where user_id = v_pos.user_id;
      if v_cash_before is null then
        raise exception 'ACCOUNT_NOT_FOUND: %', v_pos.user_id;
      end if;

      -- ---- Funding the obligation -------------------------------------
      -- A long's settlement is a receipt; only a short's is a payment. When
      -- the payment is larger than the cash on hand, the account is on a
      -- margin call, and since this platform has no deposit path the clearing
      -- behaviour is the one a desk applies to an unmet call: realise
      -- collateral. A call is recorded once per account per sweep, not once
      -- per position.
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
              'as_of', to_char(p_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
          );
          v_called := v_called || v_pos.user_id;
        end if;

        v_liq := public.liquidate_to_fund(
          v_pos.user_id, v_required - v_cash_before, p_as_of, v_pos.id
        );
        v_funded := v_funded + 1;
        v_raised := v_raised + coalesce((v_liq ->> 'raised')::numeric, 0);
        v_liq_count := coalesce((v_liq ->> 'liquidated')::int, 0);
        v_liquidated := v_liquidated + v_liq_count;

        select cash_balance into v_cash_before
        from public.paper_accounts where user_id = v_pos.user_id;

        if v_cash_before < v_required then
          -- Insolvent: liquidating every long still could not cover it. The
          -- gap is a real gap — the move beat the equity posted against it.
          v_shortfall := v_required - v_cash_before;
          v_deficits := v_deficits + 1;
        end if;
      end if;

      -- A receipt is applied against an outstanding deficit first: what the
      -- clearing house is owed is taken before the member can spend again.
      v_repay := 0;
      if v_notional > 0 then
        select coalesce(least(v_notional, acct.deficit), 0) into v_repay
        from public.paper_accounts acct where acct.user_id = v_pos.user_id;
        v_repay := coalesce(v_repay, 0);
      end if;

      update public.paper_accounts
         set cash_balance = cash_balance + v_notional - v_repay + v_shortfall,
             deficit      = deficit - v_repay + v_shortfall,
             updated_at   = p_as_of
       where user_id = v_pos.user_id;
      if not found then
        raise exception 'ACCOUNT_NOT_FOUND: %', v_pos.user_id;
      end if;

      -- Provenance for a single-interval leg; a composed instrument or a
      -- window average has no single price row behind it.
      if v_instr.legs = 1 and v_instr.settlement_rule <> 'AVERAGE' then
        v_leg_price_id := public.price_row_id(
          v_pos.market_id,
          case when v_instr.settlement_rule = 'CONVERGENCE'
               then 'DAM_HOURLY' else v_pos.product end,
          v_pos.delivery_start
        );
      else
        -- Reset per position: a composed instrument has no single price row,
        -- and a stale id from the previous iteration would attribute this
        -- settlement to an unrelated interval's price.
        v_leg_price_id := null;
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
        'SETTLED', p_as_of, p_as_of
      )
      returning id into v_trade_id;

      -- Close to flat and record the settlement. `average_entry_price` is left
      -- alone, exactly as a user close to flat leaves it.
      update public.positions
         set quantity_mwh         = 0,
             realized_pnl         = realized_pnl + v_realized,
             settled_at           = p_as_of,
             settlement_trade_id  = v_trade_id,
             updated_at           = p_as_of
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
          'settled_at', to_char(p_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
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
            'as_of', to_char(p_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
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
            'as_of', to_char(p_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
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

  -- Whatever was due and left open, whether unpriced or over the limit. A
  -- non-zero value after a run that settled nothing is the signal that the
  -- feed is behind.
  select count(*) into v_remaining
  from public.positions pos
  where pos.settled_at is null
    and pos.quantity_mwh <> 0
    and pos.delivery_end <= p_as_of
    and (p_user_id is null or pos.user_id = p_user_id);

  return jsonb_build_object(
    'as_of', p_as_of,
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

