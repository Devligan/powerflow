import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  AS_SYSTEM_POINT,
  DEFAULT_MARKET_PRODUCT,
  FORWARD_MARKET_PRODUCT,
  resolveMarketDataMode,
  settlementPointName,
} from "@/lib/ercot/types";
import { deliveryCentralToUtc } from "@/lib/ercot/mis";
import { parseDbDec, parseDec } from "@/lib/money";
import type { HourlyPrice } from "@/lib/market-stats";

export interface MarketView {
  id: string;
  settlementPoint: string;
  type: string;
  description: string | null;
  price: string | null;
  deliveryTimestamp: string | null;
  /** When the source published this observation (the mark's as-of). */
  publishedAt?: string | null;
  source: string | null;
  product: string;
  /** Day-ahead clearing for the same hour as `price`: the DART pair. */
  dayAheadPrice?: string | null;
  /** Mean day-ahead price over the next Central operating day, once its
   *  clearing has published (null until every hour of it has). */
  dayAheadNextDayAvg?: string | null;
}

const HOUR_MS = 3600_000;

/** The UTC bounds of the Central operating day `offsetDays` after `at`'s. */
function centralDayBounds(at: Date, offsetDays: number): { start: number; end: number } | null {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" })
    .format(at)
    .split("-")
    .map(Number);
  const day = (n: number) => {
    const t = new Date(Date.UTC(y, m - 1, d + n));
    const label = `${String(t.getUTCMonth() + 1).padStart(2, "0")}/${String(t.getUTCDate()).padStart(2, "0")}/${t.getUTCFullYear()}`;
    const start = deliveryCentralToUtc(label, 1);
    return start ? Date.parse(start) : null;
  };
  const start = day(offsetDays);
  const end = day(offsetDays + 1);
  return start != null && end != null ? { start, end } : null;
}

/**
 * Attach the day-ahead side to each market's real-time row: the DA clearing
 * for the same hour, and the next operating day's average. Real time is what
 * settles; day-ahead is what a desk trades forward, and the gap between them
 * is the trade. Observations are read as of `asOf`, like everything else.
 */
async function attachDayAhead(rows: MarketView[], asOf: Date | null): Promise<MarketView[]> {
  if (rows.length === 0) return rows;
  const now = asOf ?? new Date();
  const nextDay = centralDayBounds(now, 1);
  const rtStarts = rows
    .map((r) => (r.deliveryTimestamp ? Date.parse(r.deliveryTimestamp) : NaN))
    .filter((t) => !Number.isNaN(t));
  const from = rtStarts.length ? Math.min(...rtStarts) : now.getTime() - HOUR_MS;
  const to = nextDay?.end ?? now.getTime() + 48 * HOUR_MS;

  let query = supabaseAdmin()
    .from("market_prices")
    .select("market_id, delivery_timestamp, price, published_at")
    .eq("product", FORWARD_MARKET_PRODUCT)
    .in("market_id", rows.map((r) => r.id))
    .gte("delivery_timestamp", new Date(from).toISOString())
    .lt("delivery_timestamp", new Date(to).toISOString());
  if (asOf) query = query.lte("published_at", asOf.toISOString());
  const { data, error } = await query.order("published_at", { ascending: false }).limit(5000);
  if (error) throw new Error(error.message);

  // Latest publication per (market, hour): rows arrive newest first.
  const byMarket = new Map<string, Map<number, string>>();
  for (const r of data ?? []) {
    const hours = byMarket.get(r.market_id) ?? new Map<number, string>();
    const t = Date.parse(r.delivery_timestamp);
    if (!hours.has(t)) hours.set(t, String(r.price));
    byMarket.set(r.market_id, hours);
  }

  return rows.map((row) => {
    const hours = byMarket.get(row.id);
    if (!hours) return row;
    const sameHour = row.deliveryTimestamp ? hours.get(Date.parse(row.deliveryTimestamp)) : undefined;
    let nextDayAvg: string | null = null;
    if (nextDay) {
      const expected = Math.round((nextDay.end - nextDay.start) / HOUR_MS);
      const prices = [...hours].filter(([t]) => t >= nextDay.start && t < nextDay.end).map(([, p]) => parseDec(p));
      if (prices.length === expected) {
        const mean = prices.reduce((a, b) => a + b, 0n) / BigInt(prices.length);
        nextDayAvg = (Number(mean) / 1e6).toFixed(2);
      }
    }
    return { ...row, dayAheadPrice: sameHour ?? null, dayAheadNextDayAvg: nextDayAvg };
  });
}

