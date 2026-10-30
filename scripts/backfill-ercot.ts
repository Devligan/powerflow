import "dotenv/config";
import { Client } from "pg";
import {
  ErcotMISSource,
  MIS_DOWNLOAD,
  centralWallToUtc,
  deliveryCentralToUtc,
  isHubOrZone,
  listMisDocs,
  readZipEntries,
} from "../src/lib/ercot/mis";
import { NormalizedPriceRecord, requireProduct } from "../src/lib/ercot/types";

/**
 * Fills gaps in market_prices with actual ERCOT data: `npx tsx scripts/backfill-ercot.ts`.
 *
 * The incremental cron only reaches back INGEST_MAX_LOOKBACK_HOURS, so an
 * outage leaves holes it will never revisit. This walks the window
 * [--from, now + 48h] in two passes:
 *
 *   1. ERCOT's rolling MIS reports through the live adapter — RT intervals
 *      (~7 days back), the DAM clearing and AS clearing prices (~30 days).
 *      These carry ERCOT's own posting stamps, so they go first.
 *   2. ERCOT's annual archives (NP6-785 RTM and NP4-180 DAM hub/load-zone
 *      prices, NP4-181 DAM AS clearing prices), which reach back to January
 *      but carry no per-row posting time. Their
 *      publication instants are set to when ERCOT posts that series in
 *      normal operation — an RT interval ~2 minutes after it ends, the DAM at
 *      13:30 Central the day before — and the rows are labelled
 *      ERCOT_MIS_HISTORY so their provenance stays visible.
 *
 * Fill-only: a row is written only where no observation of that
 * (market, product, delivery interval) exists, so re-running is a no-op and a
 * live observation is never shadowed by an archive one. Writes go over a
 * direct Postgres connection (SUPABASE_DB_PASSWORD), then the run is recorded
 * in ingestion_runs and promote_rtm_finals settles every elapsed day.
 *
 * Flags: --from YYYY-MM-DD (Central; default 2026-09-20)  --dry-run
 */

const HOUR_MS = 3600_000;
const INTERVAL_MS = 15 * 60_000;
const RT_POSTING_LAG_MS = 2 * 60_000;
const AS_POINT = "AS_SYSTEM";
const PRODUCTS = ["DAM_HOURLY", "RTM_15MIN", "RTM_HOURLY", "REGUP", "REGDN", "RRS", "NSPIN", "ECRS"];
const REPORT_HIST_RTM = 13061; // NP6-785-ER, Historical RTM Load Zone and Hub Prices
const REPORT_HIST_DAM = 13060; // NP4-180-ER, Historical DAM Load Zone and Hub Prices
const REPORT_HIST_AS = 13091; // NP4-181-ER, Historical DAM Clearing Prices for Capacity
const MIS_UA = "Mozilla/5.0 (PowerFlow market-data ingestion)";
const SOURCE_LIVE = "ERCOT_MIS";
const SOURCE_ARCHIVE = "ERCOT_MIS_HISTORY";

