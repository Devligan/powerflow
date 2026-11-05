import { supabaseAdmin } from "@/lib/supabase/admin";
import { okPublic, serverError } from "@/lib/api";
import { LIMITS, clientIp, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { resolveMarketDataMode } from "@/lib/ercot/types";

export const dynamic = "force-dynamic";

export const maxDuration = 10;

/**
 * Public status of the market-data pipeline: last ingestion run, price
 * coverage and provenance. Presence/labels only — never synthesized into
 * a false "live ERCOT" claim. The mode label comes from the same resolver
 * the adapters use, so this status can never name a feed the app cannot run.
 * A run's error text stays out of it: that is for ingestion_runs and the logs.
 */
/** The series whose freshness decides whether the desk is trading today's
 *  market: tomorrow's day-ahead clearing and the real-time prints. */
const FRESHNESS_PRODUCTS = ["DAM_HOURLY", "RTM_15MIN", "RTM_HOURLY"] as const;

export async function GET(req: Request) {
  if (await overLimit(LIMITS.publicRead, clientIp(req))) return tooManyRequests(LIMITS.publicRead);

  const admin = supabaseAdmin();

  const [runsRes, pricesRes, ...newestRes] = await Promise.all([
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
    ...FRESHNESS_PRODUCTS.map((product) =>
      admin
        .from("market_prices")
        .select("delivery_timestamp, published_at")
        .eq("product", product)
        .order("delivery_timestamp", { ascending: false })
        .limit(1)
    ),
  ]);

  if (runsRes.error) return serverError("market-data status", runsRes.error.message);

  const latestRow = pricesRes.error ? null : pricesRes.data?.[0] ?? null;
  const latestPriceAt = latestRow?.delivery_timestamp ?? null;
  const latestPriceSource = latestRow?.source ?? null;

  // One overall "latest price" hides a stalled series: tomorrow's DAM makes it
  // look current while real time is days behind. Report each series.
  const newestByProduct = Object.fromEntries(
    FRESHNESS_PRODUCTS.map((product, i) => {
      const row = newestRes[i].error ? null : newestRes[i].data?.[0] ?? null;
      return [
        product,
        row
          ? { deliveryTimestamp: row.delivery_timestamp, publishedAt: row.published_at }
          : null,
      ];
    })
  );

  const runs = runsRes.data ?? [];

  const mode = resolveMarketDataMode();

  return okPublic({
    latestRuns: runs,
    latestPriceAt,
    latestPriceSource,
    newestByProduct,
    mode,
    generated: mode === "GENERATED",
  });
}