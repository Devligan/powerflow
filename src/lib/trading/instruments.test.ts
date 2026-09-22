import { describe, expect, it } from "vitest";
import {
  CONVERGENCE_PRODUCTS,
  PATH_SETTLEMENT_PRODUCT,
  averagePrice,
  instrumentPrice,
  needsBothMarkets,
  needsCounterPoint,
  resolveTradedProduct,
  settlesSingleInterval,
} from "@/lib/trading/instruments";
import { getInstrument } from "@/lib/ercot/types";
import { format, parseDec } from "@/lib/money";

const d = (v: string) => parseDec(v);
const p = (v: bigint | null) => (v == null ? null : format(v, 6));

describe("instrument price rules", () => {
  it("POINT is the leg's own price", () => {
    expect(p(instrumentPrice({ rule: "POINT", optionType: "NONE", legAPrice: d("42.5") }))).toBe("42.5");
    expect(instrumentPrice({ rule: "POINT", optionType: "NONE", legAPrice: null })).toBeNull();
  });

  it("DIFFERENCE is sink minus source so a long profits on A-to-B congestion", () => {
    const price = instrumentPrice({
      rule: "DIFFERENCE",
      optionType: "OBLIGATION",
      legAPrice: d("30"), // source
      legBPrice: d("35"), // sink
    });
    expect(p(price)).toBe("5");

    // Congestion the other way is a loss for a long obligation, not a floor.
    const reversed = instrumentPrice({
      rule: "DIFFERENCE",
      optionType: "OBLIGATION",
      legAPrice: d("35"),
      legBPrice: d("30"),
    });
    expect(p(reversed)).toBe("-5");
  });

  it("CONGESTION_CONVERGENCE nets the real-time spread against the day-ahead spread", () => {
    // A day-ahead PTP instrument is bought at the day-ahead congestion across
    // the path and settled at the real-time congestion across the same path, so
    // the position carries the convergence of the two. Source 30/35, sink 50/40.
    const price = instrumentPrice({
      rule: "CONGESTION_CONVERGENCE",
      optionType: "OBLIGATION",
      legAPrice: d("30"), // real-time source
      legBPrice: d("50"), // real-time sink
      dayAheadLegAPrice: d("35"), // day-ahead source
      dayAheadLegBPrice: d("40"), // day-ahead sink
    });
    // (50 − 30) − (40 − 35) = 20 − 5
    expect(p(price)).toBe("15");
  });

  it("keeps a path convergence distinct from the auctioned CRR spread", () => {
    // DIFFERENCE is the CRR, which settles on the day-ahead spread alone and
    // needs no real-time prices at all. On the same path the two rules must
    // disagree — if they agreed, the day-ahead instrument would be a CRR with
    // a different label.
    const daSource = d("35");
    const daSink = d("40");
    expect(
      p(
        instrumentPrice({
          rule: "DIFFERENCE",
          optionType: "OBLIGATION",
          legAPrice: daSource,
          legBPrice: daSink,
        })
      )
    ).toBe("5");
    expect(
      p(
        instrumentPrice({
          rule: "CONGESTION_CONVERGENCE",
          optionType: "OBLIGATION",
          legAPrice: d("30"),
          legBPrice: d("50"),
          dayAheadLegAPrice: daSource,
          dayAheadLegBPrice: daSink,
        })
      )
    ).toBe("15");
  });

  it("will not price a path convergence with any leg missing", () => {
    // Both dimensions are needed, so a missing real-time or day-ahead leg means
    // the instrument is unpriced and the order is refused rather than filled
    // off half the picture.
    const full = {
      rule: "CONGESTION_CONVERGENCE" as const,
      optionType: "OBLIGATION" as const,
      legAPrice: d("30"),
      legBPrice: d("50"),
      dayAheadLegAPrice: d("35"),
      dayAheadLegBPrice: d("40"),
    };
    expect(instrumentPrice(full)).not.toBeNull();
    for (const drop of [
      "legAPrice",
      "legBPrice",
      "dayAheadLegAPrice",
      "dayAheadLegBPrice",
    ] as const) {
      expect(instrumentPrice({ ...full, [drop]: null }), drop).toBeNull();
    }
  });

  it("floors a path convergence at zero for an option but not an obligation", () => {
    // Real-time congestion collapses below the day-ahead spread the position
    // was bought at: (40 − 40) − (40 − 35) = −5.
    const losing = {
      rule: "CONGESTION_CONVERGENCE" as const,
      legAPrice: d("40"),
      legBPrice: d("40"),
      dayAheadLegAPrice: d("35"),
      dayAheadLegBPrice: d("40"),
    };
    expect(p(instrumentPrice({ ...losing, optionType: "OBLIGATION" }))).toBe("-5");
    expect(p(instrumentPrice({ ...losing, optionType: "OPTION" }))).toBe("0");
  });

  it("derives the traded product for path and legless instruments only", () => {
    // A single-leg instrument prices the series the caller names…
    expect(
      resolveTradedProduct(getInstrument("ENERGY_SPOT")!, "RTM_15MIN")
    ).toBe("RTM_15MIN");
    expect(
      resolveTradedProduct(getInstrument("BLOCK_FORWARD")!, "RTM_HOURLY")
    ).toBe("RTM_HOURLY");

    // …while a legless or path instrument gets the market it clears in, so the
    // position identity cannot depend on a parameter that does not price it.
    expect(resolveTradedProduct(getInstrument("VIRTUAL")!, "RTM_15MIN")).toBe(
      PATH_SETTLEMENT_PRODUCT
    );
    expect(resolveTradedProduct(getInstrument("VIRTUAL")!, "RTM_15MIN")).toBe(
      resolveTradedProduct(getInstrument("VIRTUAL")!, "DAM_HOURLY")
    );
    expect(
      resolveTradedProduct(getInstrument("PTP_OBLIGATION")!, "RTM_HOURLY")
    ).toBe(PATH_SETTLEMENT_PRODUCT);
  });

  it("DIFFERENCE needs both legs", () => {
    expect(
      instrumentPrice({ rule: "DIFFERENCE", optionType: "OBLIGATION", legAPrice: d("30") })
    ).toBeNull();
    expect(
      instrumentPrice({ rule: "DIFFERENCE", optionType: "OBLIGATION", legAPrice: d("30"), legBPrice: null })
    ).toBeNull();
  });

  it("CONVERGENCE is real-time minus day-ahead", () => {
    expect(
      p(
        instrumentPrice({
          rule: "CONVERGENCE",
          optionType: "NONE",
          legAPrice: null,
          dayAheadPrice: d("40"),
          realTimePrice: d("47.25"),
        })
      )
    ).toBe("7.25");

    // Real-time settling below day-ahead is a loss for a long.
    expect(
      p(
        instrumentPrice({
          rule: "CONVERGENCE",
          optionType: "NONE",
          legAPrice: null,
          dayAheadPrice: d("40"),
          realTimePrice: d("31"),
        })
      )
    ).toBe("-9");
  });

  it("CONVERGENCE needs both markets", () => {
    expect(
      instrumentPrice({
        rule: "CONVERGENCE",
        optionType: "NONE",
        legAPrice: null,
        dayAheadPrice: d("40"),
      })
    ).toBeNull();
  });

  it("floors an OPTION at zero but lets an OBLIGATION go negative", () => {
    const common = {
      rule: "DIFFERENCE" as const,
      legAPrice: d("35"),
      legBPrice: d("30"),
    };
    expect(p(instrumentPrice({ ...common, optionType: "OPTION" }))).toBe("0");
    expect(p(instrumentPrice({ ...common, optionType: "OBLIGATION" }))).toBe("-5");

    // A profitable option still pays out in full.
    const profitable = { rule: "DIFFERENCE" as const, legAPrice: d("30"), legBPrice: d("35") };
    expect(p(instrumentPrice({ ...profitable, optionType: "OPTION" }))).toBe("5");
  });

  it("floors a zero-value option at exactly zero, not negative zero", () => {
    const price = instrumentPrice({
      rule: "DIFFERENCE",
      optionType: "OPTION",
      legAPrice: d("30"),
      legBPrice: d("30"),
    });
    expect(price).toBe(0n);
  });
});

