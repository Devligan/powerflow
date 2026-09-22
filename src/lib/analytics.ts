import { supabaseAdmin } from "@/lib/supabase/admin";
import { m } from "@/lib/api";
import { parseDbDec } from "@/lib/money";
import {
  portfolioMetrics,
  positionKey,
  replayTrades,
  unrealizedPnl,
  volumeBreakdown,
  type VolumeUnit,
} from "@/lib/trading/accounting";

export interface AnalyticsResult {
  currentEquity: string;
  startingCash: string;
  returnBps: number;
  realizedPnl: string;
  unrealizedPnl: string;
  totalTrades: number;
  winRatePercent: number;
  avgTradePnl: string;
  bestTradePnl: string;
  worstTradePnl: string;
  /** Volume per unit. MWh and MW are different dimensions and are never
   *  totalled together. Serialized to decimal strings like every other value
   *  here, because this result is returned straight from an API route. */
  volumes: Array<{
    unit: VolumeUnit;
    long: string;
    short: string;
    net: string;
  }>;
  maxDrawdown: string;
  pnlByDay: Array<{ day: string; pnl: string }>;
  pnlByMarket: Array<{ market: string; pnl: string }>;
}

/** Derive per-trade realized P&L by replaying history through the trading
 *  engine identical to execute_trade. Requires full trade history. */
