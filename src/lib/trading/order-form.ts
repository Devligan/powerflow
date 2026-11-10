import { parseDec } from "@/lib/money";
import {
  getProduct,
  tradableProducts,
  type InstrumentDef,
  type ProductDef,
  type SettlementRule,
} from "@/lib/ercot/types";
import {
  instrumentPrice,
  needsBothMarkets,
  needsCounterPoint,
  resolveTradedProduct,
} from "@/lib/trading/instruments";
import {
  DAM_BID_WINDOW_DAYS,
  centralHourEnding,
  damBidWindowOpensUtc,
  damDeadlineUtc,
  firstOpenOperatingDay,
  hourEndingStartUtc,
  isDayAheadProduct,
  lastOpenOperatingDay,
} from "@/lib/ercot/hour-ending";

/**
 * Order-ticket logic, kept out of the component.
 *
 * The trade panel has to build four different request shapes — a point fill, a
 * two-leg spread, a legless convergence trade and a window average — and every
 * one of them has rules the server enforces. Assembling that inside JSX means
 * it can only be checked by clicking, so the arithmetic, the derived product
 * and the payload live here as pure functions with tests.
 *
 * This is a client module: it imports only the catalog and the pure instrument
 * math, never a database client.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Matches the server's accepted quantity grammar and bound. */
const QUANTITY_RE = /^\d+(\.\d{1,6})?$/;
export const MAX_QUANTITY = 1000;
/** ERCOT's smallest bid increment, 0.1 MW, at the money scale (0045). */
const QUANTITY_STEP = 100_000n;
/** ERCOT's minimum bid, per hour (NP4-450). */
export const MIN_BID_MW = 1;
/** Matches `delivery_start > v_exec_at + interval '35 days'` in execute_trade. */
export const MAX_DAYS_OUT = 35;
/** Default window for a block forward: a balance-of-day style 24 hours. */
export const DEFAULT_WINDOW_INTERVALS = 24;

export interface SeriesPoint {
  deliveryTimestamp: string;
  price: string;
}

/**
 * Whether a price for the delivery is known to exist.
 *   priced    — the series covers it
 *   unpriced  — the series shows it is missing, so the order will be refused
 *   unknown   — cannot tell from here (a leg we hold no series for, or a
 *               window reaching past the series), so let the server decide
 */
export type PriceProbe = "priced" | "unpriced" | "unknown";

/** How many of the product's intervals a delivery window spans. */
export function windowIntervals(
  rule: SettlementRule,
  chosen: number
): number {
  if (rule !== "AVERAGE") return 1;
  return Number.isFinite(chosen) && chosen >= 1 ? Math.floor(chosen) : 1;
}

/**
 * The products a ticket may choose between.
 *
 * A single-leg instrument prices whatever series the caller names (the same
 * shape can be energy or an ancillary service), so it offers the tradable
 * catalog. A path or legless instrument has no series of its own — it settles
 * in the market it clears in — so its product is *derived*, not chosen, which
 * is also what keeps the position identity canonical.
 */
export function selectableProducts(instrument: InstrumentDef): string[] {
  return instrument.productFromTrade ? tradableProducts().map((p) => p.code) : [];
}

/** The product a trade will actually price from, given what was chosen. */
export function effectiveProduct(
  instrument: InstrumentDef,
  chosen: string
): string {
  return resolveTradedProduct(instrument, chosen);
}

export interface WindowInput {
  date: string; // YYYY-MM-DD
  hour: number; // 0..23 UTC
  intervalMinutes: number;
  intervals: number;
}

export interface DeliveryWindow {
  startMs: number;
  endMs: number;
  start: string;
  end: string;
  /** Total window length in minutes. */
  minutes: number;
}

/** UTC delivery window for a ticket: one interval, or a whole number of them. */
export function buildWindow(input: WindowInput): DeliveryWindow | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return null;
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) {
    return null;
  }
  if (
    !Number.isInteger(input.intervalMinutes) ||
    input.intervalMinutes <= 0 ||
    !Number.isInteger(input.intervals) ||
    input.intervals < 1
  ) {
    return null;
  }
  const [y, m, d] = input.date.split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, d, input.hour, 0, 0, 0);
  const minutes = input.intervalMinutes * input.intervals;
  const endMs = startMs + minutes * MINUTE_MS;
  return {
    startMs,
    endMs,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    minutes,
  };
}

/** The product definition a ticket trades, or undefined if it does not exist. */
export function tradedProductDef(
  instrument: InstrumentDef,
  chosen: string
): ProductDef | undefined {
  return getProduct(effectiveProduct(instrument, chosen));
}

