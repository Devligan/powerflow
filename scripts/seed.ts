import { readFileSync } from "node:fs";
import { supabaseAdmin } from "../src/lib/supabase/admin";
import {
  SIMULATED_MARKETS,
  generateMarketPrices,
} from "../src/lib/ercot/simulated";
import {
  SOURCE_SEEDED,
  requireProduct,
  truncateToHour,
} from "../src/lib/ercot/types";

// Lightweight .env loader (scripts run outside Next, which normally loads
// the env file for us). Does not overwrite values already in the environment.
(function () {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // .env missing — rely on ambient environment.
  }
})();

/**
 * PowerFlow database seed.
 *
 * Inserts:
 *   - the standard ERCOT hubs + load zones (markets)
 *   - ~45 days of deterministic historical hourly prices labeled SEEDED
 *
 * The data is a reproducible simulation, never presented as live ERCOT.
 * Run after migrations:  npx tsx scripts/seed.ts
 */
const HISTORY_DAYS = 45;
const BATCH = 250;

async function main() {
  const admin = supabaseAdmin();

  // 1. Markets
  for (const m of SIMULATED_MARKETS) {
    const { error } = await admin
      .from("markets")
      .upsert(
        {
          settlement_point: m.settlementPoint,
          settlement_point_type: m.settlementPointType,
          description: m.description,
          active: true,
        },
        { onConflict: "settlement_point" }
      );
    if (error) throw error;
  }
  console.log(`[seed] synced ${SIMULATED_MARKETS.length} markets`);

  const { data: marketRows } = await admin
    .from("markets")
    .select("id, settlement_point");
  const marketIdByPoint = new Map<string, string>();
  for (const r of marketRows ?? []) {
    marketIdByPoint.set(r.settlement_point, r.id);
  }

  // 2. Historical prices (deterministic, SOURCE_SEEDED)
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - HISTORY_DAYS);
  const to = new Date(now);
  to.setUTCHours(to.getUTCHours() + 1);

  const generated = generateMarketPrices(
    SIMULATED_MARKETS,
    truncateToHour(from),
    truncateToHour(to),
    SOURCE_SEEDED
  );

  const rows = generated.map((r) => ({
    market_id: marketIdByPoint.get(r.settlementPoint)!,
    delivery_timestamp: r.deliveryTimestamp,
    delivery_end: r.deliveryEnd,
    price: r.price,
    product: r.product,
    venue: requireProduct(r.product).venue,
    source: SOURCE_SEEDED,
    source_timestamp: new Date().toISOString(),
  }));

  const { count: before } = await admin
    .from("market_prices")
    .select("id", { count: "exact", head: true });
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await admin
      .from("market_prices")
      .upsert(chunk, {
        onConflict: "market_id,delivery_timestamp,product",
        ignoreDuplicates: true,
      })
      .select();
    if (error) throw error;
  }
  const { count: after } = await admin
    .from("market_prices")
    .select("id", { count: "exact", head: true });
  const inserted = Math.max(0, (after ?? 0) - (before ?? 0));
  console.log(
    `[seed] ${inserted}/${rows.length} historical price records inserted (${SOURCE_SEEDED})`
  );

  // 3. Record the seed transaction in ingestion_runs for observability.
  await admin.from("ingestion_runs").insert({
    source: SOURCE_SEEDED,
    status: "SUCCESS",
    records_received: generated.length,
    records_inserted: inserted,
    records_skipped: rows.length - inserted,
    detail: {
      kind: "initial_seed",
      history_days: HISTORY_DAYS,
      products: [...new Set(generated.map((r) => r.product))],
    },
  });

  console.log("[seed] done");
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});