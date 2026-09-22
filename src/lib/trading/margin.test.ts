import { describe, expect, it } from "vitest";
import { mul, parseDec } from "@/lib/money";
import {
  DEFAULT_MARGIN_RATES,
  equityOf,
  liquidationPlan,
  marginRatio,
  marginRequirements,
  marginTier,
  rateOf,
  type LiquidationCandidate,
  type MarginedPosition,
} from "@/lib/trading/margin";

/**
 * The pure margin model.
 *
 * `sql-margin.test.ts` proves the same rules against Postgres, where the money
 * actually moves. These tests pin the thresholds and the liquidation order —
 * the parts a reader has to be able to check without a database.
 */

const d = (v: string) => parseDec(v);
/** Scaled bigint → dollars, for readable assertions. */
const dollars = (v: bigint) => Number(v) / 1e6;
const near = (actual: number, expected: number) =>
  expect(actual).toBeCloseTo(expected, 6);

const pos = (
  instrument: string,
  quantity: string,
  mark: string | null,
  product = "RTM_HOURLY"
): MarginedPosition => ({
  instrument,
  product,
  quantityMwh: d(quantity),
  markPrice: mark === null ? null : d(mark),
});

const candidate = (
  positionId: string,
  quantity: string,
  mark: string
): LiquidationCandidate => ({
  positionId,
  instrument: "ENERGY_SPOT",
  quantityMwh: d(quantity),
  markPrice: d(mark),
});

describe("rateOf", () => {
  it("applies a fractional rate without floating-point drift", () => {
    near(dollars(rateOf(d("1000"), 0.12)), 120);
    near(dollars(rateOf(d("1000"), 0.1)), 100);
    near(dollars(rateOf(d("1000"), 1)), 1000);
    // 12% of 12345.67 is 1481.4804 — the rate is basis points, so the result
    // is exact to the cent and never a repeating binary fraction.
    near(dollars(rateOf(d("12345.67"), 0.12)), 1481.4804);
  });
});

describe("equityOf", () => {
  it("is cash plus marked value when there is no deficit", () => {
    near(dollars(equityOf({ cashBalance: d("100"), markedValue: d("50") })), 150);
  });

  it("treats a deficit as a liability, not as negative cash", () => {
    const eq = equityOf({
      cashBalance: d("0"),
      markedValue: d("0"),
      deficit: d("3900"),
    });
    near(dollars(eq), -3900);
  });
});

describe("marginTier", () => {
  const used = d("1200");
  const maintenance = d("1000");

  it("is OK when equity covers the initial margin", () => {
    expect(
      marginTier({ equity: d("1200"), usedMargin: used, maintenanceMargin: maintenance })
    ).toBe("OK");
    expect(
      marginTier({ equity: d("5000"), usedMargin: used, maintenanceMargin: maintenance })
    ).toBe("OK");
  });

  it("warns between maintenance and initial: the buffer is thinning", () => {
    expect(
      marginTier({ equity: d("1100"), usedMargin: used, maintenanceMargin: maintenance })
    ).toBe("WARNING");
    expect(
      marginTier({ equity: d("1000"), usedMargin: used, maintenanceMargin: maintenance })
    ).toBe("WARNING");
  });

  it("calls below maintenance", () => {
    expect(
      marginTier({ equity: d("999"), usedMargin: used, maintenanceMargin: maintenance })
    ).toBe("CALL");
    expect(
      marginTier({ equity: d("1"), usedMargin: used, maintenanceMargin: maintenance })
    ).toBe("CALL");
  });

  it("is in deficit at zero equity, or whenever anything is owed", () => {
    expect(
      marginTier({ equity: 0n, usedMargin: used, maintenanceMargin: maintenance })
    ).toBe("DEFICIT");
    expect(
      marginTier({ equity: d("-1"), usedMargin: used, maintenanceMargin: maintenance })
    ).toBe("DEFICIT");
    // Owing money is insolvency regardless of what the marks say afterwards:
    // a deficit outranks a healthy-looking equity.
    expect(
      marginTier({
        equity: d("100000"),
        usedMargin: used,
        maintenanceMargin: maintenance,
        deficit: d("1"),
      })
    ).toBe("DEFICIT");
  });

  it("is OK with no open book", () => {
    expect(
      marginTier({ equity: d("0.01"), usedMargin: 0n, maintenanceMargin: 0n })
    ).toBe("OK");
  });
});

