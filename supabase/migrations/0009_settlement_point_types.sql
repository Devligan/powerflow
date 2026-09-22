-- ============================================================================
-- 0009 — Settlement-point type universe
-- ============================================================================
--
-- 0007 added the full ERCOT location universe in TypeScript
-- (`SettlementPointType`: hubs, hub averages, load zones, resource nodes, DC
-- ties, PUNs, SOGs). The `markets.settlement_point_type` CHECK constraint from
-- 0001 was never widened to match, so ingestion could not sync anything past
-- the four hubs and four competitive zones:
--
--   market upsert failed: new row for relation "markets" violates check
--   constraint "settlement_point_type_valid"
--
-- That made the expanded universe unreachable in the database — the types
-- existed in the app and not in Postgres. This widens the constraint to the
-- TypeScript union exactly, so the two cannot disagree.
-- ----------------------------------------------------------------------------

alter table public.markets
  drop constraint if exists settlement_point_type_valid;

alter table public.markets
  add constraint settlement_point_type_valid check (
    settlement_point_type in (
      'RESOURCE_NODE',
      'HUB',
      'HUB_AVERAGE',
      'LOAD_ZONE',
      'DC_TIE',
      'PUN',
      'SOG',
      'SETTLEMENT_POINT'
    )
  );
