-- =====================================================================
-- PowerFlow — 0013: automatic settlement of delivered positions
--
-- 0008 deliberately left this out: "a delivered interval stays open until the
-- user closes it, so this engine prices and marks but never force-realises."
-- This migration supersedes that note. A position whose delivery window has
-- passed is now cashed out at its own instrument price, which is what makes
-- realised P&L reflect *delivery* rather than only users closing trades.
--
-- What settlement is
-- ------------------
-- Cash settlement of a delivered forward: the position closes to flat at the
-- price its instrument resolves to for its own window, and cash moves for that
-- close. For a long the settlement leg is a SELL; for a short it is a BUY.
--
-- Both movements collapse to one signed expression, with q = quantity_mwh
-- (signed: long positive) and p = the instrument's settlement price:
--
--     cash     += p * q
--     realised += (p - average_entry_price) * q
--
-- For a short (q < 0) the second is (average - p) * |q|, i.e. shorting profits
-- as the price falls. That is the same arithmetic `execute_trade` and
-- `applyTrade` perform for a user-initiated close — settlement only chooses the
-- side and the price itself, so there is no second accounting method.
--
-- Because the settlement price *is* the price the position was already marked
-- at (`instrument_price` over the same window), settlement is equity-neutral:
-- cash + marked value is unchanged and unrealised P&L becomes realised. That is
-- the invariant the tests pin.
--
-- Why a due position can fail to settle
-- -------------------------------------
-- 0011 made pricing exact: `instrument_price` returns NULL unless the exact
-- interval (POINT / DIFFERENCE / CONVERGENCE) or the complete window (AVERAGE)
-- has prices. So a position can be due and *unpriced* — the feed has not
-- published that interval. Settling at a guess would reintroduce exactly the
-- stale-price fill 0011 removed, so a due-but-unpriced position is left open
-- and reported by the sweep summary, never closed at a stale or invented
-- price. It settles on a later run once the price exists.
--
-- Idempotency and concurrency
-- ---------------------------
-- Settlement is terminal per position. `positions.settled_at` marks it, the
-- sweep selects only `settled_at is null`, and the rows are taken
-- `FOR UPDATE SKIP LOCKED`, so a re-run or a concurrent run settles nothing
-- twice. Once delivered, no new trade can land in the position either
-- (`execute_trade` refuses a past delivery), so a settled identity cannot be
-- reopened.
--
-- Authorization
-- -------------
-- The sweep acts across every user, so it is a service-role job. It is
-- SECURITY INVOKER (service_role has BYPASSRLS, so it sees all rows) with an
-- in-function guard on `current_user`, so the boundary holds at the function
-- as well as at the ACL — a mistaken future grant cannot reopen it. The
-- `p_as_of` parameter is deliberately *not* reachable from a client: a user
-- who could pass a future `as_of` could force-settle their own undelivered
-- positions.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Two vocabularies widen
-- ---------------------------------------------------------------------
-- A settlement is a trade — the read side reconstructs positions and per-trade
-- P&L by replaying `trades`, so settlement must appear there or the replay
-- would disagree with `positions`. It is labelled distinctly so history says
-- plainly that it was not a user order.
alter table public.trades drop constraint if exists trade_status_valid;
alter table public.trades
  add constraint trade_status_valid
  check (status in ('EXECUTED', 'REJECTED', 'SETTLED'));

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
      'POSITION_SETTLED'
    )
  );

-- ---------------------------------------------------------------------
-- 2. Settlement state on the position
-- ---------------------------------------------------------------------
alter table public.positions
  add column if not exists settled_at timestamptz,
  add column if not exists settlement_trade_id uuid references public.trades (id);

comment on column public.positions.settled_at is
  'When the position was cashed out at delivery. NULL = never settled '
  '(still delivering, or delivered but unpriced).';
comment on column public.positions.settlement_trade_id is
  'The SETTLED trade row that cashed this position out.';

-- The invariant in one place: a settled position is flat and points at its
-- settlement trade, or it is untouched. This is what makes "settled" mean
-- exactly one thing and cannot be half-applied by a future code path.
alter table public.positions drop constraint if exists position_settlement_state;
alter table public.positions
  add constraint position_settlement_state check (
    (settled_at is null and settlement_trade_id is null)
    or (
      settled_at is not null
      and settlement_trade_id is not null
      and quantity_mwh = 0
    )
  );

-- Drives the sweep. Partial, because the sweep only ever looks for
-- not-yet-settled open positions, and that set shrinks to nothing.
create index if not exists positions_settlement_due_idx
  on public.positions (delivery_end)
  where settled_at is null and quantity_mwh <> 0;

-- ---------------------------------------------------------------------
-- 3. The sweep
-- ---------------------------------------------------------------------
create or replace function public.settle_delivered_positions(
  p_as_of timestamptz default now(),
  p_limit int default 500
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
  v_cash_after   numeric;
  v_side         text;
  v_trade_id     uuid;
  v_leg_price_id uuid;
  v_considered   int := 0;
  v_settled      int := 0;
  v_deferred     int := 0;
  v_failed       int := 0;
  v_remaining    int := 0;
  v_deferred_ids uuid[] := '{}';
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
    order by pos.delivery_end, pos.id
    limit p_limit
    for update skip locked
  loop
    v_considered := v_considered + 1;

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

      -- Cash first: if the account is missing there is nothing to settle, and
      -- this is the statement that must not silently no-op.
      update public.paper_accounts
         set cash_balance = cash_balance + v_notional,
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
          'delivery_start', to_char(v_pos.delivery_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'delivery_end', to_char(v_pos.delivery_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'settled_at', to_char(p_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
      );

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
    and pos.delivery_end <= p_as_of;

  return jsonb_build_object(
    'as_of', p_as_of,
    'considered', v_considered,
    'settled', v_settled,
    'deferred', v_deferred,
    'failed', v_failed,
    'settlement_due_remaining', v_remaining,
    'deferred_position_ids', to_jsonb(v_deferred_ids),
    'errors', v_errors
  );
end;
$$;

comment on function public.settle_delivered_positions(timestamptz, int) is
  'Cash-settles every delivered, unpriced-free position at its own instrument '
  'price. Service-role job; skips (and reports) positions whose settlement '
  'interval has no price. Idempotent and safe to run concurrently.';

-- ---------------------------------------------------------------------
-- 4. ACLs
-- ---------------------------------------------------------------------
-- Revoked from `anon` explicitly as well as `public`: Supabase's default
-- privileges grant EXECUTE to anon, authenticated and service_role on every
-- function created in public, so revoking `public` alone leaves `anon` holding
-- it — the mistake 0004 made and 0012 corrected for ensure_user_records.
revoke execute on function public.settle_delivered_positions(timestamptz, int)
  from public;
revoke execute on function public.settle_delivered_positions(timestamptz, int)
  from anon;
revoke execute on function public.settle_delivered_positions(timestamptz, int)
  from authenticated;
grant execute on function public.settle_delivered_positions(timestamptz, int)
  to service_role;
