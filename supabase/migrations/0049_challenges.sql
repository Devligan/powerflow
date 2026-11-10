-- =====================================================================
-- 0049 — Challenges: the same past days, traded by friends, ranked
--
-- A challenge is a run of one to five past operating days. Everyone who
-- enters gets a fresh challenge desk (0048) — its own $100,000 — with its
-- clock set to 08:00 Central the day before the first day, and trades those
-- days as ERCOT ran them. Finishing moves the desk to the instant the last
-- day's real-time prices were final, settles it, and records its equity: the
-- challenge's standings are entrants' P&L on identical markets and identical
-- capital.
--
-- What makes it a contest rather than a replay:
--   1. The desk's clock only moves forward, never past the finish, and never
--      back to live: a trader cannot look at real time and go back to bid.
--   2. Bids are accepted only for the challenge's own operating days.
--   3. A finished entry is closed: no more bids, no more clock moves.
-- Each is a guard function the engine calls right after its caller check,
-- patched into set_sim_clock, clear_sim_clock and place_limit_order as 0042
-- and 0048 patched them. A desk that is not in a challenge passes untouched.
--
-- The market data is public and the days are past, so a determined entrant
-- can always look them up elsewhere; the guards keep the desk itself honest.
-- =====================================================================

create table if not exists public.challenges (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  first_day   date not null,
  last_day    date not null,
  -- Where an entrant's clock starts, and the instant the last day's prices
  -- were final (src/lib/practice.ts computes both from ERCOT's calendar).
  starts_at   timestamptz not null,
  finishes_at timestamptz not null,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint challenge_slug_format check (slug ~ '^[a-z0-9]{8}$'),
  constraint challenge_title_length check (char_length(btrim(title)) between 3 and 60),
  constraint challenge_days_valid check (last_day >= first_day and last_day - first_day <= 4),
  constraint challenge_window_valid check (finishes_at > starts_at)
);

create table if not exists public.challenge_entries (
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- Kept after the desk is gone, so a result outlives a reset.
  desk_id      uuid unique references public.desks (id) on delete set null,
  status       text not null default 'ACTIVE',
  entered_at   timestamptz not null default now(),
  finished_at  timestamptz,
  final_equity numeric,
  pnl          numeric,
  primary key (challenge_id, user_id),
  constraint challenge_entry_status_valid check (status in ('ACTIVE', 'FINISHED')),
  constraint challenge_entry_result check (
    (status = 'ACTIVE' and final_equity is null)
    or (status = 'FINISHED' and final_equity is not null and finished_at is not null)
  )
);

create index if not exists challenge_entries_user_idx on public.challenge_entries (user_id);

alter table public.challenges enable row level security;
alter table public.challenge_entries enable row level security;
revoke all on table public.challenges, public.challenge_entries from public, anon, authenticated;
grant all on table public.challenges, public.challenge_entries to service_role;

comment on table public.challenges is
  'A run of past operating days that entrants trade on fresh challenge desks and are ranked on. Migration 0049.';

-- The challenge an account is trading, if it is a challenge desk.
create or replace function public.challenge_of(p_user_id uuid)
returns table (challenge_id uuid, status text, first_day date, last_day date, starts_at timestamptz, finishes_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, e.status, c.first_day, c.last_day, c.starts_at, c.finishes_at
  from public.desks d
  join public.challenge_entries e on e.desk_id = d.id
  join public.challenges c on c.id = e.challenge_id
  where d.desk_user_id = p_user_id;
$$;

revoke execute on function public.challenge_of(uuid) from public, anon, authenticated;

-- 1 + 3: the clock of a challenge desk moves forward, within the challenge,
-- while the entry is open. p_iso null is a request to go back to live.
create or replace function public.challenge_check_clock(p_user_id uuid, p_iso timestamptz)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v record;
begin
  select * into v from public.challenge_of(p_user_id);
  if not found then
    return;
  end if;
  if v.status <> 'ACTIVE' then
    raise exception 'CHALLENGE_FINISHED';
  end if;
  if p_iso is null then
    raise exception 'CHALLENGE_DESK_REPLAY_ONLY';
  end if;
  -- A second of slack: the clock runs while the request is in flight.
  if p_iso < public.sim_now(p_user_id) - interval '1 second' then
    raise exception 'CHALLENGE_CLOCK_FORWARD_ONLY';
  end if;
  if p_iso > v.finishes_at then
    raise exception 'CHALLENGE_CLOCK_PAST_END';
  end if;
end;
$$;

revoke execute on function public.challenge_check_clock(uuid, timestamptz) from public, anon, authenticated;

-- 2 + 3: a challenge desk bids only on the challenge's own operating days,
-- while the entry is open. An operating day is a Central calendar day.
create or replace function public.challenge_check_order(p_user_id uuid, p_delivery_start timestamptz)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v record;
  v_day date;
begin
  select * into v from public.challenge_of(p_user_id);
  if not found then
    return;
  end if;
  if v.status <> 'ACTIVE' then
    raise exception 'CHALLENGE_FINISHED';
  end if;
  v_day := (p_delivery_start at time zone 'America/Chicago')::date;
  if v_day < v.first_day or v_day > v.last_day then
    raise exception 'CHALLENGE_DAY_OUTSIDE';
  end if;
end;
$$;

revoke execute on function public.challenge_check_order(uuid, timestamptz) from public, anon, authenticated;

-- The guards go in right after each function's caller check. Bodies were
-- written with LF or CRLF depending on the checkout that applied them, so the
-- anchor is a pattern; regexp_replace without 'g' patches the first match.
do $$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in
    select * from (values
      ('public.set_sim_clock(uuid,timestamptz)'::regprocedure,
       'perform public.challenge_check_clock(p_user_id, p_iso);'),
      ('public.clear_sim_clock(uuid)'::regprocedure,
       'perform public.challenge_check_clock(p_user_id, null);'),
      ('public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure,
       'perform public.challenge_check_order(p_user_id, p_delivery_start);')
    ) as t(fn, guard)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position(r.guard in v_def) > 0 then
      continue; -- already applied
    end if;
    v_new := regexp_replace(
      v_def,
      '(raise exception ''FORBIDDEN'';\s*end if;)',
      E'\\1\n  -- 0049: a challenge desk plays by the challenge''s rules.\n  ' || r.guard
    );
    if v_new = v_def then
      raise exception '0049: caller check not found in %', r.fn;
    end if;
    execute v_new;
  end loop;
end
$$;

-- Entering: the server has created the desk's user (src/lib/desk.ts); this
-- registers it to the challenge and starts its clock, in one transaction.
create or replace function public.enter_challenge(p_owner_id uuid, p_challenge_id uuid, p_desk_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge public.challenges%rowtype;
  v_desk uuid;
begin
  select * into v_challenge from public.challenges where id = p_challenge_id;
  if not found then
    raise exception 'CHALLENGE_NOT_FOUND';
  end if;
  if exists (select 1 from public.challenge_entries where challenge_id = p_challenge_id and user_id = p_owner_id) then
    raise exception 'CHALLENGE_ALREADY_ENTERED';
  end if;
  if not exists (select 1 from public.paper_accounts where user_id = p_desk_user_id) then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  insert into public.desks (owner_id, desk_user_id, kind)
  values (p_owner_id, p_desk_user_id, 'CHALLENGE')
  returning id into v_desk;
  update public.profiles
     set leaderboard_opt_in = false, onboarded_at = null
   where id = p_desk_user_id;
  -- The clock starts at the challenge's start, before its guard applies.
  update public.paper_accounts
     set sim_clock_offset = least(0, (extract(epoch from (v_challenge.starts_at - clock_timestamp())) * 1000000000)::bigint)
   where user_id = p_desk_user_id;
  insert into public.challenge_entries (challenge_id, user_id, desk_id)
  values (p_challenge_id, p_owner_id, v_desk);
  return v_desk;
end;
$$;

revoke execute on function public.enter_challenge(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.enter_challenge(uuid, uuid, uuid) to service_role;

-- Finishing, step 1: the clock goes to the finish (forward only, so a desk
-- already there stays). The server then sweeps and settles the desk — those
-- sweeps are service-role jobs — and records the result.
create or replace function public.challenge_advance_to_finish(p_owner_id uuid, p_challenge_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desk_user uuid;
  v_finish timestamptz;
begin
  select d.desk_user_id, c.finishes_at into v_desk_user, v_finish
  from public.challenge_entries e
  join public.desks d on d.id = e.desk_id
  join public.challenges c on c.id = e.challenge_id
  where e.challenge_id = p_challenge_id and e.user_id = p_owner_id and e.status = 'ACTIVE'
  for update of e;
  if not found then
    raise exception 'CHALLENGE_ENTRY_NOT_ACTIVE';
  end if;
  if public.sim_now(v_desk_user) < v_finish then
    update public.paper_accounts
       set sim_clock_offset = least(0, (extract(epoch from (v_finish - clock_timestamp())) * 1000000000)::bigint)
     where user_id = v_desk_user;
  end if;
  return v_desk_user;
end;
$$;

revoke execute on function public.challenge_advance_to_finish(uuid, uuid) from public, anon, authenticated;
grant execute on function public.challenge_advance_to_finish(uuid, uuid) to service_role;

-- Finishing, step 2: the desk's equity as the engine marks it, against the
-- capital every entrant started with.
create or replace function public.challenge_record_result(p_owner_id uuid, p_challenge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desk_user uuid;
  v_equity numeric;
  v_start numeric;
begin
  select d.desk_user_id into v_desk_user
  from public.challenge_entries e
  join public.desks d on d.id = e.desk_id
  where e.challenge_id = p_challenge_id and e.user_id = p_owner_id and e.status = 'ACTIVE'
  for update of e;
  if not found then
    raise exception 'CHALLENGE_ENTRY_NOT_ACTIVE';
  end if;
  select m.equity into v_equity from public.account_margin(v_desk_user) m;
  select starting_cash into v_start from public.paper_accounts where user_id = v_desk_user;

  -- Closed: any bid still resting can no longer change the result.
  update public.paper_orders
     set status = 'CANCELLED', updated_at = clock_timestamp()
   where user_id = v_desk_user and status = 'OPEN';

  update public.challenge_entries
     set status = 'FINISHED',
         finished_at = clock_timestamp(),
         final_equity = v_equity,
         pnl = v_equity - v_start
   where challenge_id = p_challenge_id and user_id = p_owner_id;
  return jsonb_build_object('equity', v_equity, 'pnl', v_equity - v_start);
end;
$$;

revoke execute on function public.challenge_record_result(uuid, uuid) from public, anon, authenticated;
grant execute on function public.challenge_record_result(uuid, uuid) to service_role;
