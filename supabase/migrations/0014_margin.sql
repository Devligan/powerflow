-- =====================================================================
-- 0014 — Margin: a settlement obligation has to be paid for
--
-- 0013 cashed out delivered positions but assumed the cash was there. It
-- isn't always. A short position's settlement is an *outflow* of
-- `settlement_price × |qty|`, and nothing in the platform bounds that
-- outflow by the account's cash. So:
--
--   account cash                       100
--   short 20 MWh, settles at 200        owes 4,000
--
--   settle_delivered_positions() →
--     {"failed": 1, "errors": [violates check constraint
--                              "cash_balance_nonneg"]}
--
-- 0001's `cash_balance <= 0` check cornered the sweep into this: the money
-- movement is rejected, the subtransaction rolls back, and the position stays
-- open with the whole loss unrealised. It is re-attempted every sweep and
-- fails every sweep (`settlement_due_remaining` never reaches zero), and it
-- keeps occupying the exposure limit forever. `deferred` is honest about a
-- position waiting for a price; `failed` about a position that can never
-- settle is not a state the platform should be able to reach.
--
-- What a real trading shop does — this is modelled on exchange margin
-- mechanics rather than invented:
--
--   1. Initial margin is posted to open a position; a maintenance level is
--      the floor the account's equity must stay above.
--   2. Equity below maintenance is a margin call: the account must be restored
--      to the initial level, by paying in or by reducing positions.
--   3. A call that is not met is force-liquidated. Margin desks do not ask
--      first — "the broker has the right to liquidate positions without
--      notice" — and they work largest risk exposure first.
--   4. The engine exists to keep the account out of deficit, but a gap
--      (a move bigger than the equity posted against it) can beat it. The
--      residual is then a *debt the member owes*, not something the engine
--      can make disappear.
--
-- So the settlement leg is where this platform has to behave: an obligation
-- that is due is either paid from cash, or paid by realising collateral at its
-- own price, or — only when the account is genuinely insolvent — booked as an
-- explicit deficit.
--
-- Two consequences that are deliberate:
--
--   * `paper_accounts.cash_balance` stays non-negative. 0001's check is kept.
--     What the account could not pay is recorded as `deficit`, a liability, so
--     equity = cash + marked value - deficit. Negative cash and a deficit
--     describe the same insolvency; a liability column is the one that keeps
--     the check meaningful for every *other* writer.
--   * The deficit is worked off, not forgiven: a settlement *receipt* is
--     applied to the outstanding deficit before the account can keep the
--     cash.
--
-- Scope note, deliberately explicit. Three things a real desk does that this
-- does not:
--
--   (a) Initial margin at entry. The existing `max_gross_notional` check in
--       `execute_trade` remains the entry-side control.
--   (b) Daily variation margin, so it can act *before* delivery. For this
--       instrument set the gap is small — delivery windows are hours away, so
--       the settlement leg is effectively the continuous monitor — but the two
--       are not equivalent for a position held across many intervals.
--   (c) Suspending a member in deficit until they pay. Deliberately left out,
--       because this platform has no deposit path: by the time a deficit exists
--       every realisable long has already been sold to meet the call, so a
--       suspension would freeze the account permanently rather than until
--       payment. `account_margin` reports the tier and the deficit is a visible
--       liability; adding the suspension back is a trigger on `trades`
--       (`status = 'EXECUTED'`), but it needs a funding path alongside it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Margin configuration and the deficit liability
-- ---------------------------------------------------------------------
alter table public.paper_accounts
  add column if not exists initial_margin_rate numeric not null default 0.12,
  add column if not exists maintenance_margin_rate numeric not null default 0.10,
  add column if not exists deficit numeric not null default 0;

comment on column public.paper_accounts.initial_margin_rate is
  'Initial margin, as a fraction of marked position value. The level a margin '
  'call must be restored to.';
comment on column public.paper_accounts.maintenance_margin_rate is
  'Maintenance margin, as a fraction of marked position value. Equity below '
  'this is a margin call. Must not exceed the initial rate.';