interface Row {
  point: string;
  product: string;
  start: string;
  end: string;
  price: string;
  publishedAt: string;
  isFinal: boolean;
  source: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const key = (r: Pick<Row, "point" | "product" | "start">) => `${r.point}|${r.product}|${r.start}`;

function fromRecord(rec: NormalizedPriceRecord): Row {
  return {
    point: rec.settlementPoint,
    product: rec.product,
    start: new Date(rec.deliveryTimestamp).toISOString(),
    end: new Date(rec.deliveryEnd).toISOString(),
    price: rec.price,
    publishedAt: new Date(rec.publishedAt).toISOString(),
    isFinal: rec.isFinal,
    source: SOURCE_LIVE,
  };
}

// ---------------------------------------------------------------------------
// Annual archive: a zip holding one .xlsx, one worksheet per month. Cells are
// plain shared strings and numbers, so a small reader is enough.
// ---------------------------------------------------------------------------

const archives = new Map<string, Promise<Map<string, Buffer>>>();

/** One download per (report, year), however many months are read from it. */
function downloadAnnualArchive(reportTypeId: number, year: number): Promise<Map<string, Buffer>> {
  const k = `${reportTypeId}:${year}`;
  if (!archives.has(k)) archives.set(k, fetchAnnualArchive(reportTypeId, year));
  return archives.get(k)!;
}

async function fetchAnnualArchive(reportTypeId: number, year: number): Promise<Map<string, Buffer>> {
  const doc = (await listMisDocs(reportTypeId)).find((d) => d.filename.includes(`_${year}.zip`));
  if (!doc) throw new Error(`no ${year} archive listed for MIS report ${reportTypeId}`);
  const res = await fetch(`${MIS_DOWNLOAD}?mimic_duns=000000000&doclookupId=${doc.doclookupId}`, {
    headers: { "User-Agent": MIS_UA },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`archive download failed: ${res.status}`);
  const outer = readZipEntries(Buffer.from(await res.arrayBuffer()));
  const xlsx = outer.find((e) => e.name.endsWith(".xlsx"));
  if (!xlsx) throw new Error(`archive ${doc.filename} holds no workbook`);
  console.log(`[backfill] archive ${doc.filename}`);
  return new Map(readZipEntries(xlsx.data).map((e) => [e.name, e.data]));
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Rows of worksheet `sheetNo` (the month, for the SPP archives) as cell text. */
function* worksheetRows(book: Map<string, Buffer>, sheetNo: number): Generator<string[]> {
  const strings = [...(book.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>(?:<t[^>]*>([\s\S]*?)<\/t>)?[\s\S]*?<\/si>/g)].map(
    (m) => decodeXml(m[1] ?? "")
  );
  const sheet = book.get(`xl/worksheets/Sheet${sheetNo}.xml`) ?? book.get(`xl/worksheets/sheet${sheetNo}.xml`);
  if (!sheet) return;
  for (const row of sheet.toString("utf8").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>(?:<v>([^<]*)<\/v>)?<\/c>/g)) {
      const col = c[1].charCodeAt(0) - 65;
      const raw = c[3] ?? "";
      cells[col] = /t="s"/.test(c[2]) ? strings[Number(raw)] ?? "" : raw;
    }
    yield cells;
  }
}

/** Central calendar days (MM/DD/YYYY) in [from, to]. */
function centralDays(from: string, to: Date): Set<string> {
  const days = new Set<string>();
  const [y, m, d] = from.split("-").map(Number);
  for (let t = Date.UTC(y, m - 1, d); t <= to.getTime(); t += 24 * HOUR_MS) {
    const dt = new Date(t);
    days.add(`${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${String(dt.getUTCDate()).padStart(2, "0")}/${dt.getUTCFullYear()}`);
  }
  return days;
}

function monthsOf(days: Set<string>): Array<{ year: number; month: number }> {
  const seen = new Map<string, { year: number; month: number }>();
  for (const day of days) {
    const [mm, , yyyy] = day.split("/");
    seen.set(`${yyyy}-${mm}`, { year: Number(yyyy), month: Number(mm) });
  }
  return [...seen.values()];
}

async function archiveRtm(days: Set<string>): Promise<Row[]> {
  const rows: Row[] = [];
  // point|hourStart -> interval -> price; intervals are keyed, not counted, so
  // a repeated print can never make a partial hour look complete.
  const hours = new Map<string, Map<number, number>>();
  for (const { year, month } of monthsOf(days)) {
    const book = await downloadAnnualArchive(REPORT_HIST_RTM, year);
    for (const [date, hourEnding, interval, repeated, point, type, price] of worksheetRows(book, month)) {
      if (!days.has(date) || !isHubOrZone(point ?? "") || !price || Number.isNaN(Number(price))) continue;
      // Load zones are printed twice, as LZ and as the energy-weighted LZEW,
      // and the two can differ. Keep the canonical print, as parseRtmSppCsv
      // does for the live report — the archive then matches it to the cent.
      if (/EW$/.test(type ?? "")) continue;
      const hourStart = deliveryCentralToUtc(date, Number(hourEnding), repeated === "Y");
      if (!hourStart) continue;
      const hourMs = Date.parse(hourStart);
      const start = hourMs + (Number(interval) - 1) * INTERVAL_MS;
      const end = start + INTERVAL_MS;
      rows.push({
        point,
        product: "RTM_15MIN",
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        price: Number(price).toFixed(2),
        publishedAt: new Date(end + RT_POSTING_LAG_MS).toISOString(),
        isFinal: false,
        source: SOURCE_ARCHIVE,
      });
      const perHour = hours.get(`${point}|${hourMs}`) ?? new Map<number, number>();
      perHour.set(Number(interval), Number(price));
      hours.set(`${point}|${hourMs}`, perHour);
    }
  }
  // RTM_HOURLY by ERCOT's equal-time rule — the same aggregation the live
  // adapter applies: the mean of the hour's four intervals, only when complete.
  for (const [k, intervals] of hours) {
    if (intervals.size !== 4) continue;
    const [point, hourMsStr] = k.split("|");
    const hourMs = Number(hourMsStr);
    const mean = [...intervals.values()].reduce((a, b) => a + b, 0) / 4;
    rows.push({
      point,
      product: "RTM_HOURLY",
      start: new Date(hourMs).toISOString(),
      end: new Date(hourMs + HOUR_MS).toISOString(),
      price: mean.toFixed(4),
      publishedAt: new Date(hourMs + HOUR_MS + RT_POSTING_LAG_MS).toISOString(),
      isFinal: false, // promote_rtm_finals settles it once its day has elapsed
      source: SOURCE_ARCHIVE,
    });
  }
  return rows;
}

/** Start of a day-ahead hour, and when its clearing posted (13:30 Central the
 *  afternoon before the operating day). */
function damHour(date: string, hourEnding: string, repeated: string): { start: number; posted: Date } | null {
  const start = deliveryCentralToUtc(date, Number((hourEnding ?? "").split(":")[0]), repeated === "Y");
  if (!start) return null;
  const [mm, dd, yyyy] = date.split("/").map(Number);
  const prev = new Date(Date.UTC(yyyy, mm - 1, dd) - 24 * HOUR_MS);
  const posted = centralWallToUtc(prev.toISOString().slice(0, 10).replace(/-/g, ""), "1330");
  return posted ? { start: Date.parse(start), posted } : null;
}

async function archiveDam(days: Set<string>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const { year, month } of monthsOf(days)) {
    const book = await downloadAnnualArchive(REPORT_HIST_DAM, year);
    for (const [date, hourEnding, repeated, point, price] of worksheetRows(book, month)) {
      if (!days.has(date) || !isHubOrZone(point ?? "") || !price || Number.isNaN(Number(price))) continue;
      const hour = damHour(date, hourEnding, repeated);
      if (!hour) continue;
      rows.push({
        point,
        product: "DAM_HOURLY",
        start: new Date(hour.start).toISOString(),
        end: new Date(hour.start + HOUR_MS).toISOString(),
        price: Number(price).toFixed(2),
        publishedAt: hour.posted.toISOString(),
        isFinal: true,
        source: SOURCE_ARCHIVE,
      });
    }
  }
  return rows;
}

