import { centralHourEnding } from "@/lib/ercot/hour-ending";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { m } from "@/lib/api";
import { parseDbDec } from "@/lib/money";
import { allPositions as loadPositions, replayInput, tradeHistory } from "@/lib/queries";
import {
  cumulativeDailyPnl,
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
  /** Share of realizing trades that made money; null until one has. */
  winRatePercent: number | null;
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
  /** How a DART desk is judged: what each settled MWh earned, by side and
   *  by hour ending, and the risk-adjusted return of daily P&L. */
  desk: {
    pnlPerMwh: string | null;
    settledMwh: string;
    decPnl: string;
    incPnl: string;
    pnlByHour: Array<{ he: number; pnl: string }>;
    /** Annualized Sharpe of daily realized P&L; null under two days. */
    sharpe: number | null;
  };
}

/** Derive per-trade realized P&L by replaying history through the trading
 *  engine identical to execute_trade. Requires full trade history. */
export async function getAnalytics(userId: string): Promise<AnalyticsResult> {
  const admin = supabaseAdmin();

  const [trades, accountRes, marketsRes, positions, marksRes] = await Promise.all([
    tradeHistory(userId),
    admin
      .from("paper_accounts")
      .select("starting_cash, cash_balance, deficit")
      .eq("user_id", userId)
      .maybeSingle(),
    admin.from("markets").select("id, settlement_point"),
    loadPositions(userId),
    // Instrument marks come from the engine (a spread has no single series to
    // look up, and a window instrument has no single interval), so they cannot
    // be recomputed from the current-price view.
    admin.rpc("position_marks", { p_user_id: userId }),
  ]);
  if (marksRes.error) throw new Error(marksRes.error.message);

  const startingCashRaw = accountRes.data?.starting_cash ?? "0";
  const startingCash = parseDbDec(startingCashRaw);

  const replay = replayTrades(trades.map(replayInput));

  const allPositions = positions.map((p) => ({
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
  // Only trades that realized something (closes and settlements) win or lose.
  // Counting opening trades as zero-P&L "losses" read a fresh long as a 0% win
  // rate and diluted the average toward zero.
  const decided = perTrade.filter((v) => v !== 0n);
  const wins = decided.filter((v) => v > 0n).length;
  const winRatePercent =
    decided.length === 0 ? null : Math.round((wins / decided.length) * 100);

  const best = decided.length ? decided.reduce((a, b) => (a > b ? a : b)) : 0n;
  const worst = decided.length ? decided.reduce((a, b) => (a < b ? a : b)) : 0n;
  const avg =
    decided.length === 0
      ? 0n
      : replay.cumulativeRealized / BigInt(decided.length);

  // P&L over time (daily) = end-of-day cumulated realized P&L.
  const byDay = cumulativeDailyPnl(replay.trades);

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
  for (const { pnl: value } of byDay) {
    if (value > peak) peak = value;
    const dd = peak - value;
    if (dd > maxDD) maxDD = dd;
  }

  // Desk metrics. A position's P&L is realized on the trade that closes it
  // (for a virtual, the real-time settlement): closing a long (a DEC) is a
  // SELL, closing a short (an INC) a BUY.
  const closing = replay.trades.filter((t) => t.realizedPnL !== 0n);
  const settledMwh = closing.reduce((s, t) => s + t.quantityMwh, 0n);
  const pnlPerMwh = settledMwh > 0n ? (replay.cumulativeRealized * 1_000_000n) / settledMwh : null;
  let decPnl = 0n;
  let incPnl = 0n;
  const byHour = new Map<number, bigint>();
  for (const t of closing) {
    if (t.side === "SELL") decPnl += t.realizedPnL;
    else incPnl += t.realizedPnL;
    const he = centralHourEnding(Date.parse(t.deliveryStart)).he;
    byHour.set(he, (byHour.get(he) ?? 0n) + t.realizedPnL);
  }
  const cumulative = byDay.map(({ pnl }) => Number(pnl) / 1e6);
  const daily = cumulative.map((v, i) => v - (i ? cumulative[i - 1] : 0));
  let sharpe: number | null = null;
  if (daily.length >= 2) {
    const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
    const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (daily.length - 1));
    sharpe = sd > 0 ? Math.round((mean / sd) * Math.sqrt(252) * 100) / 100 : null;
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
    pnlByDay: byDay.map(({ day, pnl }) => ({ day, pnl: m(pnl) })),
    pnlByMarket: [...pnlByMarketMap.entries()].map(([id, pnl]) => ({
      market: pointByMarket.get(id) ?? id,
      pnl: m(pnl),
    })),
    desk: {
      pnlPerMwh: pnlPerMwh == null ? null : m(pnlPerMwh),
      settledMwh: m(settledMwh),
      decPnl: m(decPnl),
      incPnl: m(incPnl),
      pnlByHour: [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([he, pnl]) => ({ he, pnl: m(pnl) })),
      sharpe,
    },
  };
}