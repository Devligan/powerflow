import {
  SCALE,
  abs,
  add,
  cents,
  div,
  mul,
  sub,
} from "@/lib/money";
import { centralHourEnding } from "@/lib/ercot/hour-ending";
import { isMarginedInstrument, unitForProduct, type PriceUnit } from "@/lib/ercot/types";

export type TradeSide = "BUY" | "SELL";

/** A quantity unit, plus the bucket for one that could not be determined. */
export type VolumeUnit = PriceUnit | "UNKNOWN";

/** Order units are reported in, so the shape of a report never depends on the
 *  order positions happened to arrive in. */
export const VOLUME_UNITS: readonly VolumeUnit[] = ["MWH", "MW", "UNKNOWN"];

/**
 * Volume for one unit.
 *
 * MWh and MW are separate dimensions — energy delivered versus capacity held —
 * so they are reported side by side and never summed into one number.
 */
export interface VolumeBreakdown {
  unit: VolumeUnit;
  /** Quantity added in the long direction, always non-negative. */
  long: bigint;
  /** Quantity added in the short direction, always non-negative. */
  short: bigint;
  /** Signed net exposure: long − short. */
  net: bigint;
}

/** Mutable accumulator behind `VolumeBreakdown`. */
type VolumeAccumulator = Map<VolumeUnit, VolumeBreakdown>;

function addVolume(
  acc: VolumeAccumulator,
  unit: VolumeUnit,
  signedQuantity: bigint
): void {
  let b = acc.get(unit);
  if (!b) {
    b = { unit, long: 0n, short: 0n, net: 0n };
    acc.set(unit, b);
  }
  if (signedQuantity > 0n) b.long = add(b.long, signedQuantity);
  else b.short = add(b.short, -signedQuantity);
  b.net = add(b.net, signedQuantity);
}

function volumeList(acc: VolumeAccumulator): VolumeBreakdown[] {
  const out: VolumeBreakdown[] = [];
  for (const unit of VOLUME_UNITS) {
    const b = acc.get(unit);
    // Empty buckets are dropped so a report only claims units it actually has.
    if (b) out.push(b);
  }
  return out;
}

/**
 * Aggregate a set of quantities into per-unit volume, keyed by the unit the
 * product's price is quoted in.
 *
 * The unit comes from the product catalog, not from the caller: a position's
 * unit is a property of what was traded, so it cannot be passed in wrongly.
 */
export function volumeBreakdown(
  entries: Array<{ product: string; quantityMwh: bigint }>
): VolumeBreakdown[] {
  const acc: VolumeAccumulator = new Map();
  for (const e of entries) {
    addVolume(acc, unitForProduct(e.product) ?? "UNKNOWN", e.quantityMwh);
  }
  return volumeList(acc);
}

export interface PositionState {
  /** Signed exposure in MWh (scaled 1e6). Positive = long, negative = short. */
  quantityMwh: bigint;
  /** Weighted average entry price (scaled 1e6 dollars/MWh). */
  averageEntryPrice: bigint;
  /** Cumulative realized P&L in dollars (scaled 1e6). */
  realizedPnl: bigint;
}

export const TRADE_SIDES: readonly TradeSide[] = ["BUY", "SELL"] as const;

export const EMPTY_POSITION: PositionState = {
  quantityMwh: 0n,
  averageEntryPrice: 0n,
  realizedPnl: 0n,
};

export interface TradeEffect {
  next: PositionState;
  /** Realized P&L contributed by this trade (scaled dollars). */
  realizedDelta: bigint;
}

/**
 * Apply a trade to a position using weighted-average cost accounting.
 *
 * The caller has already reduced the instrument's legs to `executionPrice` —
 * its own price — which is why one accounting function covers a spot fill, a
 * two-sided spread, a convergence trade and a window average.
 *
 * Accounting method (documented, consistently applied):
 * - A position is net exposure keyed by (user, instrument, legs, delivery
 *   window) with signed quantity: BUY adds, SELL subtracts.
 * - BUY with quantity q at price p pays cash (outside this function) and
 *   increases exposure.
 * - SELL q at price p receives cash and decreases exposure.
 * - Closing legs (trade reduces existing exposure) realize P&L immediately:
 *     long  closed: (p - avg) × closed
 *     short closed: (avg - p) × closed   (=-sign(s)(p-avg) closed)
 * - Remaining exposure keeps the pre-close weighted average for the same
 *   direction; a flip (open the opposite direction) is re-priced at the new
 *   trade price; same-direction additions use a weighted average.
 *
 * Averages and cash are exact fixed-point (see lib/money). Pass `instrument`
 * and a margined instrument's realized P&L is rounded to the cent, as the
 * engine books it (0059). The authoritative execution lives in the PostgreSQL
 * `execute_trade` RPC; this module must match it, which is pinned by tests.
 */
