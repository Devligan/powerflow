import { describe, it, expect } from "vitest";
import {
  centralDate,
  centralDayStartUtc,
  centralLocalToUtc,
  centralTime,
  shortDate,
  utcToCentralLocal,
} from "@/lib/format";
import { operatingDayHours } from "@/lib/ercot/hour-ending";

describe("Central display", () => {
  it("shows CDT in summer and CST in winter", () => {
    expect(shortDate("2026-07-01T17:05:00Z")).toBe("2026-07-01 12:05 CDT");
    expect(shortDate("2026-12-01T18:05:00Z")).toBe("2026-12-01 12:05 CST");
  });
  it("names the Central date, not the UTC one", () => {
    // 03:00 UTC is still the previous evening in Texas.
    expect(centralDate("2026-07-02T03:00:00Z")).toBe("2026-07-01");
  });
  it("tells the fall-back day's two 1 AMs apart", () => {
    expect(centralTime("2026-11-01T06:30:00Z")).toBe("01:30 CDT");
    expect(centralTime("2026-11-01T07:30:00Z")).toBe("01:30 CST");
  });
  it("prints midnight as 00, never 24", () => {
    expect(centralTime("2026-12-01T06:00:00Z")).toBe("00:00 CST");
  });
});

describe("centralLocalToUtc", () => {
  it("reads a datetime-local value as Central wall time", () => {
    expect(centralLocalToUtc("2026-07-01T12:05")).toBe(Date.parse("2026-07-01T17:05:00Z"));
    expect(centralLocalToUtc("2026-12-01T12:05")).toBe(Date.parse("2026-12-01T18:05:00Z"));
  });
  it("resolves the repeated hour to its first occurrence", () => {
    expect(centralLocalToUtc("2026-11-01T01:30")).toBe(Date.parse("2026-11-01T06:30:00Z"));
  });
  it("refuses a time in the spring-forward gap", () => {
    expect(centralLocalToUtc("2026-03-08T02:30")).toBeNull();
  });
  it("round-trips", () => {
    const ms = Date.parse("2026-09-22T14:00:00Z");
    expect(centralLocalToUtc(utcToCentralLocal(ms))).toBe(ms);
  });
  it("finds the start of a Central day", () => {
    expect(centralDayStartUtc("2026-07-01")).toBe(Date.parse("2026-07-01T05:00:00Z"));
  });
});

describe("operatingDayHours", () => {
  it("has 24, 23 or 25 hours", () => {
    expect(operatingDayHours("2026-07-01")).toHaveLength(24);
    expect(operatingDayHours("2026-03-08")).toHaveLength(23);
    const fallBack = operatingDayHours("2026-11-01");
    expect(fallBack).toHaveLength(25);
    expect(fallBack.filter((h) => h.he === 2).map((h) => h.repeated)).toEqual([false, true]);
  });
  it("offers every ticket start as an option of its own operating day", () => {
    // The ticket's hour <select> is keyed by start instant within the
    // operating day of the current delivery; a start missing from that list
    // would leave the control blank. Sweep both DST weekends hour by hour.
    for (const from of ["2026-03-07T00:00:00Z", "2026-10-31T00:00:00Z"]) {
      for (let t = Date.parse(from); t < Date.parse(from) + 72 * 3_600_000; t += 3_600_000) {
        const day = centralDate(t);
        expect(operatingDayHours(day).map((h) => h.startMs), new Date(t).toISOString()).toContain(t);
      }
    }
  });
  it("starts HE1 at Central midnight", () => {
    expect(operatingDayHours("2026-07-01")[0]).toMatchObject({
      he: 1,
      startMs: Date.parse("2026-07-01T05:00:00Z"),
    });
  });
});
