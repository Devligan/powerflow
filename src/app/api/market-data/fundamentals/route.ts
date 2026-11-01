import { ok } from "@/lib/api";
import { getFundamentals } from "@/lib/fundamentals";

export const dynamic = "force-dynamic";

/**
 * Public ERCOT fundamentals as JSON (the market page's Fundamentals panel),
 * with the raw upstream status of each feed for diagnosis when it is empty.
 */
export async function GET() {
  const probe = async (name: string) => {
    try {
      const r = await fetch(`https://www.ercot.com/api/1/services/read/dashboards/${name}.json`, {
        headers: { "User-Agent": "Mozilla/5.0 (PowerFlow fundamentals)", Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      const text = await r.text();
      return { status: r.status, bytes: text.length, head: text.slice(0, 80) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  const [fundamentals, supplyDemand, windSolar] = await Promise.all([
    getFundamentals(),
    probe("supply-demand"),
    probe("combine-wind-solar"),
  ]);
  return ok({ fundamentals, upstream: { supplyDemand, windSolar } });
}
