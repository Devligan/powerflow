import { okPublic, serverError } from "@/lib/api";
import { LIMITS, clientIp, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { loadSystemStatus } from "@/lib/system-status";

export const dynamic = "force-dynamic";

export const maxDuration = 10;

/**
 * Public status of the platform: the market-data pipeline (last ingestion
 * runs, each series' newest interval, provenance), the hourly ledger
 * reconciliation (0054) and the database's headroom (0050). What it may and
 * may not say is in `src/lib/system-status.ts`; the Production workflow
 * (`scripts/smoke-production.mjs`) fails on what it reports.
 */
export async function GET(req: Request) {
  if (await overLimit(LIMITS.publicRead, clientIp(req))) return tooManyRequests(LIMITS.publicRead);
  try {
    return okPublic(await loadSystemStatus());
  } catch (e) {
    return serverError("market-data status", e);
  }
}
