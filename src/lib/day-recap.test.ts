import { describe, expect, it } from "vitest";
import { hourEndingStartUtc } from "@/lib/ercot/hour-ending";
import { summarizeRecap } from "@/lib/day-recap";

const he = (n: number) => hourEndingStartUtc("2026-11-05", n)!;

describe("day recap", () => {
  it("pairs each hour's day-ahead clearing with real time and names the best DEC and INC hours", () => {
    const s = summarizeRecap(
      [
        { t: he(18), price: 40 },
        { t: he(4), price: 25.5 },
        { t: he(12), price: 30 },
      ],
      [
        { t: he(18), price: 65.25 }, // DEC paid 25.25
        { t: he(4), price: 19.4 }, // INC paid 6.10
        { t: he(12), price: 30 }, // nothing
      ]
    );
    expect(s.hours.map((h) => h.he)).toEqual([4, 12, 18]);
    expect(s.priced).toBe(3);
    expect(s.bestDec).toEqual({ he: 18, perMw: 25.25 });
    expect(s.bestInc).toEqual({ he: 4, perMw: 6.1 });
    expect(s.meanDart).toBe(cents((25.25 - 6.1 + 0) / 3));
  });

  it("shows only day-ahead before real time is published, and claims no winner", () => {
    const s = summarizeRecap([{ t: he(18), price: 40 }], []);
    expect(s.hours[0]).toMatchObject({ he: 18, da: 40, rt: null, dart: null });
    expect(s.priced).toBe(0);
    expect(s.bestDec).toBeNull();
    expect(s.bestInc).toBeNull();
    expect(s.meanDart).toBeNull();
  });

  it("names no DEC hour when real time never came in above day-ahead", () => {
    const s = summarizeRecap([{ t: he(1), price: 30 }], [{ t: he(1), price: 22 }]);
    expect(s.bestDec).toBeNull();
    expect(s.bestInc).toEqual({ he: 1, perMw: 8 });
  });
});

function cents(v: number) {
  return Math.round(v * 100) / 100;
}
