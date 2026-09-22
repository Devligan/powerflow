/**
 * Normalized market-data model.
 *
 * ERCOT publishes *different prices for the same delivery interval*. Energy is
 * priced two ways — day-ahead hourly SPPs out of the DAM, and real-time SPPs on
 * 15-minute settlement intervals (time-weighted SCED LMPs plus the reliability
 * deployment price adder; the ORDC adders were retired under RTC+B). Ancillary
 * services clear separately, and congestion rights price a source/sink pair
 * rather than a point.
 *
 * A price is therefore only meaningful as (settlement point, product,
 * interval) — never as "the price" of a settlement point. Everything here is
 * keyed that way so any ERCOT instrument the desk needs to represent has a
 * place to live.
 *
 * The trading engine and the rest of the application depend ONLY on these
 * types. If the ERCOT API changes, only the adapter (parsers) is modified —
 * everything downstream stays stable.
 */

export type SettlementPointType =
  | "RESOURCE_NODE"
  | "HUB"
  | "HUB_AVERAGE"
  | "LOAD_ZONE"
  | "DC_TIE"
  | "PUN"
  | "SOG"
  | "SETTLEMENT_POINT";

/** Where a price is published. OTC is bilateral/ICE tradeable against ERCOT
 *  indices — it has no ERCOT price series of its own and settles off the
 *  ERCOT settlement prices it references. */
export type MarketVenue = "DAM" | "RTM" | "AS" | "CRR" | "OTC";

/** Venues that publish their own price series. OTC trades bilaterally against
 *  ERCOT indices, so it has no series of its own. */
export type PriceVenue = Exclude<MarketVenue, "OTC">;

/**
 * Published settlement-point locations, per the ERCOT Settlement Points List.
 *
 * Resource nodes (~1,036 of them) and the DC tie points are *not* hard-coded
 * here on purpose — their codes come from ERCOT's Settlement Points List and
 * Electrical Buses Mapping file, which is an ingestion concern. Inventing node
 * codes would be worse than omitting them.
 */
export const HUBS: readonly string[] = [
  "HB_HOUSTON",
  "HB_NORTH",
  "HB_SOUTH",
  "HB_WEST",
  "HB_PAN",
];

/** The four regional hubs that make up the hub average (Panhandle excluded). */
export const REGIONAL_HUBS: readonly string[] = [
  "HB_HOUSTON",
  "HB_NORTH",
  "HB_SOUTH",
  "HB_WEST",
];

/** Published hub averages. HB_HUBAVG is the simple average of the four
 *  regional hubs in real time (excludes Panhandle); HB_BUSAVG is the bus
 *  average. */
export const HUB_AVERAGES: readonly string[] = ["HB_HUBAVG", "HB_BUSAVG"];

/** The four competitive load zones. */
export const COMPETITIVE_LOAD_ZONES: readonly string[] = [
  "LZ_HOUSTON",
  "LZ_NORTH",
  "LZ_SOUTH",
  "LZ_WEST",
];

/** Non-opt-in entity zones (municipal utilities that have not opted into
 *  retail choice). */
export const NOIE_LOAD_ZONES: readonly string[] = [
  "LZ_AEN",
  "LZ_CPS",
  "LZ_LCRA",
  "LZ_RAYBN",
];

export const LOAD_ZONES: readonly string[] = [
  ...COMPETITIVE_LOAD_ZONES,
  ...NOIE_LOAD_ZONES,
];

export type ProductKind = "ENERGY" | "ANCILLARY" | "CONGESTION";

/**
 * What a price is quoted per — which is also the unit the position's quantity
 * is held in.
 *
 * Energy settles in $/MWh over MWh. Ancillary services clear as *capacity*
 * rates in $/MW-hr over MW. These are different dimensions: 100 MWh and 100 MW
 * are not 200 of anything, so quantities of different units must never be added
 * together into one "volume" figure.
 */
export type PriceUnit = "MWH" | "MW";

/** ERCOT energy settles hourly in the DAM and on 15-minute intervals in RT. */
export type IntervalMinutes = 15 | 60;

