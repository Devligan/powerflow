import { describe, expect, it } from "vitest";
import { damDeadlineUtc } from "@/lib/ercot/hour-ending";
import { practiceDays, practiceSchedule, reachedStep } from "@/lib/practice";

const iso = (ms: number) => new Date(ms).toISOString();

describe("practice day schedule", () => {
  it("walks an ordinary CST day in ERCOT's order", () => {
    // Thursday 2026-11-05 (CST, UTC-6).
    const s = practiceSchedule("2026-11-05")!;
    expect(iso(s.at.bid)).toBe("2026-11-04T14:00:00.000Z"); // 08:00 Central, day before
    expect(iso(s.at.clearing)).toBe("2026-11-04T20:00:00.000Z"); // 14:00 Central, day before
    expect(iso(s.deliveryStart)).toBe("2026-11-05T06:00:00.000Z");
    expect(iso(s.deliveryEnd)).toBe("2026-11-06T06:00:00.000Z");
    expect(iso(s.at.delivery)).toBe("2026-11-06T06:05:00.000Z");
    // Final: 16:00 Central on the second Business Day after — Monday 11-09.
    expect(iso(s.at.settle)).toBe("2026-11-09T22:01:00.000Z");
  });

  it("opens bidding before the day-ahead deadline, and clears after it", () => {
    const s = practiceSchedule("2026-11-05")!;
    const deadline = damDeadlineUtc(s.deliveryStart)!;
    expect(s.at.bid).toBeLessThan(deadline);
    expect(s.at.clearing).toBeGreaterThan(deadline);
  });

  it("covers the 25-hour fall-back day and the 23-hour spring-forward day", () => {
    const fall = practiceSchedule("2026-11-01")!;
    expect((fall.deliveryEnd - fall.deliveryStart) / 3_600_000).toBe(25);
    const spring = practiceSchedule("2026-03-08")!;
    expect((spring.deliveryEnd - spring.deliveryStart) / 3_600_000).toBe(23);
  });

  it("offers only days whose settlement is already in the past, newest first", () => {
    // Tuesday 2026-11-10, 20:00 UTC (14:00 Central): 11-06 (Fri) is final
    // Tuesday 16:00 Central — not yet; 11-05 was final Monday.
    const now = Date.parse("2026-11-10T20:00:00Z");
    const days = practiceDays(now, 3);
    expect(days).toEqual(["2026-11-05", "2026-11-04", "2026-11-03"]);
    for (const d of days) expect(practiceSchedule(d)!.at.settle).toBeLessThanOrEqual(now);
  });

  it("stops at the start of the price history", () => {
    const days = practiceDays(Date.parse("2026-09-26T00:00:00Z"), 30);
    expect(days.at(-1)! >= "2026-09-20").toBe(true);
  });

  it("knows which step the clock has reached", () => {
    const s = practiceSchedule("2026-11-05")!;
    expect(reachedStep(s, s.at.bid - 1)).toBeNull();
    expect(reachedStep(s, s.at.bid)).toBe("bid");
    expect(reachedStep(s, s.at.clearing + 1)).toBe("clearing");
    expect(reachedStep(s, s.at.settle)).toBe("settle");
  });

  it("overlaps neighbouring days, which is why the desk records the day it practises", () => {
    // Delivery of 11-05 is already past 11-06's bid window: the clock alone
    // cannot say which day is being practised.
    const a = practiceSchedule("2026-11-05")!;
    const b = practiceSchedule("2026-11-06")!;
    expect(a.at.delivery).toBeGreaterThan(b.at.bid);
    expect(a.at.delivery).toBeLessThan(a.at.settle);
  });
});
