import {
  CorrectedInterval,
  ErcotSource,
  NormalizedMarket,
  PriceCorrectionDoc,
  NormalizedPriceRecord,
  SettlementPointType,
  requireProduct,
  settlementPointName,
  AS_SYSTEM_POINT,
  SOURCE_ERCOT_MIS,
} from "@/lib/ercot/types";
import { inflateRawSync } from "node:zlib";

/**
 * ERCOT adapter: fetches and parses the ERCOT Market Information System
 * (MIS) settlement reports DIRECTLY — MIS is public and needs no key — into
 * our internal model. Three report families, one per supported product:
 *
 *  1. MIS 12301 (SPPHLZNP6905), "Settlement Point Prices at Resource Nodes,
 *     Hubs and Load Zones" — the rolling real-time report, one file per
 *     15-minute settlement interval, columns:
 *       DeliveryDate, DeliveryHour, DeliveryInterval, SettlementPointName,
 *       SettlementPointType, SettlementPointPrice, DSTFlag
 *     DeliveryHour is the hour-ending; DeliveryInterval counts the four
 *     15-minute settlement intervals inside it (1..4). The file's name stamp
 *     is the interval END, which the parser derives rather than trusts. Each
 *     interval publishes ~2 minutes after it ends (verified against MIS
 *     postings: the 10:45 Central interval posts at 10:47 Central).
 *     → product RTM_15MIN, interim (ERCOT can still correct it).
 *
 *  2. The same 12301 files, aggregated per ERCOT's hourly settlement rule —
 *     the equal-time mean of the four settlement intervals in the delivery
 *     hour — once all four are published. This is the hourly real-time
 *     settlement series the desk trades and settles against.
 *     → product RTM_HOURLY, interim at publication, final once the delivery
 *     day closes (finality is carried on the observation, and a later
 *     corrected interval publishes a NEW observation whose re-aggregation
 *     supersedes this one at settlement).
 *
 *  3. MIS 12331 (NP4-190-CD), "DAM Settlement Point Prices" — the daily
 *     day-ahead clearing report, one file per operating day, posted the day
 *     BEFORE delivery (~12:45 Central). Columns:
 *       DeliveryDate, HourEnding ("HH:00"), SettlementPoint,
 *       SettlementPointPrice, DSTFlag
 *     → product DAM_HOURLY, final on arrival (the day-ahead clearing is
 *     ERCOT's settled value for the operating day).
 *
 * Publication instants: MIS names every document
 *   cdr.<reportId>.<zeros>.<YYYYMMDD>.<HHMMSSmmm>.<NAME>
 * in US/Central wall time. Those posting stamps are the records'
 * `publishedAt` values — the same instants the as-of engine filters against,
 * so marks, fills and settlements reproduce ERCOT's actual publication
 * timeline, minute for minute. The listing page
 * (misapp/GetReports.do?reportTypeId=<id>) carries each document's filename
 * and download link inline, so one scrape enumerates a report's archive
 * (the rolling report retains ~4.6 days) with no per-document probing.
 *
 * Finality: an ERCOT settlement value can be corrected after publication
 * (MIS price-correction reports, NP4-197). This adapter cannot see the
 * future: rolling-report rows publish as interim (isFinal=false) and stay
 * re-fetchable while MIS retains them; DAM rows are final. The observation
 * key stores revisions side by side and settlement waits for the final one.
 *
 * The trading engine never depends on these formats — only on the
 * normalized types in ercot/types.ts.
 *
 * MIS endpoints used (public, no auth):
 *   https://www.ercot.com/misapp/GetReports.do?reportTypeId=<id>
 *   https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=<id>
 */

export interface SppCsvRow {
  deliveryDate: string; // MM/DD/YYYY, ERCOT (US/Central) calendar date
  hourEnding: number; // 1..24 (1..25 on the fall-back day)
  settlementPointType: string;
  settlementPoint: string;
  price: string;
  // set when the RepeatedHourFlag is Y (the business DST 25th hour)
  repeatedHour: boolean;
}

/** One hourly row from the daily DAM settlement-point-price report. */
export interface DamSppCsvRow {
  deliveryDate: string;
  /** 1..24, parsed from the report's "HH:00" hour-ending column. */
  hourEnding: number;
  settlementPoint: string;
  price: string;
  dstFlag: boolean;
}