export function applyTrade(
  prev: PositionState,
  side: TradeSide,
  quantityMwh: bigint,
  executionPrice: bigint,
  instrument?: string
): TradeEffect {
  if (quantityMwh <= 0n) {
    throw new Error("quantity must be positive");
  }
  const t = side === "BUY" ? quantityMwh : -quantityMwh;
  const s = prev.quantityMwh;
  const avg = prev.averageEntryPrice;
  const realized = prev.realizedPnl;
  let nextAvg = avg;
  let realizedDelta = 0n;

  if (s === 0n) {
    // Opening trade.
    nextAvg = executionPrice;
  } else if (s > 0n) {
    if (t > 0n) {
      // Growing the long.
      nextAvg = div(
        add(mul(s, avg), mul(t, executionPrice)),
        add(s, t)
      );
    } else {
      // SELL against a long: close/reduce/flip.
      const closed = abs(t) < s ? abs(t) : s;
      realizedDelta = mul(sub(executionPrice, avg), closed);
      const r = add(s, t);
      if (r < 0n) {
        // Flipped past flat: the new short opens at this price.
        nextAvg = executionPrice;
      }
      // r === 0n: flat; r > 0n: partial close, average is unchanged.
    }
  } else {
    // s < 0n (short position)
    const shortExposure = -s;
    if (t < 0n) {
      // Adding to the short.
      const added = -t;
      nextAvg = div(
        add(mul(shortExposure, avg), mul(added, executionPrice)),
        add(shortExposure, added)
      );
    } else {
      // BUY against a short: close/reduce/flip.
      const closed = t < shortExposure ? t : shortExposure;
      realizedDelta = mul(sub(avg, executionPrice), closed);
      const r = add(s, t);
      if (r > 0n) {
        // Flipped to a long: opens at this price.
        nextAvg = executionPrice;
      }
    }
  }

  // 0059: a margined instrument's P&L is booked in cents.
  if (instrument != null && isMarginedInstrument(instrument)) {
    realizedDelta = cents(realizedDelta);
  }

  return {
    next: {
      quantityMwh: add(s, t),
      averageEntryPrice: nextAvg,
      realizedPnl: add(realized, realizedDelta),
    },
    realizedDelta,
  };
}

/** Unrealized P&L for a marked position: (mark - avg) × signed quantity, in
 *  cents, as the engine marks it line by line (0059). So the positions sum to
 *  the account's P&L, and settling at the mark books exactly this. */
export function unrealizedPnl(
  position: Pick<PositionState, "quantityMwh" | "averageEntryPrice">,
  markPrice: bigint
): bigint {
  return cents(mul(sub(markPrice, position.averageEntryPrice), position.quantityMwh));
}

/** The settlement leg of a delivered position. */
export interface SettlementEffect {
  /** The side that closes the position: SELL a long, BUY a short. */
  side: TradeSide;
  /** Size of the closing trade, always positive. */
  quantityMwh: bigint;
  executionPrice: bigint;
  /** Signed change to cash: p×q, or just the realized P&L for a margined
   *  instrument, which put no cash up. */
  cashDelta: bigint;
  /** Realized P&L this settlement banks. */
  realizedDelta: bigint;
  /** Post-settlement state, which is flat. */
  next: PositionState;
}

/**
 * Cash-settle a delivered position at its settlement price.
 *
 * Settlement is not a second accounting method — it is the same close
 * `applyTrade` already performs, with the engine choosing the side and the
 * price. So this returns `null` for an already-flat position, and otherwise
 * delegates, which keeps one set of weighted-average rules rather than two.
 *
 * Both movements collapse to one signed expression, with q the signed quantity
 * and p the settlement price:
 *
 *   cash     += p × q       (a long sells for p×q; a short buys back for −p×|q|)
 *   realized += (p − avg) × q   (which is (avg − p) × |q| when q < 0)
 *
 * A margined instrument (0041) never moved its notional, so only its P&L moves
 * now: pass `instrument` and cash changes by (p − avg) × q instead.
 *
 * Settlement is equity-neutral when the settlement price equals the mark the
 * position already carried, because it converts unrealized P&L into cash +
 * realized. `settlement.test.ts` pins that against `portfolioMetrics`.
 *
 * Mirrors `public.settle_delivered_positions`. The SQL is authoritative and
 * this must match it.
 */
