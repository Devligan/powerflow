import { describe, expect, it } from "vitest";
import {
  bpsToPercent,
  signTone,
  instrumentInfo,
  legsLabel,
  positionUnit,
  sign,
  signedUsd,
  tradeSideLabel,
  usd,
  volumeUnitLabel,
} from "@/lib/format";
import { INSTRUMENTS, PRODUCTS } from "@/lib/ercot/types";
import { windowLabel } from "@/lib/time";

const centralWindowLabel = (start: number, end: number) => windowLabel(start, end, "America/Chicago");

describe("centralWindowLabel", () => {
  it("names a UTC hour in Central terms, with the hour ending", () => {
    expect(
      centralWindowLabel(Date.parse("2026-10-31T22:00:00Z"), Date.parse("2026-10-31T23:00:00Z"))
    ).toBe("Sat, Oct 31 · 5:00 PM – 6:00 PM CDT · HE18");
  });

  it("calls the midnight hour HE24", () => {
    expect(
      centralWindowLabel(Date.parse("2026-11-01T04:00:00Z"), Date.parse("2026-11-01T05:00:00Z"))
    ).toBe("Sat, Oct 31 · 11:00 PM – 12:00 AM CDT · HE24");
  });

  it("uses the offset in effect on the delivery date", () => {
    // After the 2026-11-01 fall-back, Central is UTC−6.
    expect(
      centralWindowLabel(Date.parse("2026-11-02T00:00:00Z"), Date.parse("2026-11-02T01:00:00Z"))
    ).toBe("Sun, Nov 1 · 6:00 PM – 7:00 PM CST · HE19");
  });

  it("numbers the fall-back hours as ERCOT does: HE2 twice, the second repeated", () => {
    expect(
      centralWindowLabel(Date.parse("2026-11-01T05:00:00Z"), Date.parse("2026-11-01T06:00:00Z"))
    ).toBe("Sun, Nov 1 · 12:00 AM – 1:00 AM CDT · HE1");
    expect(
      centralWindowLabel(Date.parse("2026-11-01T06:00:00Z"), Date.parse("2026-11-01T07:00:00Z"))
    ).toBe("Sun, Nov 1 · 1:00 AM CDT – 1:00 AM CST · HE2");
    expect(
      centralWindowLabel(Date.parse("2026-11-01T07:00:00Z"), Date.parse("2026-11-01T08:00:00Z"))
    ).toBe("Sun, Nov 1 · 1:00 AM – 2:00 AM CST · HE2 (repeated)");
    expect(
      centralWindowLabel(Date.parse("2026-11-01T08:00:00Z"), Date.parse("2026-11-01T09:00:00Z"))
    ).toBe("Sun, Nov 1 · 2:00 AM – 3:00 AM CST · HE3");
  });

  it("names the end day of a multi-hour window that crosses midnight", () => {
    // Around-the-clock on the fall-back day: 25 hours, CDT into CST.
    expect(
      centralWindowLabel(Date.parse("2026-11-01T05:00:00Z"), Date.parse("2026-11-02T06:00:00Z"))
    ).toBe("Sun, Nov 1 · 12:00 AM CDT – Mon, Nov 2 12:00 AM CST");
    // On-peak stays inside the day.
    expect(
      centralWindowLabel(Date.parse("2026-11-02T12:00:00Z"), Date.parse("2026-11-03T04:00:00Z"))
    ).toBe("Mon, Nov 2 · 6:00 AM – 10:00 PM CST");
  });

  it("skips HE3 on the spring-forward day", () => {
    expect(
      centralWindowLabel(Date.parse("2027-03-14T07:00:00Z"), Date.parse("2027-03-14T08:00:00Z"))
    ).toBe("Sun, Mar 14 · 1:00 AM CST – 3:00 AM CDT · HE2");
    expect(
      centralWindowLabel(Date.parse("2027-03-14T08:00:00Z"), Date.parse("2027-03-14T09:00:00Z"))
    ).toBe("Sun, Mar 14 · 3:00 AM – 4:00 AM CDT · HE4");
  });
});