export interface ProductDef {
  /** Persisted on market_prices.product / trades.product. */
  code: string;
  label: string;
  kind: ProductKind;
  venue: PriceVenue;
  intervalMinutes: IntervalMinutes;
  /** What the price is quoted per. Ancillary services clear as *capacity*
   *  prices ($/MW-hr), not energy prices ($/MWh), so a single price column
   *  cannot mix them without knowing which unit it is in. */
  pricedPer: PriceUnit;
  /** Whether the paper desk may open a position in this product yet. */
  tradable: boolean;
}

/**
 * The product catalog. This is what makes the desk able to represent every
 * tradable instrument rather than a single hard-coded one.
 *
 * `tradable` on a product is a property of the *price series*: whether a
 * caller may name it as the series an order is priced off. It is not the same
 * question as whether the desk can open a position in something — that is
 * `InstrumentDef.tradable`. Ancillary services and the auctioned CRRs are
 * priced but not tradable as series, while the CRR and PTP *instruments* are
 * open to order entry regardless.
 */
export const PRODUCTS: readonly ProductDef[] = [
  {
    code: "DAM_HOURLY",
    label: "Day-ahead hourly energy",
    kind: "ENERGY",
    venue: "DAM",
    intervalMinutes: 60,
    pricedPer: "MWH",
    tradable: true,
  },
  {
    code: "RTM_15MIN",
    label: "Real-time 15-minute energy",
    kind: "ENERGY",
    venue: "RTM",
    intervalMinutes: 15,
    pricedPer: "MWH",
    tradable: true,
  },
  {
    code: "RTM_HOURLY",
    label: "Real-time hourly average (RTH)",
    kind: "ENERGY",
    venue: "RTM",
    intervalMinutes: 60,
    pricedPer: "MWH",
    tradable: true,
  },
  // ── Ancillary services ───────────────────────────────────────────────
  // ERCOT's published ancillary-service price series are exactly five: ECRS,
  // NSPIN, REGDN, REGUP and RRS. They clear as capacity prices in $/MW-hr, so
  // a single price column cannot mix them with energy without knowing which
  // unit it holds — hence `pricedPer`.
  //
  // RRS is deliberately *one* product. It does have a real internal split —
  // Primary, Under and Fast Frequency Response — but that is a requirement
  // allocation *inside* RRS (the 2026 methodology review sets the PFR share of
  // RRS at 1,377 MW), and all of it clears at the single RRS price. Modelling
  // the three tiers as three products invented price series ERCOT never
  // publishes, which is why they were removed in migration 0018.
  //
  // DRRS is a real ERCOT product still in design (NPRR1235, PUCT guidance on
  // flexibility, TAC workshops through March 2026) with no price series yet.
  // It is catalogued so its series has somewhere to land on arrival.
  //
  // Known simplification: AS clears in *both* the DAM (hourly) and real time
  // (co-optimized SCED) under RTC+B; this catalogues them once under venue AS
  // and distinguishes the two clearing passes later.
  {
    code: "REGUP",
    label: "Regulation Up",
    kind: "ANCILLARY",
    venue: "AS",
    intervalMinutes: 60,
    pricedPer: "MW",
    tradable: false,
  },
  {
    code: "REGDN",
    label: "Regulation Down",
    kind: "ANCILLARY",
    venue: "AS",
    intervalMinutes: 60,
    pricedPer: "MW",
    tradable: false,
  },
  {
    code: "RRS",
    label: "Responsive Reserve Service",
    kind: "ANCILLARY",
    venue: "AS",
    intervalMinutes: 60,
    pricedPer: "MW",
    tradable: false,
  },
  {
    code: "NSPIN",
    label: "Non-Spinning Reserve",
    kind: "ANCILLARY",
    venue: "AS",
    intervalMinutes: 60,
    pricedPer: "MW",
    tradable: false,
  },
  {
    code: "ECRS",
    label: "ERCOT Contingency Reserve Service",
    kind: "ANCILLARY",
    venue: "AS",
    intervalMinutes: 60,
    pricedPer: "MW",
    tradable: false,
  },
  {
    code: "DRRS",
    label: "Dispatchable Reliability Reserve Service (in design)",
    kind: "ANCILLARY",
    venue: "AS",
    intervalMinutes: 60,
    pricedPer: "MW",
    tradable: false,
  },
  // ── Congestion rights ────────────────────────────────────────────────
  // Auctioned annual / monthly / long-term; settle on the day-ahead
  // congestion between a source and a sink settlement point.
  {
    code: "CRR_OBLIGATION",
    label: "Congestion revenue right (PTP obligation)",
    kind: "CONGESTION",
    venue: "CRR",
    intervalMinutes: 60,
    pricedPer: "MWH",
    tradable: false,
  },
  {
    code: "CRR_OPTION",
    label: "Congestion revenue right (PTP option)",
    kind: "CONGESTION",
    venue: "CRR",
    intervalMinutes: 60,
    pricedPer: "MWH",
    tradable: false,
  },
];

