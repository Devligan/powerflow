-- =====================================================================
-- 0052 — The final cursor skips the series that is never final
--
-- 0051 made latest_final_price_timestamps one probe per (market, product),
-- but a series with no final row at all is still walked to its end looking
-- for one, because is_final is not in the index. RTM_15MIN is that series by
-- construction: the MIS adapter stores the rolling report's 15-minute prints
-- as interim, and ERCOT's corrections (0044, apply_rtm_price_corrections)
-- insert them interim too; real-time finality is RTM_HOURLY's (0024). It is
-- the largest series, about 1,500 rows a day, so the walk grew every day.
--
-- Ingestion falls back to the newest stored row where a series has no final
-- one (src/lib/ingestion.ts), so the cursor for RTM_15MIN was always absent:
-- leaving it out changes no result. A partial index would have done the
-- same at a storage cost the free plan does not need to pay.
-- =====================================================================

create or replace function public.latest_final_price_timestamps(p_market_ids uuid[])
returns table (market_id uuid, product text, delivery_timestamp timestamptz)
language sql
stable
set search_path = public
as $$
  select m.id, p.code, l.delivery_timestamp
  from public.markets m
  cross join public.products p
  cross join lateral (
    select mp.delivery_timestamp
    from public.market_prices mp
    where mp.market_id = m.id and mp.product = p.code and mp.is_final
    order by mp.delivery_timestamp desc, mp.published_at desc
    limit 1
  ) l
  where m.id = any(p_market_ids)
    -- Interim by construction (see above): never a final row to find.
    and p.code <> 'RTM_15MIN';
$$;
