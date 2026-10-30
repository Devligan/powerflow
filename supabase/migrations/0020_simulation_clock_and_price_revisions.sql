-- =====================================================================
-- 0020 — Publication model for market prices, and the simulation clock
--
-- The prior audit found the structural gap: with a static price store,
-- entry price == mark price == settlement price for every position, so
-- unrealized P&L is identically zero and the margin engine (0014) can
-- never fire. The fix is not synthetic movement — it is time.
--
-- Two concepts the old schema conflated:
--
--   delivery_timestamp   when the electricity is delivered
--   published_at         when ERCOT published this observation of it
--
-- ERCOT publishes *different observations of the same delivery interval
-- at different times*: the DAM clears an operating day the day before,
-- real-time intervals publish as they complete, and corrections
-- (MIS report NP4-197, "price correction") revise values after the
-- fact. A replay simulator must therefore hold multiple observations
-- of one delivery interval and answer, exactly:
--
--   "What did the desk know about this interval at time T?"
--        -> the latest observation published at or before T
--   "What was the final ERCOT settlement value?"
--        -> the latest *final* observation of the interval
--
-- which are different questions with different answers.
--
-- The store stays one table: a revision is simply another row for the
-- same (market, product, delivery interval) with a later publication.
-- Re-ingesting the same report is idempotent (its publication instant
-- is part of the key); a correction is a new row. Nothing is
-- overwritten, so the revision history ERCOT published is preserved.
--
-- The simulation clock rides on paper_accounts: a per-account offset
-- from the wall clock. Zero = live mode (pre-0020 behaviour, so the
-- existing cron jobs and every existing test keep working). Negative =
-- replaying the past: engine functions resolve the caller's sim time
-- and enforce visibility against it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Publication columns on market_prices
-- ---------------------------------------------------------------------
-- `source_timestamp` (0001) becomes the publication instant: when the
-- source published this observation. It was already the intended
-- meaning; adapters now set it from the report's own publication
-- timestamp instead of the fetch window. Rows that predate the model
-- are grandfathered with their ingest instant and flagged final.
-- Postgres forbids column references inside a DEFAULT expression, so the
-- grandfathering of pre-existing rows happens as an explicit backfill:
-- nullable column first, fill from source_timestamp, then lock it down.
-- The fallback default is now() — every production writer (ingestion,
-- seed, history loader) already sets published_at explicitly from the
-- source's own publication metadata.
alter table public.market_prices
  add column if not exists published_at timestamptz,
  add column if not exists is_final boolean not null default false;

update public.market_prices
   set published_at = coalesce(source_timestamp, ingested_at, now())
 where published_at is null;

alter table public.market_prices
  alter column published_at set not null,
  alter column published_at set default now();

comment on column public.market_prices.published_at is
  'When the source published this observation of the delivery interval. '
  'An observation is invisible to the simulation until this instant has '
  'passed on the reader''s clock.';
comment on column public.market_prices.is_final is
  'True when this observation is the final ERCOT settlement value for '
  'its delivery interval: the delivery day is complete and any '
  'corrections are applied. Settlement waits for a final observation.';

update public.market_prices set is_final = true where is_final = false;

-- The interval identity widens to include the publication instant, so
-- ERCOT corrections are stored alongside the originals instead of
-- silently replacing them (the old key made the ingestion pipeline
-- DROP revised prices — the one-row-per-interval store could not hold
-- a correction).
alter table public.market_prices
  drop constraint if exists market_prices_market_delivery_product_key;
alter table public.market_prices
  add constraint market_prices_observation_key
    unique (market_id, product, delivery_timestamp, published_at);

-- As-of lookups resolve per interval: latest publication at or before
-- the reader's clock. The key index serves the equality prefix.
create index if not exists market_prices_asof_idx
  on public.market_prices
    (market_id, product, delivery_timestamp, published_at desc);

-- ---------------------------------------------------------------------
-- 1b. Dependent objects that assumed one row per interval
-- ---------------------------------------------------------------------
-- current_prices (0006) and latest_price_timestamps (0006) now see
-- several observations per interval; both must resolve to the latest
-- publication or every reader multiplies rows.

