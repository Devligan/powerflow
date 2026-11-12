import { okPublic, fail } from "@/lib/api";
import { LIMITS, clientIp, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { getPublicStandings, publicStandingsJson, standingsSize } from "@/lib/standings";

export const dynamic = "force-dynamic";

/**
 * The public standings as JSON. Unauthenticated, so it carries exactly what
 * the Rank page shows anyone: chosen display names, pictures and aggregate
 * figures — never user ids, usernames or emails (src/lib/standings.ts).
 */
export async function GET(req: Request) {
  if (await overLimit(LIMITS.publicRead, clientIp(req))) return tooManyRequests(LIMITS.publicRead);

  const url = new URL(req.url);
  const top = standingsSize(url.searchParams.get("top"));

  try {
    const rows = await getPublicStandings(top);
    return okPublic({ leaderboard: rows.map(publicStandingsJson) });
  } catch {
    return fail("Standings are unavailable right now.", 500);
  }
}
