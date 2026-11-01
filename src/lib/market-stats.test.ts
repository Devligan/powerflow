import { describe, expect, it } from "vitest";
import { centralHourEnding } from "@/lib/ercot/hour-ending";
import { dartByHour, priceHeatmap, quantile, type HourlyPrice } from "@/lib/market-stats";

const at = (iso: string) => Date.parse(iso);

describe("centralHourEnding", () => {
  it("numbers an hour by the Central hour it starts in", () => {
    // 22:00Z on Oct 31 is 5 PM CDT → HE18.
    expect(centralHourEnding(at("2026-10-31T22:00:00Z"))).toEqual({ day: "2026-10-31", he: 18, repeated: false });
  });

  it("keeps HE24 on the operating day it starts in", () => {
    // 04:00Z Nov 1 is 11 PM CDT on Oct 31.
    expect(centralHourEnding(at("2026-11-01T04:00:00Z"))).toEqual({ day: "2026-10-31", he: 24, repeated: false });
  });

  it("marks the second HE2 of the fall-back day as repeated", () => {
    expect(centralHourEnding(at("2026-11-01T06:00:00Z"))).toEqual({ day: "2026-11-01", he: 2, repeated: false });
    expect(centralHourEnding(at("2026-11-01T07:00:00Z"))).toEqual({ day: "2026-11-01", he: 2, repeated: true });
  });

  it("never produces HE3 on the spring-forward day", () => {
    expect(centralHourEnding(at("2027-03-14T07:00:00Z")).he).toBe(2);
    expect(centralHourEnding(at("2027-03-14T08:00:00Z")).he).toBe(4);
  });
});

describe("quantile", () => {
  it("interpolates between ranks", () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], 0.1)).toBeCloseTo(1.4);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("dartByHour", () => {
  it("averages RT − DA per hour ending, over hours that have both", () => {
    // HE18 on two days: DART +10 and −4; a third RT hour has no DA and is ignored.
    const da: HourlyPrice[] = [
      { t: at("2026-10-30T22:00:00Z"), price: 30 },
      { t: at("2026-10-31T22:00:00Z"), price: 40 },
    ];
    const rt: HourlyPrice[] = [
      { t: at("2026-10-30T22:00:00Z"), price: 40 },
      { t: at("2026-10-31T22:00:00Z"), price: 36 },
      { t: at("2026-10-29T22:00:00Z"), price: 99 },
    ];
    const he18 = dartByHour(da, rt)[17];
    expect(he18.he).toBe(18);
    expect(he18.n).toBe(2);
    expect(he18.mean).toBeCloseTo(3);
    expect(he18.pctRtAbove).toBe(0.5);
    expect(he18.stdev).toBeCloseTo(Math.sqrt(98));
    expect(dartByHour(da, rt)[0]).toMatchObject({ he: 1, n: 0, mean: null });
  });

  it("always returns 24 hours", () => {
    expect(dartByHour([], [])).toHaveLength(24);
  });
});

describe("priceHeatmap", () => {
  it("lays prices out as operating day × hour ending, newest day first", () => {
    const rows = priceHeatmap([
      { t: at("2026-10-30T22:00:00Z"), price: 30 }, // Oct 30 HE18
      { t: at("2026-10-31T11:00:00Z"), price: 20 }, // Oct 31 HE7 (peak)
      { t: at("2026-10-31T10:00:00Z"), price: 10 }, // Oct 31 HE6 (off-peak)
    ]);
    expect(rows.map((r) => r.day)).toEqual(["2026-10-31", "2026-10-30"]);
    expect(rows[0].cells[5]).toBe(10);
    expect(rows[0].cells[6]).toBe(20);
    expect(rows[0].atc).toBe(15);
    expect(rows[0].peak).toBe(20);
    expect(rows[1].cells[17]).toBe(30);
  });

  it("averages the repeated fall-back hour into HE2 but counts both hours", () => {
    const [row] = priceHeatmap([
      { t: at("2026-11-01T06:00:00Z"), price: 10 },
      { t: at("2026-11-01T07:00:00Z"), price: 20 },
    ]);
    expect(row.cells[1]).toBe(15);
    expect(row.hours).toBe(2);
  });
});