const PRODUCT_BY_CODE = new Map(PRODUCTS.map((p) => [p.code, p]));

export function getProduct(code: string): ProductDef | undefined {
  return PRODUCT_BY_CODE.get(code);
}

/**
 * The unit a product's quantity is held in.
 *
 * Returns null for a code that is not catalogued rather than assuming a unit:
 * asserting "MWh" for something unknown is how a capacity position would get
 * silently counted as energy. Callers must decide what an unknown unit means.
 */
export function unitForProduct(code: string): PriceUnit | null {
  return PRODUCT_BY_CODE.get(code)?.pricedPer ?? null;
}

export function requireProduct(code: string): ProductDef {
  const p = PRODUCT_BY_CODE.get(code);
  if (!p) throw new Error(`unknown product: ${code}`);
  return p;
}

export function productsForVenue(venue: PriceVenue): ProductDef[] {
  return PRODUCTS.filter((p) => p.venue === venue);
}

export function tradableProducts(): ProductDef[] {
  return PRODUCTS.filter((p) => p.tradable);
}

/**
 * Instruments a trade can represent.
 *
 * Products are *price series* (one location, one interval). Instruments are
 * what a position can actually be held in. Most are one leg, but power trading
 * is dominated by instruments that are not a single price:
 *
 *   - legless financial positions (a virtual DAM bid has no delivery leg at
 *     all; it exists only to settle against the DA→RT convergence);
 *   - path instruments (a PTP obligation or CRR spans a source and a sink and
 *     settles on the congestion between them);
 *   - same-point two-sided instruments (a DART spread is one location valued in
 *     two markets);
 *   - period averages (a block forward or swap settles on the average of an
 *     index over a window, not on any one interval);
 *   - optionality (a PTP/CRR option or an OTC price option pays out on one side
 *     only).
 */
export type InstrumentKind =
  /** Single-leg, single-interval energy. */
  | "ENERGY"
  /** Legless: purely financial DA position with no intention to deliver. */
  | "VIRTUAL"
  /** Same-point day-ahead vs real-time convergence. */
  | "DART_SPREAD"
  /** Source/sink congestion path. */
  | "PTP_SPREAD"
  /** Two locations, same interval and market (hub vs zone, zone vs zone). */
  | "BASIS_SPREAD"
  /** Ancillary-service capacity position ($/MW-hr). */
  | "ANCILLARY"
  /** CRR held from auction. */
  | "CRR"
  /** Cash-settled average over a period (bal-day/week/month, block). */
  | "BLOCK_FORWARD"
  /** Fixed-for-floating settlement against an index. */
  | "SWAP"
  /** OTC price option. */
  | "OPTION";

/** How a position's settlement value is derived from prices. */
export type SettlementRule =
  /** Value is the leg's own price for the interval. */
  | "POINT"
  /** Value is leg B minus leg A, one interval (path congestion). */
  | "DIFFERENCE"
  /** Value is the same point's real-time price minus its day-ahead price. */
  | "CONVERGENCE"
  /** Value is the real-time congestion spread minus the day-ahead congestion
   *  spread across a path: (RT_sink − RT_source) − (DA_sink − DA_source).
   *
   *  This is the day-ahead-market PTP instrument, which is *bought* at the
   *  day-ahead spread and *settled* at the real-time spread, so what the
   *  position carries is the convergence of congestion between two points.
   *  It is not the same instrument as a CRR: a CRR bought in the auction
   *  settles on the day-ahead spread alone, which is what DIFFERENCE is. */
  | "CONGESTION_CONVERGENCE"
  /** Value is the average of the leg's price over a window. */
  | "AVERAGE";

