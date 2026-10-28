import {
  ErcotSource,
  SOURCE_ERCOT_MIS,
  SOURCE_SIMULATED,
} from "@/lib/ercot/types";
import { SimulatedErcotSource } from "@/lib/ercot/simulated";
import { ErcotMISSource } from "@/lib/ercot/mis";

/**
 * Resolve the configured ERCOT data source from env.
 *   ERCOT_SOURCE=GENERATED (default) → deterministic simulated feed
 *   ERCOT_SOURCE=ERCOT_MIS  → live ERCOT adapter (requires ERCOT_MIS_API_BASE_URL)
 */
export function getErcotSource(): ErcotSource {
  const mode = (process.env.ERCOT_SOURCE ?? "GENERATED").toUpperCase();
  switch (mode) {
    case "ERCOT_MIS": {
      const base = process.env.ERCOT_MIS_API_BASE_URL;
      if (!base) {
        throw new Error(
          "ERCOT_SOURCE=ERCOT_MIS requires ERCOT_MIS_API_BASE_URL"
        );
      }
      return new ErcotMISSource(base, {
        apiKey: process.env.ERCOT_MIS_API_KEY,
        product: process.env.ERCOT_MIS_PRODUCT,
      });
    }
    case "GENERATED":
    default:
      return new SimulatedErcotSource();
  }
}

export { SOURCE_ERCOT_MIS, SOURCE_SIMULATED };