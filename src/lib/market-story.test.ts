import { describe, expect, it } from "vitest";
import { pickStory } from "@/lib/market-story";
import type { RecapHour } from "@/lib/day-recap";

/** A 24-hour day at one hub with a flat $30 day-ahead and real time set per hour. */
function day(rtByHe: Record<number, number | null> = {}): RecapHour[] {
  return Array.from({ length: 24 }, (_, i) => {
    const he = i + 1;
    const rt = he in rtByHe ? rtByHe[he] : 31;
    return { he, startMs: i * 3_600_000, da: 30, rt, dart: rt == null ? null : rt - 30 };
  });
}

const DAY = "2026-11-12";

describe("pickStory", () => {
  it("leads with the widest gap across the hubs, whichever way it went", () => {
    const story = pickStory([
      { day: DAY, point: "HB_NORTH", hours: day({ 21: 367 }) },
      { day: DAY, point: "HB_WEST", hours: day({ 8: -400 }) },
    ]);
    expect(story).toMatchObject({ point: "HB_WEST", place: "West Texas", peak: { he: 8, da: 30, rt: -400, dart: -430 } });
  });

  it("looks across the days of the week, not just the latest", () => {
    const story = pickStory([
      { day: "2026-11-13", point: "HB_PAN", hours: day({ 4: 8 }) },
      { day: "2026-11-12", point: "HB_PAN", hours: day({ 4: 519 }) },
      { day: "2026-11-11", point: "HB_NORTH", hours: day({ 19: 120 }) },
    ]);
    expect(story).toMatchObject({ day: "2026-11-12", point: "HB_PAN", place: "the Panhandle", peak: { he: 4, dart: 489 } });
  });

  it("names the hub and keeps its whole day for the chart", () => {
    const story = pickStory([{ day: DAY, point: "HB_NORTH", hours: day({ 21: 367 }) }]);
    expect(story?.place).toBe("North Texas");
    expect(story?.hours).toHaveLength(24);
    expect(story?.peak).toMatchObject({ he: 21, dart: 337 });
  });

  it("passes over a hub-day that is missing prices, rather than half-drawing it", () => {
    const gappy = day(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [i + 1, null])));
    gappy[20] = { ...gappy[20], rt: 900, dart: 870 };
    const story = pickStory([
      { day: DAY, point: "HB_HOUSTON", hours: gappy },
      { day: DAY, point: "HB_SOUTH", hours: day({ 18: 80 }) },
    ]);
    expect(story?.point).toBe("HB_SOUTH");
  });

  it("has no story when no hub has a complete day", () => {
    expect(pickStory([])).toBeNull();
    expect(pickStory([{ day: DAY, point: "HB_NORTH", hours: day().slice(0, 10) }])).toBeNull();
  });
});
