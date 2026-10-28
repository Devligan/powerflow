import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The actual-ERCOT replay corpus, shared by the database suites that trade
 * through historical time.
 *
 * The fixture is built by `scripts/build-history-fixture.ts` from ERCOT MIS
 * reports (MIS 12331 daily DAM clearing; MIS 12301 rolling RT settlement
 * prices) for one operating day. Every observation carries ERCOT's own
 * posting instant, which is what the simulation clock filters against — the
 * suites trade through REAL publication timeline, not a synthetic one.
 *
 * There is no synthetic price anywhere in these suites: expected fills,
 * marks and settlements are read from the fixture, which is actual ERCOT
 * data by construction.
 */

export const ERCOT_FIXTURE = "fixtures/ercot/replay-2026-09-20.json";

/** Production observation key: re-ingesting the corpus is a no-op. */
export const OBS_KEY = "market_id,product,delivery_timestamp,published_at";

export interface FixtureObs {
  settlementPoint: string;
  product: string;
  deliveryTimestamp: string;
  deliveryEnd?: string;
  price: string;
  publishedAt: string;
  isFinal?: boolean;
}

export interface LoadedPoint {
  marketId: string;
  /** Delivery hour start → day-ahead clearing observation. */
  dam: Map<string, FixtureObs>;
  /** Delivery hour start → hourly RT settlement observation. */
  rtHour: Map<string, FixtureObs>;
  /** Interval start → 15-minute RT print. */
  rt15: Map<string, FixtureObs>;
  observationCount: number;
  source: string;
}

/**
 * Load one settlement point's slice of the corpus into the database through
 * the production observation key, and return it indexed the way the engine
 * sees it. Idempotent: re-running upserts the same observations.
 */
export async function loadFixturePoint(
  db: SupabaseClient,
  point: string,
  opts: { fixture?: string } = {}
): Promise<LoadedPoint> {
  const fixture = opts.fixture ?? ERCOT_FIXTURE;
  const corpus = JSON.parse(readFileSync(fixture, "utf8")) as {
    meta?: { source?: string };
    markets?: Array<{
      settlementPoint: string;
      settlementPointType: string;
      description?: string;
    }>;
    observations: FixtureObs[];
  };
  const source = corpus.meta?.source ?? "ERCOT_MIS_HISTORY";

  // Lookup-before-write: an existing catalog row keeps its identity, exactly
  // as the history loader and the ingestion cron resolve markets.
  let marketId: string;
  const { data: existing } = await db
    .from("markets")
    .select("id")
    .eq("settlement_point", point)
    .maybeSingle();
  if (existing) {
    marketId = existing.id as string;
  } else {
    const m = corpus.markets!.find((x) => x.settlementPoint === point)!;
    const { data, error } = await db
      .from("markets")
      .upsert(
        {
          settlement_point: m.settlementPoint,
          settlement_point_type: m.settlementPointType,
          description: m.description ?? null,
          active: true,
        },
        { onConflict: "settlement_point" }
      )
      .select("id")
      .single();
    if (error) throw new Error(`market upsert failed: ${error.message}`);
    marketId = data!.id as string;
  }

  const rows = corpus.observations.filter((o) => o.settlementPoint === point);
  if (rows.length === 0) {
    throw new Error(`fixture ${fixture} carries no observations for ${point}`);
  }
  const venueOf: Record<string, string> = {
    DAM_HOURLY: "DAM",
    RTM_HOURLY: "RTM",
    RTM_15MIN: "RTM",
  };
  const { error: ingestError } = await db.from("market_prices").upsert(
    rows.map((o) => ({
      market_id: marketId,
      product: o.product,
      delivery_timestamp: o.deliveryTimestamp,
      delivery_end: o.deliveryEnd ?? null,
      price: o.price,
      venue: venueOf[o.product],
      source,
      source_timestamp: o.publishedAt,
      published_at: o.publishedAt,
      is_final: o.isFinal ?? false,
    })),
    { onConflict: OBS_KEY, ignoreDuplicates: true }
  );
  if (ingestError) throw new Error(`corpus ingest failed: ${ingestError.message}`);

  const dam = new Map<string, FixtureObs>();
  const rtHour = new Map<string, FixtureObs>();
  const rt15 = new Map<string, FixtureObs>();
  for (const o of rows) {
    if (o.product === "DAM_HOURLY") dam.set(o.deliveryTimestamp, o);
    else if (o.product === "RTM_HOURLY") rtHour.set(o.deliveryTimestamp, o);
    else if (o.product === "RTM_15MIN") rt15.set(o.deliveryTimestamp, o);
  }
  return { marketId, dam, rtHour, rt15, observationCount: rows.length, source };
}
