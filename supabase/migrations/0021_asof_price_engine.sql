-- =====================================================================
-- 0021 — The as-of price engine: prices are published, then visible
--
-- Migration 0011 made pricing exact but made the store static: one row
-- per delivery interval meant the price a position was *entered* at is
-- the price it is *marked* and *settled* at, forever. The missing
-- ingredient was never movement — it was time. ERCOT publishes
-- different observations of the same delivery interval at different
-- times: the DAM clears an operating day the day before it delivers,
-- real-time intervals publish as they complete, and corrections arrive
-- afterwards (MIS NP4-197). With 0020 holding every observation and
-- its publication instant, this migration re-points the engine from
-- "the price for this interval" to "the latest observation of this
-- interval published at or before the reader's simulation time".
--
-- The one-entry/one-settlement discipline:
--
--   entry   an order fills at the price the market being entered publishes
--           at or before the account's simulation time. A DAM observation
--           published the day before delivery is therefore the fill —
--           the real day-ahead workflow, look-ahead-free. A virtual/PTP
--           position is entered at its DAY-AHEAD leg alone (see below):
--           the real-time outcome it converges against does not exist yet.
--   mark    the instrument's value rule, as of the mark's own as-of.
--   settle  the latest FINAL observation set (delivery day complete,
--           corrections applied). Settlement never uses an interim
--           observation when a final one exists.
--
-- Look-ahead is enforced here, in the engine: every price lookup takes
-- the reader's clock and filters published_at <= clock. A future
-- observation cannot be reached by any caller, because no caller is
-- given a lookup that lacks the clock.
--
-- Entry discipline (unchanged from 0011, restated for the new store):
-- POINT/DIFFERENCE/CONVERGENCE require an observation for the exact
-- interval; AVERAGE requires every interval of the window to have one.
-- Nothing is averaged across a gap; nothing is carried forward.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. As-of price helpers
-- ---------------------------------------------------------------------
-- Every helper takes p_as_of: "latest observation published at or
-- before this instant". The 3-argument forms are the settlement-side
-- wrappers: they resolve the FINAL observation of the interval — the
-- true ERCOT settlement value once the delivery day is complete.

-- Source precedence: when an actual ERCOT observation and a generated one
-- both cover an interval, the ERCOT observation wins at every as-of where it
-- is visible. Generated feeds model publication as "known far ahead", so
-- without this rule a replay desk could fill on simulated data in the window
-- before ERCOT's real publication — exactly the confusion the labelling rule
-- forbids. Actual data is market truth; generated data only fills gaps.

-- Latest observation of the interval published at or before p_as_of.
drop function if exists public.price_at(uuid, text, timestamptz);
create or replace function public.price_at(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz,
  p_as_of timestamptz
)
returns numeric
language sql
stable
set search_path = public
as $$
  select mp.price
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
    and mp.published_at <= p_as_of
  order by
    case when mp.source like '%GENERATED%' then 1 else 0 end,
    mp.published_at desc
  limit 1
$$;

-- Final observation of the interval: the ERCOT settlement value, once
-- published. Null when the interval has never been observed.
create or replace function public.price_final(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz
)
returns numeric
language sql
stable
set search_path = public
as $$
  select mp.price
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
    and mp.is_final
  order by
    case when mp.source like '%GENERATED%' then 1 else 0 end,
    mp.published_at desc
  limit 1
$$;

-- Provenance row for a fill: the observation the price came from.
drop function if exists public.price_row_id(uuid, text, timestamptz);
create or replace function public.price_row_id(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz,
  p_as_of timestamptz
)
returns uuid
language sql
stable
set search_path = public
as $$
  select mp.id
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
    and mp.published_at <= p_as_of
  order by
    case when mp.source like '%GENERATED%' then 1 else 0 end,
    mp.published_at desc
  limit 1
$$;

