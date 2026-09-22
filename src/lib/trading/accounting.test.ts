import { describe, expect, it } from "vitest";
import {
  applyTrade,
  portfolioMetrics,
  positionKey,
  replayTrades,
  unrealizedPnl,
  EMPTY_POSITION,
  formatBps,
  type LivePosition,
  type PositionState,
} from "@/lib/trading/accounting";
import {
  parseDec,
  parseDbDec,
  format,
  mul,
  sub,
  add,
} from "@/lib/money";

function pos(quantity?: string, avg?: string, realized?: string): PositionState {
  return {
    quantityMwh: parseDec(quantity ?? "0"),
    averageEntryPrice: parseDec(avg ?? "0"),
    realizedPnl: parseDec(realized ?? "0"),
  };
}

/** A position with an identity — a position is keyed by instrument and leg B,
 *  not by market alone. */
function live(
  over: Partial<Omit<LivePosition, "quantityMwh" | "averageEntryPrice" | "realizedPnl">> &
    Partial<PositionState> = {}
): LivePosition {
  return {
    instrument: "ENERGY_SPOT",
    marketId: "m1",
    counterMarketId: null,
    product: "RTM_HOURLY",
    deliveryStart: "2026-09-22T00:00:00Z",
    deliveryEnd: "2026-09-22T01:00:00Z",
    quantityMwh: parseDec("0"),
    averageEntryPrice: parseDec("0"),
    realizedPnl: parseDec("0"),
    ...over,
  };
}