/**
 * Is the delivery actually priced, as far as this screen can tell?
 *
 * Only leg A's series for the traded product is on hand, so:
 *   - a point fill or a window over leg A is checkable
 *   - a legless/derived instrument is not (its series is another market's)
 *   - a two-leg spread is not (leg B's series is not loaded)
 * Claiming "unpriced" on evidence we do not have would block valid orders, and
 * claiming "priced" would promise something unverified — hence `unknown`.
 */
export function probePrice(
  instrument: InstrumentDef,
  window: DeliveryWindow,
  intervalMinutes: number,
  series: SeriesPoint[],
  seriesProduct: string,
  tradedProduct: string
): PriceProbe {
  if (series.length === 0) return "unknown";
  // A derived product is priced off a series this screen does not hold.
  if (seriesProduct !== tradedProduct) return "unknown";
  // Leg B is not loaded, so a two-leg price cannot be checked here.
  if (instrument.legs === 2) return "unknown";
  if (needsBothMarkets(instrument.settlementRule)) return "unknown";

  const at = new Map<number, number>();
  for (const p of series) at.set(Date.parse(p.deliveryTimestamp), 0);

  if (instrument.settlementRule === "AVERAGE") {
    const step = intervalMinutes * MINUTE_MS;
    for (let t = window.startMs; t < window.endMs; t += step) {
      if (!at.has(t)) {
        // The series either ends before the window or has a hole in it; both
        // mean this ticket cannot confirm the window is fully priced.
        const last = Math.max(...at.keys());
        return t > last ? "unknown" : "unpriced";
      }
    }
    return "priced";
  }

  if (at.has(window.startMs)) return "priced";
  const last = Math.max(...at.keys());
  return window.startMs > last ? "unpriced" : "unknown";
}

/**
 * The instrument's own price for this delivery, when it can be derived from
 * leg A alone. Null means "composed at execution" (a spread or a convergence
 * trade), which is not the same as zero or as unknown.
 */
export function estimateInstrumentPrice(
  instrument: InstrumentDef,
  window: DeliveryWindow,
  intervalMinutes: number,
  series: SeriesPoint[],
  seriesProduct: string,
  tradedProduct: string
): bigint | null {
  if (seriesProduct !== tradedProduct || instrument.legs === 2) return null;
  if (needsBothMarkets(instrument.settlementRule)) return null;
  if (series.length === 0) return null;

  const at = new Map<number, bigint>();
  for (const p of series) at.set(Date.parse(p.deliveryTimestamp), parseDec(p.price));

  if (instrument.settlementRule === "AVERAGE") {
    const step = intervalMinutes * MINUTE_MS;
    const parts: bigint[] = [];
    for (let t = window.startMs; t < window.endMs; t += step) {
      const v = at.get(t);
      // A window genuinely needs full coverage before it is a price; a guess
      // built from part of it would be a wrong number.
      if (v === undefined) return null;
      parts.push(v);
    }
    if (parts.length === 0) return null;
    return instrumentPrice({
      rule: instrument.settlementRule,
      optionType: instrument.optionType,
      legAPrice: parts.reduce((s, v) => s + v, 0n) / BigInt(parts.length),
    });
  }

  const legA = at.get(window.startMs) ?? null;
  if (legA === null) return null;
  return instrumentPrice({
    rule: instrument.settlementRule,
    optionType: instrument.optionType,
    legAPrice: legA,
  });
}

export interface OrderFormInput {
  instrument: InstrumentDef;
  product: string;
  counterMarketId: string | null;
  marketId: string;
  quantity: string;
  delivery: DeliveryWindow;
  intervalMinutes: number;
  priceProbe: PriceProbe;
  now?: number;
}

export type OrderFormCheck =
  | { ok: true }
  | { ok: false; message: string };

/**
 * The checks this screen can make, mirroring the server's own reasons so the
 * user sees why before a round trip. Anything requiring data the screen does
 * not hold is left to the server rather than guessed at.
 */
