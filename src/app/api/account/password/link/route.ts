import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { ok, fail } from "@/lib/api";
import { authCallbackUrl } from "@/lib/account";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Email the signed-in trader a link to change their password.
 *
 * Being signed in is not enough to change a password: the link proves the
 * person at the keyboard also holds the inbox. Following it opens a
 * `recovery` session, and /api/account/password accepts a new password only
 * from such a session, shortly after it was opened.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (!user.email) return fail("This account has no email address to confirm with.", 422);

  if (await overLimit(LIMITS.accountEmail, user.id)) return tooManyRequests(LIMITS.accountEmail);

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
    redirectTo: authCallbackUrl(req, "/reset-password"),
  });
  if (error) {
    return fail(
      error.status === 429
        ? "A link was sent very recently. Wait a minute and try again."
        : "The email could not be sent. Please try again.",
      error.status === 429 ? 429 : 502
    );
  }
  return ok({ sentTo: user.email });
}
