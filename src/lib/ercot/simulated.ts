import {
  DA_PRICE_FLOOR,
  DA_SYSTEM_WIDE_OFFER_CAP,
  ErcotSource,
  NormalizedMarket,
  NormalizedPriceRecord,
  REGIONAL_HUBS,
  RT_PRICE_FLOOR,
  RT_SYSTEM_WIDE_OFFER_CAP,
  SettlementPointType,
  requireProduct,
  truncateToInterval,
} from "@/lib/ercot/types";

/**
 * Deterministic simulated ERCOT feed.
 *
 * This is the default data source. It produces plausible, reproducible prices
 * keyed by (product, settlement point, delivery interval) — the same interval
 * always yields the same price, which makes ingestion idempotent.
 *
 * It models ERCOT's *two* energy markets rather than one generic curve:
 *   - DAM_HOURLY: a smoother day-ahead forward clearing, floored at the
 *     -$251/MWh administrative floor and bounded by the $5,000/MWh day-ahead
 *     offer cap.
 *   - RTM_15MIN: real-time 15-minute settlement intervals, floored at
 *     -$251/MWh and bounded by the $2,000/MWh real-time offer cap, with
 *     scarcity adders standing in for the reserve-shortage adders and rare
 *     congestion blowouts that can push LMP *past* the offer cap.
 *   - RTM_HOURLY: the hourly average (RTH) of the four RTM_15MIN intervals,
 *     exactly as ERCOT builds the hourly figure.
 *
 * The location universe covers the published hubs, the hub averages, the four
 * competitive and four non-opt-in load zones, and resource nodes.
 *
 * Zone levels follow the IMM's 2024–2025 load-weighted real-time averages —
 * West is the rich zone and Houston the cheap one, the opposite of the folk
 * wisdom the earlier generator encoded. Panhandle is modelled cheap and
 * volatile, as an export-constrained wind-heavy hub.
 *
 * Records are labeled SOURCE_SIMULATED and the UI always shows them as
 * "Simulated", never as live ERCOT data. Point the app at a real adapter
 * (ERCOT_MIS) for live production data.
 */

export interface SimulatedMarketDef {
  settlementPoint: string;
  settlementPointType: SettlementPointType;
  description: string;
  /** Mean price across the sample range ($/MWh). Ignored for derived points. */
  dayBase: number;
  /** Diurnal half-range ($/MWh) around the mean. */
  dayAmp: number;
  /**
   * Derived settlement points are averages of other locations rather than
   * independently priced — this is how ERCOT actually publishes them:
   * HB_HUBAVG is the simple average of the four regional hubs (Panhandle
   * excluded), evaluated per interval.
   */
  averageOf?: readonly string[];
}

/** Resource nodes are synthesized here rather than hard-coded: the real ~1,036
 *  node codes come from ERCOT's Settlement Points List and Electrical Buses
 *  Mapping file, which is an ingestion concern. */
const NODES_PER_ZONE = 3;
const NODE_OFFSETS = [-6, 0.5, 7];

function resourceNodes(
  zone: string,
  dayBase: number,
  dayAmp: number
): SimulatedMarketDef[] {
  const suffix = zone.replace(/^LZ_/, "");
  return NODE_OFFSETS.slice(0, NODES_PER_ZONE).map((offset, i) => ({
    settlementPoint: `RN_${suffix}_${i + 1}`,
    settlementPointType: "RESOURCE_NODE" as SettlementPointType,
    description: `${zone} resource node ${i + 1} (synthesized)`,
    // Nodes are the most granular and most volatile prices in the market.
    dayBase: dayBase + offset,
    dayAmp: dayAmp + 3,
  }));
}

const ZONES: Array<[string, string, number, number]> = [
  ["LZ_HOUSTON", "Houston load zone", 35, 13],
  ["LZ_NORTH", "North load zone", 35.3, 13],
  ["LZ_SOUTH", "South load zone", 37.6, 13],
  ["LZ_WEST", "West load zone", 41.6, 15],
  ["LZ_AEN", "Austin Energy (NOIE) load zone", 37.5, 13],
  ["LZ_CPS", "CPS Energy (NOIE) load zone", 37.8, 13],
  ["LZ_LCRA", "LCRA (NOIE) load zone", 39, 14],
  ["LZ_RAYBN", "Rayburn Country (NOIE) load zone", 36, 13],
];