-- When the price was published — the mark's "as of" instant. Under
-- 0011 this returned the delivery timestamp (identical under exact
-- pricing); it now returns the observation's publication instant,
-- which is what a reader of a mark actually needs to know.
drop function if exists public.price_as_of(uuid, text, timestamptz);
create or replace function public.price_as_of(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz,
  p_as_of timestamptz
)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select mp.published_at
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
    and mp.published_at <= p_as_of
  order by
    case when mp.source like '%GENERATED%' then 1 else 0 end,
    mp.published_at desc
  limit 1
$$;

-- Whether no observation exists for the interval (diagnostic; under
-- as-of pricing an unfilled trade is simply refused, so this stays
-- false on every executed trade exactly as 0011 required).
drop function if exists public.price_is_stale(uuid, text, timestamptz);
create or replace function public.price_is_stale(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz,
  p_as_of timestamptz
)
returns boolean
language sql
stable
set search_path = public
as $$
  select not exists (
    select 1 from public.market_prices mp
    where mp.market_id = p_market_id
      and mp.product = p_product
      and mp.delivery_timestamp = p_ts
      and mp.published_at <= p_as_of
  );
$$;

-- The newest observation published at or before p_as_of for any interval
-- inside [p_from, p_to): the "latest print" lookup. Used to mark an hourly
-- position during its RUNNING hour, when ERCOT's hourly SPP does not exist
-- yet but 15-minute real-time prints do. Ordering is newest interval first,
-- then the interval's newest publication, with the actual-over-generated
-- precedence applied per interval.
drop function if exists public.price_latest_in_window(uuid, text, timestamptz, timestamptz, timestamptz);
create or replace function public.price_latest_in_window(
  p_market_id uuid,
  p_product text,
  p_from timestamptz,
  p_to timestamptz,
  p_as_of timestamptz
)
returns numeric
language sql
stable
set search_path = public
as $$
  select mp.price
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp >= p_from
    and mp.delivery_timestamp < p_to
    and mp.published_at <= p_as_of
  order by
    mp.delivery_timestamp desc,
    case when mp.source like '%GENERATED%' then 1 else 0 end,
    mp.published_at desc
  limit 1
$$;

-- Window average, only when every interval of the window has an
-- observation as of the clock. Revisions put several rows on one
-- interval, so the interval count is DISTINCT: the rule is coverage,
-- not row count. An incomplete window is not a price.
create or replace function public.price_average(
  p_market_id uuid,
  p_product text,
  p_from timestamptz,
  p_to timestamptz,
  p_as_of timestamptz
)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_interval_minutes int;
  v_expected int;
  v_rows int;
  v_avg numeric;
begin
  select p.interval_minutes into v_interval_minutes
  from public.products p
  where p.code = p_product;
  if v_interval_minutes is null or v_interval_minutes <= 0 then
    return null;
  end if;

  v_expected :=
    (extract(epoch from (p_to - p_from)) / 60 / v_interval_minutes)::int;
  if v_expected <= 0 then
    return null;
  end if;

  -- Revisions put several observations on one interval; averaging across
  -- all of them would mix every revision's price. Resolve each interval to
  -- its latest publication at or before the clock FIRST, then average those.
  select count(*), avg(latest.price)
    into v_rows, v_avg
  from (
    select distinct on (mp.delivery_timestamp)
           mp.delivery_timestamp, mp.price
    from public.market_prices mp
    where mp.market_id = p_market_id
      and mp.product = p_product
      and mp.delivery_timestamp >= p_from
      and mp.delivery_timestamp < p_to
      and mp.published_at <= p_as_of
    order by mp.delivery_timestamp,
             case when mp.source like '%GENERATED%' then 1 else 0 end,
             mp.published_at desc
  ) latest;

  if v_rows <> v_expected then
    return null; -- incomplete window: not a price, rather than a wrong one
  end if;

  return v_avg;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. instrument_price: every rule priced as of a clock
