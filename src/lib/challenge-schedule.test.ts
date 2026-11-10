import { describe, expect, it } from "vitest";
import { damDeadlineUtc } from "@/lib/ercot/hour-ending";
import { challengeWindow, nextMove } from "@/lib/challenge-schedule";

const NOW = Date.parse("2026-11-10T20:00:00Z");

describe("challenge window", () => {
  it("runs every move strictly forward, bidding before each day's deadline", () => {
    const w = challengeWindow("2026-11-02", 3, NOW)!;
    expect(w.days).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(w.moves.map((m) => `${m.kind}:${m.day ?? ""}`)).toEqual([
      "bid:2026-11-02",
      "clearing:2026-11-02",
      "bid:2026-11-03",
      "clearing:2026-11-03",
      "bid:2026-11-04",
      "clearing:2026-11-04",
      "finish:",
    ]);
    for (let i = 1; i < w.moves.length; i++) expect(w.moves[i].at).toBeGreaterThan(w.moves[i - 1].at);
    for (const m of w.moves.filter((m) => m.kind === "bid")) {
      const firstHour = Date.parse(`${m.day}T12:00:00Z`);
      expect(m.at).toBeLessThan(damDeadlineUtc(firstHour)!);
    }
    expect(w.startsAt).toBe(w.moves[0].at);
    // 11-04 (Wed) is final Friday 11-06 at 16:00 Central.
    expect(new Date(w.finishesAt).toISOString()).toBe("2026-11-06T22:01:00.000Z");
  });

  it("refuses days that have not settled yet, and more than five days", () => {
    expect(challengeWindow("2026-11-05", 2, NOW)).toBeNull(); // 11-06 final only on Tuesday 16:00
    expect(challengeWindow("2026-11-05", 1, NOW)).not.toBeNull();
    expect(challengeWindow("2026-10-20", 6, NOW)).toBeNull();
    expect(challengeWindow("2026-10-20", 0, NOW)).toBeNull();
  });

  it("names the next move from the clock, and none at the finish", () => {
    const w = challengeWindow("2026-11-02", 2, NOW)!;
    expect(nextMove(w, w.startsAt)!.kind).toBe("clearing");
    expect(nextMove(w, w.moves[1].at)!).toMatchObject({ kind: "bid", day: "2026-11-03" });
    expect(nextMove(w, w.finishesAt)).toBeNull();
  });
});
