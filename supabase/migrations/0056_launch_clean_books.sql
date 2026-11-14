-- =====================================================================
-- 0056 — Launch: every live book starts from real bids
--
-- The desk now offers exactly what it should (0042: virtuals and DA PTP
-- obligations) and a live account can no longer replay (0053, 0055). What
-- the build-out left behind is a few books whose results came from neither:
-- fills on instruments the desk has since retired, and fills placed on a
-- displaced clock. Such a book can never rank (0042) and reads as a record
-- of trading that did not happen live. So, once:
--
--   1. The diagnostic accounts on the reserved test.local domain (0031) are
--      deleted, with their books, through the ownership cascade (0016).
--   2. Every live account (not a desk) that holds a replay fill or a fill on
--      a retired instrument starts over: its bids, positions, fills and their
--      audit trail are removed, its cash goes back to its starting cash, and
--      it may rank again. The account, its profile and its settings stay,
--      and the reset is itself audited (ACCOUNT_RESET).
--
-- Trades and audit events refuse a direct delete (0001, 0016). That holds
-- for every role at runtime; only this migration, as the table owner, lifts
-- the guard for the duration of its own transaction, and puts it back.
-- The ledger must reconcile for every reset account before it commits.
-- =====================================================================

-- 1. Diagnostic accounts.
delete from auth.users u
where u.email like '%@test.local'
  and not exists (select 1 from public.desks d where d.desk_user_id = u.id);

-- 2. Books built off the live desk.
alter table public.audit_events drop constraint if exists audit_event_type_valid;
alter table public.audit_events
  add constraint audit_event_type_valid
  check (
    event_type in (
      'USER_CREATED',
      'ACCOUNT_CREATED',
      'TRADE_CREATED',
      'TRADE_VALIDATED',
      'TRADE_EXECUTED',
      'TRADE_REJECTED',
      'POSITION_UPDATED',
      'PROFILE_UPDATED',
      'LEADERBOARD_OPT_IN_CHANGED',
      'POSITION_SETTLED',
      'ORDER_PLACED',
      'ORDER_FILLED',
      'ORDER_CANCELLED',
      'MARGIN_CALL',
      'FORCED_LIQUIDATION',
      'ACCOUNT_DEFICIT',
      'DEFICIT_REPAID',
      'SIM_CLOCK_CHANGED',
      'ACCOUNT_RESET'
    )
  );

create temporary table reset_accounts as
select a.id as account_id, a.user_id,
       (select count(*) from public.trades t where t.user_id = a.user_id) as trades,
       (select count(*) from public.positions p where p.user_id = a.user_id) as positions,
       (select count(*) from public.paper_orders o where o.user_id = a.user_id) as orders,
       a.cash_balance - a.deficit as cash_before
from public.paper_accounts a
where not exists (select 1 from public.desks d where d.desk_user_id = a.user_id)
  and (
    a.replay_tainted_at is not null
    or exists (
      select 1
      from public.trades t
      join public.instruments i on i.code = t.instrument
      where t.user_id = a.user_id and not i.orderable
    )
  );

alter table public.trades disable trigger trg_trades_immutable;
alter table public.audit_events disable trigger trg_audit_immutable;

delete from public.paper_orders o using reset_accounts r where o.user_id = r.user_id;
delete from public.positions p using reset_accounts r where p.user_id = r.user_id;
delete from public.trades t using reset_accounts r where t.user_id = r.user_id;
delete from public.audit_events e using reset_accounts r
where e.user_id = r.user_id
  and e.event_type not in ('USER_CREATED', 'ACCOUNT_CREATED', 'PROFILE_UPDATED', 'LEADERBOARD_OPT_IN_CHANGED');

alter table public.trades enable trigger trg_trades_immutable;
alter table public.audit_events enable trigger trg_audit_immutable;

update public.paper_accounts a
set cash_balance = a.starting_cash,
    deficit = 0,
    replay_tainted_at = null
from reset_accounts r
where a.id = r.account_id;

insert into public.audit_events (user_id, event_type, entity_type, entity_id, metadata)
select r.user_id, 'ACCOUNT_RESET', 'account', r.account_id,
       jsonb_build_object(
         'migration', '0056',
         'reason', 'book held replay fills or fills on retired instruments',
         'trades_removed', r.trades,
         'positions_removed', r.positions,
         'orders_removed', r.orders,
         'cash_before', r.cash_before)
from reset_accounts r;

do $$
declare
  v_ids uuid[] := array(select user_id from reset_accounts);
begin
  if exists (select 1 from public.ledger_violations(v_ids)) then
    raise exception '0056: a reset account does not reconcile';
  end if;
  raise notice '0056: % account(s) reset', coalesce(array_length(v_ids, 1), 0);
end
$$;

drop table reset_accounts;
