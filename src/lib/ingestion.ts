import { supabaseAdmin } from "@/lib/supabase/admin";

import { getErcotSource } from "@/lib/ercot/index";
import {
  ErcotSource,
  NormalizedPriceRecord,
  normalizePriceRecord,
  requireProduct,
  truncateToHour,
} from "@/lib/ercot/types";

export interface IngestionResult {
  runId: string | null;
  source: string;
  marketsSynced: number;
  recordsReceived: number;
  recordsInserted: number;
  recordsSkipped: number;
  /** Real gaps left behind because the run hit INGEST_MAX_RECORDS. */
  recordsDeferred: number;
  /** Whether this run stopped early with work remaining. */
  truncated: boolean;
  failed: boolean;
  error?: string;
}

interface MarketRow {
  id: string;
  settlement_point: string;
}

const BATCH_SIZE = 250;
const HOUR_MS = 3600 * 1000;
/** Overlap re-fetched for a series with no stored history, so a source that
 *  publishes slightly behind its own clock still lands on the grid. */
const OVERLAP_MS = 6 * HOUR_MS;

/** Products to ingest: an explicit INGEST_PRODUCTS override, else everything
 *  the source publishes. */
function resolveProducts(published: string[]): string[] {
  const override = process.env.INGEST_PRODUCTS;
  if (!override) return published;
  const requested = override
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return requested.length > 0 ? requested : published;
}

/**
 * Idempotent market-data ingestion. Safe to run repeatedly and concurrently
 * (last writer wins on identical keys; the unique constraint
 * (market_id, delivery_timestamp, product) is the final duplicate guard).
 */
