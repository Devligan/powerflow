import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// POST-only. A GET handler would let another site sign a user out by
// navigating a top-level link (logout CSRF).
export async function POST(req: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", req.url));
}