const PRIMARY: SimulatedMarketDef[] = [
  { settlementPoint: "HB_HOUSTON", settlementPointType: "HUB", description: "Houston 345kV hub", dayBase: 34, dayAmp: 12 },
  { settlementPoint: "HB_NORTH", settlementPointType: "HUB", description: "North 345kV hub", dayBase: 34.5, dayAmp: 12 },
  { settlementPoint: "HB_SOUTH", settlementPointType: "HUB", description: "South 345kV hub", dayBase: 36.5, dayAmp: 12 },
  { settlementPoint: "HB_WEST", settlementPointType: "HUB", description: "West 345kV hub", dayBase: 40, dayAmp: 14 },
  // Export-constrained and wind-heavy: cheap on average, violent when it isn't.
  { settlementPoint: "HB_PAN", settlementPointType: "HUB", description: "Panhandle 345kV hub", dayBase: 30, dayAmp: 18 },
  ...ZONES.map(([settlementPoint, description, dayBase, dayAmp]) => ({
    settlementPoint,
    settlementPointType: "LOAD_ZONE" as SettlementPointType,
    description,
    dayBase,
    dayAmp,
  })),
  ...ZONES.flatMap(([zone, , dayBase, dayAmp]) =>
    resourceNodes(zone, dayBase, dayAmp)
  ),
];

const DERIVED: SimulatedMarketDef[] = [
  {
    settlementPoint: "HB_HUBAVG",
    settlementPointType: "HUB_AVERAGE",
    description: "ERCOT hub average (four regional hubs, Panhandle excluded)",
    dayBase: 0,
    dayAmp: 0,
    averageOf: REGIONAL_HUBS,
  },
  {
    settlementPoint: "HB_BUSAVG",
    settlementPointType: "HUB_AVERAGE",
    description: "ERCOT bus average (approximated by the hub and zone set)",
    dayBase: 0,
    dayAmp: 0,
    averageOf: [
      ...REGIONAL_HUBS,
      "HB_PAN",
      ...ZONES.map(([zone]) => zone),
    ],
  },
];

export const SIMULATED_MARKETS: SimulatedMarketDef[] = [...PRIMARY, ...DERIVED];

const LOCATION_BY_POINT = new Map(
  SIMULATED_MARKETS.map((m) => [m.settlementPoint, m])
);

export const SIMULATED_PRODUCTS: readonly string[] = [
  "DAM_HOURLY",
  "RTM_15MIN",
  "RTM_HOURLY",
];

const QUARTER_MINUTES = 15;

// ── tiny deterministic PRNG (mulberry32) ──────────────────────────────
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prngFor(key: string) {
  return mulberry32(hashString(key));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Weekend shoulder prices, summer-like weekday peaks. */
function weekendFactor(ts: Date): number {
  const dow = ts.getUTCDay();
  return dow === 0 || dow === 6 ? 0.82 : 1;
}

/** Diurnal load shape, 0..1, indexed by the UTC hour of delivery. */
function loadFactor(ts: Date): number {
  const hour = ts.getUTCHours();
  return Math.sin(((hour - 8) / 24) * 2 * Math.PI) * 0.5 + 0.5;
}

function baseCurve(market: SimulatedMarketDef, ts: Date): number {
  return market.dayBase + market.dayAmp * (2 * loadFactor(ts) - 1) * weekendFactor(ts);
}

/** Day-ahead hourly clearing price: a smooth forward curve with occasional
 *  scarcity, bounded by the day-ahead floor and offer cap. */
function daHourlyPrice(
  market: SimulatedMarketDef,
  intervalStart: Date,
  source: string
): number {
  const prng = prngFor(
    `${source}::DAM_HOURLY::${market.settlementPoint}::${intervalStart.toISOString()}`
  );
  let p = baseCurve(market, intervalStart);
  p += (prng() - 0.5) * market.dayBase * 0.2;
  if (prng() < 0.008) p += market.dayBase * (1 + prng() * 4);
  return clamp(p, DA_PRICE_FLOOR, DA_SYSTEM_WIDE_OFFER_CAP);
}

/** Real-time 15-minute settlement interval price. */
function rtIntervalPrice(
  market: SimulatedMarketDef,
  intervalStart: Date,
  source: string
): number {
  const prng = prngFor(
    `${source}::RTM_15MIN::${market.settlementPoint}::${intervalStart.toISOString()}`
  );
  let p = baseCurve(market, intervalStart);
  // Interval noise: real-time is visibly jumpier than day-ahead.
  p += (prng() - 0.5) * market.dayBase * 0.3;

  const reserve = prng();
  if (reserve < 0.012) {
    // Reserve shortage: the adder that lifts real-time prices toward the cap.
    p += market.dayBase * (1.5 + prng() * 6);
  } else if (reserve < 0.03) {
    p += prng() * 40;
  }

  if (prng() < 0.02) {
    // Wind-driven / shoulder-hour negative pricing.
    p -= market.dayBase * 0.5;
  }

  // Administrative floor, then the real-time offer cap.
  p = Math.max(p, RT_PRICE_FLOOR);
  if (prng() < 0.002) {
    // Extreme congestion: LMP can exceed the offer cap.
    return Math.min(p, DA_SYSTEM_WIDE_OFFER_CAP);
  }
  return Math.min(p, RT_SYSTEM_WIDE_OFFER_CAP);
}

/** RT hourly average (RTH): the equal-time-weighted mean of the four
 *  15-minute intervals in the hour. */
function rthPrice(
  market: SimulatedMarketDef,
  intervalStart: Date,
  source: string
): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += rtIntervalPrice(
      market,
      new Date(intervalStart.getTime() + i * QUARTER_MINUTES * 60_000),
      source
    );
  }
  return sum / 4;
}