describe("position accounting (weighted average cost)", () => {
  it("opens a long", () => {
    const res = applyTrade(EMPTY_POSITION, "BUY", parseDec("500"), parseDec("60"));
    expect(format(res.next.quantityMwh)).toBe("500");
    expect(format(res.next.averageEntryPrice)).toBe("60");
    expect(format(res.realizedDelta)).toBe("0");
    expect(format(res.next.realizedPnl)).toBe("0");
  });

  it("computes weighted average entry (spec §13)", () => {
    let st = applyTrade(EMPTY_POSITION, "BUY", parseDec("500"), parseDec("60")).next;
    st = applyTrade(st, "BUY", parseDec("300"), parseDec("70")).next;
    expect(format(st.quantityMwh)).toBe("800");
    expect(format(st.averageEntryPrice, 4)).toBe("63.75");
  });

  it("realizes P&L on partial close, keeps weighted avg (spec §14)", () => {
    let st = applyTrade(EMPTY_POSITION, "BUY", parseDec("500"), parseDec("60")).next;
    st = applyTrade(st, "BUY", parseDec("300"), parseDec("70")).next;
    const res = applyTrade(st, "SELL", parseDec("300"), parseDec("70"));
    expect(format(res.realizedDelta)).toBe("1875"); // (70 - 63.75) × 300
    expect(format(res.next.quantityMwh)).toBe("500");
    expect(format(res.next.averageEntryPrice)).toBe("63.75");
  });

  it("computes unrealized P&L with signed formula (spec §15)", () => {
    const st = pos("500", "63.75");
    expect(format(unrealizedPnl(st, parseDec("70")))).toBe("3125");
    const short = pos("-500", "70");
    expect(format(unrealizedPnl(short, parseDec("60")))).toBe("5000");
  });

  it("updates cash through buy/sell flows (spec §16)", () => {
    const cash = mul(parseDec("500"), parseDec("60"));
    expect(format(cash)).toBe("30000");
    expect(format(sub(parseDec("100000"), cash))).toBe("70000");
  });

  it("reconciles equity with realized + unrealized (spec §17-18)", () => {
    let st = applyTrade(EMPTY_POSITION, "BUY", parseDec("500"), parseDec("60")).next;
    const close = applyTrade(st, "SELL", parseDec("300"), parseDec("70"));
    st = close.next;
    // cash: 100000 - 30000 + 21000 = 91000
    const cash = sub(parseDec("100000"), sub(mul("500", "60"), mul("300", "70")));
    const realized = st.realizedPnl;
    const unrealized = unrealizedPnl(st, parseDec("70"));
    const equity = {
      cash: parseDec(cash),
      marked: mul(st.quantityMwh, parseDec("70")),
    };
    const total = sub(add(equity.cash, equity.marked), parseDec("100000"));
    expect(format(realized)).toBe("3000"); // (70 - 60) × 300
    expect(format(unrealized)).toBe("2000"); // (70-60)×500 remaining 200
    expect(format(add(realized, unrealized))).toBe("5000");
    expect(format(total)).toBe("5000");
    expect(format(add(realized, unrealized))).toBe(format(total));
  });

  it("closes / reverses longs and shorts (spec §12 sequence)", () => {
    let st = applyTrade(EMPTY_POSITION, "BUY", parseDec("500"), parseDec("60")).next;
    st = applyTrade(st, "SELL", parseDec("200"), parseDec("60")).next;
    expect(format(st.quantityMwh)).toBe("300");
    st = applyTrade(st, "SELL", parseDec("300"), parseDec("61")).next;
    expect(format(st.quantityMwh)).toBe("0");
    st = applyTrade(st, "SELL", parseDec("200"), parseDec("61")).next;
    expect(format(st.quantityMwh)).toBe("-200");
    expect(format(st.averageEntryPrice)).toBe("61");
  });

  it("realizes short P&L when covering", () => {
    const st = applyTrade(EMPTY_POSITION, "SELL", parseDec("500"), parseDec("70")).next;
    expect(format(st.quantityMwh)).toBe("-500");
    const res = applyTrade(st, "BUY", parseDec("500"), parseDec("60"));
    expect(format(res.realizedDelta)).toBe("5000"); // (70 - 60) × 500
    expect(format(res.next.quantityMwh)).toBe("0");
  });

  it("adds to a short with a weighted average", () => {
    let st = applyTrade(EMPTY_POSITION, "SELL", parseDec("500"), parseDec("70")).next;
    st = applyTrade(st, "SELL", parseDec("500"), parseDec("80")).next;
    expect(format(st.quantityMwh)).toBe("-1000");
    expect(format(st.averageEntryPrice)).toBe("75");
  });

  it("flips a long into a short, repricing the new exposure", () => {
    const st = applyTrade(EMPTY_POSITION, "BUY", parseDec("800"), parseDec("40")).next;
    const res = applyTrade(st, "SELL", parseDec("1000"), parseDec("55"));
    expect(format(res.realizedDelta)).toBe("12000"); // (55-40)×800
    expect(format(res.next.quantityMwh)).toBe("-200");
    expect(format(res.next.averageEntryPrice)).toBe("55");
  });

  it("flips a short into a long, repricing the new exposure", () => {
    const st = applyTrade(EMPTY_POSITION, "SELL", parseDec("300"), parseDec("50")).next;
    const res = applyTrade(st, "BUY", parseDec("500"), parseDec("40"));
    expect(format(res.realizedDelta)).toBe("3000"); // (50-40)×300
    expect(format(res.next.quantityMwh)).toBe("200");
    expect(format(res.next.averageEntryPrice)).toBe("40");
  });

  it("treats partial closes as avg-(unchanged) + realized only on closed leg", () => {
    let st = applyTrade(EMPTY_POSITION, "BUY", parseDec("500"), parseDec("60")).next;
    st = applyTrade(st, "BUY", parseDec("500"), parseDec("80")).next;
    expect(format(st.averageEntryPrice)).toBe("70");
    const res = applyTrade(st, "SELL", parseDec("250"), parseDec("90"));
    expect(format(res.realizedDelta)).toBe("5000"); // (90-70)×250
    expect(format(res.next.quantityMwh)).toBe("750");
    expect(format(res.next.averageEntryPrice)).toBe("70");
  });
});

