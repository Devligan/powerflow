-- =====================================================================
-- 0025 — Real time is the settlement market, not an orderable series
--
-- A live desk could select RTM_15MIN or RTM_HOURLY on the order ticket
-- and submit: the engine priced the named series and refused — but only
-- ever with PRICE_UNAVAILABLE / DELIVERY_IN_PAST, because real-time
-- prints exist only AFTER delivery. Under actual ERCOT publication
-- timing every such fill is structurally impossible; the series cannot
-- be forward-traded, and presenting them as orderable reads as a broken
-- button. (Under the old synthetic feed they traded fine — the feed
-- published forward — which is why they were orderable.)
--
-- The honest model: the day-ahead market is where a desk commits
-- forward; real time is the settlement market it converges against,
-- reached through the DART/VIRTUAL/PTP instruments and visible in the
-- reference series and charts. The TS catalog (types.ts) is updated to
-- match; the DB column is the authority the engine checks.
-- =====================================================================

update public.products
set tradable = false
where code in ('RTM_15MIN', 'RTM_HOURLY');
