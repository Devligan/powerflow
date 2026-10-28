import {
  ErcotSource,
  SOURCE_ERCOT_MIS,
  SOURCE_SIMULATED,
} from "@/lib/ercot/types";
import { ErcotMISSource } from "@/lib/ercot/mis";

/**
 * Resolve the configured ERCOT data source from env.
 *
 * PowerFlow is an ERCOT paper-trading engine: the market-data layer is
 * ALWAYS actual ERCOT data — the simulator controls the clock, orders,
 * fills, accounts and portfolio state, and must never invent the underlying
 * market. There is no generated price feed in production.
 *
 *   ERCOT_SOURCE=ERCOT_MIS (default)
 *       → the live ERCOT MIS adapter (public reports, no credentials).
 *         Publication times come from ERCOT itself; the incremental cron
 *         advances the archive as ERCOT publishes.
 *   ERCOT_SOURCE=ERCOT_REPLAY
 *       → the same adapter in archive mode, for a HISTORICAL replay corpus:
 *         driven epoch by epoch by scripts/ingest-history.ts against the
 *         simulation clock; the incremental cron refuses to run against it.
 *
 * Anything else is a configuration error, not a fallback to synthetic data.
 */
export function getErcotSource(): ErcotSource {
  const mode = (process.env.ERCOT_SOURCE ?? "ERCOT_MIS").toUpperCase();
  switch (mode) {
    case "ERCOT_MIS":
      return new ErcotMISSource();
    case "ERCOT_REPLAY":
      return new ErcotMISArchiveSource();
    default:
      throw new Error(
        `ERCOT_SOURCE=${mode} is not supported: PowerFlow runs on actual ` +
          `ERCOT MIS data (ERCOT_SOURCE=ERCOT_MIS, or ERCOT_REPLAY for a ` +
          `historical replay corpus). Synthetic price feeds are not available ` +
          `in production.`
    );
  }
}

/** Archive-mode variant of the MIS adapter: the replay loader drives it. */
class ErcotMISArchiveSource extends ErcotMISSource {
  readonly publicationMode: "live" | "archive" = "archive";
  readonly canServeHistory = true;
}

export { SOURCE_ERCOT_MIS, SOURCE_SIMULATED };