export function settlePosition(
  position: Pick<PositionState, "quantityMwh" | "averageEntryPrice" | "realizedPnl">,
  settlementPrice: bigint,
  instrument?: string
): SettlementEffect | null {
  const q = position.quantityMwh;
  if (q === 0n) return null;

  const side: TradeSide = q > 0n ? "SELL" : "BUY";
  const magnitude = abs(q);
  const effect = applyTrade(position, side, magnitude, settlementPrice, instrument);

  return {
    side,
    quantityMwh: magnitude,
    executionPrice: settlementPrice,
    cashDelta:
      instrument != null && isMarginedInstrument(instrument)
        ? effect.realizedDelta
        : mul(settlementPrice, q),
    realizedDelta: effect.realizedDelta,
    next: effect.next,
  };
}

/**
 * Position identity. A position is keyed by *instrument*, not just by market:
 * a day-ahead position, a real-time position, a point-to-point spread and a
 * virtual convergence trade on the same settlement point for the same delivery
 * window are four different positions.
 *
 * This mirrors the `positions_identity_key` unique constraint in migrations
 * 0007/0008 (where `counter_market_id` is flattened to '' so that "no second
 * leg" dedupes instead of escaping the constraint as a NULL distinct value).
 */
export interface PositionIdentity {
  /** Instrument code (see INSTRUMENTS). */
  instrument: string;
  /** Leg A settlement point. */
  marketId: string;
  /** Leg B (sink) for path instruments; null for single-point and legless. */
  counterMarketId: string | null;
  /** Product (price series) traded or settled against. */
  product: string;
  /** Interval start, or window start for AVERAGE instruments. */
  deliveryStart: string;
  /** Interval end, or window end for AVERAGE instruments. */
  deliveryEnd: string;
}

/** Canonical position key — the TS equivalent of the database identity. */
export function positionKey(id: PositionIdentity): string {
  return [
    id.instrument,
    id.marketId,
    id.counterMarketId ?? "",
    id.product,
    id.deliveryStart,
    id.deliveryEnd,
  ].join("::");
}

/** A position plus the identity it is held under. */
export interface LivePosition extends PositionIdentity, PositionState {}

export interface ReplayTradeInput extends PositionIdentity {
  id: string;
  side: TradeSide;
  quantityMwh: bigint;
  executionPrice: bigint;
}

export interface ReplayedTrade extends ReplayTradeInput {
  realizedPnL: bigint;
}

export interface ReplayResult {
  trades: ReplayedTrade[];
  /** Final positions keyed by `positionKey`; closing to flat leaves 0n. */
  positions: Map<string, LivePosition>;
  cumulativeRealized: bigint;
}

/**
 * Trades in the order the engine applied them, which `created_at` alone does
 * not give. A fill is stamped with the wall clock and a settlement with the
 * account's simulation clock, so on a replay account a position's settlement
 * sorts before the fill that opened it, and replaying that reads the close as a
 * new position. A settlement ends its position, so it follows the position's
 * last fill whatever its stamp says.
 */
export function inExecutionOrder<T>(
  trades: T[],
  read: (trade: T) => { key: string; status: string; at: string }
): T[] {
  const lastFill = new Map<string, number>();
  for (const t of trades) {
    const { key, status, at } = read(t);
    if (status === "EXECUTED") {
      lastFill.set(key, Math.max(lastFill.get(key) ?? 0, Date.parse(at)));
    }
  }
  return trades
    .map((trade, index) => {
      const { key, status, at } = read(trade);
      const own = Date.parse(at);
      const closes = status !== "EXECUTED";
      return { trade, index, closes, when: closes ? Math.max(own, lastFill.get(key) ?? own) : own };
    })
    .sort((a, b) => a.when - b.when || Number(a.closes) - Number(b.closes) || a.index - b.index)
    .map((entry) => entry.trade);
}

/**
 * Cumulative realized P&L at the end of each operating day, oldest first.
 *
 * P&L belongs to the Central operating day it was delivered in, which the UTC
 * date is not: every hour from 18:00 Central on falls on the next UTC day. And
 * the days have to be walked in order, because bids are placed in any order and
 * a running total taken in trade order is not a daily series.
 */
export function cumulativeDailyPnl(
  trades: ReadonlyArray<Pick<ReplayedTrade, "deliveryStart" | "realizedPnL">>
): Array<{ day: string; pnl: bigint }> {
  const byDay = new Map<string, bigint>();
  for (const t of trades) {
    if (t.realizedPnL === 0n) continue;
    const { day } = centralHourEnding(Date.parse(t.deliveryStart));
    byDay.set(day, (byDay.get(day) ?? 0n) + t.realizedPnL);
  }
  let running = 0n;
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, pnl]) => {
      running += pnl;
      return { day, pnl: running };
    });
}

