import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Automatic settlement of delivered positions (migration 0013).
 *
 * A position whose delivery window has passed is cashed out at its own
 * instrument price: the accounting engine closes it to flat, cash moves for
 * that close, and a `SETTLED` trade row records it. So realised P&L reflects
 * *delivery*, not only users pressing close.
 *
 * The job settles only what has actually been priced. A delivered interval
 * with no price is left open and reported — settling it at a guess would
 * reintroduce the stale-price fill migration 0011 removed. That is why
 * `deferred` and `settlementDueRemaining` are in the summary instead of those
 * rows quietly disappearing.
 *
 * `p_as_of` is deliberately NOT passed from here. The RPC accepts it so tests
 * can be deterministic, but a caller able to set it could force-settle its own
 * undelivered positions, so the job always takes the function's `now()`
 * default. The function is service-role only regardless (see 0013).
 */

export interface SettlementSummary {
  /** The instant the sweep treated as "delivery complete". */
  asOf: string;
  /** Delivered, open positions the sweep looked at. */
  considered: number;
  /** Positions cashed out by this run. */
  settled: number;
  /** Delivered but with no price for their settlement interval — left open. */
  deferred: number;
  /** Positions that raised while settling; none of their effects applied. */
  failed: number;
  /** Delivered and still open after this run, whether unpriced or over the
   *  per-run limit. Non-zero after a run that settled nothing means the feed
   *  is behind. */
  settlementDueRemaining: number;
  /** A bounded sample of the deferred positions, for diagnosing a stuck run. */
  deferredPositionIds: string[];
  errors: Array<{ positionId?: string; error: string }>;
}

/**
 * Where a position stands with respect to delivery and settlement.
 *
 * `AWAITING` and `AWAITING_PRICE` are worth telling apart: the first settles on
 * the next sweep, the second is stuck because the feed has not published the
 * interval it settles against — the difference between "working" and "the
 * market data is behind".
 */
export type SettlementState =
  /** Not delivered yet. */
  | "OPEN"
  /** Delivered and priced; the next sweep will cash it out. */
  | "AWAITING"
  /** Delivered with no price for its settlement interval — left open. */
  | "AWAITING_PRICE"
  /** Cashed out at delivery. */
  | "SETTLED"
  /** Flat, but closed by the user rather than settled. */
  | "CLOSED";

/**
 * Classify a position. Pure so the rule is unit-tested rather than click-tested,
 * and `now` is injectable so "delivered" does not depend on the wall clock in
 * tests.
 *
 * `markPrice` is the position's instrument price for its own window: null means
 * the interval is unpriced, which is exactly the condition the sweep defers on.
 */
export function settlementState(input: {
  quantityMwh: bigint;
  settledAt: string | null;
  deliveryEnd: string;
  /** Instrument price for the position's window, or null when unpriced. */
  markPrice: bigint | null;
  now?: number;
}): SettlementState {
  if (input.settledAt != null) return "SETTLED";
  // Flat without a settlement record: the user closed it before delivery.
  if (input.quantityMwh === 0n) return "CLOSED";

  const end = new Date(input.deliveryEnd).getTime();
  if (!Number.isFinite(end)) {
    throw new Error(`delivery_end is not a valid timestamp: ${input.deliveryEnd}`);
  }
  if (end > (input.now ?? Date.now())) return "OPEN";

  return input.markPrice == null ? "AWAITING_PRICE" : "AWAITING";
}

/** Whether the settlement job runs at all.
 *
 *  On by default. Set `SETTLEMENT_ENABLED=false` to leave delivered positions
 *  open until the user closes them — the pre-0013 behaviour — without touching
 *  the deployed function. */
export function settlementEnabled(): boolean {
  const raw = process.env.SETTLEMENT_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["false", "0", "off", "no"].includes(raw);
}

/**
 * The shape is asserted rather than coerced. Defaulting a missing field to zero
 * would turn "the function returned something unexpected" into "nothing needed
 * settling", which is the one reading an operator must never be given by
 * accident.
 */
function normalizeSummary(raw: unknown): SettlementSummary {
  if (raw == null || typeof raw !== "object") {
    throw new Error("settlement returned an unexpected result");
  }
  const r = raw as Record<string, unknown>;
  const num = (key: string): number => {
    const v = r[key];
    if (typeof v !== "number") {
      throw new Error(`settlement result is missing numeric field "${key}"`);
    }
    return v;
  };
  const errors = Array.isArray(r.errors)
    ? (r.errors as Array<{ position_id?: string; error?: string }>).map((e) => ({
        positionId: e.position_id,
        error: String(e.error ?? "unknown error"),
      }))
    : [];

  return {
    asOf: String(r.as_of ?? ""),
    considered: num("considered"),
    settled: num("settled"),
    deferred: num("deferred"),
    failed: num("failed"),
    settlementDueRemaining: num("settlement_due_remaining"),
    deferredPositionIds: Array.isArray(r.deferred_position_ids)
      ? r.deferred_position_ids.map(String)
      : [],
    errors,
  };
}

/** Run the sweep. Safe to run repeatedly and concurrently: settlement is
 *  terminal per position, and the rows are locked `FOR UPDATE SKIP LOCKED`. */
export async function runAutoSettlement(): Promise<SettlementSummary> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("settle_delivered_positions");
  if (error) throw new Error(`settlement failed: ${error.message}`);
  return normalizeSummary(data);
}
