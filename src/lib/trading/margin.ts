import { isMarginedInstrument } from "@/lib/ercot/types";
import { add, abs, cents, mul, mulScalar, sub } from "@/lib/money";

/**
 * The margin model, as pure functions.
 *
 * `supabase/migrations/0014_margin.sql` is where margin is *enforced* — it is
 * the settlement leg that has to fund an obligation, and it runs in Postgres
 * where the money is. This module is the readable statement of the same rules,
 * so the thresholds and the liquidation order can be tested without a database
 * and reasoned about without reading plpgsql.
 *
 * The model follows exchange mechanics rather than an invented rule:
 *
 *   initial margin      posted to open a position; the level a call must be
 *                       restored to
 *   maintenance margin  the floor equity must stay above
 *   margin call         equity below maintenance → restore to initial, by
 *                       paying in or by reducing positions
 *   forced liquidation  an unmet call is closed out; margin desks do not ask
 *                       first, and they work the largest exposure first
 *   deficit             a gap bigger than the equity posted against it. The
 *                       residual is a debt the member owes, not something the
 *                       engine can make disappear
 *
 * An obligation that is due is therefore paid from cash, or by realising
 * collateral at its own price, or — only when the account is genuinely
 * insolvent — booked as an explicit deficit.
 */

/** Margin status of an account. Ordered from healthy to insolvent. */
export type MarginTier = "OK" | "WARNING" | "CALL" | "DEFICIT";

/** Margin rates, as fractions of marked position value (0.12 = 12%). */
export interface MarginRates {
  initial: number;
  maintenance: number;
}

/** The rates migration 0014 defaults an account to. */
export const DEFAULT_MARGIN_RATES: MarginRates = { initial: 0.12, maintenance: 0.1 };

/** A rate as integer basis points, so the arithmetic stays in bigint. */
const bps = (rate: number) => Math.round(rate * 10_000);

/** Apply a fractional rate to a scaled bigint amount. */
export function rateOf(amount: bigint, rate: number): bigint {
  return (amount * BigInt(bps(rate))) / 10_000n;
}

/**
 * Equity net of the deficit.
 *
 * A deficit is a liability, so it reduces equity exactly as negative cash
 * would. Keeping `cash_balance` non-negative and recording what could not be
 * paid is the same statement, made in a way that leaves 0001's check
 * meaningful for every other writer.
 */
export function equityOf(args: {
  cashBalance: bigint;
  markedValue: bigint;
  deficit?: bigint | null;
}): bigint {
  return sub(add(args.cashBalance, args.markedValue), args.deficit ?? 0n);
}

/**
 * Which band the account is in.
 *
 * `deficit` is checked first and on its own: an account that owes money it
 * could not pay is insolvent whatever its marks say afterwards.
 */
export function marginTier(args: {
  equity: bigint;
  usedMargin: bigint;
  maintenanceMargin: bigint;
  deficit?: bigint | null;
}): MarginTier {
  const deficit = args.deficit ?? 0n;
  if (deficit > 0n || args.equity <= 0n) return "DEFICIT";
  if (args.equity < args.maintenanceMargin) return "CALL";
  if (args.equity < args.usedMargin) return "WARNING";
  return "OK";
}

/** A position as margin sees it: its own mark, or none. */
export interface MarginedPosition {
  instrument: string;
  /** Needed for a margined instrument (0041), which is worth qty × (mark − entry). */
  averageEntryPrice?: bigint;
  product: string;
  quantityMwh: bigint;
  markPrice: bigint | null;
}

export interface MarginRequirements {
  /** Σ mark × signed qty — the same marked value the portfolio metrics use. */
  markedValue: bigint;
  /** Σ |qty| × mark × initial rate: what the open book requires. */
  usedMargin: bigint;
  /** Σ |qty| × mark × maintenance rate: the floor the equity must stay above. */
  maintenanceMargin: bigint;
  /**
   * Positions whose instrument price could not be resolved. They contribute
   * nothing to the requirements, so the account is *under*-margined by an
   * unknown amount — reported rather than hidden, exactly as
   * `portfolioMetrics` reports unmarked positions.
   */
  unpricedPositions: number;
}

