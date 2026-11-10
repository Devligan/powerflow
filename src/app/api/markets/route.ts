import { okPublic, serverError } from "@/lib/api";
import { listMarkets } from "@/lib/markets";
import { LIMITS, clientIp, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Every tradable settlement point with its latest real-time hour, the
 * day-ahead clearing for that same hour, and the next operating day's
 * day-ahead average. Same rows as the markets page, from the same query.
 */
export async function GET(req: Request) {
  if (await overLimit(LIMITS.publicRead, clientIp(req))) return tooManyRequests(LIMITS.publicRead);
  // `asOf`: what ERCOT had published by then, for a replay desk. History is
  // public; the future is not, so the instant is never later than now. It is
  // taken to the minute, so replay requests share the CDN's cache.
  const raw = new URL(req.url).searchParams.get("asOf");
  const parsed = raw ? Date.parse(raw) : NaN;
  const asOf = Number.isFinite(parsed)
    ? new Date(Math.floor(Math.min(parsed, Date.now()) / 60_000) * 60_000)
    : null;
  try {
    return okPublic({ markets: await listMarkets(asOf) });
  } catch (e) {
    return serverError("markets", e, "Market data is unavailable right now.");
  }
}