/**
 * Replay an ordered trade history through the same weighted-average engine
 * used by the database RPC. Used for per-trade realized P&L, analytics and
 * reconstructable position state. Requires trades in execution order.
 */
export function replayTrades(trades: ReplayTradeInput[]): ReplayResult {
  const positions = new Map<string, LivePosition>();
  const out: ReplayedTrade[] = [];
  let realizedDelta = 0n;

  for (const t of trades) {
    const key = positionKey(t);
    const prev = positions.get(key) ?? { ...t, ...EMPTY_POSITION };
    const effect = applyTrade(prev, t.side, t.quantityMwh, t.executionPrice, t.instrument);
    positions.set(key, { ...t, ...effect.next });
    realizedDelta = add(realizedDelta, effect.realizedDelta);
    out.push({ ...t, realizedPnL: effect.realizedDelta });
  }

  return { trades: out, positions, cumulativeRealized: realizedDelta };
}

export interface PortfolioMark {
  cashBalance: bigint;
  startingCash: bigint;
  /** Settlement cash the account could not pay, owed to the clearing house.
   *  A liability, so it reduces equity exactly as negative cash would. */
  deficit?: bigint;
  /** Instrument mark price per position, keyed by `positionKey`. An instrument
   *  price is not a market price, so marks cannot be keyed by market alone. */
  marks: Map<string, bigint>;
  positions: LivePosition[];
}

/** One instrument's slice of the book. The slices sum to the totals exactly,
 *  so a breakdown can never quietly lose part of the portfolio. */
export interface InstrumentBreakdown {
  instrument: string;
  /** Positions held in this instrument, open and closed. */
  positions: number;
  /** Positions whose instrument price could not be resolved, so they
   *  contribute no marked value, exposure or unrealized P&L. */
  unmarkedPositions: number;
  markedValue: bigint;
  grossNotional: bigint;
  realizedPnl: bigint;
  unrealizedPnl: bigint;
  /** Volume in each unit held, so a capacity instrument is never reported as
   *  energy. One instrument can legitimately hold more than one unit. */
  volumes: VolumeBreakdown[];
}

/**
 * Equity and P&L from trusted persisted data only.
 *   equity       = cash + Σ mark × signed qty - deficit, with a margined
 *                  position counting only (mark - avg) × signed qty (0041)
 *   total_pnl    = equity - starting_cash
 *   realized     = Σ positions.realized_pnl
 *   unrealized   = Σ (mark - avg) × signed qty
 *
 * Realized P&L and volume are mark-independent — one is already banked, the
 * other is a quantity — so both are summed over every position, including one
 * whose instrument price could not be resolved. Everything that depends on a
 * mark is summed only over positions that have one, because an unpriced leg
 * must show up as a missing mark, never as free money.
 *
 * Volume is reported per unit and never totalled across units: MWh of energy
 * and MW of capacity are different dimensions.
 *
 * Gross notional is price × |quantity| for every catalogued product, which is
 * dollars in both cases because the price of a capacity product is a rate over
 * that product's own settlement interval ($/MW-hr over an hourly product is
 * dollars for the hour). A sub-hourly capacity product would need the interval
 * duration factored in; none is catalogued.
 *
 * `deficit` is subtracted rather than allowed to make cash negative: an
 * account that could not pay a settlement owes the difference, and equity has
 * to say so whether or not a funding path exists.
 *
 * Invariants, both holding when `unmarkedPositions === 0`:
 * - total_pnl = realized + unrealized, less any deficit since inception.
 * - byInstrument sums to every total reported here.
 *
 * An unmarked position contributes its realized P&L but neither marked value
 * nor unrealized P&L, so `unmarkedPositions` is reported rather than letting
 * the two invariants break silently.
 */
