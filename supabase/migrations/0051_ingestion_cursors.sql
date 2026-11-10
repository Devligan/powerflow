-- =====================================================================
-- 0051 — Ingestion cursors read one row per series, not the whole table
--
-- Every ingestion run (four an hour) starts by asking, for each market and
-- product, the newest interval stored (latest_price_timestamps) and the
-- newest final one (latest_final_price_timestamps). Both were a DISTINCT ON
-- over every row of every requested market: on 2026-11-10, with 120,000
-- price rows, 1,450 ms and 957 ms, growing with the table — on the free
-- plan's shared CPU, the cost of each run would have kept rising forever.
--
-- Each is now one probe per (market, product): a backward scan of
-- market_prices_observation_key (market_id, product, delivery_timestamp,
-- published_at), stopping at the first row. Measured on production inside a
-- rolled-back transaction: 78 ms and 109 ms, with identical results. Same
-- signatures and return types, so callers are unchanged.
--
-- A series with no final rows at all (RTM_15MIN is interim by design) is
-- still walked to its end by the final cursor, since is_final is not in the
-- index; that walk is one series per market rather than the whole table.
-- =====================================================================

create or replace function public.latest_price_timestamps(p_market_ids uuid[])
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
    where mp.market_id = m.id and mp.product = p.code
    order by mp.delivery_timestamp desc, mp.published_at desc
    limit 1
  ) l
  where m.id = any(p_market_ids);
$$;

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
  where m.id = any(p_market_ids);
$$;