/** One 15-minute settlement interval from the rolling RT report. */
export interface RtmSppCsvRow {
  deliveryDate: string;
  hourEnding: number; // 1..24 (1..25 on the fall-back day)
  /** 15-minute interval within the delivery hour, 1..4 (1..4 always; the
   *  repeated hour's extra intervals carry DSTFlag Y instead). */
  deliveryInterval: number;
  settlementPointType: string;
  settlementPoint: string;
  price: string;
  dstFlag: boolean;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export { MAX_RESPONSE_BYTES };
const MARKET_CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_CONCURRENCY = 6;

const MIS_LIST_JSON =
  "https://www.ercot.com/misapp/servlets/IceDocListJsonWS";
/** The MIS website's own report-listing page (GetReports.do). Measured
 *  against the JSON listing API on 2026-09-24 (two independent interval
 *  postings), the API surfaced new RT files 23–35s BEFORE this page, and the
 *  page costs ~2s of 600KB+ HTML vs ~30ms of JSON — so the live path queries
 *  the API FIRST and keeps the page as a fallback for the day the page
 *  leads instead. */
const MIS_LIST_PAGE =
  "https://www.ercot.com/misapp/GetReports.do?reportTypeId=";
export const MIS_DOWNLOAD =
  "https://www.ercot.com/misdownload/servlets/mirDownload";
const REPORT_DAM_SPP = 12331; // NP4-190-CD, DAM Settlement Point Prices
const REPORT_RT_SPP = 12301; // SPPHLZNP6905, rolling RT settlement point prices
const REPORT_DAM_MCPC = 12329; // NP4-188-CD, DAM Clearing Prices for Capacity (AS)
const REPORT_RTM_PRICE_CORRECTIONS = 13045; // NP4-197, RTM price corrections

/** The ancillary-service series the MIS adapter publishes (report 12329). */
const AS_PRODUCTS: readonly string[] = ["REGUP", "REGDN", "RRS", "NSPIN", "ECRS"];

const MIS_UA = "Mozilla/5.0 (PowerFlow market-data ingestion)";

// ── US/Central DST helpers ────────────────────────────────────────────
function usaCentralOffsetUtc(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  // DST begins second Sunday of March at 02:00 CST (08:00 UTC)
  const march1 = Date.UTC(y, 2, 1);
  const dowMarch = new Date(march1).getUTCDay();
  const secondSunday = 8 + ((7 - dowMarch) % 7);
  const dstStart = Date.UTC(y, 2, secondSunday, 8);

  // DST ends first Sunday of November at 02:00 CDT (07:00 UTC)
  const nov1 = Date.UTC(y, 10, 1);
  const dowNov = new Date(nov1).getUTCDay();
  const firstSunday = 1 + ((7 - dowNov) % 7);
  const dstEnd = Date.UTC(y, 10, firstSunday, 7);

  return ts >= dstStart && ts < dstEnd ? -5 : -6;
}

const HOUR_MS = 3600 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

/**
 * Convert an ERCOT calendar date + delivery hour-ending into the UTC instant
 * its delivery interval starts at. Hour ending `1` = 00:00–01:00 Central.
 *
 * This cannot be a fixed offset applied to local midnight, because two days a
 * year are not 24 hours long and ERCOT reports them the way the wall clock
 * actually behaved — "skip hour" in spring (…1a, 3a…) and "extra hour" in
 * fall (…1a, 2a, 2a, 3a…):
 *
 *  - **Spring forward.** Local 02:00–03:00 does not exist. There is no instant
 *    to return, so `null` is, and that row is dropped. The day yields 23
 *    delivery instants whether the report omits the hour or includes it.
 *
 *  - **Fall back.** Local 01:00–02:00 happens twice, at -05:00 (CDT) and again
 *    at -06:00 (CST). The wall clock alone cannot say which is meant, which is
 *    precisely what ERCOT's `RepeatedHourFlag` (hourly reports) and `DSTFlag`
 *    (rolling RT report) are for: the unflagged row is the first (daylight)
 *    occurrence, the flagged row the second (standard) one. That is what
 *    yields 25 distinct instants for the day.
 *
 * Both are resolved by testing which of the two possible offsets actually
 * applies at the candidate instant, rather than by arithmetic on a single
 * assumed offset — a wall time that exists once resolves identically from both
 * candidates, one that exists twice resolves to two, and one that never
 * exists resolves to neither.
 */
export function deliveryCentralToUtc(
  dateStr: string,
  hourEnding: number,
  repeatedHour = false
): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateStr.trim());
  if (!m) throw new Error(`invalid ERCOT delivery date: ${dateStr}`);
  const [, mo, day, yr] = m;
  const month = Number(mo) - 1;
  const dayN = Number(day);
  const year = Number(yr);
  const hour = hourEnding - 1;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`invalid ERCOT hour ending: ${hourEnding}`);
  }

  // The local wall-clock time, encoded as if it were UTC.
  const wallMs = Date.UTC(year, month, dayN, 0, 0, 0, 0) + hour * HOUR_MS;

  const asDaylight = wallMs + 5 * HOUR_MS; // -05:00 (CDT)
  const asStandard = wallMs + 6 * HOUR_MS; // -06:00 (CST)
  const daylightValid = usaCentralOffsetUtc(asDaylight) === -5;
  const standardValid = usaCentralOffsetUtc(asStandard) === -6;

  if (daylightValid && standardValid) {
    // Ambiguous: the repeated hour. The flag picks the second occurrence.
    return new Date(repeatedHour ? asStandard : asDaylight).toISOString();
  }
  if (daylightValid) return new Date(asDaylight).toISOString();
  if (standardValid) return new Date(asStandard).toISOString();
  return null; // nonexistent local time: the spring-forward gap
}

/**
 * An MIS posting stamp (Central wall time, as encoded in the document name)
 * → the UTC instant the document was posted. `time` is HH, HHMM or HHMMSS.
 */
export function centralWallToUtc(
  dateStr: string,
  timeStr: string
): Date | null {
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(dateStr);
  const t = /^(\d{1,2})(\d{2})(\d{2})?$/.exec(timeStr);
  if (!d || !t) return null;
  const wall = Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
    t[3] ? Number(t[3]) : 0
  );
  // Resolve the offset at the candidate instants, as deliveryCentralToUtc does.
  const asCdt = wall + 5 * HOUR_MS;
  const asCst = wall + 6 * HOUR_MS;
  const off = usaCentralOffsetUtc(asCdt) === -5 ? -5 : -6;
  const utc = off === -5 ? asCdt : asCst;
  return Number.isNaN(utc) ? null : new Date(utc);
}

// ── MIS archive enumeration ───────────────────────────────────────────

/** One downloadable MIS document, resolved from a report's listing. */
export interface MisDoc {
  doclookupId: string;
  /** cdr.<reportId>.<zeros>.<YYYYMMDD>.<HHMMSSmmm>.<NAME> */
  filename: string;
  /** ERCOT's own posting stamp for the document (ISO with offset), from
   *  the listing API when available. */
  publishDate?: string;
}

/**
 * `cdr.000<id>.0000000000000000.<YYYYMMDD>.<HHMMSSmmm>.<NAME>` → parts.
 * The date/time are the POSTING stamp, US/Central wall time.
 */
export function parseCdrName(
  filename: string
): { date: string; time: string; base: string } | null {
  const m =
    /^cdr\.\d+\.\d+\.(\d{8})\.(\d{6,9})\.(.+)$/.exec(filename.trim());
  if (!m) return null;
  return { date: m[1], time: m[2], base: m[3] };
}

/**
 * Parse the MIS document-listing JSON (misapp IceDocListJsonWS) into the
 * report's downloadable documents. Pure, so the contract is unit-testable
 * offline: DocID is the download key, ConstructedName carries the posting
 * stamp, and PublishDate the posting's wall time (see `misPostedAt` for its
 * offset).
 */
export function parseMisListingJson(payload: unknown): MisDoc[] {
  const root = payload as {
    ListDocsByRptTypeRes?: {
      DocumentList?: Array<{
        Document?: {
          DocID?: string;
          ConstructedName?: string;
          PublishDate?: string;
        };
      }>;
    };
  };
  const list = root?.ListDocsByRptTypeRes?.DocumentList ?? [];
  const docs: MisDoc[] = [];
  for (const entry of list) {
    const d = entry?.Document;
    if (!d?.DocID || !d.ConstructedName) continue;
    docs.push({
      doclookupId: String(d.DocID),
      filename: d.ConstructedName,
      publishDate: typeof d.PublishDate === "string" ? d.PublishDate : undefined,
    });
  }
  return docs;
}

