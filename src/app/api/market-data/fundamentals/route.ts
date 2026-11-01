import { ok, fail } from "@/lib/api";
import { getFundamentals } from "@/lib/fundamentals";

export const dynamic = "force-dynamic";

/**
 * Public ERCOT fundamentals as JSON — the market page's Fundamentals panel.
 * Served from the five-minute cache in getFundamentals, so this endpoint
 * never fans out to ERCOT per request.
 */
export async function GET() {
  const fundamentals = await getFundamentals();
  return fundamentals ? ok({ fundamentals }) : fail("ERCOT fundamentals are unavailable right now.", 503);
}