/**
 * The latest published price per market, AS OF an instant.
 *
 * In replay mode this is the read rule of the whole market-data layer: an
 * observation is visible when it was PUBLISHED by that instant, regardless of
 * when the interval delivers. Filtering on delivery instead would leak the
 * future into a historical simulation (look-ahead bias).
 *
 * `asOf = null` keeps the pre-clock behaviour: the latest publication there is.
 */
export async function listMarkets(asOf?: Date | null): Promise<MarketView[]> {
  const admin = supabaseAdmin();
  const marketsRes = await admin
    .from("markets")
    .select("id, settlement_point, settlement_point_type, description, active");
  if (marketsRes.error) throw new Error(marketsRes.error.message);

  const markets = (marketsRes.data ?? []).filter(
    (m: { active: boolean; settlement_point: string }) =>
      m.active && m.settlement_point !== AS_SYSTEM_POINT
  );

  type PriceRow = {
    market_id: string;
    price: string | null;
    delivery_timestamp: string | null;
    published_at: string | null;
    source: string | null;
  };
  let priceRows: PriceRow[] = [];

  if (asOf) {
    // Replay: the latest observation published at or before the clock.
    const res = await admin
      .from("market_prices")
      .select(
        "market_id, price, delivery_timestamp, published_at, source, product"
      )
      .eq("product", DEFAULT_MARKET_PRODUCT)
      .lte("published_at", asOf.toISOString())
      .order("published_at", { ascending: false })
      .limit(5000);
    if (res.error) throw new Error(res.error.message);
    // First occurrence per market IS the latest publication for it.
    const seen = new Set<string>();
    priceRows = (res.data ?? [] as PriceRow[]).filter((r) => {
      if (seen.has(r.market_id)) return false;
      seen.add(r.market_id);
      return true;
    });
  } else {
    const res = await admin
      .from("current_prices")
      .select(
        "market_id, price, delivery_timestamp, ingested_at, source, product"
      )
      .eq("product", DEFAULT_MARKET_PRODUCT);
    if (res.error) throw new Error(res.error.message);
    priceRows = (res.data ?? []).map((r: Record<string, unknown>) => ({
      market_id: String(r.market_id),
      price: (r.price as string) ?? null,
      delivery_timestamp: (r.delivery_timestamp as string) ?? null,
      published_at: (r.ingested_at as string) ?? null,
      source: (r.source as string) ?? null,
    }));
  }

  const priceByMarket = new Map(
    priceRows.map((p) => [p.market_id, p])
  );

  const rows = markets
    .sort((a: { settlement_point: string }, b: { settlement_point: string }) =>
      a.settlement_point.localeCompare(b.settlement_point)
    )
    .map((m: { id: string; settlement_point: string; settlement_point_type: string; description: string | null }) => {
      const p = priceByMarket.get(m.id);
      return {
        id: m.id,
        settlementPoint: m.settlement_point,
        type: m.settlement_point_type,
        description: settlementPointName(m.settlement_point) ?? m.description,
        price: p?.price ?? null,
        deliveryTimestamp: p?.delivery_timestamp ?? null,
        publishedAt: p?.published_at ?? null,
        source: p?.source ?? null,
        product: DEFAULT_MARKET_PRODUCT,
      };
    });
  return attachDayAhead(rows, asOf ?? null);
}

export interface MarketOption {
  id: string;
  settlementPoint: string;
  type: string;
}

/** Just enough of the market list to offer a second settlement point on a
 *  spread ticket, without dragging every market's price along with it. */
