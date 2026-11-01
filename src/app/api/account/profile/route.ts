import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { ok, fail } from "@/lib/api";
import {
  describeProfileError,
  displayNameProblem,
  normalizeDisplayName,
  normalizeUsername,
  usernameProblem,
} from "@/lib/profile";

export const dynamic = "force-dynamic";

const Body = z.object({
  username: z.string().max(64),
  displayName: z.string().max(200),
  /** Optional: the welcome form sets the standings choice in the same step. */
  leaderboardOptIn: z.boolean().optional(),
});

/**
 * Rename the signed-in trader (and, from /welcome, finish onboarding).
 * update_profile runs as the user, validates, and audits the change (0035).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Expected { username, displayName }", 422);
  const { username, displayName, leaderboardOptIn } = parsed.data;

  const problem = displayNameProblem(displayName) ?? usernameProblem(username);
  if (problem) return fail(problem, 422);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_profile", {
    p_username: normalizeUsername(username),
    p_display_name: normalizeDisplayName(displayName),
  });
  if (error) {
    const status = error.message.includes("USERNAME_TAKEN") ? 409 : 422;
    return fail(describeProfileError(error.message), status);
  }

  if (leaderboardOptIn !== undefined) {
    const { error: lbError } = await supabase.rpc("set_leaderboard_opt_in", {
      p_opt_in: leaderboardOptIn,
    });
    if (lbError) return fail("Saved your name, but not your standings choice.", 422);
  }

  return ok({ profile: data });
}
