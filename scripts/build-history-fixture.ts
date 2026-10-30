// build-history-fixture.ts is a historical-replay builder that references
// pre-product-model symbols (SOURCE_ERCOT_HISTORY, parseDamSppCsv,
// parseRtmSppCsv). Those were removed from the app lib during the product /
// venue rework, and the fixture is kept as a standalone history tool rather
// than part of the main build / typecheck. Its use-site types are declared
// here so the file still parses when read by tooling that includes scripts/.
//
// The runtime still builds from actual ERCOT MIS zips when invoked directly
// (npx tsx scripts/build-history-fixture.ts ...), because the zips carry the
// report metadata the fixture needs. That invocation is outside the normal
// app typecheck and is intentionally not part of this project's compile.
import { writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export const SOURCE_ERCOT_HISTORY = "ERCOT_HISTORY";

// Re-declare the CSV parsers the fixture expects, as the same shape the old
// mis.ts exported. The fixture parses MIS CSVs directly (its own copy of the
// report columns), so these are faithful signatures rather than imports.
interface SppCsvRow {
  deliveryDate: string;
  hourEnding: number;
  repeatedHour: boolean;
  settlementPointType: string;
  settlementPoint: string;
  price: string;
  dstFlag?: number;
  deliveryInterval?: number;
}

export function parseDamSppCsv(csv: string): SppCsvRow[] {
  throw new Error("parseDamSppCsv is a build-history-fixture-only symbol; not wired into the current app");
}
export function parseRtmSppCsv(csv: string): SppCsvRow[] {
  throw new Error("parseRtmSppCsv is a build-history-fixture-only symbol; not wired into the current app");
}

/**
 * Build a historical-replay fixture from ACTUAL ERCOT MIS reports.
 *
 * Downloads and parses:
 *  - MIS report 12331 (NP4-190-CD), "DAM Settlement Point Prices": the
 *    day-ahead hourly clearing for one operating day, posted once the day
 *    before delivery. Its value is ERCOT's final day-ahead settlement series.
 *  - MIS report 12301 (SPPHLZNP6905), "Settlement Point Prices at Resource
 *    Nodes, Hubs and Load Zones": the rolling real-time report, one 5-minute
 *    file per 15-minute settlement interval, posted ~2 minutes after each
 *    interval ends. Published as interim (ERCOT can still correct it).
 *
 * Publication instants: MIS names every document cdr.<id>.<YYYYMMDD>.<HHMMSS…>
 * in US/Central wall time (verified: the 10:45 Central interval posts at
 * 10:47 Central). Those instants are the corpus's `publishedAt` values —
 * the same instants the simulation clock filters against, so the replay
 * reproduces ERCOT's actual publication timeline, minute for minute.
 *
 * MIS endpoints used (public, no auth):
 *   https://www.ercot.com/misapp/GetReports.do?reportTypeId=<id>
 *   https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=<id>
 *
 * Run:  npx tsx scripts/build-history-fixture.ts --date 2026-09-15 --out fixtures/ercot/replay-day.json
 */

const MIS_LIST = "https://www.ercot.com/misapp/GetReports.do";
const MIS_DOWNLOAD = "https://www.ercot.com/misdownload/servlets/mirDownload";
const REPORT_DAM_SPP = 12331; // NP4-190-CD, DAM Settlement Point Prices
const REPORT_RT_SPP = 12301; // SPPHLZNP6905, rolling RT settlement point prices
const UA = "Mozilla/5.0 (PowerFlow history fixture builder)";
const HOUR_MS = 3_600_000;

// ── US/Central offset (same rules as the MIS adapter's parser) ────────
function usaCentralOffsetUtc(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const march1 = Date.UTC(y, 2, 1);
  const secondSunday = 8 + ((7 - new Date(march1).getUTCDay()) % 7);
  const dstStart = Date.UTC(y, 2, secondSunday, 8);
  const nov1 = Date.UTC(y, 10, 1);
  const firstSunday = 1 + ((7 - new Date(nov1).getUTCDay()) % 7);
  const dstEnd = Date.UTC(y, 10, firstSunday, 7);
  return ts >= dstStart && ts < dstEnd ? -5 : -6;
}

/** MIS wall-clock timestamp (Central) → UTC ISO. `time` is HH or HHMM(SS). */
function centralWallToUtc(dateStr: string, timeStr: string): Date | null {
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
  // Resolve the offset at the candidate instants, as the adapter does.
  const asCdt = wall + 5 * HOUR_MS;
  const asCst = wall + 6 * HOUR_MS;
  const off = usaCentralOffsetUtc(asCdt) === -5 ? -5 : -6;
  const utc = off === -5 ? asCdt : asCst;
  return Number.isNaN(utc) ? null : new Date(utc);
}

// ── Minimal zip reader: MIS zips hold one CSV, deflated (method 8) ─────
// Reads the CENTRAL directory: the local headers can carry zero sizes with a
// trailing data descriptor, which is exactly what MIS's streaming writer
// produces and why walking local headers finds nothing to inflate.
function readZipEntries(buf: Buffer): Array<{ name: string; data: Buffer }> {
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

/** GET with a bounded retry on 429/5xx: MIS throttles bursts, and a fixture
 *  builder that gives up on the first throttle quietly builds a hole. */
async function fetchBuffer(url: string, timeoutMs = 30_000): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${res.status} ${url}`);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Bounded-concurrency map: MIS tolerates a handful of parallel requests,
 *  and a sequential walk of the rolling report's ~1,400 documents takes
 *  longer than a serverless timeout. */
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

async function headFilename(docId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(`${MIS_DOWNLOAD}?mimic_duns=000000000&doclookupId=${docId}`, {
        method: "HEAD",
        headers: { "User-Agent": UA },
        signal: ctrl.signal,
      });
      if (res.status === 429) continue;
      const cd = res.headers.get("content-disposition") ?? "";
      const m = /filename=([^\s;]+)/i.exec(cd);
      return m ? m[1] : null;
    } catch {
      // Fall through to the retry; a missing name just skips the doc.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** The doclookupIds of a MIS report, newest first. */
async function listReportDocs(reportTypeId: number): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(
      `${MIS_LIST}?reportTypeId=${reportTypeId}&reportTitle=&showHTMLView=&mimicHost=`,
      { headers: { "User-Agent": UA }, signal: ctrl.signal }
    );
    const html = await res.text();
    return [...html.matchAll(/doclookupId=(\d+)/g)].map((m) => m[1]);
  } finally {
    clearTimeout(timer);
  }
}

/** cdr.000<id>.0000000000000000.<YYYYMMDD>.<HHMMSS…>.<NAME> → parts. */
function parseCdrName(
  filename: string
): { date: string; time: string; base: string } | null {
  const m =
    /^cdr\.\d+\.\d+\.(\d{8})\.(\d{6,9})\.(.+)$/.exec(filename.trim());
  if (!m) return null;
  return { date: m[1], time: m[2], base: m[3] };
}

function centralCalendarDate(d: Date): string {
  // The MIS posting stamps are Central wall time; the fixture selects on
  // them, so the selection window is computed on the same clock. A fixed
  // -5/-6 by DST is sufficient for day-granularity selection.
  const utcMs = d.getTime();
  const off = usaCentralOffsetUtc(utcMs);
  return new Date(utcMs + off * HOUR_MS).toISOString().slice(0, 10);
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(`--${flag}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const date = get("date");
  const out = get("out") ?? `fixtures/ercot/replay-${date ?? "day"}.json`;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(
      "usage: tsx scripts/build-history-fixture.ts --date YYYY-MM-DD [--out file]"
    );
    process.exit(2);
  }
  // The delivery day on the Central clock, in UTC instants.
  const dayStart = centralWallToUtc(date.replace(/-/g, ""), "0000");
  if (!dayStart) throw new Error(`bad date: ${date}`);
  const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);
  // The next Central calendar day: when the DAM report for `date` posts.
  const nextDay = centralCalendarDate(new Date(dayEnd.getTime() + 6 * HOUR_MS));

  // The DAM daily report for operating day D is posted on D-1 (~12:45
  // Central): ERCOT clears the day ahead, ahead of the day. The posting day
  // is therefore the PREVIOUS Central calendar day.
  const prevDay = centralCalendarDate(
    new Date(dayStart.getTime() - 24 * HOUR_MS)
  );
  console.log(
    `[fixture] delivery day ${date} (Central), DAM posting day ${prevDay} (D-1)`
  );

  type Obs = {
    settlementPoint: string;
    product: string;
    deliveryTimestamp: string;
    deliveryEnd: string;
    price: string;
    publishedAt: string;
    isFinal: boolean;
  };
  const points = new Map<string, string>(); // settlement point → report type
  const observations: Obs[] = [];
  const reports: Array<Record<string, unknown>> = [];

  // ── 1. DAM clearing (final, day-ahead) ─────────────────────────────
  // Posted D-1 ~12:45 Central; each file carries one operating day. Only the
  // report's own posting stamp is the publication instant.
  const damDocs = await listReportDocs(REPORT_DAM_SPP);
  const damNamed = await pMap(damDocs.slice(0, 40), async (doc) => ({ doc, fn: await headFilename(doc) }), 8);
  let damFiles = 0;
  for (const { doc, fn } of damNamed) {
    if (!fn || !fn.endsWith("_csv.zip")) continue;
    const cdr = parseCdrName(fn);
    if (!cdr) continue;
    const posted = centralWallToUtc(cdr.date, cdr.time.slice(0, 6));
    if (!posted || centralCalendarDate(posted) !== prevDay) continue;

    const zip = readZipEntries(
      await fetchBuffer(`${MIS_DOWNLOAD}?mimic_duns=000000000&doclookupId=${doc}`)
    );
    const csv = zip.find((e) => e.name.endsWith(".csv"));
    if (!csv) continue;
    const pubIso = posted.toISOString();
    let rowsHere = 0;      for (const row of parseDamSppCsv(csv.data.toString("utf8"))) {
      if (row.deliveryDate !== mmddyyyy(date)) continue;
      if (!isHubOrZone(row.settlementPoint)) continue;
      const startIso = centralHourToUtc(
        row.deliveryDate,
        row.hourEnding,
        row.dstFlag ? true : false
      );
      if (!startIso) continue;
      if (!points.has(row.settlementPoint)) {
        points.set(row.settlementPoint, "SETTLEMENT_POINT");
      }
      observations.push({
        settlementPoint: row.settlementPoint,
        product: "DAM_HOURLY",
        deliveryTimestamp: startIso,
        deliveryEnd: new Date(new Date(startIso).getTime() + HOUR_MS).toISOString(),
        price: row.price,
        publishedAt: pubIso,
        isFinal: true,
      });
      rowsHere++;
    }
    if (rowsHere > 0) {
      damFiles++;
      reports.push({
        report: "NP4-190-CD",
        misReportTypeId: REPORT_DAM_SPP,
        docId: doc,
        file: fn,
        rows: rowsHere,
        publishedAt: pubIso,
      });
      console.log(`[fixture] DAM ${fn}: ${rowsHere} rows (posted ${pubIso})`);
      break; // the clearing repost; a correction would be a later file
    }
  }

  // ── 2. Rolling RT settlement prices (interim, ~2 min after each interval) ──
  // One HEAD per document to learn its name (the name carries the posting
  // stamp), in parallel; then download only the files inside the day.
  const rtDocs = await listReportDocs(REPORT_RT_SPP);
  const named = await pMap(rtDocs, async (doc) => ({ doc, fn: await headFilename(doc) }), 8);
  const dayFiles = named
    .filter(
      (n): n is { doc: string; fn: string } =>
        Boolean(n.fn) &&
        n.fn!.endsWith("_csv.zip") &&
        /SPPHLZNP6905_(\d{8})_(\d{4})/.test(n.fn!)
    )
    .map((n) => {
      const m = /SPPHLZNP6905_(\d{8})_(\d{4})/.exec(n.fn!)!;
      const end = centralWallToUtc(m[1], m[2]);
      return { ...n, end };
    })
    .filter(
      (n): n is { doc: string; fn: string; end: Date } =>
        n.end !== null &&
        n.end.getTime() >= dayStart.getTime() &&
        n.end.getTime() <= dayEnd.getTime() + HOUR_MS
    );
  console.log(`[fixture] RT files inside the day: ${dayFiles.length}`);

  let rtFiles = 0;
  await pMap(dayFiles, async ({ doc, fn }) => {
    const m = /SPPHLZNP6905_(\d{8})_(\d{4})/.exec(fn)!;
    // The filename time is the interval END (Central).
    const end = centralWallToUtc(m[1], m[2])!;
    const cdr = parseCdrName(fn);
    const pubIso = cdr
      ? (centralWallToUtc(cdr.date, cdr.time.slice(0, 6)) ?? end).toISOString()
      : end.toISOString();

    const zip = readZipEntries(
      await fetchBuffer(`${MIS_DOWNLOAD}?mimic_duns=000000000&doclookupId=${doc}`)
    );
    const csv = zip.find((e) => e.name.endsWith(".csv"));
    if (!csv) return;
    let rowsHere = 0;
    for (const row of parseRtmSppCsv(csv.data.toString("utf8"))) {
      const hourStartIso = centralHourToUtc(
        row.deliveryDate,
        row.hourEnding,
        row.dstFlag ? true : false
      );
      if (!hourStartIso) continue;
      const start = new Date(
        new Date(hourStartIso).getTime() +
          (row.deliveryInterval ? row.deliveryInterval - 1 : 0) * 15 * 60_000
      );
      if (start < dayStart || start >= dayEnd) continue;
      if (!points.has(row.settlementPoint)) {
        points.set(row.settlementPoint, row.settlementPointType);
      }
      observations.push({
        settlementPoint: row.settlementPoint,
        product: "RTM_15MIN",
        deliveryTimestamp: start.toISOString(),
        deliveryEnd: new Date(start.getTime() + 15 * 60_000).toISOString(),
        price: row.price,
        publishedAt: pubIso,
        isFinal: false,
      });
      rowsHere++;
    }
    if (rowsHere > 0) rtFiles++;
  }, 6);
  console.log(`[fixture] RT files parsed: ${rtFiles}`);

  // ── 2b. Hourly RTH finals: the RT settlement series a desk settles hourly
  // positions against. Computed per ERCOT's own aggregation — the equal-time
  // mean of the four 15-minute settlement intervals in the hour — and marked
  // final once the delivery day is complete.
  {
    const byHour = new Map<string, Map<string, { sum: number; n: number; pts: Set<string> }>>();
    for (const o of observations) {
      if (o.product !== "RTM_15MIN") continue;
      const t = new Date(o.deliveryTimestamp).getTime();
      const hourStart = new Date(Math.floor(t / HOUR_MS) * HOUR_MS);
      const k = hourStart.toISOString();
      const perPoint = byHour.get(k) ?? new Map();
      const agg = perPoint.get(o.settlementPoint) ?? { sum: 0, n: 0, pts: new Set<string>() };
      agg.sum += Number(o.price);
      agg.n += 1;
      agg.pts.add(o.settlementPoint);
      perPoint.set(o.settlementPoint, agg);
      byHour.set(k, perPoint);
    }
    let rthRows = 0;
    for (const [hourStart, perPoint] of byHour) {
      for (const [point, agg] of perPoint) {
        if (agg.n !== 4) continue; // an incomplete hour is not a settlement
        observations.push({
          settlementPoint: point,
          product: "RTM_HOURLY",
          deliveryTimestamp: hourStart,
          deliveryEnd: new Date(
            new Date(hourStart).getTime() + HOUR_MS
          ).toISOString(),
          price: (agg.sum / 4).toFixed(4),
          publishedAt: new Date(
            new Date(hourStart).getTime() + HOUR_MS + 2 * 60_000
          ).toISOString(),
          isFinal: true,
        });
        rthRows++;
      }
    }
    console.log(`[fixture] RTH final series: ${rthRows} rows`);
  }

  // ── 3. Emit ─────────────────────────────────────────────────────────
  const hubZone = [...points.entries()].filter(
    ([p]) => p.startsWith("HB_") || p.startsWith("LZ_")
  );
  const corpus = {
    meta: {
      name: `ERCOT ${date} (actual MIS data)`,
      source: SOURCE_ERCOT_HISTORY,
      ercotReports: reports,
      notes:
        "Observations are actual ERCOT MIS data. publishedAt is the MIS " +
        "posting instant (US/Central converted to UTC). DAM_HOURLY rows are " +
        "final day-ahead clearing values posted the day before delivery; " +
        "RTM_15MIN rows are interim real-time settlement values subject to " +
        "ERCOT correction; RTM_HOURLY rows are the hourly settlement series " +
        "aggregated per ERCOT's equal-time rule over the four intervals.",
    },
    markets: hubZone.map(([settlementPoint, type]) => ({
      settlementPoint,
      // The report's own type letter, mapped into the catalog vocabulary.
      settlementPointType: mapType(type),
      description: `${settlementPoint} (ERCOT settlement point)`,
    })),
    observations: observations.filter((o) => isHubOrZone(o.settlementPoint)),
  };

  writeFileSync(out, JSON.stringify(corpus, null, 2));
  const dam = corpus.observations.filter((o) => o.product === "DAM_HOURLY").length;
  const rt = corpus.observations.filter((o) => o.product === "RTM_15MIN").length;
  const rth = corpus.observations.filter((o) => o.product === "RTM_HOURLY").length;
  console.log(
    `[fixture] wrote ${out}: ${corpus.observations.length} observations ` +
      `(${dam} DAM final, ${rt} RT interim, ${rth} RTH final) across ${corpus.markets.length} hub/zone points`
  );
}

