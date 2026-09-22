import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  isSupabaseConfigured,
  requireSupabaseAnonKey,
  requireSupabaseUrl,
} from "@/lib/supabase/config";
import { AUTH_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";

/**
 * Server-side Supabase client bound to the request's auth cookies.
 * Scoped by RLS to the signed-in user.
 */
export async function createClient() {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured (missing env vars)");
  }
  const cookieStore = await cookies();

  return createServerClient(requireSupabaseUrl(), requireSupabaseAnonKey(), {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component; safe to ignore when cookies
          // cannot be set from the current rendering context.
        }
      },
    },
  });
}