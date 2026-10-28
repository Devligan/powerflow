import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Server-side identity helper. Cached per request. */
export const getSessionUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/** For layouts/pages that must be authenticated. Redirects to /login. */
export async function requireUser(): Promise<User> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Ensure a user's profile + paper account exist and are never reset.
 * Idempotent (ON CONFLICT DO NOTHING on the database side). Called after
 * every successful sign-in, so users created before the DB trigger still
 * get bootstrapped exactly once.
 *
 * The parameter names must match the SQL function exactly — PostgREST resolves
 * an RPC by its argument names, so `_user_id` against a signature of
 * `(p_user_id, p_email)` fails with "function not found" every single time.
 *
 * A failure here is never swallowed: the signup trigger normally creates these
 * rows, so the RPC is a safety net, and the honest thing is to say whether the
 * user actually ended up with an account. If they did, the failed call is
 * logged (it means the safety net is broken and needs fixing). If they did
 * not, the error is raised — the alternative is a shell that renders with no
 * account behind it and no explanation anywhere.
 */
export async function ensureUserRecords(user: User): Promise<void> {
  const admin = supabaseAdmin();

  // Set simulation clock offset for replay mode when ERCOT_SOURCE=ERCOT_REPLAY
  // This runs for ALL users (new and existing) to ensure they see historical data.
  const envErcotSource = process.env.ERCOT_SOURCE ?? "ERCOT_MIS";
  const isReplayMode = envErcotSource.toUpperCase() === "ERCOT_REPLAY";
  if (isReplayMode) {
    const { error: setClockError } = await admin.rpc("set_sim_clock", {
      p_user_id: user.id,
      p_iso: "2026-09-20T00:00:00Z", // Sept 20 fixture date
    });
    if (setClockError) {
      console.error(`[auth] set_sim_clock failed for user ${user.id}: ${setClockError.message}`);
    }
  }

  const { error } = await admin.rpc("ensure_user_records", {
    p_user_id: user.id,
    p_email: user.email ?? "",
  });
  if (!error) return;

  const [profile, account] = await Promise.all([
    getUserProfile(user.id).catch(() => null),
    getPaperAccount(user.id).catch(() => null),
  ]);
  const context = `[auth] ensure_user_records failed for user ${user.id}`;
  if (profile && account) {
    console.error(
      `${context}: ${error.message} — records already exist (created by the signup trigger), continuing.`
    );
    return;
  }
  console.error(
    `${context}: ${error.message} — profile=${Boolean(profile)} account=${Boolean(account)}`
  );
  throw new Error(
    `account bootstrap failed for user ${user.id}: ${error.message}`
  );
}

export interface ProfileRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  leaderboard_opt_in: boolean;
  created_at: string;
  updated_at: string;
}

export interface PaperAccountRow {
  id: string;
  user_id: string;
  starting_cash: string;
  cash_balance: string;
  max_gross_notional: string;
  created_at: string;
  updated_at: string;
}

export async function getUserProfile(userId: string): Promise<ProfileRow | null> {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  return (data as ProfileRow | null) ?? null;
}

export async function getPaperAccount(
  userId: string
): Promise<PaperAccountRow | null> {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from("paper_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as PaperAccountRow | null) ?? null;
}