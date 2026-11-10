-- =====================================================================
-- 0046 — Least privilege for the public API
--
-- A signed-in session's JWT reaches PostgREST directly, and so does the
-- anonymous key in every browser. Whatever those two roles can call or read,
-- anyone can, as often as they like, with no limit this app can apply.
--
--   1. Functions. Every function in public was callable by `authenticated`
--      (one also by `anon`): Supabase's default privileges grant EXECUTE on
--      each new function, so each migration had to remember to revoke. The
--      app calls eight of them in a user's session — all SECURITY DEFINER,
--      each checking auth.uid() — and nothing else. Everything else, from the
--      price helpers to execute_trade (which has refused every user fill
--      since 0038), is now the service role's and the engine's alone. One of
--      them, ercot_business_day_after (0044), looped once per day of an
--      unbounded argument: a CPU sink any user could call.
--   2. Market data. market_prices (hundreds of thousands of rows, growing
--      ~2,000 an hour) and the current_prices view over it were readable by
--      anonymous visitors with any filter and sort. The app reads them only
--      through the service role. markets, products and instruments stay
--      readable when signed in, not anonymously.
--   3. Default privileges. New functions, tables and sequences no longer
--      reach anon or authenticated unless a migration grants them, so a
--      forgotten REVOKE fails closed.
--   4. Two indexes for what every ingestion run (four an hour) asks of the
--      whole price store: the interim hourly prices promote_rtm_finals looks
--      for, and the newest 15-minute print the staleness check reads. Both
--      were sequential scans of a table that only grows.
-- =====================================================================

-- 0. The service role keeps every function, whatever reached it before.
grant execute on all functions in schema public to service_role;

-- 1. Functions: revoke everything, then grant back what a session uses.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.fn);
  end loop;
end
$$;

grant execute on function public.account_margin(uuid) to authenticated;
grant execute on function public.cancel_order(uuid, uuid) to authenticated;
grant execute on function public.clear_sim_clock(uuid) to authenticated;
grant execute on function public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz) to authenticated;
grant execute on function public.position_marks(uuid) to authenticated;
grant execute on function public.set_leaderboard_opt_in(boolean) to authenticated;
grant execute on function public.set_sim_clock(uuid, timestamptz) to authenticated;
grant execute on function public.update_profile(text, text) to authenticated;

-- The engine's own day count, bounded whoever calls it.
create or replace function public.ercot_business_day_after(p_day date, p_n int)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  v_day date := p_day;
  v_left int := p_n;
begin
  if p_day is null or p_n is null or p_n < 1 or p_n > 31 then
    raise exception 'BUSINESS_DAYS_INVALID';
  end if;
  while v_left > 0 loop
    v_day := v_day + 1;
    if extract(isodow from v_day) < 6 and not public.ercot_is_holiday(v_day) then
      v_left := v_left - 1;
    end if;
  end loop;
  return v_day;
end;
$$;

-- 2. Market data.
drop policy if exists "market_prices public read" on public.market_prices;
revoke all on table public.market_prices from anon, authenticated;
revoke all on table public.current_prices from anon, authenticated;
revoke all on table public.markets, public.products, public.instruments from anon;

-- 3. New objects fail closed.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

-- 4. Indexes for the ingestion run.
create index if not exists market_prices_rtm_interim_idx
  on public.market_prices (delivery_timestamp)
  where product = 'RTM_HOURLY' and is_final = false;
create index if not exists market_prices_product_delivery_idx
  on public.market_prices (product, delivery_timestamp desc);
