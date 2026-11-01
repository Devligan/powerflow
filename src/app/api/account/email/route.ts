import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { ok, fail } from "@/lib/api";
import { authCallbackUrl } from "@/lib/account";

export const dynamic = "force-dynamic";

const Body = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

/**
 * Start an email change. Supabase Auth does not switch the address here: it
 * emails a confirmation link (with secure email change, the project default,
 * to both the current and the new address) and changes it only once those
 * are followed. Until then the account keeps signing in with the old one.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Enter a valid email address.", 422);
  const email = parsed.data.email;
  if (email === user.email?.toLowerCase()) {
    return fail("That is already your email address.", 422);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.updateUser(
    { email },
    { emailRedirectTo: authCallbackUrl(req, "/settings?email=confirmed") }
  );
  if (error) {
    if (error.status === 429) {
      return fail("Too many emails sent. Wait a minute and try again.", 429);
    }
    // Not GoTrue's own wording: "already registered" would tell anyone with
    // an account whether some other address has one too.
    return fail("That address can't be used. Check it, or try a different one.", 422);
  }
  return ok({ pendingEmail: data.user?.new_email ?? email });
}
