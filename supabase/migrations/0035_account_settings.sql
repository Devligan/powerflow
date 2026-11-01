-- =====================================================================
-- 0035 — Account settings: a chosen trader name, a profile picture, and
--        profile writes that go through the definer functions only
--
--   1. profiles.onboarded_at: NULL until the trader has chosen their name.
--      The app sends a signed-in account with no onboarded_at to /welcome
--      before the desk. Existing accounts are not backfilled — each picks
--      its name once, from a form prefilled with what it has today.
--
--   2. Profile writes are definer-only. Since 0001 the "profiles own
--      update" policy (plus Supabase's default table grants) let a session
--      write any column of its own row straight through PostgREST: any
--      avatar_url (an arbitrary external image on the public standings), a
--      leaderboard flag that bypassed 0032's audit, a username nobody
--      validated beyond the format check. The insert/update policies are
--      dropped and the write grants revoked; SELECT of the own row stays.
--
--   3. update_profile(p_username, p_display_name): the caller renames
--      themselves. Validated here (the TS mirror is src/lib/profile.ts),
--      audited as PROFILE_UPDATED with the before/after of each change, and
--      marks the profile onboarded.
--
--   4. set_profile_avatar(p_user_id, p_avatar_url): service_role only. The
--      upload route stores the image in the `avatars` bucket and records its
--      public URL here; a user session cannot point its avatar anywhere.
--
--   5. The `avatars` storage bucket: public read (the standings show the
--      pictures), 1 MB, PNG/JPEG/WebP only. No storage.objects policies, so
--      only the service role can write or list it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Onboarding marker
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists onboarded_at timestamptz;

comment on column public.profiles.onboarded_at is
  'When the trader chose their name (update_profile). NULL = not yet: '
  'the app routes the account to /welcome before the desk.';

-- ---------------------------------------------------------------------
-- 2. Profile writes go through definer functions only
-- ---------------------------------------------------------------------
drop policy if exists "profiles own insert" on public.profiles;
drop policy if exists "profiles own update" on public.profiles;

revoke insert, update, delete, truncate, references, trigger
  on public.profiles from anon, authenticated;
-- anon has no select policy, so the grant was already inert; remove it.
revoke select on public.profiles from anon;

-- ---------------------------------------------------------------------
-- 3. update_profile
-- ---------------------------------------------------------------------
create or replace function public.update_profile(
  p_username text,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_prev public.profiles%rowtype;
  v_username text := lower(btrim(coalesce(p_username, '')));
  -- Runs of whitespace (including newlines and tabs) collapse to one space.
  v_display text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
  v_changes jsonb := '{}'::jsonb;
  v_onboarding boolean;
begin
  if v_user is null then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_prev from public.profiles where id = v_user for update;
  if not found then
    raise exception 'PROFILE_NOT_FOUND';
  end if;

  if v_username !~ '^[a-z0-9_]{3,30}$' then
    raise exception 'USERNAME_INVALID';
  end if;
  -- A name already held is kept even if it is now reserved; only a change
  -- to a reserved name is refused.
  if v_username is distinct from v_prev.username and v_username = any (array[
    'admin', 'administrator', 'root', 'support', 'help', 'system', 'staff',
    'moderator', 'mod', 'official', 'security', 'api', 'null', 'undefined',
    'settings', 'account', 'powerflow', 'ercot'
  ]) then
    raise exception 'USERNAME_RESERVED';
  end if;
  if v_username is distinct from v_prev.username and exists (
    select 1 from public.profiles where username = v_username and id <> v_user
  ) then
    raise exception 'USERNAME_TAKEN';
  end if;

  if char_length(v_display) < 1 or char_length(v_display) > 40
     or v_display ~ '[[:cntrl:]]' then
    raise exception 'DISPLAY_NAME_INVALID';
  end if;

  if v_username is distinct from v_prev.username then
    v_changes := v_changes || jsonb_build_object(
      'username', jsonb_build_object('from', v_prev.username, 'to', v_username));
  end if;
  if v_display is distinct from v_prev.display_name then
    v_changes := v_changes || jsonb_build_object(
      'display_name', jsonb_build_object('from', v_prev.display_name, 'to', v_display));
  end if;
  v_onboarding := v_prev.onboarded_at is null;

  begin
    update public.profiles
    set username = v_username,
        display_name = v_display,
        onboarded_at = coalesce(onboarded_at, now())
    where id = v_user;
  exception when unique_violation then
    -- Lost a race for the same name with another session.
    raise exception 'USERNAME_TAKEN';
  end;

  if v_changes <> '{}'::jsonb or v_onboarding then
    insert into public.audit_events (
      user_id, event_type, entity_type, entity_id, metadata
    ) values (
      v_user, 'PROFILE_UPDATED', 'profile', v_user,
      jsonb_build_object('changes', v_changes, 'onboarding', v_onboarding)
    );
  end if;

  return jsonb_build_object(
    'username', v_username,
    'display_name', v_display,
    'onboarded', true
  );
end;
$$;

revoke execute on function public.update_profile(text, text) from public;
revoke execute on function public.update_profile(text, text) from anon;
grant execute on function public.update_profile(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. set_profile_avatar (service role: the upload route)
-- ---------------------------------------------------------------------
create or replace function public.set_profile_avatar(
  p_user_id uuid,
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  -- Service role runs with auth.uid() NULL. Like ensure_user_records (0012),
  -- the guard holds even if a future grant opens this to sessions.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;
  if p_avatar_url is not null
     and (p_avatar_url !~ '^https://' or char_length(p_avatar_url) > 1024) then
    raise exception 'AVATAR_URL_INVALID';
  end if;

  select avatar_url into v_prev from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'PROFILE_NOT_FOUND';
  end if;

  if v_prev is distinct from p_avatar_url then
    update public.profiles set avatar_url = p_avatar_url where id = p_user_id;
    insert into public.audit_events (
      user_id, event_type, entity_type, entity_id, metadata
    ) values (
      p_user_id, 'PROFILE_UPDATED', 'profile', p_user_id,
      jsonb_build_object('avatar', case when p_avatar_url is null then 'removed' else 'uploaded' end)
    );
  end if;
end;
$$;

revoke execute on function public.set_profile_avatar(uuid, text) from public, anon, authenticated;
grant execute on function public.set_profile_avatar(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 5. Avatars bucket
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
