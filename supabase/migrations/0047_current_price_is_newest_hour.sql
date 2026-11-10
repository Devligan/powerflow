-- =====================================================================
-- 0047 — A market's current price is its newest hour, not its newest post
--
-- current_prices picked, per (market, product), the observation published
-- last. That was the newest hour only while every hour was published once, in
-- order. ERCOT's price corrections (NP4-197, ingested since 0044) re-post old
-- hours: January's Board-directed corrections were posted in July, and would
-- each have become the "current" real-time price on every screen.
--
-- The current price is now the newest delivery interval already published,
-- at its latest publication — the same rule listMarkets applies as of a
-- replay clock. Same columns, so callers are unchanged; privileges are kept
-- (0046: the service role reads it).
-- =====================================================================

create or replace view public.current_prices
with (security_invoker = true)
as
select m.id as market_id,
       m.settlement_point,
       m.settlement_point_type,
       m.description,
       m.active,
       lp.delivery_timestamp,
       lp.delivery_end,
       lp.price,
       lp.product,
       lp.venue,
       lp.source,
       lp.published_at as ingested_at
from public.markets m
cross join lateral (
  select distinct on (mp.product)
         mp.delivery_timestamp,
         mp.delivery_end,
         mp.price,
         mp.product,
         mp.venue,
         mp.source,
         mp.published_at
  from public.market_prices mp
  where mp.market_id = m.id
    and mp.published_at <= now()
  order by mp.product, mp.delivery_timestamp desc, mp.published_at desc
) lp;
