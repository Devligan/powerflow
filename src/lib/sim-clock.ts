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

const FRIENDLY: Record<string, string> = {
  FORBIDDEN: "You can only set your own simulation clock.",
  ACCOUNT_NOT_FOUND: "Paper account not found.",
  SIM_CLOCK_INVALID: "Replay can only go back in time, to a date after 2000.",
};

/** Set the account's simulation time (null = back to live mode). */
export async function setSimClock(
  userId: string,
  to: string | null
): Promise<SetClockResult> {
  const parsed = ClockTarget.safeParse({ to });
  if (!parsed.success) {
    return { ok: false, code: "SIM_CLOCK_INVALID", message: FRIENDLY.SIM_CLOCK_INVALID };
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
      return {
        ok: false,
        code,
        message: FRIENDLY[code] ?? error.message,
      };
    }
  } else {
    const { error } = await supabase.rpc("set_sim_clock", {
      p_user_id: userId,
      p_iso: parsed.data.to,
    });
    if (error) {
      const code = String(error.message ?? "").trim();
      return {
        ok: false,
        code,
        message: FRIENDLY[code] ?? error.message,
      };
    }
  }

  const clock = await getSimClock(userId);
  if (!clock) {
    return { ok: false, code: "ACCOUNT_NOT_FOUND", message: FRIENDLY.ACCOUNT_NOT_FOUND };
  }
  return { ok: true, clock };
}
