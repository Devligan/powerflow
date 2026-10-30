-- =====================================================================
-- 0029 — The database keeps the market current
--
-- Vercel's Hobby plan runs a cron path at most once a day, which left the
-- desk trading a market up to a day old: real-time prints post every 15
-- minutes and the day-ahead clearing posts once each afternoon. pg_cron in
-- this database is minute-level and free, so it is the scheduler; Vercel
-- still does the work through the same CRON_SECRET-guarded routes, so every
-- guarantee those routes give (service role, bounded runs, run rows) holds.
--
-- Cadence follows ERCOT's own publication rhythm rather than a blind poll:
-- the rolling RT report posts each 15-minute interval ~2 minutes after it
-- ends, so ingest runs at :03/:18/:33/:48 and picks each one up within a
-- minute of posting. Settlement runs hourly just after an ingest.
--
-- The site URL and the secret live in Supabase Vault, never in this file.
-- Set them once (SQL editor, as postgres):
--
--   select vault.create_secret('https://<your-app>.vercel.app', 'powerflow_app_url');
--   select vault.create_secret('<the CRON_SECRET set in Vercel>', 'powerflow_cron_secret');
--
-- Until both exist every tick logs a warning and does nothing. Responses
-- (status, body) land in net._http_response for a few hours, which is the
-- place to look when a tick seems not to have run.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.invoke_cron_route(p_path text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'powerflow_app_url';
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'powerflow_cron_secret';

  if v_url is null or v_secret is null then
    raise warning 'invoke_cron_route(%): vault secrets powerflow_app_url and powerflow_cron_secret must both be set', p_path;
    return null;
  end if;

  -- pg_net is asynchronous: this returns a request id immediately. The
  -- timeout matches the routes' maxDuration so a catch-up run is not cut off
  -- by the caller hanging up.
  return net.http_get(
    url := rtrim(v_url, '/') || p_path,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 300000
  );
end;
$$;

revoke execute on function public.invoke_cron_route(text) from public;
revoke execute on function public.invoke_cron_route(text) from anon;
revoke execute on function public.invoke_cron_route(text) from authenticated;

-- cron.schedule replaces a job of the same name, so re-running is safe.
select cron.schedule(
  'powerflow-ingest',
  '3,18,33,48 * * * *',
  $$select public.invoke_cron_route('/api/cron/ingest')$$
);
select cron.schedule(
  'powerflow-settle',
  '25 * * * *',
  $$select public.invoke_cron_route('/api/cron/settle')$$
);
