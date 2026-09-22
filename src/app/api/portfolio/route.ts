import { getPortfolioSnapshot } from "@/lib/queries";
import { getSessionUser } from "@/lib/auth";
import { fail, ok, m } from "@/lib/api";
import { parseDbDec } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  try {
    const snapshot = await getPortfolioSnapshot(user.id);
    const met = snapshot.metrics;
    return ok({
      account: {
        id: snapshot.account.id,
        startingCash: m(met.startingCash),
        cashBalance: m(met.cashBalance),
        maxGrossNotional: m(parseDbDec(snapshot.account.maxGrossNotional ?? "0")),
      },
      metrics: {
        equity: m(met.equity),
        markedValue: m(met.markedValue),
        grossNotional: m(met.grossNotional),
        realizedPnl: m(met.realizedPnl),
        unrealizedPnl: m(met.unrealizedPnl),
        totalPnl: m(met.totalPnl),
        returnBps: Number(met.returnBps),
        // Volume is per unit: MWh of energy and MW of capacity are separate
        // dimensions and are never totalled together.
        volumes: met.volumes.map((v) => ({
          unit: v.unit,
          long: m(v.long),
          short: m(v.short),
          net: m(v.net),
        })),
        unmarkedPositions: met.unmarkedPositions,
      },
      // Exposure by instrument — the level a position is actually held at, so
      // a spread is one row rather than its two legs.
      byInstrument: met.byInstrument.map((b) => ({
        instrument: b.instrument,
        positions: b.positions,
        unmarkedPositions: b.unmarkedPositions,
        markedValue: m(b.markedValue),
        grossNotional: m(b.grossNotional),
        realizedPnl: m(b.realizedPnl),
        unrealizedPnl: m(b.unrealizedPnl),
        volumes: b.volumes.map((v) => ({
          unit: v.unit,
          long: m(v.long),
          short: m(v.short),
          net: m(v.net),
        })),
      })),
      positions: snapshot.positions.map((p) => ({
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
    return fail(e instanceof Error ? e.message : "Failed to load portfolio", 500);
  }
}