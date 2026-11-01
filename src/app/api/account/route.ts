import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getSessionUser, getUserProfile } from "@/lib/auth";
import { ok, fail } from "@/lib/api";
import { removeAvatarAt } from "@/lib/account";
import { normalizeUsername } from "@/lib/profile";

export const dynamic = "force-dynamic";

const Body = z.object({ confirm: z.string().max(64) });

/**
 * Delete the signed-in account, permanently.
 *
 * The trader confirms by typing their username. Deleting the auth user
 * cascades through every row they own — profile, paper account, orders,
 * trades, positions, audit trail (0005 lets the immutability triggers yield
 * to that cascade, and nothing else) — so nothing is left to orphan. Their
 * stored pictures are removed first, since storage is not part of the cascade.
 */
export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  const profile = await getUserProfile(user.id);
  if (!parsed.success || !profile || normalizeUsername(parsed.data.confirm) !== profile.username) {
    return fail("Type your username exactly to confirm.", 422);
  }

  await removeAvatarAt(profile.avatar_url);
  const { error } = await supabaseAdmin().auth.admin.deleteUser(user.id);
  if (error) {
    // The id only, never the email: server logs are not the place for it.
    console.error(`[account] delete failed for ${user.id}: ${error.message}`);
    return fail("Your account could not be deleted. Please try again.", 500);
  }

  // The user is gone, so the server-side revoke may fail; the cookies are
  // cleared either way.
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  return ok({ deleted: true });
}
