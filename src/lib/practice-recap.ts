import { centralHourEnding } from "@/lib/ercot/hour-ending";

/**
 * What the market did on a practice day, hour by hour, at one settlement
 * point: the day-ahead clearing against real time, and the DART spread a
 * virtual bid is paid (src/lib/glossary.ts). Browser-safe; prices here are
 * for display only — every fill and settlement still goes through the engine.
 */

export interface RecapHour {
  /** Hour ending, 1–24 (25 on the fall-back day's repeated hour is HE2 again). */
  he: number;
  startMs: number;
  da: number | null;
  /** Real time as the desk's clock sees it: null before it is published. */
  rt: number | null;
  /** rt − da: what a 1 MW DEC earned (an INC earned the opposite). */
  dart: number | null;
}

export interface RecapSummary {
  hours: RecapHour[];
  /** Hours with both prices. */
  priced: number;
  /** The hour a DEC (buy DA, sell RT) paid most, if any paid at all. */
  bestDec: { he: number; perMw: number } | null;
  /** The hour an INC (sell DA, buy RT) paid most, if any paid at all. */
  bestInc: { he: number; perMw: number } | null;
  /** Mean DART over the priced hours. */
  meanDart: number | null;
}

type Point = { t: number; price: number };

const cents = (v: number) => Math.round(v * 100) / 100;

export function summarizeRecap(dayAhead: Point[], realTime: Point[]): RecapSummary {
  const rtAt = new Map(realTime.map((p) => [p.t, p.price]));
  const hours: RecapHour[] = dayAhead
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((p) => {
      const rt = rtAt.get(p.t) ?? null;
      return {
        he: centralHourEnding(p.t).he,
        startMs: p.t,
        da: cents(p.price),
        rt: rt == null ? null : cents(rt),
        dart: rt == null ? null : cents(rt - p.price),
      };
    });

  const priced = hours.filter((h) => h.dart != null) as Array<RecapHour & { dart: number }>;
  let bestDec: RecapSummary["bestDec"] = null;
  let bestInc: RecapSummary["bestInc"] = null;
  for (const h of priced) {
    if (h.dart > 0 && (!bestDec || h.dart > bestDec.perMw)) bestDec = { he: h.he, perMw: h.dart };
    if (h.dart < 0 && (!bestInc || -h.dart > bestInc.perMw)) bestInc = { he: h.he, perMw: cents(-h.dart) };
  }
  const meanDart = priced.length ? cents(priced.reduce((a, h) => a + h.dart, 0) / priced.length) : null;
  return { hours, priced: priced.length, bestDec, bestInc, meanDart };
}