describe("signedUsd", () => {
  it("puts the sign ahead of the currency symbol", () => {
    expect(signedUsd("-6.01")).toBe("−$6.01");
    expect(signedUsd("1234.5")).toBe("+$1,234.50");
    expect(signedUsd("0")).toBe("$0.00");
  });
});

describe("money as a desk quotes it", () => {
  it("shows $/MWh to the cent, rounded rather than cut", () => {
    expect(usd("9.2")).toBe("$9.20");
    expect(usd("100000")).toBe("$100,000.00");
    expect(usd("-15.67")).toBe("−$15.67");
    // 134.925 is +134.93 on a desk, not +134.92.
    expect(sign("134.925")).toBe("+134.93");
    expect(sign("-134.925")).toBe("−134.93");
    // Something that rounds to nothing is not a loss.
    expect(usd("-0.004")).toBe("$0.00");
    expect(sign("-0.004")).toBe("0.00");
  });

  it("writes a loss with one minus sign", () => {
    // The blotter and analytics used to print --39.3.
    expect(sign("-39.3")).toBe("−39.30");
    expect(sign(-350_450_000n)).toBe("−350.45");
    expect(sign("0")).toBe("0.00");
  });

  it("signs a percent once", () => {
    expect(bpsToPercent(159)).toBe("+1.59%");
    expect(bpsToPercent(-920)).toBe("−9.20%");
    expect(bpsToPercent(0)).toBe("0.00%");
  });

  it("leaves zero uncoloured: a flat book is not a win", () => {
    expect(signTone("12.5")).toBe("pos");
    expect(signTone("-0.01")).toBe("neg");
    expect(signTone("0")).toBeUndefined();
    // Shown as $0.00, so not coloured either way.
    expect(signTone("0.004")).toBeUndefined();
    expect(signTone("-0.004")).toBeUndefined();
    expect(signTone(0n)).toBeUndefined();
    expect(signTone(-3n)).toBe("neg");
    expect(signTone(0)).toBeUndefined();
    expect(signTone("nonsense")).toBeUndefined();
  });

  it("takes the sign from the rounded figure", () => {
    // get_leaderboard's return is unrounded numeric, sent as a string.
    expect(bpsToPercent("-0.3")).toBe("0.00%");
    expect(bpsToPercent("0.4")).toBe("0.00%");
    expect(bpsToPercent("122.2154321")).toBe("+1.22%");
    expect(bpsToPercent("-0.6")).toBe("−0.01%");
  });
});

describe("tradeSideLabel", () => {
  it("speaks the desk's language", () => {
    expect(tradeSideLabel("VIRTUAL", "BUY")).toBe("DEC");
    expect(tradeSideLabel("VIRTUAL", "SELL")).toBe("INC");
    expect(tradeSideLabel("PTP_OBLIGATION", "BUY")).toBe("BUY PATH");
    // The close at delivery is not a new INC.
    expect(tradeSideLabel("VIRTUAL", "SELL", "SETTLED")).toBe("SETTLE");
    expect(tradeSideLabel("ENERGY_SPOT", "BUY")).toBe("BUY");
  });
});

