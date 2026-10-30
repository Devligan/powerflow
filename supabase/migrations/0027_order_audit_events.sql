-- =====================================================================
-- 0027 — The audit vocabulary grows with the order book
--
-- Migration 0026 introduced the order lifecycle (placed, filled,
-- cancelled), but `audit_events.audit_event_type_valid` still admits
-- only the pre-order vocabulary, so the very first placement was
-- rejected. Registering the order event types exposed a LATENT 0022-era
-- defect at the same time: the margin/settlement sweep writes MARGIN_CALL,
-- FORCED_LIQUIDATION, ACCOUNT_DEFICIT and DEFICIT_REPAID, none of which
-- were ever registered either — any account that ever reached a margin
-- call, a forced liquidation or a deficit would have failed the sweep.
-- All of it is registered here. (ORDER_EXPIRED is deliberately absent:
-- expiry is a silent book-hygiene transition, not an account event.)
-- =====================================================================

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