-- ---------------------------------------------------------------------
-- The as-of is optional only at the SQL level; a null as-of resolves
-- to the caller's simulation time. Authorization lives in the callers,
-- and sim_now() reads the caller's own account, so a user cannot point
-- the clock at anyone else's.
create or replace function public.instrument_price(
  p_market_id uuid,
  p_counter_market_id uuid,
  p_instrument text,
  p_product text,
  p_from timestamptz,
  p_to timestamptz,
  p_as_of timestamptz default null
)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_rule text;
  v_option text;
  v_as_of timestamptz;
  v_a numeric;
  v_b numeric;
  v_rt numeric;
  v_price numeric;
begin
  select i.settlement_rule, i.option_type
    into v_rule, v_option
  from public.instruments i
  where i.code = p_instrument;
  if v_rule is null then
    return null;
  end if;

  -- The reader's clock. A null as-of means "resolve from the account".
  v_as_of := coalesce(p_as_of, public.sim_now(auth.uid()));

  if v_rule = 'POINT' then
    v_a := public.price_at(p_market_id, p_product, p_from, v_as_of);
    v_price := v_a;

  elsif v_rule = 'AVERAGE' then
    v_a := public.price_average(p_market_id, p_product, p_from, p_to, v_as_of);
    v_price := v_a;

  elsif v_rule = 'DIFFERENCE' then
    if p_counter_market_id is null then
      return null;
    end if;
    v_a := public.price_at(p_market_id, p_product, p_from, v_as_of);
    v_b := public.price_at(p_counter_market_id, p_product, p_from, v_as_of);
    if v_a is null or v_b is null then
      return null;
    end if;
    v_price := v_b - v_a; -- sink minus source

  elsif v_rule = 'CONVERGENCE' then
    -- The VALUE dimension of a convergence position is its real-time leg.
    -- It was entered at the day-ahead leg (instrument_entry_price), so the
    -- running unrealized P&L is (RT_now − DA_entry): marking at RT − DA
    -- here would double-count the day-ahead leg against average_entry_price.
    v_rt := public.price_at(p_market_id, 'RTM_HOURLY', p_from, v_as_of);
    if v_rt is null then
      -- The delivery hour is still running: ERCOT publishes the hourly SPP
      -- only after the hour completes, but 15-minute real-time prints exist
      -- from ~15 minutes in. Mark at the newest actual print of THIS hour —
      -- never a later hour's, never an invented number.
      v_rt := public.price_latest_in_window(
        p_market_id, 'RTM_15MIN', p_from, p_from + interval '1 hour', v_as_of
      );
    end if;
    if v_rt is null then
      return null;
    end if;
    v_price := v_rt;

  elsif v_rule = 'CONGESTION_CONVERGENCE' then
    -- A day-ahead PTP obligation is bought at the day-ahead spread and
    -- settles at the real-time spread, so the value it carries is the
    -- real-time congestion across the path; the convergence from the
    -- day-ahead spread it was bought at is the position's P&L.
    if p_counter_market_id is null then
      return null;
    end if;
    v_a := public.price_at(p_market_id, 'RTM_HOURLY', p_from, v_as_of);
    v_b := public.price_at(p_counter_market_id, 'RTM_HOURLY', p_from, v_as_of);
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
  -- An option can only pay out; an obligation is two-way.
  if v_option = 'OPTION' and v_price < 0 then
    return 0;
  end if;
  return v_price;
end;
$$;

