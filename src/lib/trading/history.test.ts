import { describe, expect, it } from "vitest";
import { hourEndingStartUtc } from "@/lib/ercot/hour-ending";
import { parseDec } from "@/lib/money";
import {
  cumulativeDailyPnl,
  inExecutionOrder,
  portfolioMetrics,
  positionKey,
  replayTrades,
  settlePosition,
  type LivePosition,
  type ReplayTradeInput,
} from "@/lib/trading/accounting";

const d = (v: string) => parseDec(v);

const identity = {
  instrument: "VIRTUAL",
  marketId: "m1",
  counterMarketId: null,
  product: "DAM_HOURLY",
  deliveryStart: "2026-10-10T17:00:00.000Z",
  deliveryEnd: "2026-10-10T18:00:00.000Z",
};

describe("inExecutionOrder", () => {
  interface Row extends ReplayTradeInput {
    status: string;
    at: string;
  }
  const row = (over: Partial<Row>): Row => ({
    ...identity,
    id: "t",
    side: "BUY",
    quantityMwh: d("10"),
    executionPrice: d("40"),
    status: "EXECUTED",
    at: "2026-11-05T12:00:00.000Z",
    ...over,
  });
  const order = (rows: Row[]) =>
    inExecutionOrder(rows, (t) => ({ key: positionKey(t), status: t.status, at: t.at }));

  it("puts a replay settlement after the fill stamped later than it", () => {
    // A fill carries the wall clock and a settlement the simulation clock, so
    // on a replay desk the settlement of an October hour sorts first.
    const fill = row({ id: "fill" });
    const settlement = row({
      id: "settlement",
      side: "SELL",
      executionPrice: d("55"),
      status: "SETTLED",
      at: "2026-10-10T18:30:00.000Z",
    });

    const ordered = order([settlement, fill]);
    expect(ordered.map((t) => t.id)).toEqual(["fill", "settlement"]);

    const replay = replayTrades(ordered);
    expect(replay.cumulativeRealized).toBe(d("150"));
    expect(replay.positions.get(positionKey(fill))!.quantityMwh).toBe(0n);
  });

  it("leaves a live history, already in order, alone", () => {
    const rows = [
      row({ id: "a", at: "2026-11-01T12:00:00.000Z" }),
      row({ id: "b", at: "2026-11-02T12:00:00.000Z", side: "SELL", status: "SETTLED" }),
      row({ id: "c", at: "2026-11-03T12:00:00.000Z", marketId: "m2" }),
    ];
    expect(order(rows).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("orders a fill ahead of a settlement stamped the same instant", () => {
    const rows = [
      row({ id: "settled", side: "SELL", status: "SETTLED" }),
      row({ id: "fill" }),
    ];
    expect(order(rows).map((t) => t.id)).toEqual(["fill", "settled"]);
  });

  it("does not hold back another position's settlement", () => {
    const rows = [
      row({ id: "settled", marketId: "m2", side: "SELL", status: "SETTLED", at: "2026-10-10T18:30:00.000Z" }),
      row({ id: "unrelated" }),
    ];
    expect(order(rows).map((t) => t.id)).toEqual(["settled", "unrelated"]);
  });
});

describe("cumulativeDailyPnl", () => {
  const start = (day: string, he: number) => new Date(hourEndingStartUtc(day, he)!).toISOString();

  it("books an evening hour to its Central operating day, not the next UTC day", () => {
    // HE24 on Oct 10 starts 04:00Z on Oct 11.
    const series = cumulativeDailyPnl([
      { deliveryStart: start("2026-10-10", 24), realizedPnL: d("100") },
    ]);
    expect(series.map((p) => p.day)).toEqual(["2026-10-10"]);
  });

  it("walks the days in order, whatever order the trades closed in", () => {
    const series = cumulativeDailyPnl([
      { deliveryStart: start("2026-10-12", 10), realizedPnL: d("30") },
      { deliveryStart: start("2026-10-10", 10), realizedPnL: d("100") },
      { deliveryStart: start("2026-10-11", 10), realizedPnL: d("-40") },
    ]);
    expect(series).toEqual([
      { day: "2026-10-10", pnl: d("100") },
      { day: "2026-10-11", pnl: d("60") },
      { day: "2026-10-12", pnl: d("90") },
    ]);
  });

  it("leaves out days on which nothing was realized", () => {
    const series = cumulativeDailyPnl([
      { deliveryStart: start("2026-10-10", 10), realizedPnL: 0n },
      { deliveryStart: start("2026-10-11", 10), realizedPnL: d("5") },
    ]);
    expect(series.map((p) => p.day)).toEqual(["2026-10-11"]);
  });
});

describe("settlePosition on a margined instrument", () => {
  const long = { quantityMwh: d("10"), averageEntryPrice: d("40"), realizedPnl: 0n };

  it("moves only the P&L: a virtual put no cash up", () => {
    const effect = settlePosition(long, d("55"), "VIRTUAL")!;
    expect(effect.cashDelta).toBe(d("150"));
    expect(effect.realizedDelta).toBe(d("150"));
  });

  it("charges a losing short its loss, not the notional", () => {
    const short = { ...long, quantityMwh: d("-10") };
    expect(settlePosition(short, d("55"), "PTP_OBLIGATION")!.cashDelta).toBe(d("-150"));
  });

  it("still moves the full notional for a position that paid for it", () => {
    expect(settlePosition(long, d("55"), "ENERGY_SPOT")!.cashDelta).toBe(d("550"));
    expect(settlePosition(long, d("55"))!.cashDelta).toBe(d("550"));
  });
});

describe("gross exposure", () => {
  it("counts a path marked below zero as exposure, not as a credit", () => {
    const path: LivePosition = {
      ...identity,
      instrument: "PTP_OBLIGATION",
      counterMarketId: "m2",
      quantityMwh: d("10"),
      averageEntryPrice: d("-3"),
      realizedPnl: 0n,
    };
    const metrics = portfolioMetrics({
      cashBalance: d("1000"),
      startingCash: d("1000"),
      marks: new Map([[positionKey(path), d("-5")]]),
      positions: [path],
    });
    expect(metrics.grossNotional).toBe(d("50"));
    expect(metrics.unrealizedPnl).toBe(d("-20"));
  });
});
