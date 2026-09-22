import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, fail, m } from "@/lib/api";
import { parseDbDec } from "@/lib/money";

export const dynamic = "force-dynamic";

interface LeaderboardRow {
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const top = Math.min(Math.max(Number(url.searchParams.get("top") ?? "100"), 1), 100);

  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("get_leaderboard", { p_top: top });
  if (error) return fail(error.message, 500);

  const rows = (data ?? []) as unknown as LeaderboardRow[];
  return ok({
    leaderboard: rows.map((r, i) => ({
      rank: i + 1,
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      equity: m(parseDbDec(r.equity)),
      returnBps: Number(parseDbDec(r.return_bps)),
      realizedPnl: m(parseDbDec(r.realized_pnl)),
      markedValue: m(parseDbDec(r.marked_value)),
      // Notional per unit — never a single mixed total.
      openNotionalMwh: m(parseDbDec(r.open_notional_mwh)),
      openNotionalMw: m(parseDbDec(r.open_notional_mw)),
      positionsCount: r.positions_count,
      tradesCount: r.trades_count,
      joinedAt: r.joined_at,
    })),
  });
}