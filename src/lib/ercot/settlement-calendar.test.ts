import { describe, expect, it } from "vitest";
import {
  businessDayAfter,
  ercotHolidays,
  isErcotBusinessDay,
  positionFinalAt,
  priceFinalAt,
} from "@/lib/ercot/settlement-calendar";

const iso = (ms: number) => new Date(ms).toISOString();

describe("ERCOT Business Days", () => {
  it("observes the holidays ERCOT has published", () => {
    // Settlements notice M-D121925-01 and ERCOT's 2026 calendar.
    for (const day of [
      "2025-12-25",
      "2025-12-26",
      "2026-01-01",
      "2026-01-19", // MLK
      "2026-05-25",
      "2026-07-03", // the 4th is a Saturday
      "2026-09-07",
      "2026-11-26",
      "2026-11-27",
      "2026-12-24",
      "2026-12-25",
      "2027-01-01",
      "2027-01-18",
      "2021-12-24", // Christmas on a Saturday: the Friday and the Monday
      "2021-12-27",
    ]) {
      expect(isErcotBusinessDay(day), day).toBe(false);
    }
  });

  it("keeps the federal holidays ERCOT does not observe", () => {
    expect(isErcotBusinessDay("2026-02-16")).toBe(true); // Presidents' Day
    expect(isErcotBusinessDay("2026-06-19")).toBe(true); // Juneteenth
    expect(isErcotBusinessDay("2026-10-12")).toBe(true); // Columbus Day
    expect(isErcotBusinessDay("2026-11-11")).toBe(true); // Veterans Day
    // MLK Day joined the calendar in 2020 (NPRR943).
    expect(isErcotBusinessDay("2019-01-21")).toBe(true);
  });

  it("moves a Saturday New Year's Day into the year before", () => {
    expect(ercotHolidays(2021).map((h) => h.day)).toContain("2021-12-31");
    expect(ercotHolidays(2022).map((h) => h.day)).not.toContain("2022-01-01");
    expect(isErcotBusinessDay("2021-12-31")).toBe(false);
  });

  it("skips weekends and holidays when counting forward", () => {
    expect(businessDayAfter("2026-11-06", 2)).toBe("2026-11-10"); // Fri → Tue
    expect(businessDayAfter("2026-11-25", 2)).toBe("2026-12-01"); // Thanksgiving
    expect(businessDayAfter("2026-12-23", 2)).toBe("2026-12-29"); // Christmas
    expect(businessDayAfter("2025-12-24", 2)).toBe("2025-12-30");
  });
});

describe("when ERCOT's prices are final", () => {
  it("matches the PriceCorrectionTime ERCOT printed on a real correction", () => {
    // NP4-197, posted 2026-09-01 15:20: Operating Day 08/30 corrected with a
    // PriceCorrectionTime of 09/01/2026 16:00 (Central, daylight time).
    const he10 = Date.parse("2026-08-30T14:00:00Z");
    expect(iso(priceFinalAt("RTM_HOURLY", he10))).toBe("2026-09-01T21:00:00.000Z");
    expect(iso(priceFinalAt("RTM_15MIN", he10))).toBe("2026-09-01T21:00:00.000Z");
    // The day-ahead prices of that day are final at 10:00 the same day.
    expect(iso(priceFinalAt("DAM_HOURLY", he10))).toBe("2026-09-01T15:00:00.000Z");
  });

  it("puts HE24 in the day it starts in", () => {
    // Fri Nov 6, 23:00 CST is HE24 of Friday; an hour later is Saturday.
    expect(iso(priceFinalAt("RTM_HOURLY", Date.parse("2026-11-07T05:00:00Z")))).toBe(
      "2026-11-10T22:00:00.000Z"
    );
    expect(iso(priceFinalAt("RTM_HOURLY", Date.parse("2026-11-07T06:00:00Z")))).toBe(
      "2026-11-10T22:00:00.000Z"
    );
    expect(iso(priceFinalAt("RTM_HOURLY", Date.parse("2026-11-06T05:30:00Z")))).toBe(
      "2026-11-09T22:00:00.000Z" // Thursday's HE24: Monday
    );
  });

  it("reads 16:00 on the offset in force that day", () => {
    // Operating Day Fri 2026-10-30 (daylight time); final Tue Nov 3 (standard).
    expect(iso(priceFinalAt("RTM_HOURLY", Date.parse("2026-10-30T17:00:00Z")))).toBe(
      "2026-11-03T22:00:00.000Z"
    );
  });

  it("settles a virtual on real-time finality, whatever product it was bid in", () => {
    const end = Date.parse("2026-08-30T15:00:00Z");
    expect(iso(positionFinalAt("CONVERGENCE", "DAM_HOURLY", end))).toBe(
      "2026-09-01T21:00:00.000Z"
    );
    expect(iso(positionFinalAt("CONGESTION_CONVERGENCE", "DAM_HOURLY", end))).toBe(
      "2026-09-01T21:00:00.000Z"
    );
    expect(iso(positionFinalAt("POINT", "DAM_HOURLY", end))).toBe("2026-09-01T15:00:00.000Z");
  });

  it("takes a position ending at midnight from the day it delivered in", () => {
    // HE24 of Sunday 2026-08-30 ends at 00:00 Monday.
    expect(iso(positionFinalAt("CONVERGENCE", "DAM_HOURLY", Date.parse("2026-08-31T05:00:00Z")))).toBe(
      "2026-09-01T21:00:00.000Z"
    );
  });
});
