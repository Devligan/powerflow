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

describe("pickStory", () => {
  it("leads with the widest gap across the hubs, whichever way it went", () => {
    const story = pickStory("2026-11-12", [
      { point: "HB_NORTH", hours: day({ 21: 367 }) },
      { point: "HB_WEST", hours: day({ 8: -400 }) },
    ]);
    expect(story).toMatchObject({ point: "HB_WEST", place: "West Texas", peak: { he: 8, da: 30, rt: -400, dart: -430 } });
  });

  it("names the hub and keeps its whole day for the chart", () => {
    const story = pickStory("2026-11-12", [{ point: "HB_NORTH", hours: day({ 21: 367 }) }]);
    expect(story?.place).toBe("North Texas");
    expect(story?.hours).toHaveLength(24);
    expect(story?.peak).toMatchObject({ he: 21, dart: 337 });
  });

  it("passes over a hub whose day is missing prices, rather than half-drawing it", () => {
    const gappy = day(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [i + 1, null])));
    gappy[20] = { ...gappy[20], rt: 900, dart: 870 };
    const story = pickStory("2026-11-12", [
      { point: "HB_HOUSTON", hours: gappy },
      { point: "HB_SOUTH", hours: day({ 18: 80 }) },
    ]);
    expect(story?.point).toBe("HB_SOUTH");
  });

  it("has no story when no hub has a complete day", () => {
    expect(pickStory("2026-11-12", [])).toBeNull();
    expect(pickStory("2026-11-12", [{ point: "HB_NORTH", hours: day().slice(0, 10) }])).toBeNull();
  });
});
