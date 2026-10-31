-- =====================================================================
-- 0034 — Constraints reverted by re-running 0013, restored
--
-- The same hand re-run of 0013 that 0033 cleaned up after also rebuilt two
-- CHECK constraints to their 0013 shape, undoing later migrations:
--
--   trades.trade_status_valid          lost LIQUIDATED (0014): a margin
--                                      call that sells collateral could not
--                                      record its forced-liquidation trade.
--   audit_events.audit_event_type_valid lost the order events (0027) and
--                                      the margin events (0014/0027): every
--                                      limit-order placement failed, as
--                                      would any margin call or deficit.
--
-- Both are restored to their latest definitions.
-- =====================================================================

alter table public.trades drop constraint if exists trade_status_valid;
alter table public.trades
  add constraint trade_status_valid
  check (status in ('EXECUTED', 'REJECTED', 'SETTLED', 'LIQUIDATED'));

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
      'DEFICIT_REPAID'
    )
  );
