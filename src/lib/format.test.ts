import { describe, expect, it } from "vitest";
import {
  instrumentInfo,
  legsLabel,
  positionUnit,
  signedUsd,
  volumeUnitLabel,
} from "@/lib/format";
import { INSTRUMENTS, PRODUCTS } from "@/lib/ercot/types";

describe("signedUsd", () => {
  it("puts the sign ahead of the currency symbol", () => {
    expect(signedUsd("-6.01")).toBe("−$6.01");
    expect(signedUsd("1234.5")).toBe("+$1,234.5");
    expect(signedUsd("0")).toBe("$0");
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
