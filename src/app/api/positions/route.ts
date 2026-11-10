import { getPositionsView } from "@/lib/queries";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/auth";
import { getActiveDesk } from "@/lib/desk";
import { serverError, fail, ok, m } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.reads, user.id)) return tooManyRequests(LIMITS.reads);

  try {
    const desk = await getActiveDesk(user.id);
    const positions = await getPositionsView(desk.accountUserId);
    return ok({
      positions: positions.map((p) => ({
        id: p.id,
        instrument: p.instrument,
        marketId: p.marketId,
        counterMarketId: p.counterMarketId,
        product: p.product,
        settlementPoint: p.settlementPoint,
        counterSettlementPoint: p.counterSettlementPoint,
        deliveryStart: p.deliveryStart,
        deliveryEnd: p.deliveryEnd,
        quantityMwh: m(p.quantityMwh),
        averageEntryPrice: m(p.averageEntryPrice),
        realizedPnl: m(p.realizedPnl),
        unrealizedPnl: m(p.unrealizedPnl),
        markPrice: p.markPrice == null ? null : m(p.markPrice),
        markTimestamp: p.markTimestamp,
      })),
    });
  } catch (e) {
    return serverError("positions", e, "Your positions could not be loaded.");
  }
}