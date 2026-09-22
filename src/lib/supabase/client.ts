import { createBrowserClient } from "@supabase/ssr";
import {
  isSupabaseConfigured,
  requireSupabaseAnonKey,
  requireSupabaseUrl,
} from "@/lib/supabase/config";

export function createClient() {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured (missing env vars)");
  }
  return createBrowserClient(requireSupabaseUrl(), requireSupabaseAnonKey());
}

export function supabaseUrl(): string {
  return requireSupabaseUrl();
}

export function supabaseAnonKey(): string {
  return requireSupabaseAnonKey();
}