export function portfolioMetrics(pf: PortfolioMark) {
  let markedValue = 0n;
  let unrealized = 0n;
  let realized = 0n;
  let grossNotional = 0n;
  let unmarkedPositions = 0;
  const volumeAcc: VolumeAccumulator = new Map();
  const byInstrument = new Map<
    string,
    Omit<InstrumentBreakdown, "volumes"> & { volumeAcc: VolumeAccumulator }
  >();

  const bucket = (instrument: string) => {
    let b = byInstrument.get(instrument);
    if (!b) {
      b = {
        instrument,
        positions: 0,
        unmarkedPositions: 0,
        markedValue: 0n,
        grossNotional: 0n,
        realizedPnl: 0n,
        unrealizedPnl: 0n,
        volumeAcc: new Map(),
      };
      byInstrument.set(instrument, b);
    }
    return b;
  };

  for (const pos of pf.positions) {
    const b = bucket(pos.instrument);
    const unit = unitForProduct(pos.product) ?? "UNKNOWN";
    // A flat position (closed or settled) holds nothing: no value, no
    // unrealized P&L, so it needs no mark. Looking for one counted every
    // settled position as "could not be priced". Its realized P&L still counts.
    const flat = pos.quantityMwh === 0n;
    if (!flat) b.positions += 1;

    // Banked P&L and volume do not depend on a mark.
    b.realizedPnl = add(b.realizedPnl, pos.realizedPnl);
    realized = add(realized, pos.realizedPnl);
    addVolume(volumeAcc, unit, pos.quantityMwh);
    addVolume(b.volumeAcc, unit, pos.quantityMwh);
    if (flat) continue;

    const mark = pf.marks.get(positionKey(pos));
    if (mark === undefined) {
      b.unmarkedPositions += 1;
      unmarkedPositions += 1;
      continue;
    }

    const unreal = unrealizedPnl(pos, mark);
    // A margined position (0041) put no cash up, so it is worth its P&L only.
    // Each line in cents, as account_margin sums it (0059).
    const mv = isMarginedInstrument(pos.instrument) ? unreal : cents(mul(mark, pos.quantityMwh));
    // A path's mark can be negative; its exposure cannot.
    const gross = mul(abs(mark), abs(pos.quantityMwh));
    markedValue = add(markedValue, mv);
    unrealized = add(unrealized, unreal);
    grossNotional = add(grossNotional, gross);
    b.markedValue = add(b.markedValue, mv);
    b.unrealizedPnl = add(b.unrealizedPnl, unreal);
    b.grossNotional = add(b.grossNotional, gross);
  }

  const deficit = pf.deficit ?? 0n;
  const equity = sub(add(pf.cashBalance, markedValue), deficit);
  const totalPnl = sub(equity, pf.startingCash);
  // return as basis points: (total / starting) × 10000
  const returnBps =
    pf.startingCash === 0n
      ? 0n
      : (div(totalPnl, pf.startingCash) * 10000n) / SCALE;

  // Largest exposure first — the biggest instrument risk should be readable
  // at a glance — with the code as a stable tiebreak.
  const breakdown: InstrumentBreakdown[] = [...byInstrument.values()]
    .sort((a, b) => {
      const byGross = a.grossNotional > b.grossNotional
        ? -1
        : a.grossNotional < b.grossNotional
          ? 1
          : 0;
      return byGross !== 0 ? byGross : a.instrument.localeCompare(b.instrument);
    })
    .map((b) => ({
      instrument: b.instrument,
      positions: b.positions,
      unmarkedPositions: b.unmarkedPositions,
      markedValue: b.markedValue,
      grossNotional: b.grossNotional,
      realizedPnl: b.realizedPnl,
      unrealizedPnl: b.unrealizedPnl,
      volumes: volumeList(b.volumeAcc),
    }));

  return {
    equity,
    cashBalance: pf.cashBalance,
    startingCash: pf.startingCash,
    deficit,
    markedValue,
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    totalPnl,
    returnBps,
    grossNotional,
    volumes: volumeList(volumeAcc),
    unmarkedPositions,
    byInstrument: breakdown,
  };
}

export function formatBps(bps: bigint): { sign: string; value: string } {
  const neg = bps < 0n;
  const absBps = neg ? -bps : bps;
  const int = absBps / 100n;
  const frac = absBps % 100n;
  const fracStr = frac.toString().padStart(2, "0").replace(/0+$/, "");
  const value = fracStr.length > 0 ? `${int}.${fracStr}` : `${int}`;
  return { sign: neg ? "-" : "+", value };
}

/** Convert scaled quantity (MWh) to a display value honoring 1-decimal MWh. */
export function formatMwh(quantity: bigint): string {
  const neg = quantity < 0n;
  const q = neg ? -quantity : quantity;
  const int = q / 1000000n;
  const frac = (q % 1000000n)
    .toString()
    .padStart(6, "0")
    .slice(0, 1)
    .replace(/0+$/, "");
  const body = frac.length > 0 ? `${int}.${frac}` : `${int}`;
  return `${neg ? "-" : ""}${body}`;
}