comment on column public.paper_accounts.deficit is
  'Settlement cash the account was unable to pay, owed to the clearing house. '
  'A liability: equity = cash_balance + marked value - deficit. Non-zero only '
  'when the account was insolvent at settlement, i.e. liquidating every long '
  'still could not cover the obligation.';

alter table public.paper_accounts drop constraint if exists paper_account_margin_rates;
alter table public.paper_accounts
  add constraint paper_account_margin_rates check (
    initial_margin_rate > 0
    and initial_margin_rate <= 1
    and maintenance_margin_rate > 0
    and maintenance_margin_rate <= initial_margin_rate
  );

alter table public.paper_accounts drop constraint if exists paper_account_deficit_nonneg;
alter table public.paper_accounts
  add constraint paper_account_deficit_nonneg check (deficit >= 0);

-- ---------------------------------------------------------------------
-- 2. Vocabulary: a liquidation is its own trade, and margin has its own
--    audit trail.
-- ---------------------------------------------------------------------
alter table public.trades drop constraint if exists trade_status_valid;
alter table public.trades
  add constraint trade_status_valid
  check (status in ('EXECUTED', 'REJECTED', 'SETTLED', 'LIQUIDATED'));

alter table public.audit_events drop constraint if exists audit_event_type_valid;
alter table public.audit_events
  add constraint audit_event_type_valid
  check (
    event_type in (
      'USER_CREATED',
      'ACCOUNT_CREATED',
      'TRADE_CREATED',
      'TRADE_VALIDATED',
      'TRADE_EXECUTED',
      'TRADE_REJECTED',
      'POSITION_UPDATED',
      'PROFILE_UPDATED',
      'LEADERBOARD_OPT_IN_CHANGED',
      'POSITION_SETTLED',
      'MARGIN_CALL',
      'FORCED_LIQUIDATION',
      'ACCOUNT_DEFICIT',
      'DEFICIT_REPAID'
    )
  );

-- ---------------------------------------------------------------------
-- 3. Realising collateral
--
-- Sells the account's long positions at their own instrument prices until a
-- required amount of cash has been raised. Longs only: closing a short *costs*
-- cash, so it can never fund an obligation — which is also why a short's
-- settlement is the only settlement that can run an account dry.
--
-- Largest marked exposure first, the order a margin desk works. The sale price
-- is the instrument's own price, the same one the position is marked at, so
-- liquidating is equity-neutral: it converts marked value into cash without
-- creating or destroying anything.
-- ---------------------------------------------------------------------
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
  -- Service-role job: this closes positions without the holder's consent.
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
          pos.product, pos.delivery_start, pos.delivery_end
        ), 0
      ) desc,
      pos.delivery_end,
      pos.id
    for update skip locked
  loop
    exit when v_cash >= p_need;

    v_price := public.instrument_price(
      v_pos.market_id, v_pos.counter_market_id, v_pos.instrument,
      v_pos.product, v_pos.delivery_start, v_pos.delivery_end
    );
    -- No price for its own interval: it cannot be sold honestly, so it is
    -- skipped rather than dumped at a guessed price.
    if v_price is null then
      continue;
    end if;

    select * into v_instr from public.instruments where code = v_pos.instrument;
    select * into v_prod from public.products where code = v_pos.product;
    if not found then
      raise exception 'PRODUCT_MISSING: %', v_pos.product;
    end if;

    -- Selling a position whose window has already passed *is* settling it.
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
        v_pos.delivery_start
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

comment on function public.liquidate_to_fund(uuid, numeric, timestamptz, uuid) is
  'Sells an account''s long positions at their own instrument prices, largest '
  'marked exposure first, until p_need of cash has been raised. Equity-neutral '
  'by construction: the price is the position''s own mark. Service-role job.';

