-- =====================================================================
-- 0024 — A live RT hour must eventually settle
--
-- The live adapter (ERCOT_MIS) publishes the hourly settlement series
-- (RTM_HOURLY) interim forever: MIS posts the rolling hourly SPP after
-- each hour completes, and ERCOT finalizes real-time settlement through
-- the settlement calendar (initial statements, true-ups), never a daily
-- MIS report. price_final therefore returned NULL for every live
-- interval, and settle_delivered_positions deferred EVERY delivered
-- live position forever — no live P&L ever realized, margin never
-- released, the portfolio filled with immortal open positions. The
-- settlement engine only ever ran against replay fixtures.
--
-- The honest finality rule for a paper-trading desk: the hourly SPP for
-- a delivery day whose last hour has FULLY ELAPSED is the settlement
-- value. It is the actual ERCOT print for every one of that day's
-- hours; nothing further is invented. Later ERCOT corrections arrive as
-- NEW observations (the store never overwrites), price_final prefers
-- the latest is_final row, so a correction becomes the settlement
-- value on the next ingestion without any re-promotion logic.
--
-- The day boundary is US/Central — ERCOT's operating day — evaluated
-- with `at time zone 'America/Chicago'`, which resolves the offset
-- actually in effect on each date (DST-exact: a March or November
-- delivery day promotes at 24:00 Central of ITS OWN offset, not a
-- fixed UTC shift).
--
-- Called at the tail of every ingestion run; idempotent and bounded to
-- the still-interim rows that are due.
-- =====================================================================

create or replace function public.promote_rtm_finals()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_promoted integer := 0;
begin
  if current_user <> 'service_role' then
    raise exception 'FORBIDDEN: promote_rtm_finals is a service_role job';
  end if;

  -- Every still-interim hourly SPP observation whose Central delivery
  -- day has fully elapsed: the day's next Central midnight must already
  -- be in the PAST (clock_time, not the interval itself, is what marks
  -- the day complete). Grouped per (market, interval): one due interval
  -- promotes ALL of its vintages together, so a corrected publication is
  -- never left behind interim while its original becomes final.
  with due as (
    select mp.market_id, mp.delivery_timestamp
    from public.market_prices mp
    where mp.product = 'RTM_HOURLY'
      and mp.is_final = false
      and (( (mp.delivery_timestamp at time zone 'America/Chicago')::date + 1 )
           at time zone 'America/Chicago')
          <= clock_timestamp()
    group by mp.market_id, mp.delivery_timestamp
  )
  update public.market_prices mp
  set is_final = true
  from due
  where mp.market_id = due.market_id
    and mp.product = 'RTM_HOURLY'
    and mp.delivery_timestamp = due.delivery_timestamp;

  get diagnostics v_promoted = row_count;
  return v_promoted;
end;
$$;

revoke execute on function public.promote_rtm_finals() from public;
revoke execute on function public.promote_rtm_finals() from anon;
revoke execute on function public.promote_rtm_finals() from authenticated;
grant execute on function public.promote_rtm_finals() to service_role;
