import { describe, expect, it } from "vitest";
import { deskCycle } from "@/lib/desk-cycle";
import { hourEndingStartUtc } from "@/lib/ercot/hour-ending";

const he = (day: string, n: number) => hourEndingStartUtc(day, n)!;
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

// Friday 13 Nov 2026, 09:00 Central: Saturday's bids are open until 10:00.
const NOW = he("2026-11-13", 10);

describe("deskCycle", () => {
  it("names the first day still open for bids and the time left on its gate", () => {
    const c = deskCycle(NOW, [], []);
    expect(c.openDay).toBe("2026-11-14");
    expect(c.minutesToGate).toBe(60);
  });

  it("moves to the next day once the gate has passed", () => {
    const c = deskCycle(he("2026-11-13", 11) + 60_000, [], []);
    expect(c.openDay).toBe("2026-11-15");
  });

  it("splits bids into working ones and ones waiting for the clearing", () => {
    const c = deskCycle(NOW, [
      { deliveryStart: iso(he("2026-11-14", 18)) }, // Saturday: gate is 10:00 today, still open
      { deliveryStart: iso(he("2026-11-13", 18)) }, // today: gate passed yesterday
    ], []);
    expect(c.working).toBe(1);
    expect(c.awaitingClearing).toBe(1);
  });

  it("keeps a filled hour in delivery until it ends, then waits for final prices", () => {
    const today18 = he("2026-11-13", 18);
    const yesterday18 = he("2026-11-12", 18);
    const c = deskCycle(NOW, [], [
      { deliveryStart: iso(today18), deliveryEnd: iso(today18 + HOUR), unrealizedPnl: 120_000_000n, finalAt: "2026-11-17T22:00:00.000Z" },
      { deliveryStart: iso(yesterday18), deliveryEnd: iso(yesterday18 + HOUR), unrealizedPnl: -30_000_000n, finalAt: "2026-11-16T22:00:00.000Z" },
      { deliveryStart: iso(yesterday18 - HOUR), deliveryEnd: iso(yesterday18), unrealizedPnl: 5_000_000n, finalAt: "2026-11-16T22:00:00.000Z" },
    ]);
    expect(c.delivering).toEqual({ count: 1, unrealized: 120_000_000n });
    expect(c.settling).toEqual({ count: 2, unrealized: -25_000_000n, nextFinalAt: "2026-11-16T22:00:00.000Z" });
  });
});