export async function listMarketOptions(): Promise<MarketOption[]> {
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("markets")
    .select("id, settlement_point, settlement_point_type")
    .eq("active", true)
    .order("settlement_point");
  if (error) throw new Error(error.message);
  return (data ?? []).filter((m) => m.settlement_point !== AS_SYSTEM_POINT).map((m) => ({
    id: m.id,
    settlementPoint: m.settlement_point,
    type: m.settlement_point_type,
  }));
}

export interface PricePoint {
  deliveryTimestamp: string;
  deliveryEnd: string | null;
  price: string;
  /** When this observation was published (the revision identity). */
  publishedAt?: string | null;
  source: string | null;
  product: string;
}

export async function getMarketPrices(
  settlementPoint: string,
  product: string = DEFAULT_MARKET_PRODUCT,
  asOf?: Date | null
): Promise<{
  market: MarketView;
  latest: PricePoint | null;
  series: PricePoint[];
  asOf: string | null;
}> {
  const admin = supabaseAdmin();
  const marketRes = await admin
    .from("markets")
    .select("id, settlement_point, settlement_point_type, description, active")
    .eq("settlement_point", settlementPoint.toUpperCase())
    .maybeSingle();
  if (marketRes.error) throw new Error(marketRes.error.message);
  if (!marketRes.data) throw new Error("Market not found");

  interface RawPriceRow {
    delivery_timestamp: string;
    delivery_end: string | null;
    price: string;
    published_at: string | null;
    source: string | null;
  }

  // One row per delivery interval: the latest PUBLICATION of each. Revisions
  // put several observations on one interval; a chart that showed all of them
  // would draw the same interval three times, so the as-of rule (latest
  // publication at or before the reader's clock) collapses them.
  const collapseToLatestPublication = (
    rows: RawPriceRow[]
  ): PricePoint[] => {
    const byInterval = new Map<string, RawPriceRow>();
    for (const r of rows) {
      const prev = byInterval.get(r.delivery_timestamp);
      if (!prev || (prev.published_at ?? "") < (r.published_at ?? "")) {
        byInterval.set(r.delivery_timestamp, r);
      }
    }
    return [...byInterval.values()]
      .sort(
        (a, b) =>
          Date.parse(a.delivery_timestamp) - Date.parse(b.delivery_timestamp)
      )
      .slice(-120)
      .map((r) => ({
        deliveryTimestamp: r.delivery_timestamp,
        deliveryEnd: r.delivery_end,
        price: r.price,
        publishedAt: r.published_at,
        source: r.source,
        product,
      }));
  };

  let series: PricePoint[];
  if (asOf) {
    // Replay: observations visible by the clock, over a window that tracks
    // the CLOCK (not the wall clock). Intervals may deliver after the clock —
    // a day-ahead curve published by the clock is exactly what a trader
    // would have seen — so the upper bound is forward-looking.
    const horizonFrom = new Date(asOf.getTime() - 48 * 3600_000);
    const horizonTo = new Date(asOf.getTime() + 48 * 3600_000);
    const pricesRes = await admin
      .from("market_prices")
      .select(
        "delivery_timestamp, delivery_end, price, published_at, source"
      )
      .eq("market_id", marketRes.data.id)
      .eq("product", product)
      .gte("delivery_timestamp", horizonFrom.toISOString())
      .lte("delivery_timestamp", horizonTo.toISOString())
      .lte("published_at", asOf.toISOString())
      .order("delivery_timestamp")
      .limit(2000);
    if (pricesRes.error) throw new Error(pricesRes.error.message);
    series = collapseToLatestPublication(
      (pricesRes.data ?? []) as RawPriceRow[]
    );
  } else {
    const horizonFrom = new Date();
    horizonFrom.setUTCHours(horizonFrom.getUTCHours() - 48);

    const pricesRes = await admin
      .from("market_prices")
      .select(
        "delivery_timestamp, delivery_end, price, published_at, source"
      )
      .eq("market_id", marketRes.data.id)
      .eq("product", product)
      .gte("delivery_timestamp", horizonFrom.toISOString())
      .order("delivery_timestamp")
      .order("published_at", { ascending: false })
      .limit(2000);
    if (pricesRes.error) throw new Error(pricesRes.error.message);
    series = collapseToLatestPublication(
      (pricesRes.data ?? []) as RawPriceRow[]
    );
  }

  const last = series.length ? series[series.length - 1] : null;
  return {
    market: {
      id: marketRes.data.id,
      settlementPoint: marketRes.data.settlement_point,
      type: marketRes.data.settlement_point_type,
      description:
        settlementPointName(marketRes.data.settlement_point) ??
        (marketRes.data.description as string | null),
      price: last?.price ?? null,
      deliveryTimestamp: last?.deliveryTimestamp ?? null,
      publishedAt: last?.publishedAt ?? null,
      source: last?.source ?? null,
      product,
    },
    latest: last,
    series,
    asOf: asOf ? asOf.toISOString() : null,
  };
}

