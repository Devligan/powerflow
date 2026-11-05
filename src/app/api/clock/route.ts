import { getSessionUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { getSimClock, setSimClock } from "@/lib/sim-clock";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** The caller's simulation clock. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  try {
    const clock = await getSimClock(user.id);
    if (!clock) return fail("Paper account not found.", 404);
    return ok({ clock });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Failed to read clock", 500);
  }
}

/** Move the clock (null/absent `to` = clear back to live mode). */
export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  const body = (await req.json().catch(() => null)) as { to?: string | null } | null;
  try {
    const result = await setSimClock(user.id, body?.to ?? null);
    if (!result.ok) {
      return fail(result.message, result.code === "ACCOUNT_NOT_FOUND" ? 404 : 422);
    }
    await sweepOrders(user.id);
    return ok({ clock: result.clock });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Failed to set clock", 500);
  }
}

/**
 * Moving the clock can carry it past a day-ahead clearing: bids placed before
 * the deadline should then fill now, not at the next scheduled sweep. Only
 * this account's book moved, so only it is swept (0042): one user's clock must
 * not run a sweep over everyone's. Orders are judged on their own account's
 * clock (0038), so running it early can never fill a bid sooner than its
 * clearing. Best effort: the scheduled sweep catches anything missed.
 */
async function sweepOrders(userId: string) {
  try {
    await supabaseAdmin().rpc("fill_crossing_limit_orders", { p_limit: 500, p_user_id: userId });
  } catch {
    // ignored: the scheduled sweep runs every 15 minutes
  }
}

/** Back to live mode. */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  try {
    const result = await setSimClock(user.id, null);
    if (!result.ok) {
      return fail(result.message, result.code === "ACCOUNT_NOT_FOUND" ? 404 : 422);
    }
    await sweepOrders(user.id);
    return ok({ clock: result.clock });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Failed to clear clock", 500);
  }
}