export function simulatedPrice(
  market: SimulatedMarketDef,
  deliveryTimestamp: Date,
  source: string,
  product = "RTM_HOURLY"
): string {
  const def = requireProduct(product);
  const start = truncateToInterval(deliveryTimestamp, def.intervalMinutes);

  // Derived settlement points are averages of other locations, evaluated per
  // interval — the same rule ERCOT publishes them under.
  if (market.averageOf) {
    const members = market.averageOf
      .map((p) => LOCATION_BY_POINT.get(p))
      .filter((m): m is SimulatedMarketDef => Boolean(m));
    if (members.length === 0) return "0.0000";
    let sum = 0;
    for (const m of members) {
      sum += Number(simulatedPrice(m, start, source, def.code));
    }
    return (sum / members.length).toFixed(4);
  }

  if (def.code === "RTM_15MIN") {
    return rtIntervalPrice(market, start, source).toFixed(4);
  }
  if (def.venue === "DAM") {
    return daHourlyPrice(market, start, source).toFixed(4);
  }
  if (def.code === "RTM_HOURLY") {
    return rthPrice(market, start, source).toFixed(4);
  }
  // Ancillary / congestion products have no simulated series yet; a zero
  // series keeps them representable without inventing prices.
  return "0.0000";
}

export function generateMarketPrices(
  markets: SimulatedMarketDef[],
  from: Date,
  to: Date,
  source: string,
  products: readonly string[] = SIMULATED_PRODUCTS
): NormalizedPriceRecord[] {
  const records: NormalizedPriceRecord[] = [];

  for (const code of products) {
    const def = requireProduct(code);
    const stepMs = def.intervalMinutes * 60_000;
    const start = truncateToInterval(from, def.intervalMinutes);
    const end = truncateToInterval(to, def.intervalMinutes);

    for (const market of markets) {
      for (let t = start.getTime(); t < end.getTime(); t += stepMs) {
        const intervalStart = new Date(t);
        records.push({
          settlementPoint: market.settlementPoint,
          deliveryTimestamp: intervalStart.toISOString(),
          deliveryEnd: new Date(t + stepMs).toISOString(),
          price: simulatedPrice(market, intervalStart, source, def.code),
          product: def.code,
          sourceTimestamp: new Date().toISOString(),
        });
      }
    }
  }

  return records;
}

export class SimulatedErcotSource implements ErcotSource {
  readonly sourceName = "SIMULATED";

  constructor(
    private markets: SimulatedMarketDef[] = SIMULATED_MARKETS,
    private products: readonly string[] = SIMULATED_PRODUCTS
  ) {}

  async getMarkets(): Promise<NormalizedMarket[]> {
    return this.markets.map((m) => ({
      settlementPoint: m.settlementPoint,
      settlementPointType: m.settlementPointType,
      description: m.description,
    }));
  }

  async getProducts(): Promise<string[]> {
    return [...this.products];
  }

  async getPrices(
    from: Date,
    to: Date,
    products: readonly string[] = this.products
  ): Promise<NormalizedPriceRecord[]> {
    return generateMarketPrices(
      this.markets,
      from,
      to,
      this.sourceName,
      products
    );
  }
}
