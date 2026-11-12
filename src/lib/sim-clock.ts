import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * The simulation clock: per-account, independent of the wall clock.
 *
 * The offset lives on paper_accounts (migration 0020) and is enforced in the
 * engine: every fill, mark, margin evaluation and settlement sweep resolves
 * the owner's clock and shows them only the market data published by then.
 * This module is the read/write surface the UI and API use — it never decides
 * visibility itself.
 *
 * offset 0           → live mode: simulation time IS wall time.
 * offset < 0 (past)  → replay: the desk is trading a historical market.
 *
 * Only a desk (practice, challenge) may stand in the past: a trader's live
 * account is always live, so replay never moves its balance (0053).
 */

export interface SimClock {
  /** Seconds to add to the wall clock (negative when replaying the past). */
  offsetSeconds: number;
  /** "REPLAY" when the clock is displaced from now, "LIVE" at offset 0. */
  mode: "REPLAY" | "LIVE";
  /** The account's simulation time (ISO-8601 UTC). */
  now: string;
  /** Wall-clock now, for comparison. */
  wallNow: string;
}

/** The account's clock, or null when there is no account row. */
export async function getSimClock(userId: string): Promise<SimClock | null> {
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("paper_accounts")
    .select("sim_clock_offset")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const offsetNanos = BigInt(data.sim_clock_offset ?? "0");
  const wallNow = Date.now();
  const simMs = wallNow + Number(offsetNanos / 1_000_000n);
  return {
    offsetSeconds: Number(offsetNanos / 1_000_000_000n),
    mode: offsetNanos === 0n ? "LIVE" : "REPLAY",
    now: new Date(simMs).toISOString(),
    wallNow: new Date(wallNow).toISOString(),
  };
}

const ClockTarget = z.object({
  // An absolute instant in the past: the engine refuses anything else, so
  // here we only pin the type. Null clears back to live mode.
  to: z.string().datetime().nullish(),
});

export type SetClockResult =
  | { ok: true; clock: SimClock }
  | { ok: false; code: string; message: string };

export const CLOCK_MESSAGES: Record<string, string> = {
  FORBIDDEN: "You can only set your own simulation clock.",
  ACCOUNT_NOT_FOUND: "Paper account not found.",
  SIM_CLOCK_INVALID: "Replay can only go back in time, to a date after 2000.",
  LIVE_ACCOUNT_IS_LIVE:
    "Your live account always trades the live market. Switch to the practice desk to replay a past day: it has its own $100,000 and clock.",
  CHALLENGE_CLOCK_FORWARD_ONLY: "A challenge clock only moves forward.",
  CHALLENGE_CLOCK_PAST_END: "That is past the end of the challenge.",
  CHALLENGE_DESK_REPLAY_ONLY: "A challenge desk stays on the challenge's days; switch desks to trade live.",
  CHALLENGE_FINISHED: "This challenge entry is finished.",
};

const GENERIC = "The clock could not be changed. Please try again.";

/**
 * After the clock moves: moving it can carry it past a day-ahead clearing, or
 * past the instant a delivered position's prices became final. Bids placed
 * before the deadline should then fill now, and positions settle now, not at
 * the next scheduled run. Only this account's book moved, so only it is swept
 * and settled (0042): one user's clock must not run a sweep over everyone's.
 * Both judge the account on its own clock (0038, 0044), so running them early
 * can never fill a bid before its clearing or settle a position before its
 * prices are final. Best effort: the scheduled runs catch anything missed.
 */
export async function catchUpAccount(userId: string): Promise<void> {
  const admin = supabaseAdmin();
  try {
    await admin.rpc("fill_crossing_limit_orders", { p_limit: 500, p_user_id: userId });
  } catch {
    // ignored: the scheduled sweep runs every 15 minutes
  }
  try {
    await admin.rpc("settle_delivered_positions", { p_user_id: userId });
  } catch {
    // ignored: the scheduled settlement runs every hour
  }
}

/** Set the account's simulation time (null = back to live mode). */
export async function setSimClock(
  userId: string,
  to: string | null
): Promise<SetClockResult> {
  const parsed = ClockTarget.safeParse({ to });
  if (!parsed.success) {
    return { ok: false, code: "SIM_CLOCK_INVALID", message: CLOCK_MESSAGES.SIM_CLOCK_INVALID };
  }

  // Through the USER's session: the RPC re-checks auth.uid() = p_user_id, so
  // a user can only ever move their own clock even if this layer erred.
  const supabase = await createClient();
  if (parsed.data.to == null) {
    const { error } = await supabase.rpc("clear_sim_clock", {
      p_user_id: userId,
    });
    if (error) {
      const code = String(error.message ?? "").trim();
      return { ok: false, code, message: CLOCK_MESSAGES[code] ?? GENERIC };
    }
  } else {
    const { error } = await supabase.rpc("set_sim_clock", {
      p_user_id: userId,
      p_iso: parsed.data.to,
    });
    if (error) {
      const code = String(error.message ?? "").trim();
      return { ok: false, code, message: CLOCK_MESSAGES[code] ?? GENERIC };
    }
  }

  const clock = await getSimClock(userId);
  if (!clock) {
    return { ok: false, code: "ACCOUNT_NOT_FOUND", message: CLOCK_MESSAGES.ACCOUNT_NOT_FOUND };
  }
  return { ok: true, clock };
}
