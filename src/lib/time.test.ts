import { describe, it, expect } from "vitest";
import {
  briefDateTime,
  dayStartUtc,
  isValidTimeZone,
  localDate,
  localTime,
  localToUtc,
  normalizeTimeZone,
  operatingDayLabel,
  shortDate,
  utcToLocal,
  windowLabel,
} from "@/lib/time";
import {
  damBidWindowOpensUtc,
  damDeadlineUtc,
  firstOpenOperatingDay,
  isNercHoliday,
  lastOpenOperatingDay,
  isPeakWeekday,
  operatingDayHours,
} from "@/lib/ercot/hour-ending";

const CT = "America/Chicago";
const PT = "America/Los_Angeles";
const LON = "Europe/London";
const IST = "Asia/Kolkata";

describe("display in the viewer's zone", () => {
  it("shows CDT in summer and CST in winter for a Central viewer", () => {
    expect(shortDate("2026-07-01T17:05:00Z", CT)).toBe("2026-07-01 12:05 CDT");
    expect(shortDate("2026-12-01T18:05:00Z", CT)).toBe("2026-12-01 12:05 CST");
  });
  it("shows the same instant on a Pacific, London or India clock", () => {
    expect(shortDate("2026-07-01T17:05:00Z", PT)).toBe("2026-07-01 10:05 PDT");
    expect(shortDate("2026-12-01T18:05:00Z", PT)).toBe("2026-12-01 10:05 PST");
    expect(localTime("2026-07-01T17:05:00Z", LON)).toBe("18:05 GMT+1");
    expect(localTime("2026-07-01T17:05:00Z", IST)).toBe("22:35 GMT+5:30");
  });
  it("names the viewer's calendar date, not UTC's", () => {
    // 03:00 UTC is still the previous evening in Texas, already morning in India.
    expect(localDate("2026-07-02T03:00:00Z", CT)).toBe("2026-07-01");
    expect(localDate("2026-07-01T20:00:00Z", IST)).toBe("2026-07-02");
  });
  it("tells the fall-back day's two 1 AMs apart", () => {
    expect(localTime("2026-11-01T06:30:00Z", CT)).toBe("01:30 CDT");
    expect(localTime("2026-11-01T07:30:00Z", CT)).toBe("01:30 CST");
  });
  it("prints midnight as 00, never 24", () => {
    expect(localTime("2026-12-01T06:00:00Z", CT)).toBe("00:00 CST");
  });
});

describe("localToUtc", () => {
  it("reads a datetime-local value as wall time in the zone", () => {
    expect(localToUtc("2026-07-01T12:05", CT)).toBe(Date.parse("2026-07-01T17:05:00Z"));
    expect(localToUtc("2026-12-01T12:05", CT)).toBe(Date.parse("2026-12-01T18:05:00Z"));
    expect(localToUtc("2026-07-01T10:05", PT)).toBe(Date.parse("2026-07-01T17:05:00Z"));
    expect(localToUtc("2026-07-01T22:35", IST)).toBe(Date.parse("2026-07-01T17:05:00Z"));
  });
  it("resolves the repeated hour to its first occurrence", () => {
    expect(localToUtc("2026-11-01T01:30", CT)).toBe(Date.parse("2026-11-01T06:30:00Z"));
    expect(localToUtc("2026-10-25T01:30", LON)).toBe(Date.parse("2026-10-25T00:30:00Z"));
  });
  it("refuses a time in a spring-forward gap", () => {
    expect(localToUtc("2026-03-08T02:30", CT)).toBeNull();
    expect(localToUtc("2026-03-29T01:30", LON)).toBeNull();
  });
  it("round-trips in every zone", () => {
    const ms = Date.parse("2026-09-22T14:00:00Z");
    for (const tz of [CT, PT, LON, IST]) expect(localToUtc(utcToLocal(ms, tz), tz)).toBe(ms);
  });
  it("finds the start of a calendar day", () => {
    expect(dayStartUtc("2026-07-01", CT)).toBe(Date.parse("2026-07-01T05:00:00Z"));
    expect(dayStartUtc("2026-07-01", IST)).toBe(Date.parse("2026-06-30T18:30:00Z"));
  });
});

describe("windowLabel", () => {
  it("keeps ERCOT's hour-ending while showing the viewer's clock", () => {
    const s = Date.parse("2026-10-31T22:00:00Z");
    const e = s + 3_600_000;
    expect(windowLabel(s, e, CT)).toBe("Sat, Oct 31 · 5:00 PM – 6:00 PM CDT · HE18");
    expect(windowLabel(s, e, PT)).toBe("Sat, Oct 31 · 3:00 PM – 4:00 PM PDT · HE18");
  });
});

