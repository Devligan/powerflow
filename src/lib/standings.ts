import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * The public standings, as anyone may see them.
 *
 * get_leaderboard (service role) returns internal user ids and usernames.
 * Neither leaves the server: a row carries the display name the trader chose,
 * their picture and aggregate figures, plus whether it is the viewer's own.
 * Accounts that have not yet chosen a name (onboarded_at NULL) are left out,
 * since their name may still be the default minted at sign-up.
 */
export interface StandingsRow {
  rank: number;
  displayName: string;
  avatarUrl: string | null;
  isViewer: boolean;
  startingCash: string;
  cashBalance: string;
  realizedPnl: string;
  markedValue: string;
  equity: string;
  returnBps: string;
  openNotionalMwh: string;
  openNotionalMw: string;
  positionsCount: number;
  tradesCount: number;
  joinedAt: string;
}

interface RawRow {
  user_id: string;
  username: string;
  display_name: string | null;
  starting_cash: string;
  cash_balance: string;
  realized_pnl: string;
  marked_value: string;
  equity: string;
  return_bps: string;
  open_notional_mwh: string;
  open_notional_mw: string;
  positions_count: number;
  trades_count: number;
  joined_at: string;
}

export async function getPublicStandings(
  top: number,
  viewerId: string | null = null
): Promise<StandingsRow[]> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("get_leaderboard", { p_top: top });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as RawRow[];
  if (rows.length === 0) return [];

  const { data: profiles, error: pError } = await admin
    .from("profiles")
    .select("id, avatar_url, onboarded_at")
    .in("id", rows.map((r) => r.user_id));
  if (pError) throw new Error(pError.message);
  const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]));

  return rows
    .filter((r) => byId.get(r.user_id)?.onboarded_at != null && r.display_name)
    .map((r, i) => ({
      rank: i + 1,
      displayName: r.display_name as string,
      avatarUrl: (byId.get(r.user_id)?.avatar_url as string | null) ?? null,
      isViewer: viewerId != null && r.user_id === viewerId,
      startingCash: r.starting_cash,
      cashBalance: r.cash_balance,
      realizedPnl: r.realized_pnl,
      markedValue: r.marked_value,
      equity: r.equity,
      returnBps: r.return_bps,
      openNotionalMwh: r.open_notional_mwh,
      openNotionalMw: r.open_notional_mw,
      positionsCount: r.positions_count,
      tradesCount: r.trades_count,
      joinedAt: r.joined_at,
    }));
}