/**
 * A document's posting instant. ERCOT's PublishDate holds the posting's
 * Central wall time (the same as the cdr name stamp) but labels it with the
 * offset in force when the LISTING is requested, not when the document was
 * posted: in November every September posting reads -06:00 (a 15:20 CDT
 * posting as 16:20), and in September the same listing read -05:00. Taken
 * literally, anything re-read across a DST change is an hour off: late in the
 * fall, early (look-ahead) in the spring. So the wall time is read and its
 * offset resolved for its own date, as the cdr stamp is. (The repeated hour
 * of the fall-back night resolves to its first occurrence.)
 */
export function misPostedAt(doc: MisDoc): Date | null {
  const wall = doc.publishDate
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(doc.publishDate)
    : null;
  if (wall) {
    const d = centralWallToUtc(`${wall[1]}${wall[2]}${wall[3]}`, `${wall[4]}${wall[5]}${wall[6]}`);
    if (d) return d;
  }
  const cdr = parseCdrName(doc.filename);
  if (!cdr) return null;
  return centralWallToUtc(cdr.date, cdr.time.slice(0, 6));
}

/**
 * Parse the MIS website's report-listing page (GetReports.do) into its
 * downloadable documents. Pure, so the pairing rule is unit-testable
 * offline. The page is a table: one row per document, the document's
 * `cdr.…` filename in the title cell and, in a LATER row of that same
 * document's table block, the download link
 * `mirDownload?…doclookupId=<id>`. Filename and link pair by proximity in
 * document order — every download link that follows a filename before the
 * next filename belongs to it.
 *
 * No posting stamp is recoverable here: the page carries none, so scraped
 * docs take their stamp from the cdr filename (Central wall time), while
 * the API fallback carries ERCOT's authoritative `PublishDate`.
 */
export function parseMisListingPage(html: string): MisDoc[] {
  const tokens = [
    ...html.matchAll(
      /(cdr\.\d+\.\d+\.\d{8}\.\d{6,9}\.[A-Za-z0-9_.-]+)|doclookupId=(\d+)/g
    ),
  ].map((m) =>
    m[1] ? ({ kind: "name", value: m[1] } as const) : ({ kind: "id", value: m[2] } as const)
  );

  const docs: MisDoc[] = [];
  let currentName: string | null = null;
  for (const t of tokens) {
    if (t.kind === "name") {
      currentName = t.value;
    } else if (currentName) {
      docs.push({ doclookupId: t.value, filename: currentName });
      currentName = null; // exactly one download link per filename row
    }
  }
  return docs;
}

/**
 * Enumerate a MIS report's downloadable documents, newest first.
 *
 * Order of attempts:
 *  1. the JSON listing API — measured to surface new postings FIRST (by
 *     23–35s over the page), cheapest to fetch, carries the authoritative
 *     PublishDate stamps;
 *  2. the MIS website's listing page (scrape) — insurance for the day the
 *     page leads, or the API misbehaves.
 *
 * Either source alone is sufficient; both are live at all times.
 */
