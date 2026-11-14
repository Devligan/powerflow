-- =====================================================================
-- 0055 — Retire challenges, the practice desk, and session clock moves
--
-- PowerFlow is an ERCOT paper-trading desk: the whole product is the
-- practice, so the practice desk (0048) and challenges (0049) left the app
-- (PR #47). What they left in the engine is retired here:
--
--   1. The challenge guards 0049 patched into set_sim_clock, clear_sim_clock
--      and place_limit_order come out again, and the challenge tables and
--      functions are dropped. No challenge desk exists.
--   2. Every remaining practice desk is deleted. Nothing can reach one any
--      more, and its book was a replay. Deleting the row deletes its user and
--      book through 0048's trigger and the existing cascades.
--   3. No session may call set_sim_clock or clear_sim_clock. The app has no
--      clock to move; a session could only write SIM_CLOCK_CHANGED audit rows
--      to its own live account (0053 already refused any real move). The
--      service role keeps both, for the engine's test suites.
--
-- What stays: per-account clocks (0020), which every as-of read resolves
-- through; desks as the only accounts that may replay (0053), which the DB
-- suites use to test the as-of engine on past days (createReplayTestUser);
-- and acts_for (0048), which the caller checks still go through.
-- =====================================================================

-- 1. The guards out, checked: each body must lose its guard call and nothing
--    else. Bodies were stored with LF or CRLF, so the match is a pattern.
do $$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in
    select * from (values
      ('public.set_sim_clock(uuid,timestamptz)'::regprocedure),
      ('public.clear_sim_clock(uuid)'::regprocedure),
      ('public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure)
    ) as t(fn)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position('challenge_check_' in v_def) = 0 then
      continue; -- already removed
    end if;
    v_new := regexp_replace(
      v_def,
      '\s*-- 0049: a challenge desk plays by the challenge''s rules\.\s*perform public\.challenge_check_(clock|order)\([^)]*\);',
      ''
    );
    if position('challenge_check_' in v_new) > 0 then
      raise exception '0055: challenge guard not removed from %', r.fn;
    end if;
    execute v_new;
  end loop;
end
$$;

drop function if exists public.challenge_record_result(uuid, uuid);
drop function if exists public.challenge_advance_to_finish(uuid, uuid);
drop function if exists public.enter_challenge(uuid, uuid, uuid);
drop function if exists public.challenge_check_order(uuid, timestamptz);
drop function if exists public.challenge_check_clock(uuid, timestamptz);
drop function if exists public.challenge_of(uuid);
drop table if exists public.challenge_entries;
drop table if exists public.challenges;

-- 2. The desks that are left, and the columns and kinds only they used.
delete from public.desks;

alter table public.desks drop constraint if exists desk_kind_valid;
alter table public.desks add constraint desk_kind_valid check (kind = 'PRACTICE');
alter table public.desks drop column if exists practice_day;

comment on table public.desks is
  'Accounts allowed to replay past days on a displaced clock (0053). The app creates none since 0055; the DB test suites use them to test the as-of engine. Deleting a row deletes its user and book. Migration 0048.';

-- 3. Clocks move only for the service role.
revoke execute on function public.set_sim_clock(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.clear_sim_clock(uuid) from public, anon, authenticated;
grant execute on function public.set_sim_clock(uuid, timestamptz) to service_role;
grant execute on function public.clear_sim_clock(uuid) to service_role;
