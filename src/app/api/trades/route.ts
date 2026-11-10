import { getSessionUser } from "@/lib/auth";
import { getActiveDesk } from "@/lib/desk";
import { fail, ok, m, serverError } from "@/lib/api";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { parseDbDec } from "@/lib/money";
import { getTrades, parseTradeFilters } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * The blotter. Read-only: a position opens only as a day-ahead bid
 * (`POST /api/orders`), and the order sweep is what fills it (0038). The
 * direct-fill endpoint that used to live here refused every orderable
 * instrument, and since 0046 a session cannot call `execute_trade` at all.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.reads, user.id)) return tooManyRequests(LIMITS.reads);

  const filters = parseTradeFilters(new URL(req.url).searchParams);
  if (!filters) return fail("Invalid filter", 422);

  try {
    const desk = await getActiveDesk(user.id);
    const { rows, total } = await getTrades(desk.accountUserId, filters);

    return ok({
      total,
      trades: rows.map((r) => ({
        id: r.id,
        marketId: r.market_id,
        settlementPoint: r.settlement_point,
        instrument: r.instrument,
        counterMarketId: r.counter_market_id,
        counterSettlementPoint: r.counter_settlement_point,
        product: r.product,
        venue: r.venue,
        side: r.side,
        quantityMwh: m(parseDbDec(r.quantity_mwh)),
        executionPrice: m(parseDbDec(r.execution_price)),
        deliveryStart: r.delivery_start,
        deliveryEnd: r.delivery_end,
        priceTimestamp: r.price_timestamp,
        status: r.status,
        createdAt: r.created_at,
        realizedPnl: m(parseDbDec(r.realized_pnl)),
      })),
    });
  } catch (e) {
    return serverError("trades list", e, "Your trades could not be loaded.");
  }
}