describe("instrument display", () => {
  it("describes every catalogued instrument", () => {
    // A code the catalog adds must be displayable, otherwise a position in it
    // renders as a raw code with no settlement rule next to it.
    for (const def of INSTRUMENTS) {
      const info = instrumentInfo(def.code);
      expect(info, `no display for ${def.code}`).not.toBeNull();
      expect(info!.shortLabel.length).toBeGreaterThan(0);
      expect(info!.ruleLabel.length).toBeGreaterThan(0);
      expect(info!.rule).toBe(def.settlementRule);
      expect(info!.tone).toMatch(/^badge-/);
      expect(info!.legs).toBe(def.legs);
    }
  });

  it("names the settlement rule the price was reduced by", () => {
    expect(instrumentInfo("ENERGY_SPOT")!.ruleLabel).toBe("Point");
    expect(instrumentInfo("BASIS_SPREAD")!.ruleLabel).toBe("Spread");
    expect(instrumentInfo("VIRTUAL")!.ruleLabel).toBe("Convergence");
    expect(instrumentInfo("BLOCK_FORWARD")!.ruleLabel).toBe("Window avg");
  });

  it("marks an option where the rule can apply optionality", () => {
    // An option floors at zero; an obligation pays both ways.
    expect(instrumentInfo("CRR_OPTION")!.ruleLabel).toBe("Spread · option");
    expect(instrumentInfo("CRR_OBLIGATION")!.ruleLabel).toBe("Spread");
    // The suffix belongs only to rules that actually apply optionality.
    expect(instrumentInfo("ENERGY_SPOT")!.ruleLabel).not.toContain("option");
  });

  it("distinguishes the day-ahead PTP instruments from the auctioned CRRs", () => {
    // Same path, different settlement — a day-ahead PTP instrument is bought on
    // the day-ahead spread and settled on the real-time one, while a CRR
    // settles on the day-ahead spread alone. They must not read the same.
    expect(instrumentInfo("PTP_OPTION")!.ruleLabel).toBe(
      "DA→RT congestion · option"
    );
    expect(instrumentInfo("PTP_OBLIGATION")!.ruleLabel).toBe("DA→RT congestion");
    expect(instrumentInfo("PTP_OBLIGATION")!.rule).toBe("CONGESTION_CONVERGENCE");
    expect(instrumentInfo("CRR_OBLIGATION")!.rule).toBe("DIFFERENCE");
  });

  it("returns null rather than inventing a description", () => {
    expect(instrumentInfo("NOT_AN_INSTRUMENT")).toBeNull();
    expect(instrumentInfo(null)).toBeNull();
    expect(instrumentInfo(undefined)).toBeNull();
  });

  it("reports leg counts so a single leg is never rendered as a spread", () => {
    expect(instrumentInfo("VIRTUAL")!.legs).toBe(0);
    expect(instrumentInfo("ENERGY_SPOT")!.legs).toBe(1);
    expect(instrumentInfo("PTP_OBLIGATION")!.legs).toBe(2);
  });
});

describe("volume units", () => {
  it("labels the unit a quantity is held in", () => {
    expect(volumeUnitLabel("MWH")).toBe("MWh");
    expect(volumeUnitLabel("MW")).toBe("MW");
  });

  it("labels an unknown unit as unclassified rather than as energy", () => {
    expect(volumeUnitLabel("UNKNOWN")).toBe("unclassified");
    expect(volumeUnitLabel(null)).toBe("unclassified");
    expect(volumeUnitLabel(undefined)).toBe("unclassified");
  });

  it("resolves a position's unit from its product", () => {
    expect(positionUnit("RTM_HOURLY")).toBe("MWH");
    expect(positionUnit("DAM_HOURLY")).toBe("MWH");
    // Ancillary services clear as capacity, not energy.
    expect(positionUnit("REGUP")).toBe("MW");
    expect(positionUnit("NOT_A_PRODUCT")).toBe("UNKNOWN");
  });

  it("agrees with the catalog for every product", () => {
    for (const p of PRODUCTS) {
      expect(positionUnit(p.code), `unit for ${p.code}`).toBe(p.pricedPer);
    }
  });
});

describe("legsLabel", () => {
  it("renders a path when a second leg exists", () => {
    expect(legsLabel("HB_NORTH", "HB_SOUTH")).toBe("HB_NORTH → HB_SOUTH");
  });

  it("renders a single point when it does not", () => {
    expect(legsLabel("HB_NORTH", null)).toBe("HB_NORTH");
    expect(legsLabel("HB_NORTH", undefined)).toBe("HB_NORTH");
  });

  it("renders a placeholder for a missing leg A", () => {
    expect(legsLabel(null, "HB_SOUTH")).toBe("—");
  });
});
