import { getAnalytics } from "@/lib/analytics";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/auth";
import { getActiveDesk } from "@/lib/desk";
import { serverError, fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.reads, user.id)) return tooManyRequests(LIMITS.reads);

  try {
    const desk = await getActiveDesk(user.id);
    return ok({ analytics: await getAnalytics(desk.accountUserId) });
  } catch (e) {
    return serverError("analytics", e, "Your analytics could not be loaded.");
  }
}