export async function getAnalytics(userId: string): Promise<AnalyticsResult> {
  const admin = supabaseAdmin();

  const [tradesRes, accountRes, marketsRes, positionsRes, marksRes] = await Promise.all([
    admin
      .from("trades")
      .select(
        "id, instrument, market_id, counter_market_id, product, side, quantity_mwh, execution_price, delivery_start, delivery_end, created_at"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(2000),
    admin
      .from("paper_accounts")
      .select("starting_cash, cash_balance, deficit")
      .eq("user_id", userId)
      .maybeSingle(),
    admin.from("markets").select("id, settlement_point"),
    admin
      .from("positions")
      .select(
        "id, instrument, market_id, counter_market_id, product, delivery_start, delivery_end, quantity_mwh, average_entry_price, realized_pnl"
      )
      .eq("user_id", userId),
    // Instrument marks come from the engine (a spread has no single series to
    // look up, and a window instrument has no single interval), so they cannot
    // be recomputed from the current-price view.
    admin.rpc("position_marks", { p_user_id: userId }),
  ]);
  if (marksRes.error) throw new Error(marksRes.error.message);

  const startingCashRaw = accountRes.data?.starting_cash ?? "0";
  const startingCash = parseDbDec(startingCashRaw);

  const replay = replayTrades(
    (tradesRes.data ?? []).map((t) => ({
      id: t.id,
      instrument: t.instrument,
      marketId: t.market_id,
      counterMarketId: t.counter_market_id,
      product: t.product,
      side: t.side as "BUY" | "SELL",
      quantityMwh: parseDbDec(t.quantity_mwh),
      executionPrice: parseDbDec(t.execution_price),
      deliveryStart: t.delivery_start,
      deliveryEnd: t.delivery_end,
    }))
  );

  const allPositions = (positionsRes.data ?? []).map((p) => ({
    id: p.id,
    instrument: p.instrument,
    marketId: p.market_id,
    counterMarketId: p.counter_market_id,
    product: p.product,
    deliveryStart: p.delivery_start,
    deliveryEnd: p.delivery_end,
    quantityMwh: parseDbDec(p.quantity_mwh),
    averageEntryPrice: parseDbDec(p.average_entry_price),
    realizedPnl: parseDbDec(p.realized_pnl),
  }));

  const markById = new Map<string, bigint>();
  for (const row of (marksRes.data ?? []) as Array<{
    position_id: string;
    mark_price: string | null;
  }>) {
    if (row.mark_price != null) markById.set(row.position_id, parseDbDec(row.mark_price));
  }

  // Marks are keyed by position identity, the same key portfolioMetrics uses.
  const marks = new Map<string, bigint>();
  for (const p of allPositions) {
    const mark = markById.get(p.id);
    if (mark != null) marks.set(positionKey(p), mark);
  }

  const metrics = portfolioMetrics({
    cashBalance: parseDbDec(accountRes.data?.cash_balance ?? "0"),
    startingCash,
    deficit: parseDbDec(accountRes.data?.deficit ?? "0"),
    marks,
    positions: allPositions,
  });

  // Unrealized P&L is the marked sum the metrics already computed — replaying
  // it separately would mark legless and window instruments off no price at all.
  const unrealized = metrics.unrealizedPnl;

  const perTrade = replay.trades.map((t) => t.realizedPnL);
  const totalTrades = perTrade.length;
  const wins = perTrade.filter((v) => v > 0n).length;
  const winRatePercent =
    totalTrades === 0 ? 0 : Math.round((wins / totalTrades) * 100);

  const best = perTrade.length ? perTrade.reduce((a, b) => (a > b ? a : b)) : 0n;
  const worst = perTrade.length ? perTrade.reduce((a, b) => (a < b ? a : b)) : 0n;
  const avg =
    totalTrades === 0
      ? 0n
      : replay.cumulativeRealized / BigInt(totalTrades);

  // P&L over time (daily) = end-of-day cumulated realized P&L.
  const byDay = new Map<string, bigint>();
  let running = 0n;
  for (const t of replay.trades) {
    const day = t.deliveryStart.slice(0, 10);
    running += t.realizedPnL;
    byDay.set(day, running);
  }

  const pnlByMarketMap = new Map<string, bigint>();
  for (const t of replay.trades) {
    if (t.realizedPnL !== 0n) {
      pnlByMarketMap.set(
        t.marketId,
        (pnlByMarketMap.get(t.marketId) ?? 0n) + t.realizedPnL
      );
    }
  }
  for (const p of allPositions) {
    const mark = markById.get(p.id);
    if (mark == null) continue;
    // A spread is attributed to its leg A point, which is the locational side.
    const marketId = p.marketId;
    pnlByMarketMap.set(
      marketId,
      (pnlByMarketMap.get(marketId) ?? 0n) + unrealizedPnl(p, mark)
    );
  }
  const pointByMarket = new Map(
    (marketsRes.data ?? []).map((p) => [p.id, p.settlement_point])
  );

  // Max drawdown on the cumulative realized series (recursively reconstructable).
  let peak = 0n;
  let maxDD = 0n;
  for (const [day, value] of byDay.entries()) {
    void day;
    if (value > peak) peak = value;
    const dd = peak - value;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    currentEquity: m(metrics.equity),
    startingCash: m(startingCash),
    returnBps: Number(metrics.returnBps),
    realizedPnl: m(metrics.realizedPnl),
    unrealizedPnl: m(unrealized),
    totalTrades,
    winRatePercent,
    avgTradePnl: m(avg),
    bestTradePnl: m(best),
    worstTradePnl: m(worst),
    // Traded volume is signed by side, so a BUY adds long and a SELL adds
    // short, and each is bucketed by the unit of the product traded.
    volumes: volumeBreakdown(
      replay.trades.map((t) => ({
        product: t.product,
        quantityMwh: t.side === "BUY" ? t.quantityMwh : -t.quantityMwh,
      }))
    ).map((v) => ({
      unit: v.unit,
      long: m(v.long),
      short: m(v.short),
      net: m(v.net),
    })),
    maxDrawdown: m(maxDD),
    pnlByDay: [...byDay.entries()].map(([day, pnl]) => ({ day, pnl: m(pnl) })),
    pnlByMarket: [...pnlByMarketMap.entries()].map(([id, pnl]) => ({
      market: pointByMarket.get(id) ?? id,
      pnl: m(pnl),
    })),
  };
}