-- ---------------------------------------------------------------------
-- 4. The sweep, now funded
--
-- `p_user_id` scopes the sweep to one account. Optional, and null (the whole
-- book) is what the scheduled job passes, so the production path is unchanged.
-- It exists because these are the functions that move money: a settlement can
-- liquidate positions, and a test that proves one account's settlement must be
-- able to do it without closing another account's book. Support replay of a
-- single account is the same capability.
--
-- The signature changes, so the two-argument version is dropped: an overload
-- with a defaulted third parameter would make a two-argument call ambiguous.
-- ---------------------------------------------------------------------
drop function if exists public.settle_delivered_positions(timestamptz, int);

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

comment on function public.settle_delivered_positions(timestamptz, int, uuid) is
  'Cash-settles every delivered, priceable position at its own instrument '
  'price, funding a short''s outflow by realising the account''s longs (largest '
  'exposure first) and booking any unpaid remainder as an account deficit. '
  'p_user_id scopes it to one account; null sweeps every account (the job). '
  'Service-role only; skips (and reports) positions whose settlement interval '
  'has no price. Idempotent and safe to run concurrently.';

-- ---------------------------------------------------------------------
-- 5. Margin state, for the UI and for anything that needs to reason about
--    the account without moving money.
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
begin
  -- Own-row only. `auth.uid()` is null for the service role, which is how the
  -- server-side read path calls it.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  if not exists (select 1 from public.paper_accounts ac where ac.user_id = p_user_id) then
    raise exception 'ACCOUNT_NOT_FOUND: %', p_user_id;
  end if;

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
      -- Owing money the account could not pay, or no equity at all: insolvent.
      when a.deficit > 0
        or a.cash_balance + coalesce(agg.marked_value, 0) - a.deficit <= 0
        then 'DEFICIT'
      -- Equity below maintenance is a call: restore to the initial level.
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
               p.product, p.delivery_start, p.delivery_end
             ) as mark
    ) m
    where p.user_id = a.user_id
      and p.quantity_mwh <> 0
  ) agg on true;
end;
$$;

comment on function public.account_margin(uuid) is
  'Margin state for one account: equity net of any deficit, margin '
  'requirements at the account''s own rates, and the tier (OK / WARNING / '
  'CALL / DEFICIT). Read-only. Own row, or the service role.';

-- ---------------------------------------------------------------------
-- 6. Leaderboard equity must net the deficit too, or an insolvent account
--    would be ranked as if it had money it does not have.
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
-- 7. ACLs
-- ---------------------------------------------------------------------
-- Revoked from `anon` explicitly as well as `public`: Supabase's default
-- privileges grant EXECUTE to anon, authenticated and service_role on every
-- function created in public, so revoking `public` alone leaves `anon` holding
-- it — the mistake 0004 made and 0012 corrected for ensure_user_records.
revoke execute on function public.settle_delivered_positions(timestamptz, int, uuid)
  from public;
revoke execute on function public.settle_delivered_positions(timestamptz, int, uuid)
  from anon;
revoke execute on function public.settle_delivered_positions(timestamptz, int, uuid)
  from authenticated;
grant execute on function public.settle_delivered_positions(timestamptz, int, uuid)
  to service_role;

revoke execute on function public.liquidate_to_fund(uuid, numeric, timestamptz, uuid)
  from public;
revoke execute on function public.liquidate_to_fund(uuid, numeric, timestamptz, uuid)
  from anon;
revoke execute on function public.liquidate_to_fund(uuid, numeric, timestamptz, uuid)
  from authenticated;
grant execute on function public.liquidate_to_fund(uuid, numeric, timestamptz, uuid)
  to service_role;

revoke execute on function public.account_margin(uuid) from public;
revoke execute on function public.account_margin(uuid) from anon;
grant execute on function public.account_margin(uuid) to authenticated, service_role;

revoke execute on function public.get_leaderboard(int) from public;
revoke execute on function public.get_leaderboard(int) from anon;
revoke execute on function public.get_leaderboard(int) from authenticated;
grant execute on function public.get_leaderboard(int) to service_role;
