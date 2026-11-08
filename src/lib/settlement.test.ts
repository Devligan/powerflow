import { describe, expect, it } from "vitest";
import {
  applyTrade,
  portfolioMetrics,
  positionKey,
  settlePosition,
  unrealizedPnl,
  type LivePosition,
} from "@/lib/trading/accounting";
import { settlementEnabled, settlementState } from "@/lib/settlement";
import { add, format, mul, parseDec, sub } from "@/lib/money";

/**
 * The settlement rules, in TypeScript.
 *
 * `sql-settlement.test.ts` tests the SQL that moves the money. This file tests
 * the mirror of it — the rule that settlement is a *close at the instrument's
 * own price*, and that it converts unrealized P&L into cash and realized P&L
 * without changing equity. Catching a disagreement here is cheaper than
 * catching it in Postgres, and the two are pinned together by the SQL suite.
 */

const d = (v: string) => parseDec(v);
const p = (v: bigint | null) => (v == null ? null : format(v, 6));

describe("settlePosition", () => {
  it("has nothing to settle on an already-flat position", () => {
    const flat = { quantityMwh: 0n, averageEntryPrice: d("50"), realizedPnl: 0n };
    expect(settlePosition(flat, d("60"))).toBeNull();
  });

  it("closes a long by selling it at the settlement price", () => {
    const effect = settlePosition(
      { quantityMwh: d("10"), averageEntryPrice: d("50"), realizedPnl: 0n },
      d("60")
    )!;

    expect(effect.side).toBe("SELL");
    expect(p(effect.quantityMwh)).toBe("10");
    // Cash in from the sale.
    expect(p(effect.cashDelta)).toBe("600");
    // Realized: (60 − 50) × 10.
    expect(p(effect.realizedDelta)).toBe("100");
    expect(p(effect.next.quantityMwh)).toBe("0");
    expect(p(effect.next.realizedPnl)).toBe("100");
  });

  it("closes a short by buying it back, profiting as the price falls", () => {
    const effect = settlePosition(
      { quantityMwh: d("-10"), averageEntryPrice: d("50"), realizedPnl: 0n },
      d("44")
    )!;

    expect(effect.side).toBe("BUY");
    // Magnitude is positive; the side carries the direction.
    expect(p(effect.quantityMwh)).toBe("10");
    // Cash out to buy the short back.
    expect(p(effect.cashDelta)).toBe("-440");
    // (50 − 44) × 10, which is the same signed expression (p − avg) × q.
    expect(p(effect.realizedDelta)).toBe("60");
    expect(p(effect.next.quantityMwh)).toBe("0");
  });

  it("uses the same accounting as a user close, with one signed expression", () => {
    // The documented identity: realized = (settlement − entry) × signed qty,
    // and cash = settlement × signed qty, for both directions.
    for (const [qty, avg, settlement] of [
      ["10", "50", "60"],
      ["-10", "50", "44"],
      ["7.5", "31.25", "40"],
      ["-3", "100", "95"],
    ]) {
      const q = d(qty);
      const avgEntry = d(avg);
      const price = d(settlement);
      const entry = { quantityMwh: q, averageEntryPrice: avgEntry, realizedPnl: 0n };
      const effect = settlePosition(entry, price)!;

      const side = q > 0n ? ("SELL" as const) : ("BUY" as const);
      // Delegating to applyTrade must agree with the closed form.
      const viaApply = applyTrade(entry, side, q > 0n ? q : -q, price);
      expect(p(effect.realizedDelta)).toBe(p(viaApply.realizedDelta));

      const signedQty = q;
      expect(p(effect.cashDelta)).toBe(p(mul(price, signedQty)));
      expect(p(effect.realizedDelta)).toBe(p(mul(sub(price, avgEntry), signedQty)));
    }
  });

  it("is equity-neutral, converting unrealized P&L into realized", () => {
    const P = d("50");
    const P2 = d("62");
    const qty = d("10");
    // What the entry would have cost, in scaled money — money values are
    // fixed-point, so these go through the helpers rather than raw operators.
    const cashBalance = sub(d("100000"), mul(P, qty));

    const id = {
      instrument: "ENERGY_SPOT",
      marketId: "m1",
      counterMarketId: null,
      product: "RTM_HOURLY",
      deliveryStart: "2026-09-22T00:00:00.000Z",
      deliveryEnd: "2026-09-22T01:00:00.000Z",
    };
    const open: LivePosition = { ...id, quantityMwh: qty, averageEntryPrice: P, realizedPnl: 0n };

    // The position was already marked at the price it settles at, so this is
    // the mark-to-market the position was carrying. Marks are keyed the same
    // way positions are, which is why the key comes from `positionKey` rather
    // than being retyped.
    const before = portfolioMetrics({
      cashBalance,
      startingCash: d("100000"),
      marks: new Map([[positionKey(open), P2]]),
      positions: [open],
    });
    expect(p(unrealizedPnl(open, P2))).toBe("120");

    const effect = settlePosition(open, P2)!;
    const after = portfolioMetrics({
      cashBalance: add(cashBalance, effect.cashDelta),
      startingCash: d("100000"),
      // A settled position is flat, so it is no longer marked.
      marks: new Map(),
      positions: [{ ...open, ...effect.next }],
    });

    // The settlement must not create or destroy equity...
    expect(p(after.equity)).toBe(p(before.equity));
    expect(p(after.totalPnl)).toBe(p(before.totalPnl));
    // ...it moves P&L from unrealized to realized.
    expect(p(before.unrealizedPnl)).toBe("120");
    expect(p(after.unrealizedPnl)).toBe("0");
    expect(p(before.realizedPnl)).toBe("0");
    expect(p(after.realizedPnl)).toBe("120");
    // And the decomposition identity still holds.
    expect(p(after.totalPnl)).toBe(p(add(after.realizedPnl, after.unrealizedPnl)));
  });
});