describe("marginRequirements", () => {
  it("marks a book and requires margin on absolute exposure", () => {
    const req = marginRequirements([
      pos("ENERGY_SPOT", "10", "50"), // long: +500 marked
      pos("ENERGY_SPOT", "-10", "50"), // short: -500 marked
    ]);

    // Signed marks net off; requirements do not.
    near(dollars(req.markedValue), 0);
    near(dollars(req.usedMargin), 120); // 1000 × 0.12
    near(dollars(req.maintenanceMargin), 100); // 1000 × 0.10
    expect(req.unpricedPositions).toBe(0);
  });

  it("uses the account's own rates", () => {
    const req = marginRequirements([pos("ENERGY_SPOT", "10", "50")], {
      initial: 0.5,
      maintenance: 0.25,
    });
    near(dollars(req.usedMargin), 250);
    near(dollars(req.maintenanceMargin), 125);
  });

  it("reports an unpriced position instead of charging nothing silently", () => {
    const req = marginRequirements([
      pos("ENERGY_SPOT", "10", "50"),
      pos("BASIS_SPREAD", "5", null, "RTM_HOURLY"),
    ]);

    // The unpriced leg contributes neither marked value nor requirement — the
    // account is under-margined by an unknown amount, which is why the count
    // is reported rather than dropped.
    near(dollars(req.markedValue), 500);
    near(dollars(req.usedMargin), 60);
    expect(req.unpricedPositions).toBe(1);
  });

  it("ignores a flat position", () => {
    const req = marginRequirements([pos("ENERGY_SPOT", "0", "50")]);
    near(dollars(req.markedValue), 0);
    near(dollars(req.usedMargin), 0);
  });

  it("defaults to the rates migration 0014 gives an account", () => {
    expect(DEFAULT_MARGIN_RATES).toEqual({ initial: 0.12, maintenance: 0.1 });
  });
});

describe("liquidationPlan", () => {
  it("sells nothing when the cash already covers the obligation", () => {
    const plan = liquidationPlan({
      cash: d("5000"),
      need: d("2000"),
      candidates: [candidate("a", "10", "300")],
    });
    expect(plan.closes).toHaveLength(0);
    expect(plan.covered).toBe(true);
    near(dollars(plan.raised), 0);
    near(dollars(plan.cashAfter), 5000);
    expect(plan.shortfall).toBe(0n);
  });

  it("sells the largest marked exposure first, and only as much as it needs", () => {
    const plan = liquidationPlan({
      cash: d("100"),
      need: d("3100"),
      candidates: [
        candidate("small", "10", "100"), // 1,000
        candidate("big", "10", "300"), //   3,000
        candidate("middle", "10", "200"), // 2,000
      ],
    });

    // 100 + 3000 ≥ 3100 after the first sale, so the rest are untouched.
    expect(plan.closes.map((c) => c.positionId)).toEqual(["big"]);
    near(dollars(plan.raised), 3000);
    near(dollars(plan.cashAfter), 3100);
    expect(plan.covered).toBe(true);
  });

  it("keeps selling until the obligation is covered", () => {
    // 100 + 3000 = 3100 is short of 3200, so the next-largest goes too.
    const plan = liquidationPlan({
      cash: d("100"),
      need: d("3200"),
      candidates: [
        candidate("big", "10", "300"),
        candidate("next", "10", "200"),
      ],
    });
    expect(plan.closes.map((c) => c.positionId)).toEqual(["big", "next"]);
    near(dollars(plan.raised), 5000);
    near(dollars(plan.cashAfter), 5100);
    expect(plan.covered).toBe(true);
  });

  it("never sells a short: closing one costs cash, so it cannot fund anything", () => {
    const plan = liquidationPlan({
      cash: d("0"),
      need: d("100"),
      candidates: [candidate("short", "-10", "300"), candidate("long", "1", "50")],
    });
    expect(plan.closes.map((c) => c.positionId)).toEqual(["long"]);
    near(dollars(plan.cashAfter), 50);
    expect(plan.covered).toBe(false);
    near(dollars(plan.shortfall), 50);
  });

  it("reports the shortfall when every long is gone and it is still not enough", () => {
    const plan = liquidationPlan({
      cash: d("100"),
      need: d("10000"),
      candidates: [candidate("big", "10", "300"), candidate("small", "10", "100")],
    });
    expect(plan.closes).toHaveLength(2);
    near(dollars(plan.raised), 4000);
    near(dollars(plan.cashAfter), 4100);
    expect(plan.covered).toBe(false);
    near(dollars(plan.shortfall), 5900);
  });

  it("is equity-neutral: cash gained equals marked value given up", () => {
    const candidates = [candidate("a", "10", "300"), candidate("b", "10", "100")];
    const plan = liquidationPlan({ cash: d("100"), need: d("10000"), candidates });
    const givenUp = plan.closes.reduce(
      (sum, c) => sum + mul(c.markPrice, c.quantityMwh),
      0n
    );
    expect(plan.raised).toBe(givenUp);
  });

  it("treats a non-positive need as nothing to do", () => {
    const plan = liquidationPlan({
      cash: d("0"),
      need: d("-500"),
      candidates: [candidate("a", "10", "300")],
    });
    expect(plan.closes).toHaveLength(0);
    expect(plan.covered).toBe(true);
  });

  it("breaks ties on position id, so the order is deterministic", () => {
    const plan = liquidationPlan({
      cash: d("0"),
      need: d("1"),
      candidates: [candidate("b", "1", "100"), candidate("a", "1", "100")],
    });
    expect(plan.closes.map((c) => c.positionId)).toEqual(["a"]);
  });
});

describe("marginRatio", () => {
  it("is equity over used margin", () => {
    expect(marginRatio(d("1200"), d("1200"))).toBe(1);
    expect(marginRatio(d("600"), d("1200"))).toBe(0.5);
  });

  it("is undefined with no requirement, rather than zero", () => {
    expect(marginRatio(d("100"), 0n)).toBeNull();
  });
});
