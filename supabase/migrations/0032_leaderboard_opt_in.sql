-- =====================================================================
-- 0032 — The leaderboard is opt-in, and a trader can say so
--
-- The site has always described leaderboard participation as opt-in, but
-- profiles.leaderboard_opt_in defaulted to TRUE and nothing let a user
-- change it: every account was listed, with no way out. Two corrections:
--
--   1. New accounts start unlisted. Existing accounts keep their current
--      setting, so nobody already on the board disappears without acting.
--   2. set_leaderboard_opt_in(p_opt_in): the caller changes their own flag
--      and the change is recorded as LEADERBOARD_OPT_IN_CHANGED, the audit
--      event the schema has reserved since 0001.
-- =====================================================================

alter table public.profiles alter column leaderboard_opt_in set default false;

create or replace function public.set_leaderboard_opt_in(p_opt_in boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_prev boolean;
begin
  if v_user is null then
    raise exception 'FORBIDDEN';
  end if;

  select leaderboard_opt_in into v_prev
  from public.profiles
  where id = v_user
  for update;
  if not found then
    raise exception 'PROFILE_NOT_FOUND';
  end if;

  if v_prev is distinct from p_opt_in then
    update public.profiles set leaderboard_opt_in = p_opt_in where id = v_user;
    insert into public.audit_events (
      user_id, event_type, entity_type, entity_id, metadata
    ) values (
      v_user, 'LEADERBOARD_OPT_IN_CHANGED', 'profile', v_user,
      jsonb_build_object('leaderboard_opt_in', p_opt_in)
    );
  end if;

  return p_opt_in;
end;
$$;

revoke execute on function public.set_leaderboard_opt_in(boolean) from public;
revoke execute on function public.set_leaderboard_opt_in(boolean) from anon;
grant execute on function public.set_leaderboard_opt_in(boolean) to authenticated;
