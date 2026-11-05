import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api";
import { authCallbackUrl } from "@/lib/account";
import { LIMITS, clientIp, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const Body = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

/**
 * "Forgot password": email a reset link. Signed-out callers, so the answer is
 * the same whether or not the address has an account — this endpoint must not
 * become a way to test which emails are registered. Limited here as well as
 * by Supabase Auth: this is unauthenticated, emails anyone, and draws on the
 * project's whole outbound email quota.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Enter a valid email address.", 422);

  if (await overLimit(LIMITS.forgotByIp, clientIp(req))) return tooManyRequests(LIMITS.forgotByIp);
  if (await overLimit(LIMITS.forgotByEmail, parsed.data.email)) {
    // The same reply as success: a 429 here would say this address is real.
    return ok({ sent: true });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: authCallbackUrl(req, "/reset-password"),
  });
  if (error?.status === 429) {
    return fail("Too many requests. Wait a minute and try again.", 429);
  }
  return ok({ sent: true });
}
