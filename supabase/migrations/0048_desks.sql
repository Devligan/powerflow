-- =====================================================================
-- 0048 — Desks: a practice account beside the live one
--
-- Replay is the fastest way to learn the desk: bid a past operating day,
-- watch it clear, deliver and settle in minutes. But since 0042 any bid
-- placed on a displaced clock marks the account replay_tainted_at for good,
-- and its results never rank again — so practising on the live account costs
-- a trader their place on the standings.
--
-- A desk is a second engine account a trader owns. The engine is keyed by
-- user id throughout (positions, orders, trades, margin, settlement, the
-- clock), so a desk is an auth user of its own that never signs in: created
-- by the server with an unroutable address and no password, bootstrapped by
-- handle_new_user like anyone else ($100,000, its own clock), and owned
-- through public.desks. Nothing in the engine changes except who may act for
-- an account:
--
--   1. public.desks: owner -> desk user. One practice desk per trader. A desk
--      cannot own desks. Deleting a desk row deletes its user, so its book
--      goes with it through the existing cascades; deleting the owner deletes
--      their desks the same way.
--   2. acts_for(p_user_id): the caller is that account, or owns it as a desk.
--      The six caller-checked trading functions use it in place of
--      auth.uid() = p_user_id, so ownership of a desk is enforced by the
--      engine itself, through the caller's own session — not by the app.
--
-- A desk's profile is never onboarded and never opted in, so it cannot appear
-- on the public standings (src/lib/standings.ts reads only onboarded
-- profiles), and replay taints it anyway.
-- =====================================================================

create table if not exists public.desks (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  desk_user_id uuid not null unique references auth.users (id) on delete cascade,
  kind         text not null,
  -- The operating day a practice desk is walking through (src/lib/practice.ts).
  -- Neighbouring days' practice windows overlap, so the clock alone cannot say.
  practice_day date,
  created_at   timestamptz not null default now(),
  constraint desk_kind_valid check (kind in ('PRACTICE', 'CHALLENGE')),
  constraint desk_not_self check (owner_id <> desk_user_id)
);

create unique index if not exists desks_one_practice_per_owner
  on public.desks (owner_id) where kind = 'PRACTICE';
create index if not exists desks_owner_idx on public.desks (owner_id);

alter table public.desks enable row level security;
revoke all on table public.desks from public, anon, authenticated;
grant all on table public.desks to service_role;

comment on table public.desks is
  'Engine accounts a trader owns beside their live one (practice, challenge). The desk user never signs in; the owner acts for it through acts_for(). Migration 0048.';

-- A desk is an account, not a trader: it cannot own desks of its own, and a
-- trader cannot be made someone else's desk.
create or replace function public.desks_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.desks where desk_user_id = new.owner_id) then
    raise exception 'DESK_CANNOT_OWN_DESKS';
  end if;
  if exists (select 1 from public.desks where owner_id = new.desk_user_id) then
    raise exception 'DESK_USER_INVALID';
  end if;
  return new;
end;
$$;

revoke execute on function public.desks_guard() from public, anon, authenticated;

drop trigger if exists desks_guard on public.desks;
create trigger desks_guard
  before insert or update on public.desks
  for each row execute function public.desks_guard();

-- The desk's user goes with its row, and its whole book with that user.
create or replace function public.desks_drop_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.users where id = old.desk_user_id;
  return old;
end;
$$;

revoke execute on function public.desks_drop_user() from public, anon, authenticated;

drop trigger if exists desks_drop_user on public.desks;
create trigger desks_drop_user
  after delete on public.desks
  for each row execute function public.desks_drop_user();

-- Who may act for an account: its own session, or the session of the trader
-- who owns it as a desk. Null when there is no session.
create or replace function public.acts_for(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() = p_user_id
      or exists (
           select 1 from public.desks d
           where d.owner_id = auth.uid() and d.desk_user_id = p_user_id
         );
$$;

revoke execute on function public.acts_for(uuid) from public, anon, authenticated;

-- The server creates the desk's user (through Auth, so it is a real account
-- handle_new_user bootstraps), then registers it here: the ownership row and
-- a profile that stays off the standings, in one transaction.
create or replace function public.register_desk(p_owner_id uuid, p_desk_user_id uuid, p_kind text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.paper_accounts where user_id = p_desk_user_id) then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;
  insert into public.desks (owner_id, desk_user_id, kind)
  values (p_owner_id, p_desk_user_id, p_kind)
  returning id into v_id;
  update public.profiles
     set leaderboard_opt_in = false, onboarded_at = null
   where id = p_desk_user_id;
  return v_id;
end;
$$;

revoke execute on function public.register_desk(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.register_desk(uuid, uuid, text) to service_role;

-- The six caller-checked trading functions: patched in place, as 0042 did,
-- each patch checked. The service role still passes where it did (the
-- `auth.uid() is not null and ...` form); a session must now act for the
-- account rather than be it.
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select * from (values
      ('public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure),
      ('public.cancel_order(uuid,uuid)'::regprocedure),
      ('public.set_sim_clock(uuid,timestamptz)'::regprocedure),
      ('public.clear_sim_clock(uuid)'::regprocedure),
      ('public.account_margin(uuid)'::regprocedure),
      ('public.position_marks(uuid)'::regprocedure)
    ) as t(fn)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position('not public.acts_for(p_user_id)' in v_def) > 0 then
      continue; -- already applied
    end if;
    if position('auth.uid() <> p_user_id' in v_def) = 0 then
      raise exception '0048: expected caller check not found in %', r.fn;
    end if;
    execute replace(v_def, 'auth.uid() <> p_user_id', 'not public.acts_for(p_user_id)');
  end loop;
end
$$;
