import {
  ErcotSource,
  NormalizedMarket,
  NormalizedPriceRecord,
  SettlementPointType,
  requireProduct,
} from "@/lib/ercot/types";

/**
 * ERCOT adapter: parses the ERCOT Market Information System (MIS)
 * "60-Day RTM / DAM Settlement Point Price" report CSVs and a normalized
 * market catalog into our internal model.
 *
 * The trading engine never depends on this format — only on the normalized
 * types in ercot/types.ts.
 *
 * The real ERCOT MIS requires a signed report URL; this adapter expects
 * ERCOT_MIS_API_BASE_URL to point at a gateway that serves:
 *   GET {base}/markets → JSON [ { settlementPoint, settlementPointType, description } ]
 *   GET {base}/spp.csv?from=ISO&to=ISO → ERCOT-style CSV (see parseErcotSppCsv)
 * Without it the ingestion run fails cleanly and is recorded as such.
 */

export interface SppCsvRow {
  deliveryDate: string; // MM/DD/YYYY, ERCOT (US/Central) calendar date
  hourEnding: number; // 1..24
  settlementPointType: string;
  settlementPoint: string;
  price: string;
  // set when the RepeatedHourFlag is Y (the business DST 25th hour)
  repeatedHour: boolean;
}

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
 *    precisely what ERCOT's `RepeatedHourFlag` is for: the unflagged row is the
 *    first (daylight) occurrence, the flagged row the second (standard) one.
 *    That is what yields 25 distinct instants for the day.
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
 * Parse an ERCOT "60-Day SPP Report" CSV into normalized rows.
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
    if (!Number.isInteger(hourEnding) || hourEnding < 1 || hourEnding > 24) continue;

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

const TYPE_MAP: Record<string, SettlementPointType> = {
  HUB: "HUB",
  LOAD: "LOAD_ZONE",
  LOAD_ZONE: "LOAD_ZONE",
  SETTLEMENT_POINT: "SETTLEMENT_POINT",
};

export class ErcotMISSource implements ErcotSource {
  readonly sourceName = "ERCOT_MIS";
  /** Product the gateway's report carries; the 60-day SPP report is the
   *  real-time hourly series, so that is the default. */
  private readonly product: string;

  constructor(
    private baseUrl: string,
    private opts: { apiKey?: string; timeoutMs?: number; product?: string } = {}
  ) {
    this.product = opts.product ?? "RTM_HOURLY";
  }

  private async fetchText(path: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS
    );
    try {
      const headers: Record<string, string> = {};
      if (this.opts.apiKey) headers["X-API-Key"] = this.opts.apiKey;
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers,
        signal: controller.signal,
      });
      const body = await res.text();
      if (body.length > MAX_RESPONSE_BYTES) {
        throw new Error("response too large");
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async getMarkets(): Promise<NormalizedMarket[]> {
    const body = await this.fetchText("/markets");
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) {
      throw new Error("markets endpoint returned a non-array payload");
    }
    const markets: NormalizedMarket[] = [];
    for (const item of parsed) {
      const rec = item as Record<string, unknown>;
      if (typeof rec.settlementPoint !== "string") continue;
      markets.push({
        settlementPoint: rec.settlementPoint,
        settlementPointType:
          (TYPE_MAP[String(rec.settlementPointType ?? "")] as SettlementPointType) ??
          "SETTLEMENT_POINT",
        description:
          typeof rec.description === "string" ? rec.description : undefined,
      });
    }
    return markets;
  }

  async getProducts(): Promise<string[]> {
    return [this.product];
  }

  async getPrices(
    from: Date,
    to: Date,
    products?: readonly string[]
  ): Promise<NormalizedPriceRecord[]> {
    const def = requireProduct(products?.[0] ?? this.product);
    const qs = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const body = await this.fetchText(`/spp.csv?${qs.toString()}`);
    const parsed = parseErcotSppCsv(body);

    // The fall-back day repeats one hour ending. `RepeatedHourFlag` says which
    // of the two rows is the extra one; a second occurrence of the same
    // (day, hour ending) is treated as repeated as well, so the two rows map to
    // two distinct instants regardless of which one the feed flagged.
    const seenHour = new Set<string>();
    const records: NormalizedPriceRecord[] = [];

    for (const row of parsed) {
      const key = `${row.deliveryDate}|${row.hourEnding}`;
      const isRepeat = row.repeatedHour || seenHour.has(key);
      seenHour.add(key);

      // Hour-ending 1 = 00:00-01:00 Central; the interval start is the
      // delivery hour converted into UTC. A null means the wall time does not
      // exist (the spring-forward hour), so the row is skipped rather than
      // mapped onto a neighbouring interval.
      const iso = deliveryCentralToUtc(row.deliveryDate, row.hourEnding, isRepeat);
      if (iso === null) continue;
      const start = new Date(iso);

      records.push({
        settlementPoint: row.settlementPoint,
        deliveryTimestamp: start.toISOString(),
        deliveryEnd: new Date(
          start.getTime() + def.intervalMinutes * 60_000
        ).toISOString(),
        price: row.price,
        product: def.code,
        sourceTimestamp: from.toISOString(),
      });
    }
    return records;
  }
}