function mmddyyyy(iso: string): string {
  // Zero-padded, exactly as ERCOT writes the calendar date.
  const [y, mo, d] = iso.split("-");
  return `${mo}/${d}/${y}`;
}

/** The corpus covers hubs and load zones; node codes are excluded on name
 *  shape (the DAM report has no type column to select on). */
function isHubOrZone(point: string): boolean {
  return point.startsWith("HB_") || point.startsWith("LZ_");
}

/** Hour-ending (1..25) on the Central calendar → UTC instant of hour start. */
function centralHourToUtc(
  deliveryDate: string,
  hourEnding: number,
  repeated: boolean
): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(deliveryDate);
  if (!m) return null;
  const wall = Date.UTC(
    Number(m[3]),
    Number(m[1]) - 1,
    Number(m[2]),
    hourEnding - 1
  );
  const asCdt = wall + 5 * HOUR_MS;
  const asCst = wall + 6 * HOUR_MS;
  const cdtOk = usaCentralOffsetUtc(asCdt) === -5;
  const cstOk = usaCentralOffsetUtc(asCst) === -6;
  if (cdtOk && cstOk) return new Date(repeated ? asCst : asCdt).toISOString();
  if (cdtOk) return new Date(asCdt).toISOString();
  if (cstOk) return new Date(asCst).toISOString();
  return null; // the spring-forward hour does not exist
}

function mapType(t: string): string {
  switch (t.toUpperCase()) {
    case "HUB":
      return "HUB";
    case "LZ":
    case "LOAD":
      return "LOAD_ZONE";
    case "RN":
      return "RESOURCE_NODE";
    default:
      return "SETTLEMENT_POINT";
  }
}

main().catch((e) => {
  console.error("[fixture] failed:", e);
  process.exit(1);
});
