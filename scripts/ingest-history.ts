// ingest-history.ts is a historical-replay loader that references
// pre-product-model symbols (SOURCE_ERCOT_HISTORY, corpus fields such as
// publishedAt/isFinal) that were removed from the app lib during the product /
// venue rework. It is kept as a standalone history tool and is intentionally
// not part of the main app typecheck/build. Its own internal types are declared
// here so the file still parses when included by tooling that includes scripts/.
import { readFileSync } from "node:fs";
import { supabaseAdmin } from "../src/lib/supabase/admin";
import {
  requireProduct,
} from "../src/lib/ercot/types";
import { getErcotSource } from "../src/lib/ercot/index";

export const SOURCE_ERCOT_HISTORY = "ERCOT_HISTORY";

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
 * Historical-replay corpus ingestion.
 *
 * This is the loader for ERCOT market data replayed through the simulation
 * clock. Two corpus kinds:
 *
 *   --fixture <file>   a JSON corpus of real ERCOT observations (built by
 *                      scripts/build-history-fixture.ts from the MIS daily
 *                      reports, or curated by hand for tests). Rows carry
 *                      their own publication instants and finality.
 *
 *   --gateway --from <ISO> --to <ISO>
 *                      walk the configured ERCOT_REPLAY source day by day
 *                      (the gateway serves the MIS daily reports for
 *                      historical windows). Publication times come from the
 *                      adapter, which takes them from ERCOT's own report
 *                      metadata.
 *
 * The observation key (market, product, delivery interval, published_at)
 * makes every run idempotent: a re-ingested corpus is a no-op, and a corpus
 * revised after ERCOT corrections simply carries extra observations.
 *
 * Run:  npx tsx scripts/ingest-history.ts --fixture fixtures/ercot/replay-day.json
 */

const BATCH = 250;

interface FixtureObservation {
  settlementPoint: string;
  product: string;
  deliveryTimestamp: string;
  deliveryEnd?: string;
  price: string;
  publishedAt: string;
  isFinal?: boolean;
  reportId?: string;
  docId?: string;
}

// Ergonomic re-export for the fixture's corpus shape. The current app's
// NormalizedPriceRecord does not carry publishedAt / isFinal, so this loader
// keeps its own observation type rather than pretending corpus rows fit the app
// model.
export type { FixtureObservation as IngestHistoryObservation };

interface HistoryCorpus {
  meta?: {
    name?: string;
    source?: string;
    ercotReports?: Array<Record<string, unknown>>;
  };
  markets?: Array<{
    settlementPoint: string;
    settlementPointType: string;
    description?: string;
  }>;
  observations: FixtureObservation[];
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      args[a.slice(2)] = next && !next.startsWith("--") ? next : "true";
      if (!next || next.startsWith("--")) continue;
      i++;
    }
  }
  return args;
}

function requireEnv(): void {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      "SUPABASE credentials required: set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY in .env"
    );
  }
}

async function ingestMarkets(
  admin: ReturnType<typeof supabaseAdmin>,
  markets: NonNullable<HistoryCorpus["markets"]>
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const m of markets) {
    // Lookup before write: an existing catalog row keeps its own settlement
    // point type and description (the fixture's coarse MIS-derived types must
    // never overwrite curated ones — e.g. HB_NORTH is catalogued as a HUB).
    const { data: existing } = await admin
      .from("markets")
      .select("id, settlement_point")
      .eq("settlement_point", m.settlementPoint)
      .maybeSingle();
    if (existing) {
      ids.set(existing.settlement_point, existing.id);
      continue;
    }
    const { data, error } = await admin
      .from("markets")
      .upsert(
        {
          settlement_point: m.settlementPoint,
          settlement_point_type: m.settlementPointType,
          description: m.description ?? null,
          active: true,
        },
        { onConflict: "settlement_point", ignoreDuplicates: false }
      )
      .select("id, settlement_point")
      .single();
    if (error) throw new Error(`market upsert failed: ${error.message}`);
    ids.set(data.settlement_point, data.id);
  }
  return ids;
}