-- ---------------------------------------------------------------------
-- 2b. instrument_entry_price: what a NEW position is filled at
-- ---------------------------------------------------------------------
-- Marking answers "what is the position worth now"; entry answers "what does
-- the desk pay right now to open it". For most rules these are the same
-- function. They differ for the two convergence instruments, because a
-- mark can use observations that did not exist when the position was
-- opened — and an entry must not:
--
--   CONVERGENCE (virtual INC/DEC, DA/RT spread)
--       entered at the DAY-AHEAD clearing price — the INC/DEC bid clears
--       in the DAM and pays the DA price; its payoff (RT − DA) is not
--       known until real time. Filling it at RT − DA would be buying a
--       spread whose both legs are already published.
--   CONGESTION_CONVERGENCE (day-ahead PTP obligation/option)
--       entered at the DAY-AHEAD congestion spread across the path —
--       (DA_sink − DA_source) — which is what the PTP clears at in the
--       DAM. The real-time spread it settles against comes later.
--
-- Everywhere else, entry and value are the same reduction of the legs
-- visible at the clock.
create or replace function public.instrument_entry_price(
  p_market_id uuid,
  p_counter_market_id uuid,
  p_instrument text,
  p_product text,
  p_from timestamptz,
  p_to timestamptz,
  p_as_of timestamptz default null
)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_rule text;
  v_option text;
  v_as_of timestamptz;
  v_da_a numeric;
  v_da_b numeric;
  v_price numeric;
begin
  select i.settlement_rule, i.option_type into v_rule, v_option
  from public.instruments i
  where i.code = p_instrument;
  if v_rule is null then
    return null;
  end if;

  v_as_of := coalesce(p_as_of, public.sim_now(auth.uid()));

  if v_rule = 'CONVERGENCE' then
    -- Pay the day-ahead price; the convergence is the position's payoff,
    -- not its entry cost.
    v_price := public.price_at(p_market_id, 'DAM_HOURLY', p_from, v_as_of);

  elsif v_rule = 'CONGESTION_CONVERGENCE' then
    if p_counter_market_id is null then
      return null;
    end if;
    v_da_a := public.price_at(p_market_id, 'DAM_HOURLY', p_from, v_as_of);
    v_da_b := public.price_at(p_counter_market_id, 'DAM_HOURLY', p_from, v_as_of);
    if v_da_a is null or v_da_b is null then
      return null;
    end if;
    v_price := v_da_b - v_da_a; -- the day-ahead spread the PTP clears at
  else
    -- POINT / DIFFERENCE / AVERAGE: entry is the value rule at the clock.
    v_price := public.instrument_price(
      p_market_id, p_counter_market_id, p_instrument, p_product,
      p_from, p_to, v_as_of
    );
  end if;

  if v_price is null then
    return null;
  end if;
  -- Optionality applies at entry too: an option is bought for a premium
  -- (floored at zero, as in the auction), an obligation is two-way.
  if v_option = 'OPTION' and v_price < 0 then
    return 0;
  end if;
  return v_price;
end;
$$;

revoke execute on function public.instrument_entry_price(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz) from public;
grant execute on function public.instrument_entry_price(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz)
  to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. execute_trade: fills at the market state of the simulated instant
-- ---------------------------------------------------------------------
-- Two changes against the 0017 body:
--   * the delivery horizon is validated against the account's
--     SIMULATION time, not the wall clock — replaying a historical day
--     means trading intervals that are in the past on the wall clock
--     but future on the clock. In live mode (offset 0) the two are
--     identical and every 0011-era refusal still fires.
--   * the fill is priced as of that simulation time, and the trade's
--     `price_timestamp` records it, so the provenance of a fill is the
--     instant its market state came from.
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
  -- The account's simulation time: the "now" of the market state this
  -- fill is priced against. Wall time is still v_exec_at (audit).
  v_as_of     timestamptz;
  v_window_ms numeric;
  v_interval_ms numeric;
  v_coid      text;
  v_result    jsonb;