export async function listMisDocs(reportTypeId: number): Promise<MisDoc[]> {
  // 1. The JSON listing API — freshest and cheapest per measurement.
  try {
    const res = await fetch(`${MIS_LIST_JSON}?reportTypeId=${reportTypeId}`, {
      headers: { "User-Agent": MIS_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const docs = parseMisListingJson(await res.json());
      if (docs.length > 0) return docs;
    }
  } catch {
    // API unavailable — the page below is the availability fallback.
  }

  // 2. The website's listing page (scrape).
  const res = await fetch(`${MIS_LIST_PAGE}${reportTypeId}`, {
    headers: { "User-Agent": MIS_UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`MIS listing returned ${res.status} (report ${reportTypeId})`);
  }
  return parseMisListingPage(await res.text());
}

// ── Minimal zip reader: MIS zips hold one CSV, deflated (method 8) ─────
// Reads the CENTRAL directory: the local headers can carry zero sizes with a
// trailing data descriptor, which is exactly what MIS's streaming writer
// produces and why walking local headers finds nothing to inflate.
export function readZipEntries(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const entries: Array<{ name: string; data: Buffer }> = [];

  // End of central directory: signature 0x06054b50, scanned from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return entries;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // Resolve the member's data start from its LOCAL header (name/extra
    // lengths there can differ from the central copy).
    if (localOffset + 30 <= buf.length &&
        buf.readUInt32LE(localOffset) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) {
        entries.push({ name, data: Buffer.from(raw) });
      } else if (method === 8) {
        try {
          entries.push({ name, data: inflateRawSync(raw) });
        } catch {
          // A truncated or unsupported member is skipped; the caller counts
          // what actually parsed.
        }
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with a bounded retry on 429/5xx: MIS throttles bursts. */
async function fetchBuffer(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": MIS_UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${res.status} ${url}`);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * A MIS document never changes once posted (a correction is a new document
 * with its own doclookupId), so a fetched CSV can be reused for as long as the
 * function instance lives. Each run re-reads overlapping windows — RTM_HOURLY
 * resumes from its last FINAL hour, up to a day back — and without this every
 * frequent cron tick re-downloads the same files from ERCOT.
 */
const CSV_CACHE_MAX_ENTRIES = 600;
const CSV_CACHE_MAX_BYTES = 512 * 1024;
const csvCache = new Map<string, string | null>();

/** Fetch a MIS document by doclookupId and return its first CSV member. */
export async function fetchMisCsv(doclookupId: string): Promise<string | null> {
  if (csvCache.has(doclookupId)) return csvCache.get(doclookupId) ?? null;
  const buf = await fetchBuffer(
    `${MIS_DOWNLOAD}?mimic_duns=000000000&doclookupId=${doclookupId}`
  );
  if (buf.length > MAX_RESPONSE_BYTES) throw new Error("MIS document too large");
  const entry = readZipEntries(buf).find((e) => e.name.endsWith(".csv"));
  const csv = entry ? entry.data.toString("utf8") : null;
  // Only the small rolling RT files are worth holding; a DAM file is fetched
  // about once a day.
  if (csv === null || csv.length <= CSV_CACHE_MAX_BYTES) {
    if (csvCache.size >= CSV_CACHE_MAX_ENTRIES) {
      csvCache.delete(csvCache.keys().next().value as string);
    }
    csvCache.set(doclookupId, csv);
  }
  return csv;
}

/** Bounded-concurrency map: MIS tolerates a handful of parallel requests. */
async function pMap<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  limit: number
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Parse an ERCOT hourly "SPP" report CSV into normalized rows.
 * Tolerates: BOM, report metadata prefix lines, blank lines, and trailer
 * artifact rows. Invalid rows are skipped (the bad-record tally belongs to
 * the ingestion pipeline).
 */
export function parseErcotSppCsv(csv: string): SppCsvRow[] {
  const rows: SppCsvRow[] = [];
  const cleaned = csv.replace(/^\ufeff/, "");
  const lines = cleaned.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("DeliveryDate")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return rows;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 6) continue;
    if (parts[0] === "DosId" || parts[0] === "RowType") continue;
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(parts[0])) continue;

    const hourEnding = Number(parts[1]);
    if (!Number.isInteger(hourEnding) || hourEnding < 1 || hourEnding > 24) {
      continue;
    }

    const price = parts[5].replace(/[^\d.\-]/g, "");
    if (!price || Number.isNaN(Number(price))) continue;

    rows.push({
      deliveryDate: parts[0],
      hourEnding,
      repeatedHour: parts[2]?.toUpperCase() === "Y" || parts[2]?.toUpperCase() === "X",
      settlementPointType: parts[3],
      settlementPoint: parts[4],
      price,
    });
  }
  return rows;
}

/**
 * Parse one file of the rolling 15-minute RT report (MIS 12301). The file
 * carries exactly one (date, hour, interval) triple across all settlement
 * points, but the parser resolves each row independently so a concatenated
 * stream still parses.
 */
export function parseRtmSppCsv(csv: string): RtmSppCsvRow[] {
  const rows: RtmSppCsvRow[] = [];
  const cleaned = csv.replace(/^\ufeff/, "");
  const lines = cleaned.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("DeliveryDate")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return rows;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 6) continue;
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(parts[0])) continue;

    const hourEnding = Number(parts[1]);
    const interval = Number(parts[2]);
    if (
      !Number.isInteger(hourEnding) ||
      hourEnding < 1 ||
      hourEnding > 25 ||
      !Number.isInteger(interval) ||
      interval < 1 ||
      interval > 4
    ) {
      continue;
    }

    const price = parts[5].replace(/[^\d.\-]/g, "");
    if (!price || Number.isNaN(Number(price))) continue;

    rows.push({
      deliveryDate: parts[0],
      hourEnding,
      deliveryInterval: interval,
      settlementPointType: parts[4],
      settlementPoint: parts[3],
      price,
      dstFlag: parts[6]?.toUpperCase() === "Y",
    });
  }

  // ERCOT prints every load zone and DC tie TWICE per interval, in adjacent
  // rows: once under the point's own type code (LZ / DC) and once under its
  // EHV variant (LZEW / DCEW), with prices within a rounding hair of each
  // other (|Δ| ≤ 0.02). They are two prints of ONE settlement observation.
  // Downstream, the hourly settlement aggregation counts interval rows, so an
  // undeduped print makes a two-interval hour look complete and publishes a
  // doubled "average" — keep the canonical typed print (the one matching the
  // point's own family) and drop the EHV twin, preserving file order.
  const canonical = new Map<string, RtmSppCsvRow>();
  for (const row of rows) {
    const key = `${row.deliveryDate}|${row.hourEnding}|${row.deliveryInterval}|${row.settlementPoint}`;
    const prev = canonical.get(key);
    if (!prev) {
      canonical.set(key, row);
      continue;
    }
    const prevIsEw = /EW$/.test(prev.settlementPointType);
    const rowIsEw = /EW$/.test(row.settlementPointType);
    if (prevIsEw && !rowIsEw) canonical.set(key, row);
  }
  return [...canonical.values()];
}

/** One corrected 15-minute price from ERCOT's NP4-197 report. */
export interface RtmPriceCorrectionRow {
  deliveryDate: string;
  hourEnding: number;
  deliveryInterval: number;
  settlementPoint: string;
  settlementPointType: string;
  original: string;
  corrected: string;
  dstFlag: boolean;
}

/**
 * Parse one NP4-197 real-time SPP correction file (MIS 13045,
 * `pricecorrection_RTM_SPP_*`). Columns, read by name:
 *   DeliveryDate, DeliveryHour, DeliveryInterval, SettlementPointName,
 *   SettlementPointType, SPPOriginal, SPPCorrected, PriceCorrectionTime,
 *   DSTFlag
 * Load zones are printed twice here too (LZ and LZEW), but unlike the rolling
 * report a correction lists only the prints that changed: an interval can
 * carry its LZEW twin alone, which means the canonical LZ print was NOT
 * corrected. EW rows are therefore dropped outright, never taken as a stand-in.
 */
export function parseRtmPriceCorrectionCsv(csv: string): RtmPriceCorrectionRow[] {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim().startsWith("DeliveryDate"));
  if (headerIdx === -1) return [];
  const header = lines[headerIdx].trim().split(",");
  const col = (name: string) => header.indexOf(name);
  const c = {
    date: col("DeliveryDate"),
    hour: col("DeliveryHour"),
    interval: col("DeliveryInterval"),
    point: col("SettlementPointName"),
    type: col("SettlementPointType"),
    original: col("SPPOriginal"),
    corrected: col("SPPCorrected"),
    dst: col("DSTFlag"),
  };
  if (Object.values(c).some((i) => i < 0)) {
    throw new Error("NP4-197 correction file has an unexpected header");
  }

  const canonical = new Map<string, RtmPriceCorrectionRow>();
  for (const line of lines.slice(headerIdx + 1)) {
    const parts = line.trim().split(",");
    if (parts.length < header.length) continue;
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(parts[c.date])) continue;
    if (/EW$/i.test(parts[c.type])) continue;
    const hourEnding = Number(parts[c.hour]);
    const interval = Number(parts[c.interval]);
    if (!Number.isInteger(hourEnding) || hourEnding < 1 || hourEnding > 24) continue;
    if (!Number.isInteger(interval) || interval < 1 || interval > 4) continue;
    const corrected = cleanPrice(parts[c.corrected]);
    if (!corrected) continue;
    const row: RtmPriceCorrectionRow = {
      deliveryDate: parts[c.date],
      hourEnding,
      deliveryInterval: interval,
      settlementPoint: parts[c.point],
      settlementPointType: parts[c.type],
      original: cleanPrice(parts[c.original]) ?? "",
      corrected,
      dstFlag: parts[c.dst]?.toUpperCase() === "Y",
    };
    // One correction per interval and point; a repeated row restates it.
    canonical.set(
      `${row.deliveryDate}|${row.hourEnding}|${row.deliveryInterval}|${row.dstFlag}|${row.settlementPoint}`,
      row
    );
  }
  return [...canonical.values()];
}

