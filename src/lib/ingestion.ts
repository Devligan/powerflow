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
  /** RTM_HOURLY observations whose Central delivery day has fully elapsed
   *  and were promoted to final settlement values this run (0024). */
  finalsPromoted: number;
  /** Age of the newest real-time interval in the store (seconds since its
   *  delivery start). A healthy 5-minute cadence keeps this under ~20 min;
   *  anything beyond means postings stopped landing. */
  newestIntervalAgeSeconds: number | null;
  /** True when the newest interval is older than the staleness threshold. */
  feedStale: boolean;
  /** Limit orders filled by this run's sweep (0026). */
  ordersFilled: number;
  /** Limit orders expired by this run's sweep. */
  ordersExpired: number;
  failed: boolean;
  error?: string;
  /** Set when the run was intentionally skipped (e.g. an archive source). */
  skippedReason?: string;
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
 * Caps `rows` at `budget`, shared round-robin across products, keeping each
 * product's OLDEST deliveries. A plain slice of the concatenated list let the
 * first product fetched (the 15-minute series, ~1,700 rows a day) take the
 * whole budget, so the series behind it never advanced. Oldest-first within a
 * product matters too: the next run resumes each market from its newest stored
 * interval, so a deferred row must never be older than one that landed, or it
 * would fall below the cursor and be lost.
 */
export function fairShare<
  T extends { product: string; delivery_timestamp: string; published_at: string },
>(rows: T[], budget: number): T[] {
  if (rows.length <= budget) return rows;
  const byProduct = new Map<string, T[]>();
  for (const row of rows) {
    const list = byProduct.get(row.product) ?? [];
    list.push(row);
    byProduct.set(row.product, list);
  }
  const queues = [...byProduct.values()].map((list) =>
    list.sort(
      (a, b) =>
        Date.parse(a.delivery_timestamp) - Date.parse(b.delivery_timestamp) ||
        Date.parse(a.published_at) - Date.parse(b.published_at)
    )
  );
  const taken: T[] = [];
  for (let depth = 0; taken.length < budget; depth++) {
    let any = false;
    for (const queue of queues) {
      if (depth >= queue.length) continue;
      any = true;
      taken.push(queue[depth]);
      if (taken.length === budget) break;
    }
    if (!any) break;
  }
  return taken;
}

/**
 * Idempotent market-data ingestion over the observation store.
 *
 * One row per (market, product, delivery interval, PUBLICATION instant): a
 * correction ERCOT publishes later is another row, not an overwrite, so the
 * revision history survives re-ingestion. The unique key is the final
 * duplicate guard; `ignoreDuplicates` makes re-runs and concurrent runs safe.
 *
 * The resume cursor is read from the FINAL series (latest_final_price_
 * timestamps): an interim observation must not advance the cursor past its
 * interval, or the final value published later would fall behind it and never
 * be fetched. The fetch window starts AT the any-observation cursor rather
 * than after it, because a later publication for an already-stored interval
 * (a correction) is exactly the row this pipeline exists to keep.
 */
