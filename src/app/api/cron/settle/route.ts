import { NextResponse } from "next/server";
import { runAutoSettlement, settlementEnabled } from "@/lib/settlement";
import { safeEqual, ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export const maxDuration = 60;

/**
 * Vercel Cron / manual trigger target for automatic settlement. Guarded by
 * CRON_SECRET so random callers cannot provoke a settlement sweep.
 *
 * Settlement is a service-role job over every user's book, so this route is
 * the only way to reach it — the RPC refuses any caller that is not
 * `service_role`, and `p_as_of` is never taken from the request.
 *
 * Exported for GET as well as POST because Vercel Cron invokes a cron path with
 * GET; an external scheduler can POST instead.
 */
async function handle(req: Request) {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!safeEqual(bearer, process.env.CRON_SECRET)) {
    return fail("Unauthorized", 401);
  }

  // Delivered positions stay open while this is off (the pre-0013 behaviour).
  if (!settlementEnabled()) {
    return ok({ skipped: true, reason: "SETTLEMENT_ENABLED is off" });
  }

  try {
    const summary = await runAutoSettlement();
    // Deferred positions are normal — the feed may not have published an
    // interval yet, and they settle on a later run. A hard failure is not: it
    // means a position raised while being settled, so it surfaces as an error
    // rather than a quiet success.
    if (summary.failed > 0) {
      // Same shape as a success, plus the error — so a cron log carries the
      // per-position reasons rather than only a status code.
      return NextResponse.json(
        { ...summary, error: `settlement failed for ${summary.failed} position(s)` },
        { status: 500 }
      );
    }
    return ok(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Settlement failed";
    return fail(message, 500);
  }
}

export const GET = handle;
export const POST = handle;