/**
 * Parse the DAILY DAM "Settlement Point Prices" report (MIS 12331,
 * NP4-190-CD). Its columns differ from the 60-day SPP report — no
 * settlement-point-type column, the hour written as "HH:00", and a DST flag
 * carrying the repeated-hour mark:
 *
 *   DeliveryDate,HourEnding,SettlementPoint,SettlementPointPrice,DSTFlag
 *   09/23/2026,01:00,7RNCHSLR_ALL, 37.87,N
 *
 * The report is posted once per operating day, the day BEFORE delivery
 * (~12:45 Central), and its values are the final day-ahead clearing.
 */
export function parseDamSppCsv(csv: string): DamSppCsvRow[] {
  const rows: DamSppCsvRow[] = [];
  const cleaned = csv.replace(/^\ufeff/, "");
  const lines = cleaned.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("DeliveryDate")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return rows;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 5) continue;
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(parts[0])) continue;

    // "01:00" .. "24:00" — the hour ending, written with a colon.
    const hourEnding = parseInt(parts[1], 10);
    if (!Number.isInteger(hourEnding) || hourEnding < 1 || hourEnding > 24) {
      continue;
    }

    const price = parts[3].replace(/[^\d.\-]/g, "");
    if (!price || Number.isNaN(Number(price))) continue;

    rows.push({
      deliveryDate: parts[0],
      hourEnding,
      settlementPoint: parts[2].trim(),
      price,
      dstFlag: parts[4]?.toUpperCase() === "Y",
    });
  }
  return rows;
}

/**
 * One parsed row of the DAILY DAM "Clearing Prices for Capacity" report
 * (MIS 12329, NP4-188-CD): the Market Clearing Price for Capacity (MCPC)
 * of one ancillary-service type for one delivery hour. The layout matches
 * the DAM SPP report's — "HH:00" hour endings, a DST flag — with the AS
 * type code where a settlement point would be.
 */
export interface DamMcpcCsvRow {
  deliveryDate: string;
  hourEnding: number;
  ancillaryType: string;
  price: string;
  dstFlag: boolean;
}

/**
 * Parse the daily DAM AS clearing report (MIS 12329). Exactly ERCOT's five
 * published AS types appear — RRS, NSPIN, REGUP, REGDN, ECRS — one MCPC per
 * type per delivery hour, final on arrival (the day-ahead clearing), posted
 * the day before delivery alongside the DAM energy clearing.
 */
export function parseDamMcpcCsv(csv: string): DamMcpcCsvRow[] {
  const rows: DamMcpcCsvRow[] = [];
  const cleaned = csv.replace(/^\ufeff/, "");
  const lines = cleaned.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("DeliveryDate")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return rows;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 5) continue;
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(parts[0])) continue;

    const hourEnding = parseInt(parts[1], 10);
    if (!Number.isInteger(hourEnding) || hourEnding < 1 || hourEnding > 24) {
      continue;
    }

    const ancillaryType = parts[2].trim().toUpperCase();
    if (!ANCILLARY_TYPES.has(ancillaryType)) continue;

    const price = parts[3].replace(/[^\d.\-]/g, "");
    if (!price || Number.isNaN(Number(price))) continue;

    rows.push({
      deliveryDate: parts[0],
      hourEnding,
      ancillaryType,
      price,
      dstFlag: parts[4]?.toUpperCase() === "Y",
    });
  }
  return rows;
}

/** The AS type codes ERCOT publishes in NP4-188-CD (and the catalog carries). */
const ANCILLARY_TYPES = new Set(["RRS", "NSPIN", "REGUP", "REGDN", "ECRS"]);

const TYPE_MAP: Record<string, SettlementPointType> = {
  HUB: "HUB",
  LOAD: "LOAD_ZONE",
  LOAD_ZONE: "LOAD_ZONE",
  LZ: "LOAD_ZONE",
  RN: "RESOURCE_NODE",
  RESOURCE_NODE: "RESOURCE_NODE",
  SETTLEMENT_POINT: "SETTLEMENT_POINT",
};

function cleanPrice(raw: string): string | null {
  const price = raw.replace(/[^\d.\-]/g, "");
  if (!price || Number.isNaN(Number(price))) return null;
  return price;
}

/**
 * The universe this platform quotes: the ERCOT hubs and load zones. The MIS
 * reports also carry thousands of individual resource nodes (…_RN), which are
 * not part of the trading catalog — selected on the point-name shape, the one
 * selector the reports agree on.
 */
export function isHubOrZone(point: string): boolean {
  return point.startsWith("HB_") || point.startsWith("LZ_");
}

function marketType(point: string, reportType?: string): SettlementPointType {
  const mapped = reportType ? TYPE_MAP[reportType.toUpperCase()] : undefined;
  if (mapped && mapped !== "RESOURCE_NODE") return mapped;
  if (point.startsWith("HB_")) return "HUB";
  if (point.startsWith("LZ_")) return "LOAD_ZONE";
  return "SETTLEMENT_POINT";
}

export class ErcotMISSource implements ErcotSource {
  readonly sourceName = SOURCE_ERCOT_MIS;
  /** A live MIS feed publishes as ERCOT publishes: the cron advances it.
   *  (ERCOT_REPLAY deployments run this same adapter in archive mode — see
   *  the resolver — where scripts/ingest-history.ts drives it instead.) */
  readonly publicationMode: "live" | "archive" = "live";
  /** MIS keeps every daily report downloadable, so any past window can be
   *  re-resolved from ERCOT's own files (the history loader walks it). */
  readonly canServeHistory = true;
  private marketsCache: { markets: NormalizedMarket[]; expires: number } | null =
    null;