export async function runMarketDataIngestion(
  opts: { dryRun?: boolean; source?: ErcotSource } = {}
): Promise<IngestionResult> {
  const admin = supabaseAdmin();
  // Production resolves the configured ERCOT source (always actual ERCOT
  // data). The injection seam exists so tests can drive the pipeline with a
  // deterministic source without any global synthetic configuration.
  const source = opts.source ?? getErcotSource();

  // Archive-mode sources (historical replay corpora) are driven explicitly,
  // epoch by epoch, by scripts/ingest-history.ts. Letting the incremental cron
  // point at one would re-walk the whole corpus on every tick.
  if (source.publicationMode === "archive") {
    return {
      runId: null,
      source: source.sourceName,
      marketsSynced: 0,
      recordsReceived: 0,
      recordsInserted: 0,
      recordsSkipped: 0,
      recordsDeferred: 0,
      truncated: false,
      finalsPromoted: 0,
      newestIntervalAgeSeconds: null,
      feedStale: false,
      ordersFilled: 0,
      ordersExpired: 0,
      failed: false,
      skippedReason:
        "archive source: run scripts/ingest-history.ts instead of the incremental cron",
    };
  }

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
  // RTM_HOURLY observations promoted to final by this run (0024).
  let finalsPromoted = 0;
  // Age of the newest RTM_15MIN interval (seconds) and whether it exceeds
  // the staleness threshold — the cron's own health signal.
  let newestIntervalAgeSeconds: number | null = null;
  let feedStale = false;
  // Limit-order sweep results from this run (0026).
  let ordersFilled = 0;
  let ordersExpired = 0;
  // The products this run covered (resolved in the try body; recorded on
  // the run row's detail at the tail).
  let products: string[] = [];
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

    // 2. Resume points: the latest stored delivery timestamp per
    //    (market, product), over all observations and over finals.
    products = resolveProducts(await source.getProducts());
    const marketIds = [...marketById.values()].map((m) => m.id);
    const [latestRes, latestFinalRes] = await Promise.all([
      admin.rpc("latest_price_timestamps", { p_market_ids: marketIds }),
      admin.rpc("latest_final_price_timestamps", { p_market_ids: marketIds }),
    ]);
    if (latestRes.error) {
      throw new Error(
        `could not read ingestion resume points: ${latestRes.error.message}`
      );
    }
    if (latestFinalRes.error) {
      throw new Error(
        `could not read final-series resume points: ${latestFinalRes.error.message}`
      );
    }
    const latestByKey = new Map<string, string>();
    for (const row of (latestRes.data ?? []) as Array<{
      market_id: string;
      product: string;
      delivery_timestamp: string;
    }>) {
      latestByKey.set(
        `${row.market_id}::${row.product}`,
        row.delivery_timestamp
      );
    }
    const latestFinalByKey = new Map<string, string>();
    for (const row of (latestFinalRes.data ?? []) as Array<{
      market_id: string;
      product: string;
      delivery_timestamp: string;
    }>) {
      latestFinalByKey.set(
        `${row.market_id}::${row.product}`,
        row.delivery_timestamp
      );
    }

    // 3. Horizon (bounded per run) plus the earliest resume point. The window
    //    opens AT the cursor, not after it: a new publication for an interval
    //    already stored is a revision, and the store's key makes re-inserting
    //    it a no-op rather than a duplicate.
    const now = new Date();
    const horizon = new Date(
      now.getTime() + Number(process.env.INGEST_WINDOW_HOURS ?? 72) * HOUR_MS
    );
    const maxLookbackMs =
      Number(process.env.INGEST_MAX_LOOKBACK_HOURS ?? 48) * HOUR_MS;

    const rowsToInsert: Array<{
      market_id: string;
      delivery_timestamp: string;
      delivery_end: string;
      price: string;
      product: string;
      venue: string;
      source: string;
      source_timestamp: string;
      published_at: string;
      is_final: boolean;
    }> = [];

    for (const product of products) {
      const def = requireProduct(product);

      // 4. The earliest gap any market has for this product: the older of the
      //    all-observations cursor and the final-series cursor (a series whose
      //    final lags its interim tail must keep being fetched).
      let earliest = Number.POSITIVE_INFINITY;
      for (const row of marketById.values()) {
        const known = latestByKey.get(`${row.id}::${product}`);
        const knownFinal = latestFinalByKey.get(`${row.id}::${product}`);
        const candidate = [known, knownFinal]
          .filter((v): v is string => Boolean(v))
          .map((v) => new Date(v).getTime());
        const from = candidate.length
          ? Math.min(...candidate)
          : now.getTime() - OVERLAP_MS; // no history: a bounded overlap buffer
        if (from < earliest) earliest = from;
      }
      // Never reach back further than the lookback bound. A series that fell
      // days behind would otherwise ask MIS for one file per 15-minute
      // interval since its cursor — thousands of downloads that cannot finish
      // inside one invocation, so the series never advanced at all. Older
      // gaps belong to scripts/ingest-history.ts, which has no time budget.
      earliest = Math.max(earliest, now.getTime() - maxLookbackMs);
      if (!Number.isFinite(earliest) || earliest >= horizon.getTime()) continue;

      const records = await source.getPrices(
        new Date(earliest),
        horizon,
        [product]
      );
      recordsReceived += records.length;

      // 5. Validate + normalize, keep only rows for known markets. Dedupe is
      //    the store's job (the observation key), so rows below a market's own
      //    cursor are NOT dropped here: a correction to an old interval is a
      //    new observation and must survive.
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
        // Revision-pickup policy: the fetch window opens AT a market's
        // cursor, so each run re-offers the boundary interval (where a
        // live correction would land) plus every interval a LAGGING
        // market is missing. Rows strictly below a market's own cursor
        // are dropped here rather than capped later: they are either
        // already stored (the observation key makes the insert a no-op)
        // or historical corrections, which belong to the history loader
        // (scripts/ingest-history.ts), which has no record budget. Letting
        // them ride in the capped payload would let a feed's re-offered
        // rows crowd real gaps out of the budget and strand lagging
        // markets below the horizon their peers reached.
        const knownAt = latestByKey.get(`${market.id}::${product}`);
        if (
          knownAt &&
          new Date(check.record.deliveryTimestamp) < new Date(knownAt)
        ) {
          recordsSkipped++;
          continue;
        }
        rowsToInsert.push({
          market_id: market.id,
          delivery_timestamp: check.record.deliveryTimestamp,
          delivery_end: check.record.deliveryEnd,
          price: check.record.price,
          product: check.record.product,
          venue: def.venue,
          source: source.sourceName,
          source_timestamp: check.record.sourceTimestamp,
          published_at: check.record.publishedAt,
          is_final: check.record.isFinal,
        });
      }
    }

    // 6. Persist with ON CONFLICT DO NOTHING on the observation key
    //    (idempotent by construction). This runs BEFORE the sweeps below, so
    //    promotion, limit-order fills and the staleness check all see this
    //    run's prints instead of waiting a tick for them.
    const maxRecords = Math.max(
      1,
      Number(process.env.INGEST_MAX_RECORDS ?? 20000)
    );
    const rowsToInsertCapped = fairShare(rowsToInsert, maxRecords);
    // Deferred is not the same as skipped: these rows are real gaps left for
    // the next bounded run.
    recordsDeferred = rowsToInsert.length - rowsToInsertCapped.length;

    for (let i = 0; i < rowsToInsertCapped.length; i += BATCH_SIZE) {
      const chunk = rowsToInsertCapped.slice(i, i + BATCH_SIZE);
      // With ignoreDuplicates the response carries exactly the rows that were
      // inserted, and `count` is always null — so the row count is the honest
      // measure. (Summing `count` reported 0 for every run; see 0009-era fix.)
      const { data: inserted, error: err } = await admin
        .from("market_prices")
        .upsert(chunk, {
          onConflict: "market_id,product,delivery_timestamp,published_at",
          ignoreDuplicates: true,
        })
        .select("id");
      if (err) throw new Error(`price insert failed: ${err.message}`);
      recordsInserted += inserted?.length ?? 0;
    }
    // Anything the unique key rejected was already stored: a true skip.
    recordsSkipped += rowsToInsertCapped.length - recordsInserted;

    // 5b. Finality promotion (0024): hourly SPP observations whose Central
    // delivery day has fully elapsed become the settlement values. Every
    // run promotes — including no-op runs — so a live position settles at
    // most one cron tick + one settle sweep after its day ends. Later ERCOT
    // corrections arrive as new interim observations and are promoted on a
    // later run the same way (price_final prefers the latest final row).
    try {
      const { data: promoted, error: promoteErr } = await admin.rpc(
        "promote_rtm_finals"
      );
      if (promoteErr) throw new Error(promoteErr.message);
      finalsPromoted = Number(promoted ?? 0);
    } catch (e) {
      // Promotion failing must not fail the ingestion (data landed fine);
      // settlement self-heals on the next run.
      console.warn(
        "[ingestion] finality promotion failed:",
        e instanceof Error ? e.message : e
      );
    }

    // 5d. Limit-order sweep: fill open orders whose interval now has a
    // crossing print. Runs from the same cron tail as promotion so an order
    // fills within one tick of its price publishing. The sweep is the
    // service role (same trust tier as settlement); fills go through
    // execute_trade so every engine guarantee applies unchanged.
    try {
      const { data: sweep, error: sweepErr } = await admin.rpc(
        "fill_crossing_limit_orders"
      );
      if (sweepErr) throw new Error(sweepErr.message);
      const s = (sweep ?? {}) as { filled?: number; expired?: number };
      ordersFilled = Number(s.filled ?? 0);
      ordersExpired = Number(s.expired ?? 0);
    } catch (e) {
      // The book surviving an ingestion problem matters more than one sweep;
      // the next tick retries, and expired orders are re-expired there.
      console.warn(
        "[ingestion] limit-order sweep failed:",
        e instanceof Error ? e.message : e
      );
    }

    // 5c. Feed staleness: how old is the newest real-time interval in the
    // store? Calibrated against healthy operation: interval [T, T+15)
    // posts at ~T+17, so at any instant the newest POSTED interval started
    // 17–32 minutes ago (starts are on a 15-minute grid). Healthy age
    // therefore cycles 17→32 minutes; a 35-minute threshold sits just
    // above that ceiling, and a genuinely stuck feed grows past it
    // without bound.
    try {
      const { data: newestRow, error: newestErr } = await admin
        .from("market_prices")
        .select("delivery_timestamp")
        .eq("product", "RTM_15MIN")
        .order("delivery_timestamp", { ascending: false })
        .limit(1);
      if (newestErr) throw new Error(newestErr.message);
      const newest = (newestRow?.[0]?.delivery_timestamp as string | undefined) ?? null;
      if (newest) {
        newestIntervalAgeSeconds = Math.max(
          0,
          Math.round((Date.now() - new Date(newest).getTime()) / 1000)
        );
      }
    } catch (e) {
      // Observability failing must not fail ingestion.
      console.warn(
        "[ingestion] staleness check failed:",
        e instanceof Error ? e.message : e
      );
    }
    feedStale =
      newestIntervalAgeSeconds != null && newestIntervalAgeSeconds > 35 * 60;

    // 7. Observability: record success. Every run closes its row — a run with
    //    nothing new is still a SUCCESS, not a row left RUNNING forever.
    await finalize(runId, {
      status: "SUCCESS",
      finished_at: new Date().toISOString(),
      records_received: recordsReceived,
      records_inserted: recordsInserted,
      records_skipped: recordsSkipped,
      detail: {
        products: products,
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

  // Record the staleness metric on the run row, then return.
  await finalize(runId, {
    detail: {
      products,
      records_deferred: recordsDeferred,
      truncated: recordsDeferred > 0,
      finals_promoted: finalsPromoted,
      newest_interval_age_seconds: newestIntervalAgeSeconds,
      feed_stale: feedStale,
      orders_filled: ordersFilled,
      orders_expired: ordersExpired,
    },
  });

  return {
    runId,
    source: source.sourceName,
    marketsSynced,
    recordsReceived,
    recordsInserted,
    recordsSkipped,
    recordsDeferred,
    truncated: recordsDeferred > 0,
    finalsPromoted,
    newestIntervalAgeSeconds,
    feedStale,
    ordersFilled,
    ordersExpired,
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