/** Obligations pay both ways; options pay on one side only. */
export type OptionType = "NONE" | "OBLIGATION" | "OPTION";

export interface InstrumentDef {
  code: string;
  label: string;
  /** Table-sized name. Kept in the catalog rather than derived from `label`
   *  so display and settlement never drift apart. */
  shortLabel: string;
  kind: InstrumentKind;
  venue: MarketVenue;
  /** 0 = legless financial, 1 = single point, 2 = point pair. */
  legs: 0 | 1 | 2;
  settlementRule: SettlementRule;
  optionType: OptionType;
  /** Single-leg instruments take their price product from the trade itself
   *  (where the same instrument shape can be energy or an ancillary service). */
  productFromTrade: boolean;
  tradable: boolean;
}

/**
 * The instrument catalog. ERCOT-cleared instruments sit alongside the OTC
 * contracts that dominate financial power trading; OTC instruments carry their
 * own venue but no price series — they settle against the ERCOT settlement
 * prices they reference.
 */
export const INSTRUMENTS: readonly InstrumentDef[] = [
  // ── ERCOT-cleared energy ─────────────────────────────────────────────
  { code: "ENERGY_SPOT", label: "Energy at a settlement point", shortLabel: "Energy spot", kind: "ENERGY", venue: "RTM", legs: 1, settlementRule: "POINT", optionType: "NONE", productFromTrade: true, tradable: true },
  { code: "VIRTUAL", label: "Virtual bid/offer (INC/DEC)", shortLabel: "Virtual INC/DEC", kind: "VIRTUAL", venue: "DAM", legs: 0, settlementRule: "CONVERGENCE", optionType: "NONE", productFromTrade: false, tradable: true },
  { code: "DART_SPREAD", label: "Day-ahead vs real-time spread", shortLabel: "DA/RT spread", kind: "DART_SPREAD", venue: "DAM", legs: 1, settlementRule: "CONVERGENCE", optionType: "NONE", productFromTrade: false, tradable: true },
  { code: "BASIS_SPREAD", label: "Basis spread (point A vs point B)", shortLabel: "Basis spread", kind: "BASIS_SPREAD", venue: "RTM", legs: 2, settlementRule: "DIFFERENCE", optionType: "NONE", productFromTrade: true, tradable: true },
  // ── ERCOT-cleared congestion ────────────────────────────────────────
  // Two genuinely different congestion instruments with two different
  // settlements, which is what `CONGESTION_CONVERGENCE` exists to separate.
  //
  // A PTP obligation submitted into the day-ahead market is bought at the
  // day-ahead spread and settled at the real-time spread, so it carries the
  // *convergence* of congestion across the path.
  { code: "PTP_OBLIGATION", label: "Day-ahead PTP obligation (DA to RT congestion)", shortLabel: "DA PTP obligation", kind: "PTP_SPREAD", venue: "DAM", legs: 2, settlementRule: "CONGESTION_CONVERGENCE", optionType: "OBLIGATION", productFromTrade: false, tradable: true },
  { code: "PTP_OPTION", label: "Day-ahead PTP option (DA to RT congestion)", shortLabel: "DA PTP option", kind: "PTP_SPREAD", venue: "DAM", legs: 2, settlementRule: "CONGESTION_CONVERGENCE", optionType: "OPTION", productFromTrade: false, tradable: true },
  // A CRR bought in the auction settles on the day-ahead spread alone — Nodal
  // Protocols 7.9.1.1 pays the owner "the difference in the Day-Ahead
  // Settlement Point Price between the sink Settlement Point and the source
  // Settlement Point" — which is exactly what DIFFERENCE computes.
  { code: "CRR_OBLIGATION", label: "Congestion revenue right (obligation)", shortLabel: "CRR obligation", kind: "CRR", venue: "CRR", legs: 2, settlementRule: "DIFFERENCE", optionType: "OBLIGATION", productFromTrade: false, tradable: true },
  { code: "CRR_OPTION", label: "Congestion revenue right (option)", shortLabel: "CRR option", kind: "CRR", venue: "CRR", legs: 2, settlementRule: "DIFFERENCE", optionType: "OPTION", productFromTrade: false, tradable: true },
  // ── ERCOT-cleared capacity ──────────────────────────────────────────
  { code: "AS_CAPACITY", label: "Ancillary service capacity", shortLabel: "AS capacity", kind: "ANCILLARY", venue: "AS", legs: 1, settlementRule: "POINT", optionType: "NONE", productFromTrade: true, tradable: false },
  // ── OTC / bilateral ────────────────────────────────────────────────
  { code: "BLOCK_FORWARD", label: "Block forward (bal-day/week/month)", shortLabel: "Block forward", kind: "BLOCK_FORWARD", venue: "OTC", legs: 1, settlementRule: "AVERAGE", optionType: "NONE", productFromTrade: true, tradable: true },
  { code: "INDEX_SWAP", label: "Fixed-for-floating index swap", shortLabel: "Index swap", kind: "SWAP", venue: "OTC", legs: 1, settlementRule: "AVERAGE", optionType: "NONE", productFromTrade: true, tradable: true },
  { code: "PRICE_OPTION", label: "OTC price option", shortLabel: "Price option", kind: "OPTION", venue: "OTC", legs: 1, settlementRule: "AVERAGE", optionType: "OPTION", productFromTrade: true, tradable: true },
];