begin
  -- 0. Authorization.
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  -- The clock. SECURITY DEFINER resolves it for the authorized caller;
  -- p_user_id was just pinned to auth.uid().
  v_as_of := public.sim_now(p_user_id);
  if v_as_of is null then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  -- 0b. Idempotency key. A malformed id is rejected rather than coerced.
  v_coid := nullif(btrim(coalesce(p_client_order_id, '')), '');
  if v_coid is not null and length(v_coid) > 128 then
    raise exception 'CLIENT_ORDER_ID_INVALID';
  end if;

  -- 0c. Ordinary retry: this order already executed, so return its result.
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
  --    names. A legless or path instrument has no series of its own.
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
  if v_instr.settlement_rule in ('DIFFERENCE', 'CONGESTION_CONVERGENCE') then
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

  -- 5. Validate the delivery side.
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

  -- Delivery horizon, in SIMULATION time: an interval that has already
  -- settled on the clock cannot be traded, and nothing beyond the
  -- traded horizon may be ordered. (v_exec_at, wall time, is still
  -- what created_at/executed_at record.)
  if p_delivery_end <= v_as_of then
    raise exception 'DELIVERY_IN_PAST';
  end if;
  if p_delivery_start > v_as_of + interval '35 days' then
    raise exception 'DELIVERY_TOO_FAR_OUT';
  end if;

  -- 6. Authoritative entry price: the market state of the simulated
  --    instant, priced by the ENTRY rule — a convergence position pays its
  --    day-ahead leg, not a spread that needs real-time observations which
  --    do not exist yet. No price visible at that instant, no fill.
  v_price := public.instrument_entry_price(
    p_market_id, p_counter_market_id, p_instrument, p_product,
    p_delivery_start, p_delivery_end, v_as_of
  );
  if v_price is null then
    raise exception 'PRICE_UNAVAILABLE';
  end if;

  -- Provenance for single-leg fills; composed instruments have no
  -- single row. The observation cited is the one visible at v_as_of.
  if v_instr.legs = 1 and v_instr.settlement_rule <> 'AVERAGE' then
    if v_instr.settlement_rule = 'CONVERGENCE' then
      v_leg_price_id := public.price_row_id(p_market_id, 'DAM_HOURLY', p_delivery_start, v_as_of);
      v_price_stale := public.price_is_stale(p_market_id, 'DAM_HOURLY', p_delivery_start, v_as_of);
    else
      v_leg_price_id := public.price_row_id(p_market_id, p_product, p_delivery_start, v_as_of);
      v_price_stale := public.price_is_stale(p_market_id, p_product, p_delivery_start, v_as_of);
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

  -- 7b. Replay re-check under the serialization lock.
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

  -- 8c. Gross exposure, marking every other open position at its own
  --     instrument price as of the same clock.
  for v_other in
    select *
    from public.positions pos
    where pos.user_id = p_user_id
      and pos.quantity_mwh <> 0
      and (v_pos.id is null or pos.id <> v_pos.id)
  loop
    v_other_price := public.instrument_price(
      v_other.market_id, v_other.counter_market_id, v_other.instrument,
      v_other.product, v_other.delivery_start, v_other.delivery_end, v_as_of
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

  -- 9. Position accounting (weighted-average cost, signed quantity).
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

  -- 11. The execution result, computed once and stored.
  v_result := jsonb_build_object(
    'instrument', v_instr.code,
    'settlement_rule', v_instr.settlement_rule,
    'option_type', v_instr.option_type,
    'product', v_product.code,
    'venue', v_product.venue,
    'side', p_side,
    'quantity_mwh', p_quantity_mwh,
    'execution_price', v_price,
    'price_timestamp', v_as_of,
    'price_stale', v_price_stale,
    'market_price_id', v_leg_price_id,
    'counter_market_id', p_counter_market_id,
    'notional', v_notional,
    'realized_delta', v_realized_delta,
    'cash_balance', (select cash_balance from public.paper_accounts where id = v_account.id),
    'position_quantity', v_new_qty,
    'position_average_entry_price', v_new_avg,
    'executed_at', v_exec_at,
    'sim_as_of', v_as_of,
    'replayed', false
  );

  -- 12. Immutable trade record.
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
    v_price, v_as_of, v_leg_price_id,
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
      'sim_as_of', v_as_of,
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
