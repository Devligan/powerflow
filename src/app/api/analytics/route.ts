import { getAnalytics } from "@/lib/analytics";
import { getSessionUser } from "@/lib/auth";
import { serverError, fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  try {
    return ok({ analytics: await getAnalytics(user.id) });
  } catch (e) {
    return serverError("analytics", e, "Your analytics could not be loaded.");
  }
}