const INSTRUMENT_BY_CODE = new Map(INSTRUMENTS.map((i) => [i.code, i]));

export function getInstrument(code: string): InstrumentDef | undefined {
  return INSTRUMENT_BY_CODE.get(code);
}

export function requireInstrument(code: string): InstrumentDef {
  const i = INSTRUMENT_BY_CODE.get(code);
  if (!i) throw new Error(`unknown instrument: ${code}`);
  return i;
}

export function tradableInstruments(): InstrumentDef[] {
  return INSTRUMENTS.filter((i) => i.tradable);
}

export const DEFAULT_INSTRUMENT = "ENERGY_SPOT";

/**
 * Price bounds.
 *
 * ERCOT's system-wide offer caps are *offer* caps, not price caps: LMP can and
 * does exceed them under extreme congestion. So these are representation
 * bounds — wide enough to store anything ERCOT can publish — while the feed
 * generator models the economically real bounds separately.
 *
 *   RT administrative floor          -$251/MWh
 *   DA administrative floor          -$251/MWh (NPRR1051 proposes removing it)
 *   RT system-wide offer cap (RTC+B) $2,000/MWh
 *   DA system-wide offer cap (RTC+B) $5,000/MWh
 *   Effective VOLL / system lambda cap $5,000/MWh
 */
export const RT_PRICE_FLOOR = -251;
export const DA_PRICE_FLOOR = -251;
export const RT_SYSTEM_WIDE_OFFER_CAP = 2000;
export const DA_SYSTEM_WIDE_OFFER_CAP = 5000;
export const EFFECTIVE_VOLL = 5000;
/** Storage bounds: congestion can push a price past the offer cap. */
export const MIN_REPRESENTABLE_PRICE = -2000;
export const MAX_REPRESENTABLE_PRICE = 20000;

export interface NormalizedMarket {
  settlementPoint: string;
  settlementPointType: SettlementPointType;
  description?: string;
}

export interface NormalizedPriceRecord {
  settlementPoint: string;
  /** ISO-8601 UTC delivery interval start. */
  deliveryTimestamp: string;
  /** ISO-8601 UTC delivery interval end (product interval length). */
  deliveryEnd: string;
  /** Dollars per MWh, exact decimal string. */
  price: string;
  /** Product code this price belongs to (see PRODUCTS). */
  product: string;
  /** When the source published this record (ISO-8601 UTC). */
  sourceTimestamp: string;
}

