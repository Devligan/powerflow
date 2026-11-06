import { add, gt, sub } from "@/lib/money";
import type { InstrumentDef, OptionType, SettlementRule } from "@/lib/ercot/types";

/**
 * Instrument settlement rules.
 *
 * Product prices are per (settlement point, product, interval). An *instrument*
 * price reduces one or more leg prices to the single scalar that a position is
 * held at, which is what lets the weighted-average accounting in
 * `accounting.ts` apply unchanged to spreads, convergence trades and period
 * averages.
 *
 * This module mirrors `public.instrument_price(...)`, defined in migration 0008
 * and amended in 0017 to add the congestion-convergence rule. The SQL is
 * authoritative. For the two convergence rules this returns the PAYOFF per MWh;
 * since 0021 the engine reaches the same number as (its value leg − the entry
 * price), holding the position at the day-ahead leg and marking the real-time
 * one, so do not read these two as a position's mark.
 *
 * Sign conventions (these are the part worth being explicit about):
 *
 *   DIFFERENCE   instrument price = leg B − leg A ("sink minus source"), so a
 *                long position profits when congestion runs from A to B. This
 *                is the auctioned CRR, whose payout is exactly
 *                (sink − source) × MWh on the day-ahead prices.
 *   CONVERGENCE  instrument price = real-time − day-ahead, so a long position
 *                profits when the real-time price settles above the day-ahead
 *                price it was filled at. This is the virtual/DART trade.
 *   CONGESTION_CONVERGENCE
 *                instrument price = (RT_sink − RT_source) − (DA_sink − DA_source).
 *                This is the day-ahead market PTP instrument, which is *bought*
 *                at the day-ahead spread and *settled* at the real-time spread,
 *                so the position carries the convergence of congestion across
 *                the path. It is not DIFFERENCE with a flag: a CRR settles on
 *                the day-ahead spread alone and needs no real-time prices.
 *   POINT        the leg's own price for the interval.
 *   AVERAGE      the leg's price averaged over a settlement window; the
 *                averaging itself is a price-source concern (SQL), so here the
 *                caller supplies the resolved average and `averagePrice` is
 *                provided for the TS side.
 *
 * Optionality: an obligation pays in both directions; an option floors at zero
 * (it can only pay out, never charge).
 */

export interface InstrumentPriceInput {
  rule: SettlementRule;
  optionType: OptionType;
  /** Leg A price in the market this rule reads: the leg's own price for
   *  POINT and AVERAGE, the source leg for DIFFERENCE, and the source leg's
   *  *real-time* price for CONGESTION_CONVERGENCE. */
  legAPrice: bigint | null;
  /** Leg B (sink) price in the same market — DIFFERENCE and path convergence. */
  legBPrice?: bigint | null;
  /** Day-ahead price — the fill side of a same-point CONVERGENCE instrument. */
  dayAheadPrice?: bigint | null;
  /** Real-time price — the settle side of a same-point CONVERGENCE instrument. */
  realTimePrice?: bigint | null;
  /** Path convergence: leg A's *day-ahead* price. */
  dayAheadLegAPrice?: bigint | null;
  /** Path convergence: leg B's *day-ahead* price. */
  dayAheadLegBPrice?: bigint | null;
}

/** Reduce leg prices to the instrument's own price. Returns null when any leg
 *  the rule needs is missing, so callers reject rather than fill blind. */
export function instrumentPrice(input: InstrumentPriceInput): bigint | null {
  let raw: bigint | null;

  switch (input.rule) {
    case "POINT":
    case "AVERAGE":
      raw = input.legAPrice;
      break;
    case "DIFFERENCE":
      raw =
        input.legAPrice == null || input.legBPrice == null
          ? null
          : sub(input.legBPrice, input.legAPrice);
      break;
    case "CONVERGENCE":
      raw =
        input.dayAheadPrice == null || input.realTimePrice == null
          ? null
          : sub(input.realTimePrice, input.dayAheadPrice);
      break;
    case "CONGESTION_CONVERGENCE": {
      // (RT_sink − RT_source) − (DA_sink − DA_source). Both dimensions are
      // needed: the real-time congestion across the path, less the day-ahead
      // congestion the position was bought at. Any missing leg leaves the
      // instrument unpriced, so the caller rejects rather than fills blind.
      const rtA = input.legAPrice;
      const rtB = input.legBPrice ?? null;
      const daA = input.dayAheadLegAPrice ?? null;
      const daB = input.dayAheadLegBPrice ?? null;
      raw =
        rtA == null || rtB == null || daA == null || daB == null
          ? null
          : sub(sub(rtB, rtA), sub(daB, daA));
      break;
    }
  }

  if (raw == null) return null;
  // An option can only pay out; an obligation is two-way.
  if (input.optionType === "OPTION" && !gt(raw, 0n)) return 0n;
  return raw;
}

/** Mean of the prices that exist across a settlement window. Null when the
 *  window has no prices at all (an unpriced window must not settle at zero). */
export function averagePrice(prices: Array<bigint | null>): bigint | null {
  const present = prices.filter((p): p is bigint => p !== null);
  if (present.length === 0) return null;
  let sum = 0n;
  for (const p of present) sum = add(sum, p);
  return sum / BigInt(present.length);
}

/** Instruments that settle a single interval rather than a window. */
export function settlesSingleInterval(rule: SettlementRule): boolean {
  return rule !== "AVERAGE";
}

/** Whether a rule needs a second settlement point (leg B). */
export function needsCounterPoint(rule: SettlementRule): boolean {
  return rule === "DIFFERENCE" || rule === "CONGESTION_CONVERGENCE";
}

/** Whether a rule spans both energy markets rather than one product — either
 *  side of a day-ahead/real-time pair. A path convergence needs both *and* a
 *  second point, which is why the two predicates are separate. */
export function needsBothMarkets(rule: SettlementRule): boolean {
  return rule === "CONVERGENCE" || rule === "CONGESTION_CONVERGENCE";
}

/** The day-ahead / real-time product pair a market-spanning instrument uses. */
export const CONVERGENCE_PRODUCTS = {
  dayAhead: "DAM_HOURLY",
  realTime: "RTM_HOURLY",
} as const;

/** The product a path or legless instrument clears in — the day-ahead market,
 *  which is where congestion and the virtual DA side are priced. */
export const PATH_SETTLEMENT_PRODUCT = "DAM_HOURLY";

/**
 * The product a trade's prices are read from.
 *
 * A single-leg instrument prices whatever series the caller names (the same
 * shape can be energy or an ancillary service); a path or legless instrument
 * has no series of its own and settles off the market it clears in. Deriving
 * it here rather than accepting it keeps the position identity canonical — two
 * virtual trades on one settlement point and interval cannot land in separate
 * positions because the caller passed a different product.
 *
 * Mirrors `execute_trade` step 3 in migration 0008.
 */
export function resolveTradedProduct(
  instrument: Pick<InstrumentDef, "productFromTrade">,
  product: string
): string {
  return instrument.productFromTrade ? product : PATH_SETTLEMENT_PRODUCT;
}