describe("portfolio metrics", () => {
  const m1 = live({ marketId: "m1" });
  const m2 = live({ marketId: "m2" });
  const marks = new Map<string, bigint>([
    [positionKey(m1), parseDec("70")],
    [positionKey(m2), parseDec("25")],
  ]);

  it("equity = cash + marked value; total = realized + unrealized", () => {
    // Consistent series:
    //  cash start 100000
    //  BUY   500 @ 50        -> cash 75000;  +500 @ 50
    //  SELL  200 @ 55        -> cash 86000;  +300 @ 50   realized +1000
    //  SELL  400 @ 60 (flip) -> cash 110000; -100 @ 60   realized +3000
    //  SELL  200 @ 30 (m2)   -> cash 116000; -200 @ 30   realized 0
    // marks: m1 = 70, m2 = 25
    const metrics = portfolioMetrics({
      cashBalance: parseDec("116000"),
      startingCash: parseDec("100000"),
      marks,
      positions: [
        { ...m1, ...pos("-100", "60", "4000") },
        { ...m2, ...pos("-200", "30", "0") },
      ],
    });
    expect(format(metrics.markedValue)).toBe("-12000"); // -100×70 + -200×25
    expect(format(metrics.equity)).toBe("104000");
    expect(format(metrics.totalPnl)).toBe("4000");
    expect(format(metrics.realizedPnl)).toBe("4000");
    expect(format(metrics.unrealizedPnl)).toBe("0"); // -1000 + 1000
    expect(format(add(metrics.realizedPnl, metrics.unrealizedPnl))).toBe(
      format(metrics.totalPnl)
    );
    expect(metrics.returnBps).toBe(400n); // +4.00%
    expect(formatBps(metrics.returnBps)).toEqual({ sign: "+", value: "4" });
  });

  it("computes return percent as basis points", () => {
    const metrics = portfolioMetrics({
      cashBalance: parseDec("110000"),
      startingCash: parseDec("100000"),
      marks,
      positions: [],
    });
    expect(metrics.returnBps).toBe(1000n); // +10.00%
    expect(formatBps(metrics.returnBps)).toEqual({ sign: "+", value: "10" });
  });
});

describe("database-sourced values (PostgreSQL numeric scale)", () => {
  // Postgres returns numeric at whatever scale it has, so persisted money
  // arrives with more than the 6 decimals the engine fixes on.
  it("keeps equity = cash + marked and total = realized + unrealized", () => {
    // Series: 100000 start; BUY 500 @ 50 (cash 75000); SELL 200 @ 55
    // (cash 86000, realized 1000); remaining +300 @ 50; mark 70.
    const position = live({
      quantityMwh: parseDbDec("300.000000000000000"),
      averageEntryPrice: parseDbDec("50.000000000000000000"),
      realizedPnl: parseDbDec("1000.0000000000000000"),
    });
    const metrics = portfolioMetrics({
      cashBalance: parseDbDec("86000.0000000000000000"),
      startingCash: parseDbDec("100000"),
      marks: new Map([[positionKey(position), parseDbDec("70.0000000000000000000")]]),
      positions: [position],
    });
    expect(format(metrics.markedValue)).toBe("21000");
    expect(format(metrics.equity)).toBe("107000");
    expect(format(metrics.totalPnl)).toBe("7000");
    expect(format(metrics.realizedPnl)).toBe("1000");
    expect(format(metrics.unrealizedPnl)).toBe("6000");
    expect(format(add(metrics.realizedPnl, metrics.unrealizedPnl))).toBe(
      format(metrics.totalPnl)
    );
    expect(metrics.returnBps).toBe(700n); // +7.00%
  });
});

