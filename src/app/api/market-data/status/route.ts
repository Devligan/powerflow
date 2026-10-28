import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export const maxDuration = 30;

/**
 * Public status of the market-data pipeline: last ingestion run, price
 * coverage and provenance. Presence/labels only — never synthesized into
 * a false "live ERCOT" claim.
 */
export async function GET() {
  const admin = supabaseAdmin();

  const [runsRes, pricesRes] = await Promise.all([
    admin
      .from("ingestion_runs")
      .select("id, source, status, records_received, records_inserted, records_skipped, detail, started_at, finished_at")
      .order("finished_at", { ascending: false })
      .limit(5),
    admin
      .from("market_prices")
      .select("source, delivery_timestamp")
      .order("delivery_timestamp", { ascending: false })
      .limit(1),
  ]);

  if (runsRes.error) return fail(runsRes.error.message, 500);

  const latestRow = pricesRes.error ? null : pricesRes.data?.[0] ?? null;
  const latestPriceAt = latestRow?.delivery_timestamp ?? null;
  const latestPriceSource = latestRow?.source ?? null;

  const runs = runsRes.data ?? [];

  return ok({
    latestRuns: runs,
    latestPriceAt,
    latestPriceSource,
    mode: process.env.ERCOT_SOURCE ?? "GENERATED",
    generated: (process.env.ERCOT_SOURCE ?? "GENERATED") === "GENERATED",
  });
}