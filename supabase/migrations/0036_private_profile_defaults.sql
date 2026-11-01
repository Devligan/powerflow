-- =====================================================================
-- 0036 — A new account's defaults no longer come from its email address
--
-- Since 0001 a new profile was named after the part of the email before the
-- "@": mint_username() made it the username, and handle_new_user() made it
-- the display name for every email sign-up. That put a piece of the address
-- wherever the name appeared, the public standings included, and a username
-- check could be used to probe whether an address had an account.
--
--   1. mint_username(p_email, p_user_id) ignores the email and returns a
--      random "trader_xxxxxxxx", retrying on the (vanishingly rare)
--      collision. The signature is unchanged so ensure_user_records (0012)
--      and handle_new_user keep calling it as they do.
--   2. handle_new_user() takes a display name only from what an OAuth
--      provider supplies as the person's name; otherwise it is left NULL and
--      the trader chooses one on /welcome (0035) before anything shows it.
--
-- Existing rows are not rewritten: an account keeps the name it has until
-- it changes it. The app hides accounts that have not chosen a name from the
-- standings (src/lib/standings.ts), so no default is shown publicly either way.
-- =====================================================================

create or replace function public.mint_username(p_email text, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate text;
begin
  -- p_email and p_user_id are deliberately unused: a username must not be
  -- derivable from either.
  loop
    v_candidate := 'trader_' || substr(md5(gen_random_uuid()::text), 1, 8);
    exit when not exists (select 1 from public.profiles where username = v_candidate);
  end loop;
  return v_candidate;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    public.mint_username(new.email, new.id),
    -- A name the person gave their identity provider, never the email.
    nullif(btrim(left(coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    ), 40)), ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do nothing;

  insert into public.paper_accounts (user_id, starting_cash, cash_balance)
  values (new.id, 100000, 100000)
  on conflict (user_id) do nothing;

  insert into public.audit_events (user_id, event_type, entity_type, entity_id, metadata)
  values (new.id, 'USER_CREATED', 'user', new.id, jsonb_build_object('email', new.email))
  on conflict do nothing;

  return new;
end;
$$;

-- Restated so the ACL is right even where an earlier grant was missed.
revoke execute on function public.mint_username(text, uuid) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
