-- =====================================================================
-- PowerFlow — ACL hardening (security)
--
-- Postgres grants EXECUTE on functions to PUBLIC by default. That would
-- let the `anon` role reach SECURITY DEFINER write surfaces such as
-- ensure_user_records. Restrict execution to the minimal roles and make
-- username minting definer so the uniqueness probe sees all profiles
-- (seed duplicate usernames that would otherwise fail sign-ups).
-- =====================================================================

-- Deny unauthenticated + PUBLIC access to every function we create.
revoke execute on function public.mint_username(text, uuid) from public;
revoke execute on function public.ensure_user_records(uuid, text) from public;
revoke execute on function public.execute_trade(uuid, uuid, text, numeric, timestamptz, timestamptz) from public;
revoke execute on function public.latest_price_timestamps(uuid[]) from public;
revoke execute on function public.get_leaderboard(int) from public;
revoke execute on function public.set_updated_at() from public;
revoke execute on function public.prevent_trade_mutation() from public;
revoke execute on function public.prevent_audit_mutation() from public;

-- Account bootstrapping is a server-side (service-role) concern; the app
-- calls it through the admin client, never the user session.
revoke execute on function public.ensure_user_records(uuid, text) from authenticated;
grant execute on function public.ensure_user_records(uuid, text) to service_role;

-- Trade engine: authenticated sessions only (the FORBIDDEN guard above is
-- defense in depth; the anon role is now excluded at the ACL level too).
grant execute on function public.execute_trade(uuid, uuid, text, numeric, timestamptz, timestamptz)
  to authenticated;

-- Public market data + leaderboard remain public read surfaces.
grant execute on function public.get_leaderboard(int) to anon, authenticated;
grant execute on function public.latest_price_timestamps(uuid[]) to authenticated;
grant execute on function public.mint_username(text, uuid) to authenticated;

-- Trigger helpers must run with the invoking session role (invoker-style
-- triggers do not bypass EXECUTE), so re-grant the roles that may fire them.
grant execute on function public.set_updated_at() to authenticated, service_role;
grant execute on function public.prevent_trade_mutation() to authenticated, service_role;
grant execute on function public.prevent_audit_mutation() to authenticated, service_role;

-- Username minting: needs to check all profiles (uniqueness is global), but
-- the caller only ever supplies their own email/user id.
create or replace function public.mint_username(p_email text, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_candidate text;
begin
  v_base := lower(
    regexp_replace(split_part(coalesce(p_email, ''), '@', 1), '[^a-z0-9_]', '', 'g')
  );
  if v_base is null or length(v_base) < 3 then
    v_base := 'trader';
  end if;
  v_base := left(v_base, 20);

  if not exists (select 1 from public.profiles where username = v_base) then
    return v_base;
  end if;

  v_candidate := v_base || '_' || substr(md5(p_user_id::text), 1, 6);
  return v_candidate;
end;
$$;