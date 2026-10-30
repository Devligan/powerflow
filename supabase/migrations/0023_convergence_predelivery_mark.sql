-- =====================================================================
-- 0023 — Mark a virtual honestly before real time exists
--
-- Migration 0021 gave CONVERGENCE positions (VIRTUAL, DART_SPREAD) the
-- correct settlement: the final real-time price of the delivery hour,
-- realized against the day-ahead leg the desk paid at entry. But the
-- same reduction was used for MARKING, and it has a hole: before the
-- delivery hour ERCOT has printed no real-time observation at all —
-- hourly SPP arrives only after the hour completes, and 15-minute
-- prints only once the hour is running. The mark came back NULL, so
-- from entry until delivery an open virtual carried NO value in the
-- account's equity: a desk that bought an INC for the day-ahead price
-- watched its equity drop by the full premium it had just paid, and a
-- portfolio screen showed every open virtual as a phantom loss.
--
-- The honest pre-delivery mark is the day-ahead leg itself. It is an
-- ACTUAL ERCOT observation (the DAM clearing, published D-1), it is
-- what the desk actually paid, and marking the position there reports
-- exactly the truth available at the clock: the position has not
-- converged yet, so its unrealized P&L is zero until real time moves.
-- No invented number is introduced at any point — the fallback only
-- replaces "no mark" with "the leg ERCOT has actually published".
--
-- Intra-hour behaviour is unchanged: once 15-minute real-time prints
-- exist for the running hour, the newest of THEM is the mark; once the
-- hour completes, the hourly SPP is. Settlement (0022's
-- instrument_settlement_price) is untouched: a virtual still realizes
-- at the final real-time value against its day-ahead entry.
--
-- Regression coverage: the settlement suite's long case asserts that
-- settlement moves equity by exactly the realized P&L — which requires
-- the pre-sweep mark of the open position to equal its entry leg.
-- =====================================================================

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
    if v_rt is not null then
      v_price := v_rt;
    else
      -- Before real time: the position has not converged yet, and ERCOT
      -- has published no real-time observation of the hour. Its honest
      -- value is the day-ahead leg the desk already paid — an actual
      -- ERCOT clearing — so the position carries its entry cost and its
      -- unrealized P&L is zero until real time moves. A NULL here would
      -- drop the position out of equity entirely and report a phantom
      -- loss of the full premium paid.
      v_price := public.price_at(p_market_id, 'DAM_HOURLY', p_from, v_as_of);
    end if;

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

-- ACLs preserved from 0021/0022: engine internals stay server-side.
revoke execute on function public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz) from anon;
grant execute on function public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz)
  to authenticated, service_role;
