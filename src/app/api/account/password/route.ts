import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { ok, fail } from "@/lib/api";
import { passwordLinkStatus } from "@/lib/account";
import { PASSWORD_MIN } from "@/lib/profile";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const Body = z.object({ password: z.string().min(PASSWORD_MIN).max(128) });

/**
 * Set a new password — only from a session opened by an emailed password
 * link within the last few minutes (see /api/account/password/link). Every
 * other session of the account is then signed out, so a password changed
 * because a device was lost actually locks that device out.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.accountChange, user.id)) return tooManyRequests(LIMITS.accountChange);

  const link = await passwordLinkStatus();
  if (!link.ok) {
    return fail(
      link.reason === "EXPIRED"
        ? "That password link has expired. Request a new one from Settings."
        : "Open the link we emailed you before choosing a new password.",
      403
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(`Passwords must be at least ${PASSWORD_MIN} characters.`, 422);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    if (error.code === "same_password") {
      return fail("Choose a password different from your current one.", 422);
    }
    if (error.code === "weak_password") {
      return fail("That password is too easy to guess. Choose a stronger one.", 422);
    }
    console.error(`[account] password change failed for ${user.id}: ${error.message}`);
    return fail("Your password could not be changed. Please try again.", 422);
  }

  await supabase.auth.signOut({ scope: "others" });
  return ok({ changed: true });
}
