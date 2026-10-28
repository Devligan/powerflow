import { getSessionUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { getSimClock, setSimClock } from "@/lib/sim-clock";

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
  const body = (await req.json().catch(() => ({}))) as { to?: string | null };
  try {
    const result = await setSimClock(user.id, body.to ?? null);
    if (!result.ok) {
      return fail(result.message, result.code === "ACCOUNT_NOT_FOUND" ? 404 : 422);
    }
    return ok({ clock: result.clock });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Failed to set clock", 500);
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
    return ok({ clock: result.clock });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Failed to clear clock", 500);
  }
}
