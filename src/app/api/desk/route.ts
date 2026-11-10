import { cookies } from "next/headers";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { fail, ok, serverError } from "@/lib/api";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";
import {
  DESK_COOKIE,
  DESK_COOKIE_OPTIONS,
  deletePracticeDesk,
  ensurePracticeDesk,
  getActiveDesk,
  getPracticeDesk,
  liveDesk,
} from "@/lib/desk";

export const dynamic = "force-dynamic";

/** The desk being traded, and whether a practice desk exists. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  try {
    const [active, practice] = await Promise.all([getActiveDesk(user.id), getPracticeDesk(user.id)]);
    return ok({ active, practice });
  } catch (e) {
    return serverError("desk read", e, "Your desks could not be loaded.");
  }
}

const Switch = z.object({ desk: z.enum(["LIVE", "PRACTICE"]) });

/** Trade the live account, or the practice desk (created on first use). */
export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  const parsed = Switch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Choose LIVE or PRACTICE.", 422);

  const store = await cookies();
  if (parsed.data.desk === "LIVE") {
    store.delete(DESK_COOKIE);
    return ok({ active: liveDesk(user.id) });
  }

  try {
    let practice = await getPracticeDesk(user.id);
    if (!practice) {
      if (await overLimit(LIMITS.desk, user.id)) return tooManyRequests(LIMITS.desk);
      practice = await ensurePracticeDesk(user.id);
    }
    store.set(DESK_COOKIE, practice.id as string, DESK_COOKIE_OPTIONS);
    return ok({ active: practice });
  } catch (e) {
    return serverError("desk switch", e, "The practice desk could not be opened.");
  }
}

/** Start practice over: the practice desk and its whole book are deleted. */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.desk, user.id)) return tooManyRequests(LIMITS.desk);
  try {
    await deletePracticeDesk(user.id);
    const store = await cookies();
    store.delete(DESK_COOKIE);
    return ok({ active: liveDesk(user.id) });
  } catch (e) {
    return serverError("desk reset", e, "The practice desk could not be reset.");
  }
}