describe("breakdown by instrument", () => {
  const spot = live({ instrument: "ENERGY_SPOT", marketId: "m1" });
  const virtual = live({
    instrument: "VIRTUAL",
    marketId: "m1",
    product: "DAM_HOURLY",
  });

  it("slices sum to the portfolio totals", () => {
    const positions = [
      { ...spot, ...pos("100", "50") },
      { ...virtual, ...pos("-40", "10", "50") },
    ];
    const metrics = portfolioMetrics({
      cashBalance: parseDec("94000"),
      startingCash: parseDec("100000"),
      marks: new Map([
        [positionKey(spot), parseDec("60")],
        [positionKey(virtual), parseDec("12")],
      ]),
      positions,
    });

    const sum = (pick: (b: (typeof metrics.byInstrument)[number]) => bigint) =>
      metrics.byInstrument.reduce((acc, b) => acc + pick(b), 0n);

    expect(metrics.byInstrument).toHaveLength(2);
    expect(sum((b) => b.grossNotional)).toBe(metrics.grossNotional);
    expect(sum((b) => b.markedValue)).toBe(metrics.markedValue);
    expect(sum((b) => b.realizedPnl)).toBe(metrics.realizedPnl);
    expect(sum((b) => b.unrealizedPnl)).toBe(metrics.unrealizedPnl);
    expect(sum((b) => b.volumes.reduce((a, v) => a + v.net, 0n))).toBe(
      metrics.volumes.reduce((a, v) => a + v.net, 0n)
    );
    expect(metrics.unmarkedPositions).toBe(0);

    // Both positions are energy, so there is exactly one unit bucket.
    expect(metrics.volumes.map((v) => v.unit)).toEqual(["MWH"]);
    expect(format(metrics.volumes[0].long)).toBe("100");
    expect(format(metrics.volumes[0].short)).toBe("40");
    expect(format(metrics.volumes[0].net)).toBe("60");

    // Gross: |100|×60 + |−40|×12 = 6000 + 480. The virtual leg is held at its
    // own convergence price, not at a point price.
    expect(format(metrics.grossNotional)).toBe("6480");
    const spotRow = metrics.byInstrument.find((b) => b.instrument === "ENERGY_SPOT")!;
    const virtualRow = metrics.byInstrument.find((b) => b.instrument === "VIRTUAL")!;
    expect(format(spotRow.grossNotional)).toBe("6000");
    expect(format(virtualRow.grossNotional)).toBe("480");
    expect(format(virtualRow.unrealizedPnl)).toBe("-80"); // (12-10) × -40
    expect(format(virtualRow.realizedPnl)).toBe("50");
  });

  it("orders by exposure, largest first", () => {
    const metrics = portfolioMetrics({
      cashBalance: parseDec("100000"),
      startingCash: parseDec("100000"),
      marks: new Map([
        [positionKey(spot), parseDec("60")],
        [positionKey(virtual), parseDec("12")],
      ]),
      positions: [
        { ...virtual, ...pos("-40", "10") },
        { ...spot, ...pos("100", "50") },
      ],
    });
    expect(metrics.byInstrument.map((b) => b.instrument)).toEqual([
      "ENERGY_SPOT",
      "VIRTUAL",
    ]);
  });

  it("counts a spread as one instrument position, not two legs", () => {
    const spread = live({
      instrument: "BASIS_SPREAD",
      marketId: "m1",
      counterMarketId: "m2",
    });
    const metrics = portfolioMetrics({
      cashBalance: parseDec("100000"),
      startingCash: parseDec("100000"),
      marks: new Map([[positionKey(spread), parseDec("5")]]),
      positions: [{ ...spread, ...pos("200", "3") }],
    });
    expect(metrics.byInstrument).toHaveLength(1);
    expect(metrics.byInstrument[0].instrument).toBe("BASIS_SPREAD");
    expect(metrics.byInstrument[0].positions).toBe(1);
    expect(format(metrics.byInstrument[0].grossNotional)).toBe("1000");
  });

  it("never adds MW of capacity to MWh of energy", () => {
    // A capacity position and an energy position are different dimensions.
    // Summing them into one "volume" would be arithmetic on unlike things.
    const capacity = live({
      instrument: "AS_CAPACITY",
      marketId: "m1",
      product: "REGUP",
    });
    const metrics = portfolioMetrics({
      cashBalance: parseDec("100000"),
      startingCash: parseDec("100000"),
      marks: new Map([
        [positionKey(spot), parseDec("60")],
        [positionKey(capacity), parseDec("120")],
      ]),
      positions: [
        { ...spot, ...pos("100", "50") },
        { ...capacity, ...pos("250", "100") },
      ],
    });

    expect(metrics.volumes.map((v) => v.unit)).toEqual(["MWH", "MW"]);
    const energy = metrics.volumes.find((v) => v.unit === "MWH")!;
    const capacityVolume = metrics.volumes.find((v) => v.unit === "MW")!;
    expect(format(energy.long)).toBe("100");
    expect(format(capacityVolume.long)).toBe("250");
    // Neither bucket contains the other's quantity.
    expect(format(capacityVolume.net)).toBe("250");

    // The per-instrument rows carry their own unit, so a capacity instrument
    // is reported in MW wherever it appears.
    const row = metrics.byInstrument.find((b) => b.instrument === "AS_CAPACITY")!;
    expect(row.volumes.map((v) => v.unit)).toEqual(["MW"]);
    expect(format(row.volumes[0].long)).toBe("250");

    // Cash is untouched by unit mixing; exposure still aggregates in dollars.
    expect(format(metrics.grossNotional)).toBe("36000"); // 6000 + 250×120
  });

  it("reports volume per unit rather than one mixed total", () => {
    // A single instrument can hold more than one unit if it is priced off more
    // than one product, so the bucket list is per instrument, not per code.
    const a = live({ instrument: "BLOCK_FORWARD", product: "RTM_HOURLY" });
    const b = live({ instrument: "BLOCK_FORWARD", product: "RRS" });
    const metrics = portfolioMetrics({
      cashBalance: parseDec("100000"),
      startingCash: parseDec("100000"),
      marks: new Map([
        [positionKey(a), parseDec("40")],
        [positionKey(b), parseDec("15")],
      ]),
      positions: [
        { ...a, ...pos("100", "38") },
        { ...b, ...pos("-50", "15") },
      ],
    });
    expect(metrics.byInstrument).toHaveLength(1);
    expect(metrics.byInstrument[0].volumes.map((v) => v.unit)).toEqual([
      "MWH",
      "MW",
    ]);
  });

  it("flags a quantity whose unit cannot be established", () => {
    // An uncatalogued product must not be assumed to be energy.
    const unknown = live({ instrument: "ENERGY_SPOT", product: "NOT_A_PRODUCT" });
    const metrics = portfolioMetrics({
      cashBalance: parseDec("100000"),
      startingCash: parseDec("100000"),
      marks: new Map([[positionKey(unknown), parseDec("10")]]),
      positions: [{ ...unknown, ...pos("100", "10") }],
    });
    expect(metrics.volumes.map((v) => v.unit)).toEqual(["UNKNOWN"]);
    expect(format(metrics.volumes[0].long)).toBe("100");
  });

  it("banks realized P&L of an unpriced position without valuing it", () => {
    // The series for this instrument has no price, so it can be neither marked
    // nor marked to market — but the P&L it already realized is not optional.
    const metrics = portfolioMetrics({
      cashBalance: parseDec("100000"),
      startingCash: parseDec("100000"),
      marks: new Map([[positionKey(spot), parseDec("60")]]),
      positions: [
        { ...spot, ...pos("100", "50") },
        { ...virtual, ...pos("40", "10", "50") },
      ],
    });
    expect(metrics.unmarkedPositions).toBe(1);
    expect(format(metrics.realizedPnl)).toBe("50");
    const virtualRow = metrics.byInstrument.find((b) => b.instrument === "VIRTUAL")!;
    expect(virtualRow.unmarkedPositions).toBe(1);
    expect(virtualRow.realizedPnl).toBe(parseDec("50"));
    expect(virtualRow.grossNotional).toBe(0n);
    expect(virtualRow.markedValue).toBe(0n);
    expect(virtualRow.unrealizedPnl).toBe(0n);
    // Volume is a quantity, so it is reported whether or not the position can
    // be priced — an unpriced leg is still a held position.
    expect(virtualRow.volumes).toHaveLength(1);
    expect(format(virtualRow.volumes[0].long)).toBe("40");
  });
});

