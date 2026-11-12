import { format, parseDbDec } from "@/lib/money";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Money as the API gives it: an exact decimal string. */
const m = (v: string) => format(parseDbDec(v), 6);

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

/** How many rows to show: a whole number from 1 to 100, else the default. */
export function standingsSize(raw: string | null | undefined): number {
  const n = Number(raw ?? "100");
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), 100) : 100;
}

/**
 * The standings mark every opted-in book to market, and the Rank page is
 * public: computed per visitor, anyone could turn page loads into database
 * load. They are held for STANDINGS_TTL_MS per function instance, and
 * concurrent requests share one computation; only `isViewer` is per request.
 */
const STANDINGS_TTL_MS = 30_000;
type Ranked = { row: RawRow; avatarUrl: string | null };
const standingsCache = new Map<number, { at: number; rows: Promise<Ranked[]> }>();

async function rankedStandings(top: number): Promise<Ranked[]> {
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
    .map((row) => ({ row, avatarUrl: (byId.get(row.user_id)?.avatar_url as string | null) ?? null }));
}

/**
 * A row as the public JSON carries it. Money is exact decimal strings;
 * returnBps is a plain number of basis points, as /api/portfolio gives it —
 * not a fixed-point value (parseDbDec's 1e6 scale would multiply it).
 */
export function publicStandingsJson(r: StandingsRow) {
  return {
    rank: r.rank,
    displayName: r.displayName,
    avatarUrl: r.avatarUrl,
    equity: m(r.equity),
    returnBps: Number(r.returnBps),
    realizedPnl: m(r.realizedPnl),
    markedValue: m(r.markedValue),
    // Notional per unit — never a single mixed total.
    openNotionalMwh: m(r.openNotionalMwh),
    openNotionalMw: m(r.openNotionalMw),
    positionsCount: r.positionsCount,
    tradesCount: r.tradesCount,
    joinedAt: r.joinedAt,
  };
}

export async function getPublicStandings(
  top: number,
  viewerId: string | null = null
): Promise<StandingsRow[]> {
  const now = Date.now();
  let entry = standingsCache.get(top);
  if (!entry || now - entry.at > STANDINGS_TTL_MS) {
    entry = { at: now, rows: rankedStandings(top) };
    standingsCache.set(top, entry);
    // A failure must not be served from the cache to everyone after it.
    entry.rows.catch(() => standingsCache.delete(top));
  }
  const ranked = await entry.rows;

  return ranked.map(({ row: r, avatarUrl }, i) => ({
      rank: i + 1,
      displayName: r.display_name as string,
      avatarUrl,
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