  /**
   * Products published, one per MIS report family:
   *   DAM_HOURLY  — the daily day-ahead clearing (MIS 12331), final.
   *   RTM_15MIN   — the rolling real-time settlement intervals (MIS 12301),
   *                 interim, ~2 min publication latency.
   *   RTM_HOURLY  — the hourly real-time settlement series, aggregated per
   *                 ERCOT's equal-time rule over the four intervals once all
   *                 four are published.
   */
  async getProducts(): Promise<string[]> {
    return ["DAM_HOURLY", "RTM_15MIN", "RTM_HOURLY", ...AS_PRODUCTS];
  }

  /**
   * The traded settlement points. Scraped from the rolling RT report's
   * listing (its CSVs enumerate every published point), filtered to the
   * hubs and load zones that form the trading catalog. CACHED for 10
   * minutes: the point universe changes at ERCOT's pace, not the cron's.
   */
  async getMarkets(): Promise<NormalizedMarket[]> {
    const now = Date.now();
    if (this.marketsCache && this.marketsCache.expires > now) {
      return this.marketsCache.markets;
    }
    // The newest RT file enumerates the points currently being published;
    // fall back to the DAM listing's newest file if the RT scrape comes up
    // empty (both carry the same hub/zone universe).
    const points: NormalizedMarket[] = [];
    for (const reportTypeId of [REPORT_RT_SPP, REPORT_DAM_SPP]) {
      const docs = await listMisDocs(reportTypeId);
      if (docs.length === 0) continue;
      const csv = await fetchMisCsv(docs[0].doclookupId);
      if (!csv) continue;
      const seen = new Set<string>();
      for (const row of parseRtmSppCsv(csv)) {
        if (!isHubOrZone(row.settlementPoint) || seen.has(row.settlementPoint)) {
          continue;
        }
        seen.add(row.settlementPoint);
        points.push({
          settlementPoint: row.settlementPoint,
          settlementPointType: marketType(
            row.settlementPoint,
            row.settlementPointType
          ),
          description:
            settlementPointName(row.settlementPoint) ??
            `${row.settlementPoint} (ERCOT settlement point)`,
        });
      }
      if (points.length > 0) break;
    }
    if (points.length === 0) {
      throw new Error("could not enumerate ERCOT settlement points from MIS");
    }
    // The AS series clear system-wide and live on one shared row.
    points.push({
      settlementPoint: AS_SYSTEM_POINT,
      settlementPointType: "SETTLEMENT_POINT",
      description: "Ancillary services (system-wide clearing)",
    });
    this.marketsCache = { markets: points, expires: now + MARKET_CACHE_TTL_MS };
    return points;
  }

  /**
   * Fetch a window of ERCOT settlement prices across the supported products.
   *
   * Publication time: every record of one MIS file shares that file's own
   * posting instant (the cdr name stamp, Central → UTC), because one MIS
   * file IS one publication event. For the rolling 15-minute report that is
   * ~2 minutes after the interval ends; the DAM clearing posts the day
   * before delivery.
   *
   * Window semantics: records whose DELIVERY interval intersects [from, to)
   * are returned. For the hourly products a delivery hour is published by
   * files that post after the hour starts, so selection runs on posting
   * time and filtering on delivery time.
   */
  async getPrices(
    from: Date,
    to: Date,
    products?: readonly string[]
  ): Promise<NormalizedPriceRecord[]> {
    const wanted = products?.length ? products : await this.getProducts();
    const records: NormalizedPriceRecord[] = [];
    for (const code of wanted) {
      const def = requireProduct(code);
      if (code === "RTM_15MIN") {
        records.push(...(await this.fetchRtm15Min(from, to, def.intervalMinutes)));
      } else if (code === "RTM_HOURLY") {
        records.push(...(await this.fetchRtmHourly(from, to, def.intervalMinutes)));
      } else if (code === "DAM_HOURLY") {
        records.push(...(await this.fetchDam(from, to, def.intervalMinutes)));
      } else if ((AS_PRODUCTS as readonly string[]).includes(code)) {
        records.push(...(await this.fetchDamMcpc(from, to, code)));
      } else {
        throw new Error(
          `ERCOT_MIS has no report family for product ${code}; INGEST_PRODUCTS must be limited to DAM_HOURLY, RTM_15MIN, RTM_HOURLY, and the AS series`
        );
      }
    }
    return records;
  }

  /**
   * The rolling RT report, one MIS file per 15-minute settlement interval.
   * Files are selected by INTERVAL END (the filename stamp) inside
   * (from, to]: the interval ending exactly at `to` covers [to−15m, to) and
   * belongs to the window, and a window opening mid-interval must not lose
   * the interval in progress.
   */
  private async fetchRtm15Min(
    from: Date,
    to: Date,
    intervalMinutes: number
  ): Promise<NormalizedPriceRecord[]> {
    const docs = await this.rtmDocsInWindow(from, to);
    let failures = 0;
    const records: NormalizedPriceRecord[] = [];
    await pMap(docs, async (doc) => {
      try {
        const csv = await fetchMisCsv(doc.doclookupId);
        if (!csv) return;
        const m = /SPPHLZNP6905_(\d{8})_(\d{4})_csv\.zip$/.exec(doc.filename);
        if (!m) return;
        const end = centralWallToUtc(m[1], m[2]);
        if (!end) return;
        const pubIso = this.postedAt(doc)?.toISOString();
        if (!pubIso) return;
        for (const row of parseRtmSppCsv(csv)) {
          if (!isHubOrZone(row.settlementPoint)) continue;
          const hourStart = deliveryCentralToUtc(
            row.deliveryDate,
            row.hourEnding,
            row.dstFlag
          );
          if (!hourStart) continue; // the spring-forward hour: no instant
          const start = new Date(
            new Date(hourStart).getTime() + (row.deliveryInterval - 1) * INTERVAL_MS
          );
          if (start.getTime() < from.getTime() || start.getTime() >= to.getTime()) {
            continue;
          }
          const price = cleanPrice(row.price);
          if (!price) continue;
          records.push({
            settlementPoint: row.settlementPoint,
            deliveryTimestamp: start.toISOString(),
            deliveryEnd: new Date(
              start.getTime() + intervalMinutes * 60_000
            ).toISOString(),
            price,
            product: "RTM_15MIN",
            sourceTimestamp: pubIso,
            publishedAt: pubIso,
            isFinal: false,
          });
        }
      } catch (e) {
        failures++;
        console.warn(
          `[ercot-mis] RTM_15MIN file failed (${doc.filename}):`,
          e instanceof Error ? e.message : e
        );
      }
    }, FETCH_CONCURRENCY);
    this.assertPartialSuccess(failures, docs.length, "RTM_15MIN");
    return records;
  }

