-- =====================================================================
-- PowerFlow — security boundary (authorization)
--
-- Findings from attacking the live database as an *unauthenticated* caller
-- (the bare anon key a browser holds), not from reading the policies.
--
-- 1. `ensure_user_records` was executable by `anon` and, by design of the
--    Supabase default privileges, still is. `0004_harden_acl.sql` revoked
--    execute from `public` and from `authenticated` — but Supabase grants
--    EXECUTE to `postgres, anon, authenticated, service_role` on every
--    function created in `public` via default privileges, so revoking
--    PUBLIC does *not* remove the explicit `anon` grant. The result was
--    exactly inverted from the intent: `authenticated` could not call it and
--    an **unauthenticated** caller could. Because the function is SECURITY
--    DEFINER, a bare anon key could write a forged `USER_CREATED` row into
--    any user's immutable audit log (confirmed: HTTP 204, row appended), and
--    could bootstrap a `paper_accounts` row for any id it could learn. The
--    ids are learnable from `get_leaderboard`, which is why that surface is
--    tightened below too.
--
-- 2. The fix is both an ACL change (deny anon) and a guard inside the
--    function (defense in depth: even if a future grant re-opens it, a user
--    session may only bootstrap *itself*).
--
-- 3. `ingestion_runs` carried a `using (true)` SELECT policy for every
--    authenticated user, exposing global ingestion telemetry. It is read
--    server-side only, so the policy is removed (service role bypasses RLS).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Account bootstrapping: server-side (service role) only.
-- ---------------------------------------------------------------------
-- Recreated with an authorization guard, so the grant is not the only thing
-- standing between a caller and another user's accounts/audit log.
create or replace function public.ensure_user_records(p_user_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := coalesce(p_email, '');
begin
  -- Service role (and only service role) runs with auth.uid() NULL; a user
  -- session may bootstrap its own id and nothing else. Keeping this check
  -- inside the definer function means a mistaken future grant cannot turn
  -- this into a cross-user write.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN: cannot bootstrap records for another user';
  end if;

  insert into public.profiles (id, username)
  values (p_user_id, public.mint_username(v_email, p_user_id))
  on conflict (id) do nothing;

  insert into public.paper_accounts (user_id, starting_cash, cash_balance)
  values (p_user_id, 100000, 100000)
  on conflict (user_id) do nothing;

  insert into public.audit_events (user_id, event_type, entity_type, entity_id, metadata)
  values (p_user_id, 'USER_CREATED', 'user', p_user_id, jsonb_build_object('email', v_email))
  on conflict do nothing;
end;
$$;

-- `anon` is the grant 0004 missed (default privileges re-add it on create);
-- `authenticated` was already revoked but is restated so the ACL is correct
-- even on a database where 0004 was never applied.
revoke execute on function public.ensure_user_records(uuid, text) from public, anon, authenticated;
grant execute on function public.ensure_user_records(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 2. Leaderboard: it returns raw `user_id`s, so it is not an anon surface.
-- ---------------------------------------------------------------------
-- Both call sites (the leaderboard RSC and /api/leaderboard) use the service
-- role. Exposing a machine-readable list of user ids to an unauthenticated
-- visitor is what made finding 1 exploitable at scale.
revoke execute on function public.get_leaderboard(int) from public, anon, authenticated;
grant execute on function public.get_leaderboard(int) to service_role;

-- ---------------------------------------------------------------------
-- 3. Trigger helpers are not RPC entry points.
-- ---------------------------------------------------------------------
-- Postgres already refuses to execute a trigger-returning function outside a
-- trigger, but there is no reason to leave them PUBLIC-executable.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon;
revoke execute on function public.prevent_trade_mutation() from public, anon;
revoke execute on function public.prevent_audit_mutation() from public, anon;

-- ---------------------------------------------------------------------
-- 4. Ingestion telemetry is not user data.
-- ---------------------------------------------------------------------
drop policy if exists "ingestion_runs read" on public.ingestion_runs;

-- ---------------------------------------------------------------------
-- 5. Remove the probe helper left behind by the audit.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pf_depth_probe'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end
$$;
