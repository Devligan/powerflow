import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveMarketDataMode, type MarketDataMode } from "@/lib/ercot/types";
import { publicLedgerStatus, type LedgerAuditRow, type PublicLedgerStatus } from "@/lib/ledger";

/**
 * Public health of the platform: the market-data pipeline, the ledger
 * reconciliation and the database's headroom. Read by
 * `GET /api/market-data/status` (which the Production workflow checks) and the
 * `/status` page, so the page shows exactly what the alarm judges.
 *
 * Presence, counts and labels only: never a run's error text (that is for
 * ingestion_runs and the logs) and never a reconciliation sample (they name
 * accounts). The mode label comes from the same resolver the adapters use, so
 * this can never name a feed the app cannot run.
 */

/** The series whose freshness decides whether the desk is trading today's
 *  market: tomorrow's day-ahead clearing and the real-time prints. */
export const FRESHNESS_PRODUCTS = ["DAM_HOURLY", "RTM_15MIN", "RTM_HOURLY"] as const;

/** The free plan's database size (Supabase: 500 MB), read conservatively. */
const FREE_TIER_DB_BYTES = 500_000_000;

export interface IngestionRunSummary {
  id: string;
  source: string;
  status: string;
  records_received: number;
  records_inserted: number;
  records_skipped: number;
  started_at: string;
  finished_at: string | null;
}

export interface SystemStatus {
  latestRuns: IngestionRunSummary[];
  latestPriceAt: string | null;
  latestPriceSource: string | null;
  newestByProduct: Record<(typeof FRESHNESS_PRODUCTS)[number], { deliveryTimestamp: string; publishedAt: string } | null>;
  mode: MarketDataMode;
  generated: boolean;
  storage: { percentOfFreeTier: number } | null;
  /** The newest hourly reconciliation (0054); null before its first run. */
  ledger: PublicLedgerStatus | null;
}

/** Throws only when the ingestion log itself cannot be read; every other
 *  part degrades to null, which the smoke check reports as a failure. */
export async function loadSystemStatus(): Promise<SystemStatus> {
  const admin = supabaseAdmin();

  const [usageRes, runsRes, pricesRes, ledgerRes, ...newestRes] = await Promise.all([
    // 0050: how full the database is, so the Production workflow warns long
    // before the free plan's limit. A percentage, never a table or a count.
    admin.rpc("database_usage"),
    admin
      .from("ingestion_runs")
      .select("id, source, status, records_received, records_inserted, records_skipped, started_at, finished_at")
      // started_at, not finished_at: Postgres sorts NULLs first descending, so
      // ordering by finished_at put abandoned runs above every real one.
      .order("started_at", { ascending: false })
      .limit(5),
    admin
      .from("market_prices")
      .select("source, delivery_timestamp")
      .order("delivery_timestamp", { ascending: false })
      .limit(1),
    admin
      .from("ledger_audits")
      .select("checked_at, ok, checks, accounts, trades, duration_ms")
      .order("checked_at", { ascending: false })
      .limit(1),
    ...FRESHNESS_PRODUCTS.map((product) =>
      admin
        .from("market_prices")
        .select("delivery_timestamp, published_at")
        .eq("product", product)
        .order("delivery_timestamp", { ascending: false })
        .limit(1)
    ),
  ]);

  if (runsRes.error) throw new Error(runsRes.error.message);

  const latestRow = pricesRes.error ? null : pricesRes.data?.[0] ?? null;

  // One overall "latest price" hides a stalled series: tomorrow's DAM makes it
  // look current while real time is days behind. Report each series.
  const newestByProduct = Object.fromEntries(
    FRESHNESS_PRODUCTS.map((product, i) => {
      const row = newestRes[i].error ? null : newestRes[i].data?.[0] ?? null;
      return [product, row ? { deliveryTimestamp: row.delivery_timestamp, publishedAt: row.published_at } : null];
    })
  ) as SystemStatus["newestByProduct"];

  const mode = resolveMarketDataMode();
  const usedBytes = usageRes.error ? null : Number(usageRes.data);
  const audit = ledgerRes.error ? null : (ledgerRes.data?.[0] as LedgerAuditRow | undefined) ?? null;

  return {
    latestRuns: (runsRes.data ?? []) as IngestionRunSummary[],
    latestPriceAt: latestRow?.delivery_timestamp ?? null,
    latestPriceSource: latestRow?.source ?? null,
    newestByProduct,
    mode,
    generated: mode === "GENERATED",
    storage:
      usedBytes == null || !Number.isFinite(usedBytes)
        ? null
        : { percentOfFreeTier: Math.round((usedBytes / FREE_TIER_DB_BYTES) * 1000) / 10 },
    ledger: audit ? publicLedgerStatus(audit) : null,
  };
}
