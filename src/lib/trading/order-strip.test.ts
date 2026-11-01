import { describe, expect, it } from "vitest";
import {
  MAX_STRIP_HOURS,
  blockWindow,
  buildWindow,
  stripClientOrderId,
  stripWindows,
} from "@/lib/trading/order-form";
import { hourEndingStartUtc } from "@/lib/ercot/hour-ending";

describe("stripWindows", () => {
  const first = buildWindow({ date: "2026-11-02", hour: 19, intervalMinutes: 60, intervals: 1 })!;

  it("repeats one interval over consecutive hours", () => {
    const legs = stripWindows(first, 3, 60);
    expect(legs.map((w) => w.start)).toEqual([
      "2026-11-02T19:00:00.000Z",
      "2026-11-02T20:00:00.000Z",
      "2026-11-02T21:00:00.000Z",
    ]);
    expect(legs.every((w) => w.endMs - w.startMs === 3_600_000)).toBe(true);
  });

  it("treats a bad count as one leg and caps a long one", () => {
    expect(stripWindows(first, 0, 60)).toHaveLength(1);
    expect(stripWindows(first, Number.NaN, 60)).toHaveLength(1);
    expect(stripWindows(first, 99, 60)).toHaveLength(MAX_STRIP_HOURS);
  });
});

describe("stripClientOrderId", () => {
  it("keeps leg 0 on the ticket's own id and suffixes the rest", () => {
    expect(stripClientOrderId("abc12345", 0)).toBe("abc12345");
    expect(stripClientOrderId("abc12345", 2)).toBe("abc12345~2");
  });
});

describe("hourEndingStartUtc", () => {
  it("inverts the hour-ending convention", () => {
    // Nov 2 is CST (UTC−6): HE14 starts 13:00 CST = 19:00Z.
    expect(new Date(hourEndingStartUtc("2026-11-02", 14)!).toISOString()).toBe("2026-11-02T19:00:00.000Z");
    // Oct 31 is CDT (UTC−5): HE1 starts 00:00 CDT = 05:00Z.
    expect(new Date(hourEndingStartUtc("2026-10-31", 1)!).toISOString()).toBe("2026-10-31T05:00:00.000Z");
  });

  it("picks the first HE2 on fall-back and has no HE3 in spring", () => {
    expect(new Date(hourEndingStartUtc("2026-11-01", 2)!).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(hourEndingStartUtc("2027-03-14", 3)).toBeNull();
  });
});

describe("blockWindow", () => {
  it("places on-peak at HE7–HE22: 16 hours from 06:00 Central", () => {
    expect(blockWindow("2026-11-02", "PEAK")).toEqual({ date: "2026-11-02", hour: 12, intervals: 16 });
    expect(blockWindow("2026-10-30", "PEAK")).toEqual({ date: "2026-10-30", hour: 11, intervals: 16 });
  });

  it("spans the operating day for ATC, 25 hours on fall-back and 23 in spring", () => {
    expect(blockWindow("2026-11-02", "ATC")).toEqual({ date: "2026-11-02", hour: 6, intervals: 24 });
    expect(blockWindow("2026-11-01", "ATC")).toEqual({ date: "2026-11-01", hour: 5, intervals: 25 });
    expect(blockWindow("2027-03-14", "ATC")).toEqual({ date: "2027-03-14", hour: 6, intervals: 23 });
  });

  it("refuses a malformed day", () => {
    expect(blockWindow("11/02/2026", "PEAK")).toBeNull();
  });
});
