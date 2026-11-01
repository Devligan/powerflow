import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ensureUserRecords, getUserProfile } from "@/lib/auth";
import { safeNextPath } from "@/lib/redirect";

export const dynamic = "force-dynamic";

/** Account pages report a link's outcome themselves (?link=…). */
function isAccountPage(path: string): boolean {
  return path.startsWith("/settings") || path.startsWith("/reset-password");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));

  if (!code) {
    // Not every emailed link comes back with a code: with secure email
    // change, following the first of the two confirmations only returns a
    // message, and an expired or reused link returns an error. On an account
    // page the trader is (usually) still signed in, so say what happened
    // there rather than on a sign-in screen they would be bounced from.
    if (isAccountPage(next)) {
      const dest = new URL(next, url);
      dest.searchParams.set(
        "link",
        url.searchParams.get("error") || url.searchParams.get("error_description")
          ? "invalid"
          : "partial"
      );
      return NextResponse.redirect(dest);
    }
    return NextResponse.redirect(
      new URL(`/login?error=missing_code&next=${encodeURIComponent(next)}`, url)
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    if (isAccountPage(next)) {
      const dest = new URL(next, url);
      dest.searchParams.set("link", "invalid");
      return NextResponse.redirect(dest);
    }
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(error.message)}&next=${encodeURIComponent(next)}`,
        url
      )
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    // A failed bootstrap must not be silent — it means the session is about to
    // land on a shell with no account behind it.
    await ensureUserRecords(user);

    // A new account chooses its trader name before anything else. A password
    // link is let through: the reset page is not part of the desk.
    if (!next.startsWith("/reset-password")) {
      const profile = await getUserProfile(user.id).catch(() => null);
      if (profile && profile.onboarded_at === null) {
        return NextResponse.redirect(
          new URL(`/welcome?next=${encodeURIComponent(next)}`, url)
        );
      }
    }
  }

  return NextResponse.redirect(new URL(next, url));
}
