import { getPositionsView } from "@/lib/queries";
import { getSessionUser } from "@/lib/auth";
import { fail, ok, m } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  try {
    const positions = await getPositionsView(user.id);
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
    return fail(e instanceof Error ? e.message : "Failed to load positions", 500);
  }
}