/**
 * Margin requirements for an open book.
 *
 * Legless and window instruments are priced through their own instrument price
 * (never a leg A point price), so a spread's requirement is based on the
 * exposure it actually carries.
 */
export function marginRequirements(
  positions: MarginedPosition[],
  rates: MarginRates = DEFAULT_MARGIN_RATES
): MarginRequirements {
  let markedValue = 0n;
  let usedMargin = 0n;
  let maintenanceMargin = 0n;
  let unpricedPositions = 0;

  for (const pos of positions) {
    if (pos.quantityMwh === 0n) continue;
    if (pos.markPrice === null) {
      unpricedPositions += 1;
      continue;
    }
    // Each line in cents, as account_margin sums it (0059).
    markedValue = add(
      markedValue,
      cents(
        mul(
          isMarginedInstrument(pos.instrument) ? pos.markPrice - (pos.averageEntryPrice ?? 0n) : pos.markPrice,
          pos.quantityMwh
        )
      )
    );

    // A path's mark can be negative; a requirement cannot.
    const notional = mul(abs(pos.markPrice), abs(pos.quantityMwh));
    usedMargin = add(usedMargin, rateOf(notional, rates.initial));
    maintenanceMargin = add(
      maintenanceMargin,
      rateOf(notional, rates.maintenance)
    );
  }

  return { markedValue, usedMargin, maintenanceMargin, unpricedPositions };
}

/** A position that could be sold to raise cash. */
export interface LiquidationCandidate {
  positionId: string;
  instrument: string;
  /** Signed, and positive: only a long sale raises cash. */
  quantityMwh: bigint;
  markPrice: bigint;
}

export interface LiquidationPlan {
  /** What gets sold, in the order it is sold. */
  closes: LiquidationCandidate[];
  raised: bigint;
  cashAfter: bigint;
  covered: boolean;
  /** What the account still cannot pay once every candidate is sold. */
  shortfall: bigint;
}

/**
 * Which positions get sold to meet an obligation, and whether that is enough.
 *
 * Mirrors `liquidate_to_fund`. Two rules carry the design:
 *
 *   * **Longs only.** Selling a long is a receipt; buying back a short is a
 *     payment. Closing a short can never fund anything — which is also why a
 *     *short's* settlement is the only settlement that can run an account dry.
 *   * **Largest marked exposure first**, the order a margin desk works.
 *
 * Selling at the position's own mark makes this equity-neutral: it converts
 * marked value into cash without creating or destroying any. So liquidation
 * can never repair a deficit — it can only pay an obligation that is due.
 * That is the whole reason a gap can still leave a debt.
 */
export function liquidationPlan(args: {
  cash: bigint;
  need: bigint;
  candidates: LiquidationCandidate[];
}): LiquidationPlan {
  const need = args.need > 0n ? args.need : 0n;
  let cash = args.cash;
  const closes: LiquidationCandidate[] = [];

  const sellable = args.candidates
    .filter((c) => c.quantityMwh > 0n)
    .sort((a, b) => {
      const byExposure = compareDesc(
        mul(a.markPrice, a.quantityMwh),
        mul(b.markPrice, b.quantityMwh)
      );
      return byExposure !== 0 ? byExposure : a.positionId.localeCompare(b.positionId);
    });

  for (const candidate of sellable) {
    if (cash >= need) break;
    closes.push(candidate);
    cash = add(cash, mul(candidate.markPrice, candidate.quantityMwh));
  }

  const raised = sub(cash, args.cash);
  return {
    closes,
    raised,
    cashAfter: cash,
    covered: cash >= need,
    shortfall: cash >= need ? 0n : sub(need, cash),
  };
}

function compareDesc(a: bigint, b: bigint): number {
  return a > b ? -1 : a < b ? 1 : 0;
}

/** Pre-scale a signed quantity for display alongside a requirement. */
export function marginRatio(equity: bigint, usedMargin: bigint): number | null {
  if (usedMargin === 0n) return null;
  return Number(mulScalar(equity, 1_000_000n) / usedMargin) / 1_000_000;
}