const PAGE = 1000; // PostgREST's default max-rows: larger .limit()s are silently capped.

/**
 * Hourly history for one (market, product) over [fromMs, toMs), as of a clock:
 * the latest publication of each interval visible at `asOf` (all of them when
 * live). Paged, because weeks of revisions run past one response.
 */
export async function getHourlyHistory(
  marketId: string,
  product: string,
  fromMs: number,
  toMs: number,
  asOf?: Date | null
): Promise<HourlyPrice[]> {
  const admin = supabaseAdmin();
  const latest = new Map<string, { published: string; price: number }>();
  for (let offset = 0; ; offset += PAGE) {
    let q = admin
      .from("market_prices")
      .select("id, delivery_timestamp, price, published_at")
      .eq("market_id", marketId)
      .eq("product", product)
      .gte("delivery_timestamp", new Date(fromMs).toISOString())
      .lt("delivery_timestamp", new Date(toMs).toISOString());
    if (asOf) q = q.lte("published_at", asOf.toISOString());
    const { data, error } = await q
      .order("delivery_timestamp")
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const prev = latest.get(r.delivery_timestamp);
      if (!prev || prev.published < r.published_at) {
        latest.set(r.delivery_timestamp, {
          published: r.published_at,
          price: Number(parseDbDec(String(r.price))) / 1e6,
        });
      }
    }
    if (!data || data.length < PAGE) break;
  }
  return [...latest.entries()]
    .map(([ts, v]) => ({ t: Date.parse(ts), price: v.price }))
    .sort((a, b) => a.t - b.t);
}

export interface MarketStatus {
  latestRuns: Array<Record<string, unknown>>;
  latestPriceAt: string | null;
  latestPriceSource: string | null;
  mode: string;
  /** ERCOT_REPLAY | ERCOT_LIVE — the two data regimes (both actual ERCOT). */
  dataMode: string;
}

export async function getMarketStatus(): Promise<MarketStatus> {
  const admin = supabaseAdmin();
  const [runsRes, pricesRes] = await Promise.all([
    admin
      .from("ingestion_runs")
      .select("id, source, status, records_received, records_inserted, records_skipped, detail, started_at, finished_at")
      // started_at: NULLs sort first descending, so finished_at put abandoned
      // runs above every real one.
      .order("started_at", { ascending: false })
      .limit(5),
    admin
      .from("market_prices")
      .select("source, published_at, product")
      .eq("product", DEFAULT_MARKET_PRODUCT)
      .order("published_at", { ascending: false })
      .limit(1),
  ]);
  if (runsRes.error) throw new Error(runsRes.error.message);

  const latestRow = pricesRes.error ? null : pricesRes.data?.[0] ?? null;
  const mode = process.env.ERCOT_SOURCE ?? "ERCOT_MIS";
  return {
    latestRuns: (runsRes.data ?? []) as Array<Record<string, unknown>>,
    latestPriceAt: latestRow?.published_at ?? null,
    latestPriceSource: latestRow?.source ?? null,
    mode,
    dataMode: resolveMarketDataMode(),
  };
}