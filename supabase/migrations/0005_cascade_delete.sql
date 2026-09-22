-- =====================================================================
-- PowerFlow — allow FK-cascade teardown of user data (account deletion)
--
-- The immutability triggers below must not stand in the way of account
-- deletion: removing a row from auth.users cascades into every user table
-- (profiles, paper_accounts, trades, positions, audit_events). Postgres
-- fires the child-table row triggers during that cascade, so 'trades are
-- immutable' aborted user deletion at the database level — GoTrue surfaced
-- it as a 500 "Database error deleting user".
--
-- pg_trigger_depth() is 0 for direct mutations (an explicit UPDATE/DELETE)
-- and >0 while FK cascade enforcement is firing the triggers. Gating on it
-- preserves the immutability guarantee for every direct path (any role,
-- UPDATE or DELETE) while letting the ownership cascade remove data during
-- account teardown.
-- =====================================================================

create or replace function public.prevent_trade_mutation()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 0 then
    return old; -- FK cascade (account teardown), not a direct mutation
  end if;
  raise exception 'trades are immutable' using errcode = 'TRADE';
end;
$$;

create or replace function public.prevent_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 0 then
    return old; -- FK cascade (account teardown), not a direct mutation
  end if;
  raise exception 'audit events are immutable' using errcode = 'AUDIT';
end;
$$;