export async function runMarketDataIngestion(
  opts: { dryRun?: boolean } = {}
): Promise<IngestionResult> {
  const admin = supabaseAdmin();
  const source = getErcotSource();

  // Observability: open an ingestion_runs row up front.
  let runId: string | null = null;
  if (!opts.dryRun) {
    const { data, error } = await admin
      .from("ingestion_runs")
      .insert({
        source: source.sourceName,
        status: "RUNNING",
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) {
      throw new Error(`could not start ingestion run: ${error.message}`);
    }
    runId = data.id;
  }

  let recordsReceived = 0;
  let recordsInserted = 0;
  let recordsSkipped = 0;
  let recordsDeferred = 0;
  let marketsSynced = 0;
  let failed = false;
  let error: string | undefined;

  try {
    // 1. Markets from the source (idempotent upsert by settlement_point).
    const markets = await source.getMarkets();
    const marketById = new Map<string, MarketRow>();
    for (const m of markets) {
      const { data, error: err } = await admin
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
      if (err) throw new Error(`market upsert failed: ${err.message}`);
      marketById.set(m.settlementPoint, data as MarketRow);
      marketsSynced++;
    }

    // 2. Latest persisted delivery timestamp per (market, product).
    const products = resolveProducts(await source.getProducts());
    const { data: latests, error: latestErr } = await admin.rpc(
      "latest_price_timestamps",
      { p_market_ids: [...marketById.values()].map((m) => m.id) }
    );
    if (latestErr) {
      // Not something to shrug off: falling back to "assume nothing is stored"
      // would silently refetch the whole horizon for every market and report a
      // clean run, so a genuine failure here is raised instead.
      throw new Error(`could not read ingestion resume points: ${latestErr.message}`);
    }
    const latestByKey = new Map<string, string>();
    for (const row of (latests ?? []) as Array<{
      market_id: string;
      product: string;
      delivery_timestamp: string;
    }>) {
      latestByKey.set(
        `${row.market_id}::${row.product}`,
        row.delivery_timestamp
      );
    }

    // 3. Horizon (bounded per run) plus each series' own resume point.
    const now = new Date();
    const horizon = new Date(
      now.getTime() + Number(process.env.INGEST_WINDOW_HOURS ?? 72) * HOUR_MS
    );

    const rowsToInsert: Array<{
      market_id: string;
      delivery_timestamp: string;
      delivery_end: string;
      price: string;
      product: string;
      venue: string;
      source: string;
      source_timestamp: string;
    }> = [];

    for (const product of products) {
      const def = requireProduct(product);

      // 4. Resume point per market, for this product. Previously this was a
      //    single `from` taken as the *maximum* last-known timestamp across all
      //    markets, so one market that was current dragged every lagging market
      //    up to its own position and the lagging ones were never backfilled —
      //    their gap was simply skipped, run after run. Each series now resumes
      //    from its own last published interval.
      const resumeAt = new Map<string, number>();
      let earliest = Number.POSITIVE_INFINITY;
      for (const row of marketById.values()) {
        const known = latestByKey.get(`${row.id}::${product}`);
        const from = known
          ? new Date(known).getTime() + 1000
          : now.getTime() - OVERLAP_MS; // no history: a bounded overlap buffer
        resumeAt.set(row.id, from);
        if (from < earliest) earliest = from;
      }
      // One fetch per product, from the earliest gap any market has. Rows that
      // do not advance a market's own series are dropped below, so fetching
      // wide cannot double-write the markets that are already current.
      if (!Number.isFinite(earliest) || earliest >= horizon.getTime()) continue;

      const records = await source.getPrices(new Date(earliest), horizon, [product]);
      recordsReceived += records.length;

      // 5. Validate + normalize, retain only rows for known markets that are
      //    genuinely missing from that market's own series.
      for (const rec of records) {
        const market = marketById.get(rec.settlementPoint);
        if (!market) {
          recordsSkipped++;
          continue;
        }
        const check = normalizePriceRecord(rec, source.sourceName, product);
        if (!check.ok) {
          recordsSkipped++;
          continue;
        }
        const from = resumeAt.get(market.id) ?? 0;
        if (new Date(check.record.deliveryTimestamp).getTime() >= from) {
          rowsToInsert.push({
            market_id: market.id,
            delivery_timestamp: check.record.deliveryTimestamp,
            delivery_end: check.record.deliveryEnd,
            price: check.record.price,
            product: check.record.product,
            venue: def.venue,
            source: source.sourceName,
            source_timestamp: check.record.sourceTimestamp,
          });
        } else {
          recordsSkipped++;
        }
      }
    }

    if (rowsToInsert.length === 0) {
      // Nothing new to fetch (already current for every product).
      return {
        runId,
        source: source.sourceName,
        marketsSynced,
        recordsReceived,
        recordsInserted,
        recordsSkipped,
        recordsDeferred: 0,
        truncated: false,
        failed,
      };
    }

    // 6. Persist with ON CONFLICT DO NOTHING (idempotent by construction).
    //    Bounded chunks per run keep serverless executions well-scoped.
    const maxRecords = Math.max(
      1,
      Number(process.env.INGEST_MAX_RECORDS ?? 2000)
    );
    const rowsToInsertCapped = rowsToInsert.slice(0, maxRecords);
    // Deferred is not the same as skipped: these rows are real gaps left for
    // the next bounded run, and reporting them as "skipped" (or as an out-and
    // -out success with everything accounted for) is how a truncated run used
    // to look identical to a complete one.
    recordsDeferred = rowsToInsert.length - rowsToInsertCapped.length;

    for (let i = 0; i < rowsToInsertCapped.length; i += BATCH_SIZE) {
      const chunk = rowsToInsertCapped.slice(i, i + BATCH_SIZE);
      // With ignoreDuplicates the response carries exactly the rows that were
      // inserted, and `count` is always null — so the row count is the honest
      // measure. Summing `count` reported 0 inserted for every run while the
      // rows were in fact being written, and then counted every one of them as
      // skipped.
      const { data: inserted, error: err } = await admin
        .from("market_prices")
        .upsert(chunk, {
          onConflict: "market_id,delivery_timestamp,product",
          ignoreDuplicates: true,
        })
        .select("id");
      if (err) throw new Error(`price insert failed: ${err.message}`);
      recordsInserted += inserted?.length ?? 0;
    }
    // Anything the unique key rejected was already stored: a true skip.
    recordsSkipped += rowsToInsertCapped.length - recordsInserted;

    // 7. Observability: record success.
    await finalize(runId, {
      status: "SUCCESS",
      finished_at: new Date().toISOString(),
      records_received: recordsReceived,
      records_inserted: recordsInserted,
      records_skipped: recordsSkipped,
      detail: {
        products: products,
        // Non-zero means the run hit INGEST_MAX_RECORDS and left real gaps for
        // the next run rather than finishing the horizon.
        records_deferred: recordsDeferred,
        truncated: recordsDeferred > 0,
      },
    });
  } catch (e) {
    failed = true;
    error = e instanceof Error ? e.message : String(e);
    if (runId) {
      await finalize(runId, {
        status: "FAILED",
        finished_at: new Date().toISOString(),
        records_received: recordsReceived,
        records_inserted: recordsInserted,
        records_skipped: recordsSkipped,
        error_message: error.slice(0, 2000),
      });
    }
  }

  return {
    runId,
    source: source.sourceName,
    marketsSynced,
    recordsReceived,
    recordsInserted,
    recordsSkipped,
    recordsDeferred,
    truncated: recordsDeferred > 0,
    failed,
    error,
  };
}

async function finalize(
  runId: string | null,
  patch: Record<string, unknown>
): Promise<void> {
  if (!runId) return;
  const admin = supabaseAdmin();
  await admin.from("ingestion_runs").update(patch).eq("id", runId);
}

export type { ErcotSource, NormalizedPriceRecord };

// Helper used by seed & tests: pure validation without a DB.
export function validatePriceRecord(rec: unknown, source: string) {
  return normalizePriceRecord(rec, source);
}

export { truncateToHour };