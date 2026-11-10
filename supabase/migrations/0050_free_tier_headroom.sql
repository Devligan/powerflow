-- =====================================================================
-- 0050 — Room to grow on the free tier
--
-- The project runs on Supabase's free plan, whose database holds 500 MB. On
-- 2026-11-10 it held 81 MB, 62 MB of it market_prices — 23 MB of rows and
-- 40 MB of indexes — growing about 1.25 MB a day: full in about eleven
-- months. Three changes, none of which touches a price:
--
--   1. market_prices_asof_idx (market_id, product, delivery_timestamp,
--      published_at DESC) repeats market_prices_observation_key on the same
--      four columns, only the last one descending. The unique key, scanned
--      backward, serves every as-of lookup; the few queries that order a
--      window by delivery ascending and publication descending sort a
--      window's rows instead. Measured against production before the drop:
--      the market chart's week of 15-minute prices took 9.8 ms without it
--      against 13.2 ms with it. 13 MB now, a fifth of all growth after.
--   2. Housekeeping, nightly: the scheduler's run log, ingestion runs older
--      than 90 days and expired rate-limit windows grow without bound and
--      are read only while recent.
--   3. database_usage(): the size of the database, for the market-data
--      status route, so the Production workflow fails long before the limit.
-- =====================================================================

drop index if exists public.market_prices_asof_idx;

create or replace function public.housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_runs int;
  v_limits int;
  v_cron int := 0;
begin
  delete from public.ingestion_runs where started_at < now() - interval '90 days';
  get diagnostics v_runs = row_count;
  -- The longest limit window is an hour.
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_limits = row_count;
  if to_regclass('cron.job_run_details') is not null then
    delete from cron.job_run_details where end_time < now() - interval '14 days';
    get diagnostics v_cron = row_count;
  end if;
  return jsonb_build_object('ingestion_runs', v_runs, 'rate_limits', v_limits, 'cron_runs', v_cron);
end;
$$;

revoke execute on function public.housekeeping() from public, anon, authenticated;
grant execute on function public.housekeeping() to service_role;

-- cron.schedule replaces a job of the same name, so re-running is safe.
select cron.schedule('powerflow-housekeeping', '7 9 * * *', $$select public.housekeeping()$$);

create or replace function public.database_usage()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select pg_database_size(current_database());
$$;

revoke execute on function public.database_usage() from public, anon, authenticated;
grant execute on function public.database_usage() to service_role;
