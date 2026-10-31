-- =====================================================================
-- 0033 — Superseded engine overloads come back out
--
-- Later migrations replaced two functions with new signatures, which in
-- Postgres creates a NEW function beside the old one rather than replacing
-- it. Re-applying the old migrations by hand (0002, 0013) had re-created
-- the originals, and both did damage:
--
--   settle_delivered_positions(timestamptz, int)   — from 0013
--     The job calls settle_delivered_positions() with defaults, which now
--     matched both this and the current (timestamptz, int, uuid) version,
--     so every hourly sweep failed "could not choose the best candidate
--     function" and no delivered position settled.
--
--   execute_trade(uuid, uuid, text, numeric, timestamptz, timestamptz) — 0002
--     The pre-instrument engine, SECURITY DEFINER and executable by anon
--     and authenticated. It filled at the latest stored price for ANY
--     interval (the stale-price fallback 0011 removed), ignored the
--     simulation clock, and had no idempotency — a signed-in user calling
--     it over the API could fill their own account at a price from another
--     hour.
--
-- Every caller uses the current signatures. Never re-run a superseded
-- migration on its own: apply forward.
-- =====================================================================

drop function if exists public.settle_delivered_positions(timestamptz, integer);
drop function if exists public.execute_trade(uuid, uuid, text, numeric, timestamptz, timestamptz);

do $guard$
declare
  v_name text;
  v_count int;
begin
  foreach v_name in array array['settle_delivered_positions', 'execute_trade'] loop
    select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;
    if v_count <> 1 then
      raise exception '0033: expected exactly one public.% after cleanup, found %', v_name, v_count;
    end if;
  end loop;
end
$guard$;
