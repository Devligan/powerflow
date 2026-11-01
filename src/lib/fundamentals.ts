/**
 * ERCOT fundamentals — what a desk reads before bidding the day-ahead market:
 * the hourly system load forecast and available capacity, and the wind and
 * solar production forecasts (STWPF / STPPF). Net load (load − wind − solar)
 * drives the price: low net load is when negative prices print, tight
 * reserves when scarcity does.
 *
 * Read from ERCOT's public dashboard feeds (no credentials), cached for five
 * minutes; nothing is stored. A feed that fails yields null and the panel is
 * simply not shown.
 */

const BASE = "https://www.ercot.com/api/1/services/read/dashboards";

export interface FundamentalHour {
  he: number;
  repeated: boolean;
  /** MW */
  load: number | null;
  capacity: number | null;
  wind: number | null;
  solar: number | null;
  netLoad: number | null;
  /** Available capacity minus forecast load, MW. */
  reserve: number | null;
}

export interface FundamentalDay {
  day: string;
  hours: FundamentalHour[];
}

export interface Fundamentals {
  updated: string | null;
  /** The next operating day, hour by hour (the day being bid). */
  next: FundamentalDay | null;
  /** Peak forecast load per day for the coming week, MW. */
  weekPeaks: Array<{ day: string; peakLoad: number; minReserve: number }>;
}

interface LoadRow {
  deliveryDate: string;
  hourEnding: number;
  dstFlag: string;
  forecastedDemand: number;
  availCapGen: number;
}

interface WindSolarRow {
  hourEnding: number;
  dstFlag: string;
  stwpf?: number;
  stppf?: number;
}

async function get<T>(name: string): Promise<T | null> {
  try {
    // ERCOT's edge refuses server requests without a browser-like
    // User-Agent (the MIS ingestion sends one for the same reason).
    const res = await fetch(`${BASE}/${name}.json`, {
      headers: { "User-Agent": "Mozilla/5.0 (PowerFlow fundamentals)", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      console.error(`[fundamentals] ${name}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.error(`[fundamentals] ${name}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function getFundamentals(): Promise<Fundamentals | null> {
  const [sd, ws] = await Promise.all([
    get<{ lastUpdated?: string; forecast?: LoadRow[] }>("supply-demand"),
    get<{ lastUpdated?: string; nextDay?: { date?: string; data?: Record<string, WindSolarRow> } }>(
      "combine-wind-solar"
    ),
  ]);
  if (!sd?.forecast?.length) return null;

  const byDay = new Map<string, LoadRow[]>();
  for (const r of sd.forecast) {
    if (!byDay.has(r.deliveryDate)) byDay.set(r.deliveryDate, []);
    byDay.get(r.deliveryDate)!.push(r);
  }
  const weekPeaks = [...byDay.entries()].map(([day, rows]) => ({
    day,
    peakLoad: Math.max(...rows.map((r) => r.forecastedDemand)),
    minReserve: Math.min(...rows.map((r) => r.availCapGen - r.forecastedDemand)),
  }));

  const nextDate = ws?.nextDay?.date?.slice(0, 10) ?? [...byDay.keys()][0];
  const loadRows = byDay.get(nextDate) ?? [];
  const wsRows = Object.values(ws?.nextDay?.data ?? {});
  const hours: FundamentalHour[] = loadRows.map((r) => {
    const repeated = r.dstFlag === "Y";
    const w = wsRows.find((x) => x.hourEnding === r.hourEnding && (x.dstFlag === "Y") === repeated);
    const load = num(r.forecastedDemand);
    const capacity = num(r.availCapGen);
    const wind = num(w?.stwpf);
    const solar = num(w?.stppf);
    return {
      he: r.hourEnding,
      repeated,
      load,
      capacity,
      wind,
      solar,
      netLoad: load != null && wind != null && solar != null ? load - wind - solar : null,
      reserve: load != null && capacity != null ? capacity - load : null,
    };
  });

  return {
    updated: ws?.lastUpdated ?? sd.lastUpdated ?? null,
    next: hours.length ? { day: nextDate, hours } : null,
    weekPeaks,
  };
}
