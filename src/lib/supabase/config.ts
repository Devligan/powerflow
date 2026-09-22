/**
 * Central env access for Supabase credentials. Configured means both the
 * project URL and the anon key are present; used to short-circuit auth flows
 * until a developer has filled in .env.
 */
export const supabaseUrlEnv = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const supabaseAnonKeyEnv = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export function isSupabaseConfigured(): boolean {
  return (
    supabaseUrlEnv.startsWith("http") &&
    supabaseAnonKeyEnv.length > 0
  );
}

export function requireSupabaseUrl(): string {
  if (!supabaseUrlEnv) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured");
  return supabaseUrlEnv;
}

export function requireSupabaseAnonKey(): string {
  if (!supabaseAnonKeyEnv) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not configured");
  return supabaseAnonKeyEnv;
}