import { supabaseAdmin } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";
import { ok, fail } from "@/lib/api";
import { normalizeUsername, usernameProblem } from "@/lib/profile";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Whether a username is free, for the form's inline check. Signed-in only.
 * The answer is advisory: update_profile re-checks under a row lock.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  // Without a limit, this answers "who has an account here?" at any speed.
  if (await overLimit(LIMITS.usernameCheck, user.id)) return tooManyRequests(LIMITS.usernameCheck);

  const name = normalizeUsername(new URL(req.url).searchParams.get("name") ?? "");
  const admin = supabaseAdmin();
  const { data: me } = await admin
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();

  const problem = usernameProblem(name, me?.username ?? null);
  if (problem) return ok({ available: false, reason: problem });
  if (name === me?.username) return ok({ available: true, current: true });

  const { count, error } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("username", name);
  if (error) return fail("Could not check that name", 500);
  return ok(
    count && count > 0
      ? { available: false, reason: "That username is already taken." }
      : { available: true }
  );
}
