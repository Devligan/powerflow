import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}