create or replace view public.current_prices as
select
  m.id as market_id,
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
         mp.delivery_timestamp, mp.delivery_end, mp.price,
         mp.product, mp.venue, mp.source, mp.published_at
  from public.market_prices mp
  where mp.market_id = m.id
  order by mp.product, mp.published_at desc
) lp;

drop function if exists public.latest_price_timestamps(uuid[]);
create or replace function public.latest_price_timestamps(p_market_ids uuid[])
returns table (market_id uuid, product text, delivery_timestamp timestamptz)
language sql
stable
as $$
  select distinct on (mp.market_id, mp.product)
         mp.market_id, mp.product, mp.delivery_timestamp
  from public.market_prices mp
  where mp.market_id = any(p_market_ids)
  order by mp.market_id, mp.product, mp.delivery_timestamp desc, mp.published_at desc;
$$;
grant execute on function public.latest_price_timestamps(uuid[]) to authenticated;

-- Ingestion's resume cursor over the FINAL series only. An interim
-- observation (published before the delivery day closes) must not advance
-- the cursor past its interval, or the final value ERCOT publishes later
-- would fall behind the resume point and never be fetched. Keying on
-- is_final keeps re-fetching a series until ERCOT's settlement-grade value
-- is in, without re-fetching anything already final.
drop function if exists public.latest_final_price_timestamps(uuid[]);
create or replace function public.latest_final_price_timestamps(p_market_ids uuid[])
returns table (market_id uuid, product text, delivery_timestamp timestamptz)
language sql
stable
as $$
  select distinct on (mp.market_id, mp.product)
         mp.market_id, mp.product, mp.delivery_timestamp
  from public.market_prices mp
  where mp.market_id = any(p_market_ids)
    and mp.is_final
  order by mp.market_id, mp.product, mp.delivery_timestamp desc, mp.published_at desc;
$$;
grant execute on function public.latest_final_price_timestamps(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Per-account simulation clock
-- ---------------------------------------------------------------------
alter table public.paper_accounts
  add column if not exists sim_clock_offset bigint not null default 0;

comment on column public.paper_accounts.sim_clock_offset is
  'Nanoseconds to add to the wall clock to get this account''s '
  'simulation time. Zero = live mode. Negative = replaying the past. '
  'Engine functions resolve this once per call and enforce market-data '
  'visibility against it.';

create or replace function public.set_sim_clock(p_user_id uuid, p_iso timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offset bigint;
begin
  -- Own account only (the service role passes because auth.uid() is null).
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;
  if p_iso is null then
    raise exception 'SIM_CLOCK_INVALID';
  end if;

  -- The offset is nanoseconds; a timestamptz difference is an interval, so
  -- it goes through epoch seconds rather than an implicit (absent) cast.
  update public.paper_accounts
     set sim_clock_offset =
       (extract(epoch from (p_iso - clock_timestamp())) * 1000000000)::bigint
   where user_id = p_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;
  return p_iso;
end;
$$;

create or replace function public.clear_sim_clock(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;
  update public.paper_accounts set sim_clock_offset = 0 where user_id = p_user_id;
end;
$$;

-- The account's simulation time as of this instant. NULL when the
-- account does not exist — callers distinguish that from live mode.
create or replace function public.sim_now(p_user_id uuid)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select clock_timestamp() + (
    select a.sim_clock_offset * interval '1 microsecond' / 1000
    from public.paper_accounts a where a.user_id = p_user_id
  )
$$;

-- ---------------------------------------------------------------------
-- 3. ACLs
-- ---------------------------------------------------------------------
revoke execute on function public.set_sim_clock(uuid, timestamptz) from public;
revoke execute on function public.set_sim_clock(uuid, timestamptz) from anon;
grant execute on function public.set_sim_clock(uuid, timestamptz)
  to authenticated, service_role;
revoke execute on function public.clear_sim_clock(uuid) from public;
revoke execute on function public.clear_sim_clock(uuid) from anon;
grant execute on function public.clear_sim_clock(uuid) to authenticated, service_role;
revoke execute on function public.sim_now(uuid) from public;
grant execute on function public.sim_now(uuid) to authenticated, service_role;
