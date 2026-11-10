import { getSessionUser } from "@/lib/auth";
import { fail, ok, serverError } from "@/lib/api";
import { getActiveDesk } from "@/lib/desk";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { catchUpAccount, getSimClock, setSimClock } from "@/lib/sim-clock";

export const dynamic = "force-dynamic";

/** The clock of the desk being traded. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  try {
    const desk = await getActiveDesk(user.id);
    const clock = await getSimClock(desk.accountUserId);
    if (!clock) return fail("Paper account not found.", 404);
    return ok({ clock, desk });
  } catch (e) {
    return serverError("clock read", e, "The clock could not be read.");
  }
}

/** Move the clock (null/absent `to` = clear back to live mode). */
export async function PUT(req: Request) {
  return move(req, true);
}

/** Back to live mode. */
export async function DELETE(req: Request) {
  return move(req, false);
}

async function move(req: Request, readTarget: boolean) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.clock, user.id)) return tooManyRequests(LIMITS.clock);
  const body = readTarget
    ? ((await req.json().catch(() => null)) as { to?: string | null } | null)
    : null;
  try {
    const desk = await getActiveDesk(user.id);
    const result = await setSimClock(desk.accountUserId, body?.to ?? null);
    if (!result.ok) {
      return fail(result.message, result.code === "ACCOUNT_NOT_FOUND" ? 404 : 422);
    }
    await catchUpAccount(desk.accountUserId);
    return ok({ clock: result.clock, desk });
  } catch (e) {
    return serverError(readTarget ? "clock set" : "clock clear", e, "The clock could not be set.");
  }
}
