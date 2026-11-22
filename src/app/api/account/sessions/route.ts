import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { ok, fail } from "@/lib/api";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Sign out every other device and browser; this one stays signed in. */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.accountChange, user.id)) return tooManyRequests(LIMITS.accountChange);

  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error) return fail("Could not sign out your other sessions.", 502);
  return ok({ signedOut: "others" });
}
