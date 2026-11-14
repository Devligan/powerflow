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
  try {
    return okPublic({ markets: await listMarkets() });
  } catch (e) {
    return serverError("markets", e, "Market data is unavailable right now.");
  }
}
