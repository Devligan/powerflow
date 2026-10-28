import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_INTERVALS,
  MAX_QUANTITY,
  buildWindow,
  checkOrderForm,
  effectiveProduct,
  estimateInstrumentPrice,
  orderRequest,
  probePrice,
  ruleHint,
  selectableProducts,
  windowIntervals,
  type SeriesPoint,
} from "@/lib/trading/order-form";
import { requireInstrument, tradableInstruments } from "@/lib/ercot/types";

const at = (iso: string): string => new Date(`${iso}:00:00.000Z`).toISOString();

/** 48 hourly points starting 2026-09-22T00:00Z, prices 10, 11, 12 … */
const series: SeriesPoint[] = Array.from({ length: 48 }, (_, i) => ({
  deliveryTimestamp: at(`2026-09-${i < 24 ? "22" : "23"}T${String(i % 24).padStart(2, "0")}`),
  price: String(10 + i),
}));

const spot = requireInstrument("ENERGY_SPOT");
const virtual = requireInstrument("VIRTUAL");
const basis = requireInstrument("BASIS_SPREAD");
const ptpOption = requireInstrument("PTP_OPTION");
const block = requireInstrument("BLOCK_FORWARD");

const win = (hour: number, intervals = 1, intervalMinutes = 60) =>
  buildWindow({ date: "2026-09-22", hour, intervalMinutes, intervals })!;

/** The series ends at 2026-09-23T23:00Z, so this window overhangs it. */
const overhanging = buildWindow({
  date: "2026-09-23",
  hour: 21,
  intervalMinutes: 60,
  intervals: 6,
})!;

const ticket = (over: Partial<Parameters<typeof checkOrderForm>[0]> = {}) => ({
  instrument: spot,
  product: "RTM_HOURLY",
  counterMarketId: null,
  marketId: "m-a",
  quantity: "10",
  delivery: win(18),
  intervalMinutes: 60,
  priceProbe: "priced" as const,
  now: Date.parse("2026-09-22T00:00:00.000Z"),
  ...over,
});

describe("delivery window", () => {
  it("spans one interval unless the instrument settles a window", () => {
    expect(windowIntervals("POINT", 24)).toBe(1);
    expect(windowIntervals("DIFFERENCE", 24)).toBe(1);
    expect(windowIntervals("CONVERGENCE", 24)).toBe(1);
    expect(windowIntervals("AVERAGE", 24)).toBe(24);
    expect(windowIntervals("AVERAGE", 0)).toBe(1);
    expect(windowIntervals("AVERAGE", 6.7)).toBe(6);
  });

  it("builds an interval-aligned UTC window", () => {
    const one = win(18);
    expect(one.start).toBe("2026-09-22T18:00:00.000Z");
    expect(one.end).toBe("2026-09-22T19:00:00.000Z");
    expect(one.minutes).toBe(60);

    const day = win(18, DEFAULT_WINDOW_INTERVALS);
    expect(day.start).toBe("2026-09-22T18:00:00.000Z");
    expect(day.end).toBe("2026-09-23T18:00:00.000Z");
    expect(day.minutes).toBe(1440);

    const quarters = buildWindow({
      date: "2026-09-22",
      hour: 18,
      intervalMinutes: 15,
      intervals: 4,
    })!;
    expect(quarters.end).toBe("2026-09-22T19:00:00.000Z");
  });

  it("refuses a malformed date or hour rather than shifting the window", () => {
    expect(buildWindow({ date: "22/09/2026", hour: 1, intervalMinutes: 60, intervals: 1 })).toBeNull();
    expect(buildWindow({ date: "2026-09-22", hour: 24, intervalMinutes: 60, intervals: 1 })).toBeNull();
    expect(buildWindow({ date: "2026-09-22", hour: 1, intervalMinutes: 0, intervals: 1 })).toBeNull();
    expect(buildWindow({ date: "2026-09-22", hour: 1, intervalMinutes: 60, intervals: 0 })).toBeNull();
  });
});

