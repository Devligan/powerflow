import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client. Server-only; importing this module into a client
 * component or browser bundle will leak the service key.
 * Used exclusively for:
 *   - the market-data ingestion pipeline
 *   - leaderboard / analytics computation over trusted data
 *   - account bootstrapping during sign-in
 */
export function getAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase server credentials missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)"
    );
  }

  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export const supabaseAdmin = getAdminClient;