/** Day-ahead AS clearing prices (NP4-181-ER): one sheet per year, one column
 *  per service, held on the shared AS_SYSTEM row as the live adapter does. */
async function archiveAs(days: Set<string>): Promise<Row[]> {
  const rows: Row[] = [];
  const years = new Set(monthsOf(days).map((m) => m.year));
  for (const year of years) {
    const book = await downloadAnnualArchive(REPORT_HIST_AS, year);
    let columns: string[] | null = null;
    for (const cells of worksheetRows(book, 1)) {
      if (cells[0] === "Delivery Date") {
        columns = cells;
        continue;
      }
      if (!columns || !days.has(cells[0])) continue;
      const hour = damHour(cells[0], cells[1], cells[2]);
      if (!hour) continue;
      for (let col = 3; col < columns.length; col++) {
        const product = columns[col];
        const price = cells[col];
        if (!PRODUCTS.includes(product) || !price || Number.isNaN(Number(price))) continue;
        rows.push({
          point: AS_POINT,
          product,
          start: new Date(hour.start).toISOString(),
          end: new Date(hour.start + HOUR_MS).toISOString(),
          price: Number(price).toFixed(2),
          publishedAt: hour.posted.toISOString(),
          isFinal: true,
          source: SOURCE_ARCHIVE,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------

function connect(): Client {
  const ref =
    process.env.SUPABASE_PROJECT_REF ||
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!ref || !process.env.SUPABASE_DB_PASSWORD) {
    throw new Error("SUPABASE_DB_PASSWORD plus SUPABASE_PROJECT_REF (or NEXT_PUBLIC_SUPABASE_URL) must be set");
  }
  return new Client({
    host: "aws-0-us-west-2.pooler.supabase.com",
    port: 5432,
    user: `postgres.${ref}`,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: "postgres",
    statement_timeout: 300_000,
    ssl: { rejectUnauthorized: false },
  });
}

async function main() {
  const fromDay = arg("from") ?? "2026-09-20";
  const dryRun = process.argv.includes("--dry-run");
  const from = new Date(`${fromDay}T05:00:00Z`); // Central midnight (CDT)
  const to = new Date(Date.now() + 48 * HOUR_MS);
  const startedAt = new Date();

  const db = connect();
  await db.connect();
  try {
    const marketRes = await db.query<{ id: string; settlement_point: string }>("select id, settlement_point from markets");
    const marketId = new Map(marketRes.rows.map((r) => [r.settlement_point, r.id]));
    const existing = new Set(
      (
        await db.query<{ point: string; product: string; start: Date }>(
          `select distinct m.settlement_point point, mp.product, mp.delivery_timestamp start
           from market_prices mp join markets m on m.id = mp.market_id
           where mp.delivery_timestamp >= $1`,
          [from]
        )
      ).rows.map((r) => key({ point: r.point, product: r.product, start: r.start.toISOString() }))
    );
    console.log(`[backfill] ${existing.size} observed intervals already stored since ${fromDay}`);

    // Pass 1: rolling reports (real posting stamps).
    const planned = new Map<string, Row>();
    const source = new ErcotMISSource();
    for (const product of PRODUCTS) {
      const t0 = Date.now();
      const recs = await source.getPrices(from, to, [product]);
      let added = 0;
      for (const rec of recs) {
        const row = fromRecord(rec);
        const k = key(row);
        if (existing.has(k) || planned.has(k)) continue;
        planned.set(k, row);
        added++;
      }
      console.log(`[backfill] rolling ${product}: ${recs.length} received, ${added} fill gaps (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }

    // Pass 2: annual archives for whatever is still missing.
    const days = centralDays(fromDay, new Date());
    for (const [label, rows] of [
      ["archive RTM", await archiveRtm(days)],
      ["archive DAM", await archiveDam(days)],
      ["archive AS", await archiveAs(days)],
    ] as const) {
      let added = 0;
      for (const row of rows) {
        const k = key(row);
        if (existing.has(k) || planned.has(k)) continue;
        planned.set(k, row);
        added++;
      }
      console.log(`[backfill] ${label}: ${rows.length} parsed, ${added} fill gaps`);
    }

    // Only points the catalog trades (hubs, load zones, and the shared AS row).
    const rows = [...planned.values()].filter(
      (r) => marketId.has(r.point) && (r.point === AS_POINT || isHubOrZone(r.point))
    );
    const byProduct = new Map<string, number>();
    for (const r of rows) byProduct.set(r.product, (byProduct.get(r.product) ?? 0) + 1);
    console.log(`[backfill] ${rows.length} rows to write:`, Object.fromEntries(byProduct));
    if (dryRun) return;

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 5000) {
      const chunk = rows.slice(i, i + 5000);
      const res = await db.query(
        `insert into market_prices
           (market_id, product, delivery_timestamp, delivery_end, price, venue, source, source_timestamp, published_at, is_final)
         select t.market_id, t.product, t.start, t.end_ts, t.price, t.venue, t.source, t.published_at, t.published_at, t.is_final
         from unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::numeric[],
                     $6::text[], $7::text[], $8::timestamptz[], $9::boolean[])
              as t(market_id, product, start, end_ts, price, venue, source, published_at, is_final)
         where not exists (
           select 1 from market_prices mp
           where mp.market_id = t.market_id and mp.product = t.product and mp.delivery_timestamp = t.start
         )
         on conflict do nothing`,
        [
          chunk.map((r) => marketId.get(r.point)),
          chunk.map((r) => r.product),
          chunk.map((r) => r.start),
          chunk.map((r) => r.end),
          chunk.map((r) => r.price),
          chunk.map((r) => requireProduct(r.product).venue),
          chunk.map((r) => r.source),
          chunk.map((r) => r.publishedAt),
          chunk.map((r) => r.isFinal),
        ]
      );
      inserted += res.rowCount ?? 0;
      console.log(`[backfill] wrote ${inserted}/${rows.length}`);
    }

    // Settle every RT hour whose Central day has elapsed, through the engine's
    // own rule rather than a copy of it.
    await db.query("begin");
    await db.query("set local role service_role");
    const promoted = await db.query<{ n: number }>("select public.promote_rtm_finals() n");
    await db.query("commit");

    await db.query(
      `insert into ingestion_runs (source, status, started_at, finished_at, records_received, records_inserted, records_skipped, detail)
       values ($1, 'SUCCESS', $2, now(), $3, $4, $5, $6)`,
      [
        SOURCE_ARCHIVE,
        startedAt,
        rows.length,
        inserted,
        rows.length - inserted,
        {
          kind: "backfill",
          tool: "scripts/backfill-ercot.ts",
          from: fromDay,
          by_product: Object.fromEntries(byProduct),
          finals_promoted: promoted.rows[0]?.n ?? 0,
          archive_reports: ["NP6-785-ER", "NP4-180-ER"],
        },
      ]
    );
    console.log(`[backfill] done: ${inserted} inserted, ${promoted.rows[0]?.n ?? 0} RT hours promoted to final`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("[backfill] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