describe("settlementState", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const base = {
    quantityMwh: d("10"),
    settledAt: null,
    deliveryEnd: "2026-09-21T18:00:00.000Z",
    markPrice: d("50"),
    now,
  };

  it("distinguishes undelivered, deliverable, stuck, settled and closed", () => {
    // Undelivered: the window has not passed.
    expect(settlementState(base)).toBe("OPEN");

    // Delivered and priced: the next sweep cashes it out.
    expect(
      settlementState({ ...base, deliveryEnd: "2026-09-21T11:00:00.000Z" })
    ).toBe("AWAITING");

    // Delivered but the interval has no price, so it cannot settle yet. This is
    // the difference between "working" and "the market data is behind".
    expect(
      settlementState({ ...base, deliveryEnd: "2026-09-21T11:00:00.000Z", markPrice: null })
    ).toBe("AWAITING_PRICE");

    // Settlement wins over delivery.
    expect(
      settlementState({
        ...base,
        deliveryEnd: "2026-09-21T11:00:00.000Z",
        settledAt: "2026-09-21T11:00:01.000Z",
        quantityMwh: 0n,
      })
    ).toBe("SETTLED");

    // Flat without a settlement record: closed by the user.
    expect(settlementState({ ...base, quantityMwh: 0n })).toBe("CLOSED");
  });

  it("treats the delivery end itself as delivered", () => {
    // The sweep uses `delivery_end <= as_of`, so the boundary is delivered.
    expect(
      settlementState({ ...base, deliveryEnd: "2026-09-21T12:00:00.000Z" })
    ).toBe("AWAITING");
    expect(
      settlementState({ ...base, deliveryEnd: "2026-09-21T12:00:00.001Z" })
    ).toBe("OPEN");
  });

  it("holds a delivered position until ERCOT's price is final", () => {
    const delivered = { ...base, deliveryEnd: "2026-09-21T11:00:00.000Z" };
    // Priced, but ERCOT can still correct it until the finality instant.
    expect(settlementState({ ...delivered, finalAt: now + 1 })).toBe("FINALIZING");
    expect(settlementState({ ...delivered, finalAt: now })).toBe("AWAITING");
    // An unpriced hour is stuck on the feed, whatever the calendar says.
    expect(settlementState({ ...delivered, markPrice: null, finalAt: now + 1 })).toBe(
      "AWAITING_PRICE"
    );
    // Not delivered is not delivered.
    expect(settlementState({ ...base, finalAt: now + 1 })).toBe("OPEN");
  });

  it("rejects a delivery timestamp it cannot reason about", () => {
    expect(() => settlementState({ ...base, deliveryEnd: "not-a-date" })).toThrow(
      /delivery_end/
    );
  });
});

describe("settlementEnabled", () => {
  const original = process.env.SETTLEMENT_ENABLED;

  const withEnv = (value: string | undefined, run: () => void) => {
    if (value === undefined) delete process.env.SETTLEMENT_ENABLED;
    else process.env.SETTLEMENT_ENABLED = value;
    try {
      run();
    } finally {
      if (original === undefined) delete process.env.SETTLEMENT_ENABLED;
      else process.env.SETTLEMENT_ENABLED = original;
    }
  };

  it("is on by default", () => {
    withEnv(undefined, () => expect(settlementEnabled()).toBe(true));
    withEnv("", () => expect(settlementEnabled()).toBe(true));
  });

  it("is off only for an explicit off value", () => {
    for (const off of ["false", "0", "off", "no", "FALSE", " Off "]) {
      withEnv(off, () => expect(settlementEnabled()).toBe(false));
    }
    for (const on of ["true", "1", "yes", "on"]) {
      withEnv(on, () => expect(settlementEnabled()).toBe(true));
    }
  });
});