describe("product selection", () => {
  it("offers the catalog to single-leg instruments and nothing to the rest", () => {
    expect(selectableProducts(spot)).toContain("RTM_HOURLY");
    expect(selectableProducts(block)).toContain("DAM_HOURLY");
    // legless and path instruments settle in a market they do not choose
    expect(selectableProducts(virtual)).toEqual([]);
    expect(selectableProducts(ptpOption)).toEqual([]);
  });

  it("derives the product for instruments that have no series of their own", () => {
    expect(effectiveProduct(virtual, "RTM_15MIN")).toBe("DAM_HOURLY");
    expect(effectiveProduct(ptpOption, "RTM_15MIN")).toBe("DAM_HOURLY");
    expect(effectiveProduct(basis, "RTM_15MIN")).toBe("RTM_15MIN");
    expect(effectiveProduct(spot, "DAM_HOURLY")).toBe("DAM_HOURLY");
  });

  it("describes every tradable instrument's settlement", () => {
    for (const i of tradableInstruments()) {
      expect(ruleHint(i).length, i.code).toBeGreaterThan(0);
    }
  });
});

describe("price probing", () => {
  it("confirms a point that the series covers", () => {
    expect(probePrice(spot, win(18), 60, series, "RTM_HOURLY", "RTM_HOURLY")).toBe("priced");
  });

  it("reports a point past the end of the series as unpriced", () => {
    expect(probePrice(spot, win(18), 60, series, "RTM_HOURLY", "RTM_HOURLY")).toBe("priced");
    const later = buildWindow({
      date: "2026-09-24",
      hour: 4,
      intervalMinutes: 60,
      intervals: 1,
    })!;
    expect(probePrice(spot, later, 60, series, "RTM_HOURLY", "RTM_HOURLY")).toBe("unpriced");
  });

  it("will not claim to know a price it holds no series for", () => {
    // a two-leg spread needs leg B, which this screen never loads
    expect(probePrice(basis, win(18), 60, series, "RTM_HOURLY", "RTM_HOURLY")).toBe("unknown");
    // a derived product is priced off another market's series
    expect(probePrice(virtual, win(18), 60, series, "RTM_HOURLY", "DAM_HOURLY")).toBe("unknown");
    expect(probePrice(spot, win(18), 60, [], "RTM_HOURLY", "RTM_HOURLY")).toBe("unknown");
  });

  it("requires a whole window for an average instrument", () => {
    const covered = win(18, 6);
    expect(probePrice(block, covered, 60, series, "RTM_HOURLY", "RTM_HOURLY")).toBe("priced");

    // window runs past the end of the series: cannot be confirmed, not disproved
    expect(overhanging.end).toBe("2026-09-24T03:00:00.000Z");
    expect(probePrice(block, overhanging, 60, series, "RTM_HOURLY", "RTM_HOURLY")).toBe(
      "unknown"
    );

    // a hole inside the series is a known gap
    const holed = series.filter((p) => p.deliveryTimestamp !== at("2026-09-22T20"));
    expect(probePrice(block, win(18, 6), 60, holed, "RTM_HOURLY", "RTM_HOURLY")).toBe("unpriced");
  });
});

describe("price estimate", () => {
  it("uses the interval price for a point instrument", () => {
    const p = estimateInstrumentPrice(spot, win(18), 60, series, "RTM_HOURLY", "RTM_HOURLY")!;
    expect(p).toBe(28_000_000n); // $28 = 10 + 18
  });

  it("averages the window for a window instrument", () => {
    // hours 18..21 → 28,29,30,31 → 29.5
    const p = estimateInstrumentPrice(block, win(18, 4), 60, series, "RTM_HOURLY", "RTM_HOURLY")!;
    expect(p).toBe(29_500_000n);
  });

  it("refuses to guess a composed price", () => {
    expect(estimateInstrumentPrice(basis, win(18), 60, series, "RTM_HOURLY", "RTM_HOURLY")).toBeNull();
    expect(estimateInstrumentPrice(virtual, win(18), 60, series, "RTM_HOURLY", "DAM_HOURLY")).toBeNull();
    // a window reaching past the series is not a price either
    expect(
      estimateInstrumentPrice(block, overhanging, 60, series, "RTM_HOURLY", "RTM_HOURLY")
    ).toBeNull();
  });

  it("floors an option at zero rather than showing a negative fill", () => {
    const option = requireInstrument("PRICE_OPTION");
    const negative: SeriesPoint[] = [
      { deliveryTimestamp: win(18).start, price: "-30" },
    ];
    const p = estimateInstrumentPrice(
      option,
      win(18),
      60,
      negative,
      "RTM_HOURLY",
      "RTM_HOURLY"
    );
    // An option can only pay out; a negative leg means it is worth nothing.
    expect(p).toBe(0n);
  });
});

