import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ensureUserRecords } from "@/lib/auth";
import { safeNextPath } from "@/lib/redirect";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(
      new URL(`/login?error=missing_code&next=${encodeURIComponent(next)}`, url)
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
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
  }

  return NextResponse.redirect(new URL(next, url));
}