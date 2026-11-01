import { ok, fail, m } from "@/lib/api";
import { parseDbDec } from "@/lib/money";
import { getPublicStandings } from "@/lib/standings";

export const dynamic = "force-dynamic";

/**
 * The public standings as JSON. Unauthenticated, so it carries exactly what
 * the Rank page shows anyone: chosen display names, pictures and aggregate
 * figures — never user ids, usernames or emails (src/lib/standings.ts).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const top = Math.min(Math.max(Number(url.searchParams.get("top") ?? "100"), 1), 100);

  try {
    const rows = await getPublicStandings(top);
    return ok({
      leaderboard: rows.map((r) => ({
        rank: r.rank,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        equity: m(parseDbDec(r.equity)),
        returnBps: Number(parseDbDec(r.returnBps)),
        realizedPnl: m(parseDbDec(r.realizedPnl)),
        markedValue: m(parseDbDec(r.markedValue)),
        // Notional per unit — never a single mixed total.
        openNotionalMwh: m(parseDbDec(r.openNotionalMwh)),
        openNotionalMw: m(parseDbDec(r.openNotionalMw)),
        positionsCount: r.positionsCount,
        tradesCount: r.tradesCount,
        joinedAt: r.joinedAt,
      })),
    });
  } catch {
    return fail("Standings are unavailable right now.", 500);
  }
}
