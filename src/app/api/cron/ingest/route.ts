import { runMarketDataIngestion } from "@/lib/ingestion";
import { safeEqual, ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";



/**
 * Vercel Cron / manual trigger target. Guarded by CRON_SECRET so random
 * callers cannot provoke ingestion load.
 *
 * Exported for GET as well as POST, because Vercel Cron invokes a cron path
 * with GET — a POST-only export left the schedule in `vercel.json` answering
 * 405 and never ingesting. An external scheduler can still POST.
 */
async function handle(req: Request) {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!safeEqual(bearer, process.env.CRON_SECRET)) {
    return fail("Unauthorized", 401);
  }

  try {
    const summary = await runMarketDataIngestion();
    return ok(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ingestion failed";
    return fail(message, 500);
  }
}

export const GET = handle;
export const POST = handle;