async function ingestObservations(
  admin: ReturnType<typeof supabaseAdmin>,
  marketIdByPoint: Map<string, string>,
  sourceName: string,
  rows: FixtureObservation[]
): Promise<{ inserted: number; skipped: number }> {
  const payload: Array<Record<string, unknown>> = [];
  let skipped = 0;

  for (const r of rows) {
    const marketId = marketIdByPoint.get(r.settlementPoint);
    if (!marketId) {
      skipped++;
      continue;
    }
    const def = requireProduct(r.product); // throws on an unknown product
    const ts = new Date(r.deliveryTimestamp);
    if (Number.isNaN(ts.getTime())) {
      skipped++;
      continue;
    }
    const pub = new Date(r.publishedAt);
    if (Number.isNaN(pub.getTime())) {
      skipped++;
      continue;
    }
    const intervalEnd = r.deliveryEnd
      ? new Date(r.deliveryEnd).toISOString()
      : new Date(
          ts.getTime() + def.intervalMinutes * 60_000
        ).toISOString();

    payload.push({
      market_id: marketId,
      delivery_timestamp: ts.toISOString(),
      delivery_end: intervalEnd,
      price: r.price,
      product: r.product,
      venue: def.venue,
      source: sourceName,
      source_timestamp: pub.toISOString(),
      published_at: pub.toISOString(),
      is_final: r.isFinal ?? false,
    });
  }

  let inserted = 0;
  for (let i = 0; i < payload.length; i += BATCH) {
    const chunk = payload.slice(i, i + BATCH);
    const { data, error } = await admin
      .from("market_prices")
      .upsert(chunk, {
        // A price is an observation (0020): one row per publication, so a
        // revision is a new row and a repeat load of the same file is a no-op.
        onConflict: "market_id,product,delivery_timestamp,published_at",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) throw new Error(`price insert failed: ${error.message}`);
    inserted += data?.length ?? 0;
  }
  // Anything the observation key rejected was already stored: a true skip.
  return { inserted, skipped: skipped + (payload.length - inserted) };
}

async function ingestFixture(
  fixturePath: string,
  dryRun: boolean
): Promise<void> {
  const corpus: HistoryCorpus = JSON.parse(readFileSync(fixturePath, "utf8"));
  if (!Array.isArray(corpus.observations)) {
    throw new Error(`fixture ${fixturePath} has no observations array`);
  }
  const sourceName = corpus.meta?.source ?? SOURCE_ERCOT_HISTORY;
  console.log(
    `[history] corpus "${corpus.meta?.name ?? fixturePath}": ` +
      `${corpus.observations.length} observations, source ${sourceName}`
  );

  if (dryRun) {
    const products = new Set(corpus.observations.map((o) => o.product));
    const finals = corpus.observations.filter((o) => o.isFinal).length;
    console.log(
      `[history] dry run: products ${[...products].join(", ")}, ` +
        `${finals} final observations, ` +
        `${corpus.markets?.length ?? "(from gateway)"} markets`
    );
    return;
  }

  requireEnv();
  const admin = supabaseAdmin();

  const marketIdByPoint = corpus.markets
    ? await ingestMarkets(admin, corpus.markets)
    : await (async () => {
        const { data } = await admin
          .from("markets")
          .select("id, settlement_point");
        return new Map(
          (data ?? []).map((m: { id: string; settlement_point: string }) => [
            m.settlement_point,
            m.id,
          ])
        );
      })();

  const { inserted, skipped } = await ingestObservations(
    admin,
    marketIdByPoint,
    sourceName,
    corpus.observations ?? [],
  );

  await admin.from("ingestion_runs").insert({
    source: sourceName,
    status: "SUCCESS",
    records_received: corpus.observations?.length ?? 0,
    records_inserted: inserted,
    records_skipped: skipped,
    detail: {
      kind: "history_fixture",
      fixture: fixturePath,
      name: corpus.meta?.name ?? null,
      ercot_reports: corpus.meta?.ercotReports ?? [],
      products: corpus.observations ? [...new Set(corpus.observations.map((o) => o.product))] : [],
    },
  });

  console.log(
    `[history] inserted ${inserted}, skipped ${skipped} ` +
      `(already stored = idempotent no-op)`
  );
}

async function ingestFromGateway(
  fromIso: string,
  toIso: string,
  dryRun: boolean
): Promise<void> {  const source = getErcotSource();
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new Error(`invalid window: ${fromIso} .. ${toIso}`);
  }

  console.log(
    `[history] gateway corpus: ${source.sourceName}, ` +
      `${from.toISOString()} .. ${to.toISOString()} (day by day)`
  );
  if (dryRun) return;

  requireEnv();
  const admin = supabaseAdmin();
  const markets = await source.getMarkets();
  const marketIdByPoint = await ingestMarkets(admin, markets);

  const products = await source.getProducts();
  let received = 0;
  let inserted = 0;
  let skipped = 0;

  // One MIS report file covers one delivery day; the adapter resolves each
  // row's publication instant from the report metadata.
  for (let d = from.getTime(); d < to.getTime(); d += 24 * 3600 * 1000) {
    const dayStart = new Date(d);
    const dayEnd = new Date(Math.min(d + 24 * 3600 * 1000, to.getTime()));
    for (const product of products) {
      const records = await source.getPrices(dayStart, dayEnd, [product]);
      received += records.length;
      const res = await ingestObservations(
        admin,
        marketIdByPoint,
        source.sourceName,
        records.map((r) => {
          // publishedAt / isFinal are corpus-only fields kept by the
          // standalone history loader; the current app model does not
          // expose them, so the loader maps whatever the source returned.
          const raw = r as unknown as Record<string, string | boolean | undefined>;
          return {
            settlementPoint: r.settlementPoint,
            product: r.product,
            deliveryTimestamp: r.deliveryTimestamp,
            deliveryEnd: r.deliveryEnd,
            price: r.price,
            publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : r.deliveryTimestamp,
            isFinal: raw.isFinal === true,
          };
        }),
      );
      inserted += res.inserted;
      skipped += res.skipped;
    }
  }

  await admin.from("ingestion_runs").insert({
    source: source.sourceName,
    status: "SUCCESS",
    records_received: received,
    records_inserted: inserted,
    records_skipped: skipped,
    detail: {
      kind: "history_gateway",
      window_from: from.toISOString(),
      window_to: to.toISOString(),
      products,
    },
  });

  console.log(
    `[history] received ${received}, inserted ${inserted}, skipped ${skipped}`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.fixture) {
    await ingestFixture(args.fixture, args["dry-run"] === "true");
  } else if (args.gateway) {
    await ingestFromGateway(
      args.from ?? "",
      args.to ?? "",
      args["dry-run"] === "true"
    );
  } else {
    console.error(
      "usage: tsx scripts/ingest-history.ts --fixture <file> [--dry-run]\n" +
        "       tsx scripts/ingest-history.ts --gateway --from <ISO> --to <ISO> [--dry-run]"
    );
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("[history] failed:", e);
  process.exit(1);
});
