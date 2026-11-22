import { createClient } from "@/lib/supabase/server";
import { fail, ok } from "@/lib/api";
import { LIMITS, clientIp, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Email/password sign-in, executed server-side so the auth cookies are set
 * with httpOnly + Secure attributes. Passwords are held only in this request
 * and sent straight to Supabase Auth over HTTPS — never logged or stored.
 */
export async function POST(req: Request) {
  let email = "";
  let password = "";
  try {
    const body: unknown = await req.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      if (typeof record.email === "string") email = record.email.slice(0, 254);
      if (typeof record.password === "string") {
        password = record.password.slice(0, 1024);
      }
    }
  } catch {
    return fail("Invalid request.", 400);
  }

  if (!email || !password) {
    return fail("Email and password are required.", 400);
  }

  const ip = clientIp(req);
  const address = email.trim().toLowerCase();
  if (await overLimit(LIMITS.loginByIp, ip)) return tooManyRequests(LIMITS.loginByIp);
  if (await overLimit(LIMITS.loginByAttempt, `${ip}|${address}`)) {
    return tooManyRequests(LIMITS.loginByAttempt);
  }
  if (await overLimit(LIMITS.loginByEmail, address)) return tooManyRequests(LIMITS.loginByEmail);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // One answer for a wrong password and an unknown address, so the form
    // cannot be used to find out who has an account. An unconfirmed address
    // is only reported after the password matched, so saying so leaks nothing.
    if (error.code === "email_not_confirmed") {
      return fail("Confirm your email address first, using the link we sent you.", 401);
    }
    if (error.status === 429) {
      return fail("Too many attempts. Wait a minute and try again.", 429);
    }
    return fail("Incorrect email or password.", 401);
  }

  return ok({ ok: true });
}
