import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { supabaseAdmin } from "../src/lib/supabase/admin";
import type { SettlementPointType } from "../src/lib/ercot/types";

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
 * The seed carries NO price data. PowerFlow is an ERCOT paper-trading
 * engine: market truth is actual ERCOT MIS data, ingested live by the cron
 * (or, for a historical replay, by scripts/ingest-history.ts from a real
 * MIS corpus). Seeding synthetic prices here would poison every fill, mark
 * and settlement with invented numbers, so it is gone.
 *
 * What the seed does:
 *   1. Syncs the traded settlement-point catalog — the ERCOT hubs and load
 *      zones, taken from the historical MIS fixture so the offline DB
 *      matches the points ERCOT actually publishes.
 *   2. Verifies the data source configuration is an ERCOT one.
 *
 * Optional: `npx tsx scripts/seed.ts --load-history [fixture.json]`
 * also loads an actual-ERCOT MIS replay corpus (built with
 * scripts/build-history-fixture.ts) through the same loader the replay
 * workflow uses — useful to bring a fresh environment to life with a real
 * day of ERCOT data.
 *
 * Run after migrations:  npx tsx scripts/seed.ts
 */

const HISTORY_FIXTURE = "fixtures/ercot/replay-2026-09-20.json";
const BATCH = 250;

interface CorpusMarket {
  settlementPoint: string;
  settlementPointType: string;
  description?: string;
}

function loadCatalogMarkets(): CorpusMarket[] {
  const corpus = JSON.parse(readFileSync(HISTORY_FIXTURE, "utf8")) as {
    markets: CorpusMarket[];
  };
  if (!Array.isArray(corpus.markets) || corpus.markets.length === 0) {
    throw new Error(`${HISTORY_FIXTURE} carries no market catalog`);
  }
  return corpus.markets;
}

async function seedMarkets(markets: CorpusMarket[]): Promise<number> {
  const admin = supabaseAdmin();
  for (let i = 0; i < markets.length; i += BATCH) {
    const chunk = markets.slice(i, i + BATCH).map((m) => ({
      settlement_point: m.settlementPoint,
      settlement_point_type: m.settlementPointType as SettlementPointType,
      description: m.description ?? `${m.settlementPoint} (ERCOT settlement point)`,
      active: true,
    }));
    const { error } = await admin
      .from("markets")
      .upsert(chunk, { onConflict: "settlement_point", ignoreDuplicates: false });
    if (error) throw error;
  }
  return markets.length;
}

function checkSourceConfig(): void {
  const mode = (process.env.ERCOT_SOURCE ?? "ERCOT_MIS").toUpperCase();
  if (mode !== "ERCOT_MIS" && mode !== "ERCOT_REPLAY") {
    throw new Error(
      `ERCOT_SOURCE=${mode} is not supported: PowerFlow runs on actual ` +
        `ERCOT MIS data. Set ERCOT_SOURCE=ERCOT_MIS (or ERCOT_REPLAY for a ` +
        `historical replay corpus).`
    );
  }
}

async function main() {
  const loadHistory = process.argv.includes("--load-history");
  const fixtureArg = process.argv[process.argv.indexOf("--load-history") + 1];

  checkSourceConfig();

  const markets = loadCatalogMarkets();
  const synced = await seedMarkets(markets);
  console.log(`[seed] synced ${synced} ERCOT settlement points (hubs + load zones)`);

  if (loadHistory) {
    const fixture = fixtureArg && !fixtureArg.startsWith("-") ? fixtureArg : HISTORY_FIXTURE;
    console.log(`[seed] loading actual ERCOT MIS corpus ${fixture} …`);
    const r = spawnSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/ingest-history.ts", "--fixture", fixture],
      { stdio: "inherit" }
    );
    if (r.status !== 0) {
      throw new Error(`history load failed (exit ${r.status})`);
    }
  } else {
    console.log(
      "[seed] no price data seeded — actual ERCOT MIS data arrives via the " +
        "ingestion cron, or via `npm run load:history` for a replay day."
    );
  }

  console.log("[seed] done");
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