  /**
   * The hourly real-time settlement series: per ERCOT's equal-time rule, the
   * mean of the four 15-minute settlement intervals in the delivery hour.
   * Aggregated here from the same 12301 files the 15-minute product uses —
   * MIS publishes no separate hourly settlement report — once ALL FOUR
   * intervals of the hour are published (a partial hour is not a settlement
   * value and is omitted; the next run completes it). Interim at
   * publication; a later correction to any interval republishes the
   * re-aggregated hour as a new observation.
   */
  private async fetchRtmHourly(
    from: Date,
    to: Date,
    intervalMinutes: number
  ): Promise<NormalizedPriceRecord[]> {
    // Need interval files ending in (from, to].
    const docs = await this.rtmDocsInWindow(
      new Date(from.getTime() + 1), // strictly after `from`
      to
    );
    let failures = 0;
    // hour-start → point → { interval → { price, pub } }. The map key is the
    // 15-minute INTERVAL, not the row: a file that re-offers an interval
    // (a correction, or ERCOT's adjacent LZ/LZEW double print surviving any
    // future parser change) must REPLACE that interval, not inflate the
    // row count. Completeness is then "4 distinct intervals" — a count that
    // duplicates cannot satisfy early and corrections cannot poison.
    const hours = new Map<
      number,
      Map<string, Map<number, { price: number; pub: number }>>
    >();
    await pMap(docs, async (doc) => {
      try {
        const csv = await fetchMisCsv(doc.doclookupId);
        if (!csv) return;
        const pubMs = this.postedAt(doc)?.getTime();
        if (pubMs === undefined) return;
        for (const row of parseRtmSppCsv(csv)) {
          if (!isHubOrZone(row.settlementPoint)) continue;
          const hourStart = deliveryCentralToUtc(
            row.deliveryDate,
            row.hourEnding,
            row.dstFlag
          );
          if (!hourStart) continue;
          const t = new Date(hourStart).getTime();
          if (t < from.getTime() || t >= to.getTime()) continue;
          const price = cleanPrice(row.price);
          if (!price) continue;
          const perPoint = hours.get(t) ?? new Map();
          const perInterval = perPoint.get(row.settlementPoint) ?? new Map();
          const interval = (row.hourEnding - 1) * 4 + row.deliveryInterval;
          const prev = perInterval.get(interval);
          // Same-interval reprint: later posting wins (a correction), and
          // equal-posting ties prefer the canonical typed print.
          if (prev && prev.pub > pubMs) continue;
          perInterval.set(interval, { price: Number(price), pub: pubMs });
          perPoint.set(row.settlementPoint, perInterval);
          hours.set(t, perPoint);
        }
      } catch (e) {
        failures++;
        console.warn(
          `[ercot-mis] RTM_HOURLY file failed (${doc.filename}):`,
          e instanceof Error ? e.message : e
        );
      }
    }, FETCH_CONCURRENCY);
    this.assertPartialSuccess(failures, docs.length, "RTM_HOURLY");

    const records: NormalizedPriceRecord[] = [];
    for (const [hourStartMs, perPoint] of hours) {
      for (const [point, perInterval] of perPoint) {
        if (perInterval.size !== 4) continue; // an incomplete hour is not a settlement
        let sum = 0;
        let pub = 0;
        for (const { price, pub: p } of perInterval.values()) {
          sum += price;
          pub = Math.max(pub, p);
        }
        records.push({
          settlementPoint: point,
          deliveryTimestamp: new Date(hourStartMs).toISOString(),
          deliveryEnd: new Date(
            hourStartMs + intervalMinutes * 60_000
          ).toISOString(),
          price: (sum / perInterval.size).toFixed(4),
          product: "RTM_HOURLY",
          sourceTimestamp: new Date(pub).toISOString(),
          publishedAt: new Date(pub).toISOString(),
          isFinal: false,
        });
      }
    }
    return records;
  }

  /**
   * The daily DAM clearing report (MIS 12331): one file per operating day,
   * posted the day BEFORE delivery (~12:45 Central), values final on
   * arrival. A delivery day's hours are published by one file that posts
   * ~36 hours before the last hour ends, so file selection runs on the
   * posting stamp over a window widened accordingly, and rows filter on
   * their own delivery instants.
   */
  private async fetchDam(
    from: Date,
    to: Date,
    intervalMinutes: number
  ): Promise<NormalizedPriceRecord[]> {
    const docs = await listMisDocs(REPORT_DAM_SPP);
    // A DAM file posted at T serves deliveries in [T+12h, T+36h]. Keep the
    // postings whose service window can intersect [from, to).
    const candidates = docs.filter((doc) => {
      const posted = this.postedAt(doc);
      if (!posted) return false;
      const servesFrom = posted.getTime() + 12 * HOUR_MS;
      const servesTo = posted.getTime() + 36 * HOUR_MS;
      return servesTo > from.getTime() && servesFrom < to.getTime();
    });

    let failures = 0;
    const records: NormalizedPriceRecord[] = [];
    await pMap(candidates, async (doc) => {
      try {
        const csv = await fetchMisCsv(doc.doclookupId);
        if (!csv) return;
        const docPosted = this.postedAt(doc);
        if (!docPosted) return;
        const pubIso = docPosted.toISOString();
        for (const row of parseDamSppCsv(csv)) {
          if (!isHubOrZone(row.settlementPoint)) continue;
          const start = deliveryCentralToUtc(
            row.deliveryDate,
            row.hourEnding,
            row.dstFlag
          );
          if (!start) continue;
          const startMs = new Date(start).getTime();
          if (startMs < from.getTime() || startMs >= to.getTime()) continue;
          const price = cleanPrice(row.price);
          if (!price) continue;
          records.push({
            settlementPoint: row.settlementPoint,
            deliveryTimestamp: start,
            deliveryEnd: new Date(
              startMs + intervalMinutes * 60_000
            ).toISOString(),
            price,
            product: "DAM_HOURLY",
            sourceTimestamp: pubIso,
            publishedAt: pubIso,
            // The day-ahead clearing is ERCOT's settled value for the
            // operating day: final on arrival.
            isFinal: true,
          });
        }
      } catch (e) {
        failures++;
        console.warn(
          `[ercot-mis] DAM file failed (${doc.filename}):`,
          e instanceof Error ? e.message : e
        );
      }
    }, FETCH_CONCURRENCY);
    this.assertPartialSuccess(failures, candidates.length, "DAM_HOURLY");
    return records;
  }