describe("position identity and instrument-aware replay", () => {
  const base = {
    marketId: "m1",
    counterMarketId: null,
    product: "RTM_HOURLY",
    deliveryStart: "2026-09-22T00:00:00Z",
    deliveryEnd: "2026-09-22T01:00:00Z",
  } as const;

  it("keys positions by instrument, leg B and window, not by market alone", () => {
    // Same point, product and interval — four different instruments.
    const a = positionKey({ ...base, instrument: "ENERGY_SPOT" });
    const b = positionKey({ ...base, instrument: "VIRTUAL" });
    const c = positionKey({ ...base, instrument: "BASIS_SPREAD", counterMarketId: "m2" });
    const d = positionKey({ ...base, instrument: "BASIS_SPREAD", counterMarketId: "m3" });
    expect(new Set([a, b, c, d]).size).toBe(4);

    // A legless instrument flattens leg B to an empty segment, the same way
    // the generated `leg_key` column does in the database.
    expect(positionKey({ ...base, instrument: "VIRTUAL", counterMarketId: null })).toBe(
      "VIRTUAL::m1::::RTM_HOURLY::2026-09-22T00:00:00Z::2026-09-22T01:00:00Z"
    );
  });

  it("does not net a spot position against a virtual position on the same hour", () => {
    const trades = [
      { id: "t1", ...base, instrument: "ENERGY_SPOT", side: "BUY" as const, quantityMwh: parseDec("100"), executionPrice: parseDec("60") },
      { id: "t2", ...base, instrument: "VIRTUAL", side: "SELL" as const, quantityMwh: parseDec("100"), executionPrice: parseDec("5") },
    ];
    const replay = replayTrades(trades);
    expect(replay.positions.size).toBe(2);
    expect(format([...replay.positions.values()][0].quantityMwh)).toBe("100");
    expect(format([...replay.positions.values()][1].quantityMwh)).toBe("-100");
    // Neither trade closed anything, so no realized P&L was attributed.
    expect(replay.cumulativeRealized).toBe(0n);
    expect(replay.trades.map((t) => format(t.realizedPnL))).toEqual(["0", "0"]);
  });

  it("nets two legs of the same spread instrument, and only those", () => {
    const spread = { ...base, instrument: "BASIS_SPREAD", counterMarketId: "m2" } as const;
    const other = { ...base, instrument: "BASIS_SPREAD", counterMarketId: "m3" } as const;
    const replay = replayTrades([
      { id: "t1", ...spread, side: "BUY", quantityMwh: parseDec("100"), executionPrice: parseDec("8") },
      { id: "t2", ...other, side: "BUY", quantityMwh: parseDec("50"), executionPrice: parseDec("3") },
      { id: "t3", ...spread, side: "SELL", quantityMwh: parseDec("40"), executionPrice: parseDec("10") },
    ]);
    const spreadKey = positionKey(spread);
    const spreadPos = replay.positions.get(spreadKey)!;
    expect(format(spreadPos.quantityMwh)).toBe("60");
    expect(format(spreadPos.averageEntryPrice)).toBe("8");
    // (10 - 8) × 40 on a long spread priced at the congestion value.
    expect(format(spreadPos.realizedPnl)).toBe("80");
    expect(format(replay.positions.get(positionKey(other))!.quantityMwh)).toBe("50");
  });

  it("marks an option-type instrument at the floored price by construction", () => {
    // The floor/obligation rule lives in instrumentPrice (instruments.test.ts);
    // what matters here is that accounting takes the reduced price as given.
    const st = applyTrade(EMPTY_POSITION, "BUY", parseDec("10"), parseDec("0"));
    expect(format(st.next.averageEntryPrice)).toBe("0");
    const res = applyTrade(st.next, "SELL", parseDec("10"), parseDec("12"));
    expect(format(res.realizedDelta)).toBe("120");
  });
});