export function checkOrderForm(input: OrderFormInput): OrderFormCheck {
  const now = input.now ?? Date.now();

  if (!QUANTITY_RE.test(input.quantity)) {
    return { ok: false, message: "Quantity must be a positive number." };
  }
  const qty = parseDec(input.quantity);
  if (qty <= 0n) return { ok: false, message: "Quantity must be greater than zero." };
  if (qty > BigInt(MAX_QUANTITY * 1_000_000)) {
    return { ok: false, message: `Quantity must not exceed ${MAX_QUANTITY}.` };
  }
  // ERCOT takes bid quantities in steps of 0.1 MW (0045).
  if (qty % QUANTITY_STEP !== 0n) {
    return { ok: false, message: "ERCOT takes bid quantities in steps of 0.1 MW." };
  }

  if (needsCounterPoint(input.instrument.settlementRule) && !input.counterMarketId) {
    return {
      ok: false,
      message: "This instrument is a spread — it needs a second settlement point.",
    };
  }
  if (!needsCounterPoint(input.instrument.settlementRule) && input.counterMarketId) {
    return {
      ok: false,
      message: "This instrument settles on one point; remove the second point.",
    };
  }
  if (input.counterMarketId === input.marketId) {
    return { ok: false, message: "A spread needs two different settlement points." };
  }

  if (input.instrument.productFromTrade && selectableProducts(input.instrument).length === 0) {
    return { ok: false, message: "No product is open for this instrument." };
  }
  if (!tradedProductDef(input.instrument, input.product)) {
    return { ok: false, message: "That product is not one this desk trades." };
  }

  // Trading closes when delivery STARTS (0037): inside the period, its
  // real-time prints are already being published, so a price fixed before
  // it would be a bet on a partly known result.
  if (input.delivery.startMs <= now) {
    return { ok: false, message: "That delivery period has already started, so it can no longer be traded." };
  }
  if (input.delivery.startMs > now + MAX_DAYS_OUT * 24 * HOUR_MS) {
    return {
      ok: false,
      message: `Delivery is more than ${MAX_DAYS_OUT} days out, which is beyond the traded horizon.`,
    };
  }
  if (input.delivery.minutes % input.intervalMinutes !== 0) {
    return {
      ok: false,
      message: "A settlement window must be a whole number of settlement intervals.",
    };
  }
  // Day-ahead positions are bids made before the market clears (0038): an
  // operating day takes bids until 10:00 Central the day before, at a price
  // nobody knows yet. So no published price is the normal case for a bid —
  // it waits for the clearing — and a passed deadline is final.
  const dayAhead = isDayAheadProduct(effectiveProduct(input.instrument, input.product));
  if (dayAhead) {
    const deadline = damDeadlineUtc(input.delivery.startMs);
    if (deadline != null && now >= deadline) {
      const day = centralHourEnding(input.delivery.startMs).day;
      return {
        ok: false,
        message: `Day-ahead bids for operating day ${day} closed at 10:00 AM Central the day before. The first day still open is ${firstOpenOperatingDay(now)}.`,
      };
    }
    const opens = damBidWindowOpensUtc(input.delivery.startMs);
    if (opens != null && now < opens) {
      const day = centralHourEnding(input.delivery.startMs).day;
      return {
        ok: false,
        message: `ERCOT takes bids for operating day ${day} from ${DAM_BID_WINDOW_DAYS} days ahead. The furthest day open now is ${lastOpenOperatingDay(now)}.`,
      };
    }
  } else if (input.priceProbe === "unpriced") {
    return {
      ok: false,
      message:
        "No price is published for that delivery interval, so the order would be refused.",
    };
  }

  return { ok: true };
}

/** Most hours one strip ticket may place: a full operating day. */
export const MAX_STRIP_HOURS = 25;

/**
 * A strip: the same single-interval order repeated over consecutive
 * intervals, the way desks bid virtuals (an INC across HE14–HE19, say).
 * Each window is its own order — positions are per interval — so a strip is
 * N independent fills, never one averaged trade.
 */
export function stripWindows(first: DeliveryWindow, count: number, intervalMinutes: number): DeliveryWindow[] {
  const n = Number.isInteger(count) && count >= 1 ? Math.min(count, MAX_STRIP_HOURS) : 1;
  const step = intervalMinutes * MINUTE_MS;
  return Array.from({ length: n }, (_, i) => {
    const startMs = first.startMs + i * step;
    const endMs = startMs + step;
    return {
      startMs,
      endMs,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      minutes: intervalMinutes,
    };
  });
}

/**
 * One idempotency key per strip leg, derived from the ticket's: a retry of
 * the whole strip replays every leg that already filled instead of filling it
 * twice, while legs that failed get a genuine second attempt.
 */
export function stripClientOrderId(base: string, index: number): string {
  return index === 0 ? base : `${base}~${index}`;
}

export type BlockShape = "PEAK" | "ATC";

/**
 * The ticket inputs (UTC date, UTC hour, hourly intervals) for a standard
 * block on a Central operating day: on-peak is HE7–HE22, 16 hours on every
 * day; around-the-clock is HE1 to the next day's HE1, which is 23 or 25 hours
 * across a DST change.
 */
export function blockWindow(
  day: string,
  shape: BlockShape
): { date: string; hour: number; intervals: number } | null {
  const start = hourEndingStartUtc(day, shape === "PEAK" ? 7 : 1);
  if (start == null) return null;
  let end: number | null;
  if (shape === "PEAK") {
    end = start + 16 * HOUR_MS;
  } else {
    const [y, m, d] = day.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    end = hourEndingStartUtc(next, 1);
  }
  if (end == null) return null;
  const iso = new Date(start).toISOString();
  return { date: iso.slice(0, 10), hour: new Date(start).getUTCHours(), intervals: Math.round((end - start) / HOUR_MS) };
}