describe("briefDateTime", () => {
  it("drops the year and zone, in the viewer's zone", () => {
    // ERCOT's final-price instant: 16:00 Central on a Wednesday.
    const t = "2026-11-11T22:00:00Z";
    expect(briefDateTime(t, CT)).toBe("Wed, Nov 11, 4:00 PM");
    expect(briefDateTime(t, PT)).toBe("Wed, Nov 11, 2:00 PM");
    expect(briefDateTime(null, CT)).toBe("—");
  });
});

describe("operatingDayLabel", () => {
  it("names the Central operating day, whatever the viewer's zone", () => {
    // HE24 of Thu Nov 12 starts 23:00 Central; its end is Fri 00:00.
    expect(operatingDayLabel("2026-11-13T05:00:00Z")).toBe("Thu, Nov 12");
    expect(operatingDayLabel(Date.parse("2026-11-13T06:00:00Z") - 1)).toBe("Thu, Nov 12");
    expect(operatingDayLabel("2026-11-13T06:00:00Z")).toBe("Fri, Nov 13");
  });
});

describe("time zone validation", () => {
  it("accepts IANA names and falls back to Central otherwise", () => {
    expect(isValidTimeZone(PT)).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(normalizeTimeZone("Not/AZone")).toBe(CT);
    expect(normalizeTimeZone(undefined)).toBe(CT);
  });
});

describe("day-ahead deadline (mirror of dam_gate, 0038)", () => {
  it("is 10:00 Central the day before the operating day, across DST", () => {
    // Operating day Nov 1 (HE24 included): Oct 31 10:00 CDT.
    expect(damDeadlineUtc(Date.parse("2026-11-02T05:00:00Z"))).toBe(Date.parse("2026-10-31T15:00:00Z"));
    // Operating day Nov 3: Nov 2 10:00 CST.
    expect(damDeadlineUtc(Date.parse("2026-11-03T06:00:00Z"))).toBe(Date.parse("2026-11-02T16:00:00Z"));
  });
  it("names the first operating day still open for bids", () => {
    expect(firstOpenOperatingDay(Date.parse("2026-11-01T15:59:00Z"))).toBe("2026-11-02"); // 09:59 CST
    expect(firstOpenOperatingDay(Date.parse("2026-11-01T16:00:00Z"))).toBe("2026-11-03"); // 10:00 CST
  });
});

describe("day-ahead bid window (mirror of dam_bid_window_opens, 0045)", () => {
  it("opens at 00:00 Central fourteen days before the operating day, across DST", () => {
    // Operating day Nov 3 (CST) opens Oct 20 (CDT).
    expect(damBidWindowOpensUtc(Date.parse("2026-11-03T23:00:00Z"))).toBe(Date.parse("2026-10-20T05:00:00Z"));
    // HE24 belongs to the day it starts in.
    expect(damBidWindowOpensUtc(Date.parse("2026-11-04T05:00:00Z"))).toBe(Date.parse("2026-10-20T05:00:00Z"));
  });
  it("names the furthest operating day already open", () => {
    expect(lastOpenOperatingDay(Date.parse("2026-11-08T12:00:00Z"))).toBe("2026-11-22");
    // 23:30 CST on Nov 7 is still Nov 7 in Texas.
    expect(lastOpenOperatingDay(Date.parse("2026-11-08T05:30:00Z"))).toBe("2026-11-21");
  });
});

describe("peak calendar", () => {
  it("knows the NERC holidays, with Sunday ones observed on Monday", () => {
    for (const d of ["2026-01-01", "2026-05-25", "2026-07-04", "2026-09-07", "2026-11-26", "2026-12-25"]) {
      expect(isNercHoliday(d), d).toBe(true);
    }
    expect(isNercHoliday("2027-12-27")).toBe(false); // Christmas 2027 is a Saturday: not moved
    expect(isNercHoliday("2028-12-25")).toBe(true);
    expect(isNercHoliday("2033-12-26")).toBe(true); // Christmas 2033 is a Sunday → Monday
    expect(isNercHoliday("2026-11-25")).toBe(false);
  });
  it("trades weekdays as 5x16 and weekends/holidays as 2x16", () => {
    expect(isPeakWeekday("2026-11-02")).toBe(true); // Monday
    expect(isPeakWeekday("2026-11-01")).toBe(false); // Sunday
    expect(isPeakWeekday("2026-11-26")).toBe(false); // Thanksgiving
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
        const day = localDate(t, CT);
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