/** Every ingestion source must implement this. */
export interface ErcotSource {
  /** Logical source name persisted on market_prices / ingestion_runs. */
  sourceName: string;
  getMarkets(): Promise<NormalizedMarket[]>;
  /** Products this source can publish. */
  getProducts(): Promise<string[]>;
  getPrices(
    from: Date,
    to: Date,
    products?: readonly string[]
  ): Promise<NormalizedPriceRecord[]>;
}

/** Product used to mark positions and to show a market's headline price.
 *  Real-time hourly is the series the desk trades and values against. */
export const DEFAULT_MARKET_PRODUCT = "RTM_HOURLY";

export const SOURCE_SIMULATED = "SIMULATED";
export const SOURCE_SEEDED = "SEEDED";
export const SOURCE_ERCOT_MIS = "ERCOT_MIS";

/** Back-compat aliases for the pre-product-model names. */
export const MIN_PRICE = MIN_REPRESENTABLE_PRICE;
export const MAX_PRICE = MAX_REPRESENTABLE_PRICE;

export interface ValidationIssue {
  record: unknown;
  reason: string;
}

/**
 * Validate + normalize an arbitrary record into a NormalizedPriceRecord.
 *
 * `fallbackProduct` is used when the record does not name its product (an
 * adapter that only publishes one series); an unknown product is rejected
 * rather than silently coerced, so a mislabelled feed cannot corrupt the
 * price store.
 */
export function normalizePriceRecord(
  input: unknown,
  source: string,
  fallbackProduct = "RTM_HOURLY"
): { ok: true; record: NormalizedPriceRecord } | { ok: false; reason: string } {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "record is not an object" };
  }
  const rec = input as Record<string, unknown>;

  const settlementPoint =
    typeof rec.settlementPoint === "string" ? rec.settlementPoint.trim() : "";
  if (!settlementPoint) return { ok: false, reason: "missing settlementPoint" };

  const productCode =
    typeof rec.product === "string" && rec.product.trim()
      ? rec.product.trim()
      : fallbackProduct;
  const product = getProduct(productCode);
  if (!product) return { ok: false, reason: `unknown product: ${productCode}` };

  const deliveryTimestamp =
    typeof rec.deliveryTimestamp === "string" ? rec.deliveryTimestamp : "";
  const ts = parseIsoUtc(deliveryTimestamp);
  if (!ts) return { ok: false, reason: "invalid deliveryTimestamp" };

  // The interval start must align to the product's own interval, otherwise
  // prices would silently collide across differently-shaped series.
  if (!isAligned(ts, product.intervalMinutes)) {
    return {
      ok: false,
      reason: `deliveryTimestamp is not aligned to a ${product.intervalMinutes}-minute interval`,
    };
  }

  const price = parsePrice(rec.price);
  if (
    price === null ||
    price < MIN_REPRESENTABLE_PRICE ||
    price > MAX_REPRESENTABLE_PRICE
  ) {
    return { ok: false, reason: "price out of range or invalid" };
  }

  let sourceTimestamp = source;
  const st = parseIsoUtc(
    typeof rec.sourceTimestamp === "string" ? rec.sourceTimestamp : ""
  );
  if (st) sourceTimestamp = st.toISOString();
  else sourceTimestamp = new Date().toISOString();

  return {
    ok: true,
    record: {
      settlementPoint,
      deliveryTimestamp: ts.toISOString(),
      deliveryEnd: new Date(
        ts.getTime() + product.intervalMinutes * 60_000
      ).toISOString(),
      price: price.toFixed(4),
      product: product.code,
      sourceTimestamp,
    },
  };
}

function parseIsoUtc(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Parse a numeric-ish value exactly without floating point drift risk
 *  (rounding to 4 decimals for storage). */
function parsePrice(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** True when `d` sits exactly on a multiple of `minutes` since the epoch. */
export function isAligned(d: Date, minutes: IntervalMinutes): boolean {
  return d.getTime() % (minutes * 60_000) === 0;
}

/** Floor a timestamp to the start of its `minutes`-long UTC interval. */
export function truncateToInterval(d: Date, minutes: IntervalMinutes): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

/** group-normalize timestamps to the top of the hour (UTC). */
export function truncateToHour(d: Date): Date {
  return truncateToInterval(d, 60);
}