  /**
   * The daily DAM AS clearing report (MIS 12329, NP4-188-CD): one MCPC per
   * ancillary-service type per delivery hour, posted D-1 with the DAM energy
   * clearing, final on arrival. Same file-selection window logic as the DAM
   * SPP report (one file serves [posted+12h, posted+36h] of deliveries).
   *
   * The series lives on one SYSTEM-wide market row — AS clears for the
   * whole grid, not per settlement point — so every record names the shared
   * `AS_SYSTEM` point that the catalog seeds once (see scripts/seed.ts and
   * migration 0018's product family).
   */
  private async fetchDamMcpc(
    from: Date,
    to: Date,
    product: string
  ): Promise<NormalizedPriceRecord[]> {
    const docs = await listMisDocs(REPORT_DAM_MCPC);
    const candidates = docs.filter((doc) => {
      const posted = this.postedAt(doc);
      if (!posted) return false;
      const servesFrom = posted.getTime() + 12 * HOUR_MS;
      const servesTo = posted.getTime() + 36 * HOUR_MS;
      return servesTo > from.getTime() && servesFrom < to.getTime();
    });

    let failures = 0;
    const records: NormalizedPriceRecord[] = [];
    await pMap(candidates, async (doc) => {
      try {
        const csv = await fetchMisCsv(doc.doclookupId);
        if (!csv) return;
        const docPosted = this.postedAt(doc);
        if (!docPosted) return;
        const pubIso = docPosted.toISOString();
        for (const row of parseDamMcpcCsv(csv)) {
          if (row.ancillaryType !== product) continue;
          const start = deliveryCentralToUtc(
            row.deliveryDate,
            row.hourEnding,
            row.dstFlag
          );
          if (!start) continue;
          const startMs = new Date(start).getTime();
          if (startMs < from.getTime() || startMs >= to.getTime()) continue;
          records.push({
            settlementPoint: AS_SYSTEM_POINT,
            deliveryTimestamp: start,
            deliveryEnd: new Date(startMs + 3600_000).toISOString(),
            price: row.price,
            product,
            sourceTimestamp: pubIso,
            publishedAt: pubIso,
            isFinal: true,
          });
        }
      } catch (e) {
        failures++;
        console.warn(
          `[ercot-mis] AS file failed (${doc.filename}):`,
          e instanceof Error ? e.message : e
        );
      }
    }, FETCH_CONCURRENCY);
    this.assertPartialSuccess(failures, candidates.length, product);
    return records;
  }

  /**
   * ERCOT's real-time SPP correction postings (NP4-197), oldest first. The
   * report also carries LMP, shadow-price and AS corrections, and each in XML
   * as well; only the SPP CSVs bear on what the desk settles.
   */
  async listRtmPriceCorrections(): Promise<PriceCorrectionDoc[]> {
    const docs = await listMisDocs(REPORT_RTM_PRICE_CORRECTIONS);
    const out: PriceCorrectionDoc[] = [];
    for (const doc of docs) {
      if (!/\.pricecorrection_RTM_SPP_\d{8}_to_\d{8}_NP4197_csv\.zip$/.test(doc.filename)) {
        continue;
      }
      const posted = this.postedAt(doc);
      if (!posted) continue;
      out.push({ docId: doc.doclookupId, postedAt: posted.toISOString() });
    }
    return out.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  }

  /** One correction document's corrected 15-minute prices, hubs and zones. */
  async getRtmPriceCorrection(doc: PriceCorrectionDoc): Promise<CorrectedInterval[]> {
    const csv = await fetchMisCsv(doc.docId);
    if (!csv) throw new Error(`NP4-197 document ${doc.docId} holds no CSV`);
    const out: CorrectedInterval[] = [];
    for (const row of parseRtmPriceCorrectionCsv(csv)) {
      if (!isHubOrZone(row.settlementPoint)) continue;
      const hourStart = deliveryCentralToUtc(row.deliveryDate, row.hourEnding, row.dstFlag);
      if (!hourStart) continue;
      out.push({
        settlementPoint: row.settlementPoint,
        deliveryTimestamp: new Date(
          Date.parse(hourStart) + (row.deliveryInterval - 1) * INTERVAL_MS
        ).toISOString(),
        price: row.corrected,
      });
    }
    return out;
  }

  /**
   * The rolling RT documents whose INTERVAL END (the filename stamp) falls
   * in (from, to], enumerated from the listing page. Listing retention is
   * ~4.6 days, so windows older than that return an empty archive — which
   * the caller reports honestly rather than papering over.
   */
  private async rtmDocsInWindow(from: Date, to: Date): Promise<MisDoc[]> {
    const docs = await listMisDocs(REPORT_RT_SPP);
    const inWindow: Array<{ doc: MisDoc; end: Date }> = [];
    for (const doc of docs) {
      const m = /SPPHLZNP6905_(\d{8})_(\d{4})_csv\.zip$/.exec(doc.filename);
      if (!m) continue;
      const end = centralWallToUtc(m[1], m[2]);
      if (!end) continue;
      if (end.getTime() > from.getTime() && end.getTime() <= to.getTime()) {
        inWindow.push({ doc, end });
      }
    }
    // Oldest first, so a run that hits its record budget fills the OLDEST
    // gaps before adding the newest intervals.
    inWindow.sort((a, b) => a.end.getTime() - b.end.getTime());
    return inWindow.map((x) => x.doc);
  }

  private postedAt(doc: MisDoc): Date | null {
    return misPostedAt(doc);
  }

  /**
   * A single failed MIS file must not fail the run (the next run re-fetches
   * it — MIS retains the archive), but a run that failed EVERY file it
   * tried has learned nothing and must be recorded as a failure, not a
   * silent stall.
   */
  private assertPartialSuccess(
    failures: number,
    attempted: number,
    what: string
  ): void {
    if (attempted > 0 && failures === attempted) {
      throw new Error(
        `all ${attempted} MIS ${what} documents failed; failing the run rather than reporting an empty fetch`
      );
    }
  }
}