describe("averagePrice", () => {
  it("averages the prices that exist over a settlement window", () => {
    expect(p(averagePrice([d("10"), d("20"), d("30")]))).toBe("20");
  });

  it("ignores intervals with no price rather than treating them as zero", () => {
    expect(p(averagePrice([d("10"), null, d("30")]))).toBe("20");
  });

  it("returns null for a window with no prices at all", () => {
    expect(averagePrice([])).toBeNull();
    expect(averagePrice([null, null])).toBeNull();
  });

  it("averages negative prices correctly", () => {
    expect(p(averagePrice([d("-251"), d("0")]))).toBe("-125.5");
  });
});

describe("rule shape helpers", () => {
  it("distinguishes interval instruments from window instruments", () => {
    expect(settlesSingleInterval("POINT")).toBe(true);
    expect(settlesSingleInterval("CONVERGENCE")).toBe(true);
    expect(settlesSingleInterval("DIFFERENCE")).toBe(true);
    expect(settlesSingleInterval("CONGESTION_CONVERGENCE")).toBe(true);
    expect(settlesSingleInterval("AVERAGE")).toBe(false);
  });

  it("flags which rules need a second point or a second market", () => {
    expect(needsCounterPoint("DIFFERENCE")).toBe(true);
    expect(needsCounterPoint("CONGESTION_CONVERGENCE")).toBe(true);
    expect(needsCounterPoint("POINT")).toBe(false);
    expect(needsBothMarkets("CONVERGENCE")).toBe(true);
    expect(needsBothMarkets("CONGESTION_CONVERGENCE")).toBe(true);
    // A path convergence needs *both* a second point and both markets, which is
    // why the two predicates stay separate rather than one implying the other.
    expect(needsBothMarkets("DIFFERENCE")).toBe(false);
  });

  it("pins the day-ahead / real-time product pair", () => {
    expect(CONVERGENCE_PRODUCTS.dayAhead).toBe("DAM_HOURLY");
    expect(CONVERGENCE_PRODUCTS.realTime).toBe("RTM_HOURLY");
  });
});
