-- =====================================================================
-- 0016 — Immutability guards: fix the cascade exemption that disabled them
--
-- 0005 introduced a `pg_trigger_depth()` guard so that deleting a row from
-- `auth.users` could cascade into `trades` and `audit_events` without the
-- immutability triggers aborting the teardown. Its stated premise was:
--
--   "pg_trigger_depth() is 0 for direct mutations (an explicit UPDATE/DELETE)
--    and >0 while FK cascade enforcement is firing the triggers."
--
-- The first half of that is wrong. `pg_trigger_depth()` counts the frame the
-- *current* trigger is running in, so inside a trigger function invoked as a
-- trigger it is already 1:
--
--   outside any trigger ............ 0
--   inside a trigger function ...... 1
--   during an ON DELETE CASCADE .... 2      (the RI trigger is depth 1)
--
-- So `> 0` was true on every path, and neither function ever reached its
-- `raise exception`. Measured against the deployed schema, both tables were
-- mutable by any role that bypasses RLS:
--
--   UPDATE trades SET quantity_mwh = 999999   ->  reported UPDATE 1,
--                                                 value unchanged
--   DELETE FROM trades WHERE id = ...         ->  deleted the row
--   DELETE FROM audit_events WHERE id = ...   ->  deleted the row
--
-- The UPDATE case is the subtler half: a BEFORE UPDATE trigger that returns
-- `old` makes Postgres rewrite the row with its previous values and report the
-- statement as successful. It looks immutable while raising nothing, which is
-- why it went unnoticed — the data was intact, so nothing looked wrong.
--
-- The fix is the boundary: a direct mutation is depth 1 and must raise, a
-- cascade is depth 2 and must be allowed. Nothing else changes, and the
-- cascade branch now returns the row the statement actually intended rather
-- than always `old` (for a DELETE `new` is NULL, so `coalesce(new, old)` is
-- `old` — which is what a delete needs; for an update it is `new`, so a
-- cascade can never be turned into a silent no-op).
--
-- 0001's claim — "nothing may mutate executed trades or audit events, even
-- through the service role" — holds again once this is applied. The functions
-- are re-created rather than altered because a plpgsql body cannot be patched
-- in place; `create or replace` preserves their ACLs from 0004.
-- =====================================================================

create or replace function public.prevent_trade_mutation()
returns trigger
language plpgsql
as $$
begin
  -- Depth 2 is an FK cascade (account teardown). Depth 1 is this trigger's own
  -- frame, i.e. a direct UPDATE/DELETE, which must be refused.
  if pg_trigger_depth() > 1 then
    return coalesce(new, old); -- FK cascade, not a direct mutation
  end if;
  raise exception 'trades are immutable' using errcode = 'TRADE';
end;
$$;

create or replace function public.prevent_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old); -- FK cascade, not a direct mutation
  end if;
  raise exception 'audit events are immutable' using errcode = 'AUDIT';
end;
$$;
