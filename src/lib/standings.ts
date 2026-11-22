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

/** A row of get_leaderboard, as the service role reads it. */
export interface RawRow {
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
 * load. The ranking is held for STANDINGS_TTL_MS per function instance, and
 * concurrent requests share one computation.
 *
 * Who may be shown is not cached. Leaving the standings takes effect on the
 * next page load, not when the cache expires (#70), and a new name or picture
 * shows at once: those are read per request, by primary key.
 */
const STANDINGS_TTL_MS = 30_000;
const standingsCache = new Map<number, { at: number; rows: Promise<RawRow[]> }>();

async function rankedStandings(top: number): Promise<RawRow[]> {
  const { data, error } = await supabaseAdmin().rpc("get_leaderboard", { p_top: top });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as RawRow[];
}

/** A profile as it is now: whether, and as whom, the trader may be shown. */
export interface ListedProfile {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  onboarded_at: string | null;
  leaderboard_opt_in: boolean;
}

/**
 * The cached ranking, cut to the traders who are listed now, ranked again.
 * A trader who has left, or has not yet chosen a name (onboarded_at NULL),
 * is left out; one without a current profile row is too.
 */
export function listedStandings(
  ranked: RawRow[],
  profiles: ListedProfile[],
  viewerId: string | null
): StandingsRow[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const rows: StandingsRow[] = [];
  for (const r of ranked) {
    const p = byId.get(r.user_id);
    if (!p || !p.leaderboard_opt_in || p.onboarded_at == null || !p.display_name) continue;
    rows.push({
      rank: rows.length + 1,
      displayName: p.display_name,
      avatarUrl: p.avatar_url,
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
    });
  }
  return rows;
}

/**
 * A row as the public JSON carries it. Money is exact decimal strings;
 * returnBps is a plain number of basis points, as the portfolio snapshot gives it —
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
  if (ranked.length === 0) return [];

  // A failure here fails the page: it must never fall back to showing anyone.
  const { data: profiles, error } = await supabaseAdmin()
    .from("profiles")
    .select("id, display_name, avatar_url, onboarded_at, leaderboard_opt_in")
    .in("id", ranked.map((r) => r.user_id));
  if (error) throw new Error(error.message);

  return listedStandings(ranked, (profiles ?? []) as ListedProfile[], viewerId);
}