describe("order ticket validation", () => {
  it("accepts a plain point order", () => {
    expect(checkOrderForm(ticket())).toEqual({ ok: true });
  });

  it("requires a second point for a spread, and rejects one without", () => {
    expect(checkOrderForm(ticket({ instrument: basis })).ok).toBe(false);
    expect(
      checkOrderForm(ticket({ instrument: basis, counterMarketId: "m-b" })).ok
    ).toBe(true);
    expect(
      checkOrderForm(ticket({ instrument: basis, counterMarketId: "m-a" })).ok
    ).toBe(false);
    // a single-point instrument must not carry a stray second leg
    expect(checkOrderForm(ticket({ counterMarketId: "m-b" })).ok).toBe(false);
  });

  it("validates quantity against the same grammar and bound as the API", () => {
    expect(checkOrderForm(ticket({ quantity: "0" })).ok).toBe(false);
    expect(checkOrderForm(ticket({ quantity: "-5" })).ok).toBe(false);
    expect(checkOrderForm(ticket({ quantity: "1e3" })).ok).toBe(false);
    expect(checkOrderForm(ticket({ quantity: "0.1234567" })).ok).toBe(false);
    expect(checkOrderForm(ticket({ quantity: "0.123456" })).ok).toBe(true);
    expect(checkOrderForm(ticket({ quantity: String(MAX_QUANTITY) })).ok).toBe(true);
    expect(checkOrderForm(ticket({ quantity: String(MAX_QUANTITY + 1) })).ok).toBe(false);
  });

  it("refuses a settled interval and one beyond the traded horizon", () => {
    const settled = ticket({
      delivery: win(1),
      now: Date.parse("2026-09-22T02:00:00.000Z"),
    });
    expect(checkOrderForm(settled).ok).toBe(false);

    const tooFar = ticket({
      delivery: buildWindow({ date: "2026-11-05", hour: 0, intervalMinutes: 60, intervals: 1 })!,
    });
    expect(checkOrderForm(tooFar).ok).toBe(false);
  });

  it("blocks a delivery it knows has no price, and lets an unverifiable one through", () => {
    expect(checkOrderForm(ticket({ priceProbe: "unpriced" })).ok).toBe(false);
    // "unknown" is not a reason to refuse — the server is the authority
    expect(checkOrderForm(ticket({ priceProbe: "unknown" })).ok).toBe(true);
  });

  it("refuses a product that is not on the desk", () => {
    expect(checkOrderForm(ticket({ product: "NOT_A_PRODUCT" })).ok).toBe(false);
  });
});

describe("request assembly", () => {
  it("sends exactly what the route accepts", () => {
    const body = orderRequest({
      marketId: "m-a",
      instrumentCode: "BASIS_SPREAD",
      product: "RTM_HOURLY",
      counterMarketId: "m-b",
      side: "BUY",
      quantity: "12.5",
      delivery: win(18, 1),
      clientOrderId: "order-abc-123",
    });
    expect(body).toEqual({
      marketId: "m-a",
      instrument: "BASIS_SPREAD",
      product: "RTM_HOURLY",
      counterMarketId: "m-b",
      side: "BUY",
      quantityMwh: "12.5",
      deliveryStart: "2026-09-22T18:00:00.000Z",
      deliveryEnd: "2026-09-22T19:00:00.000Z",
      clientOrderId: "order-abc-123",
    });
  });

  it("carries the window as the delivery, since the window *is* the delivery", () => {
    const body = orderRequest({
      marketId: "m-a",
      instrumentCode: "BLOCK_FORWARD",
      product: "RTM_HOURLY",
      counterMarketId: null,
      side: "SELL",
      quantity: "24",
      delivery: win(18, DEFAULT_WINDOW_INTERVALS),
      clientOrderId: "order-def-456",
    });
    expect(body.deliveryStart).toBe("2026-09-22T18:00:00.000Z");
    expect(body.deliveryEnd).toBe("2026-09-23T18:00:00.000Z");
    expect(body.counterMarketId).toBeNull();
  });
});
