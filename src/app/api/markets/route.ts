import { ok, fail } from "@/lib/api";
import { listMarkets } from "@/lib/markets";

export const dynamic = "force-dynamic";

/**
 * Every tradable settlement point with its latest real-time hour, the
 * day-ahead clearing for that same hour, and the next operating day's
 * day-ahead average. Same rows as the markets page, from the same query.
 */
export async function GET() {
  try {
    return ok({ markets: await listMarkets() });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Market data unavailable", 500);
  }
}
