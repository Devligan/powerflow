-- =====================================================================
-- 0030 — Test fixtures do not belong in the market list
--
-- Early database suites created TEST_HUB_* settlement points in the shared
-- project and left them active, so they appeared beside the real ERCOT hubs
-- and load zones on the markets page. No current suite uses them. They are
-- deactivated rather than deleted, so any history that references them stays
-- intact.
-- =====================================================================

update public.markets
set active = false
where settlement_point like 'TEST\_%' escape '\'
  and active;
