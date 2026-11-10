import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// POST-only. A GET handler would let another site sign a user out by
// navigating a top-level link (logout CSRF).
export async function POST(req: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // 303: the browser follows with a GET. The default 307 would re-POST to the
  // login page.
  return NextResponse.redirect(new URL("/login", req.url), 303);
}