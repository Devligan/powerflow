import { centralHourEnding, isPeakHour } from "@/lib/ercot/hour-ending";

/**
 * Desk analytics over a settlement point's hourly history: what a trader
 * looks at before bidding virtuals or picking a block.
 *
 * These are read-side statistics for display, so they work in dollars as
 * numbers; nothing here feeds a fill, a mark or a balance (those stay exact,
 * in SQL and `money.ts`).
 */

export interface HourlyPrice {
  /** Delivery start, epoch ms. */
  t: number;
  /** $/MWh. */
  price: number;
}

export interface DartHour {
  he: number;
  /** Hours with both a day-ahead and a real-time price. */
  n: number;
  /** Mean of RT − DA: positive means real time cleared above day-ahead (a DEC earned). */
  mean: number | null;
  stdev: number | null;
  /** Share of hours where RT > DA, 0–1. */
  pctRtAbove: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
}

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * DART (real time minus day-ahead) by ERCOT hour ending. Only hours that have
 * both prices count; the repeated fall-back hour folds into its HE.
 */
export function dartByHour(dayAhead: HourlyPrice[], realTime: HourlyPrice[]): DartHour[] {
  const daAt = new Map(dayAhead.map((p) => [p.t, p.price]));
  const buckets: number[][] = Array.from({ length: 24 }, () => []);
  for (const rt of realTime) {
    const da = daAt.get(rt.t);
    if (da == null) continue;
    buckets[centralHourEnding(rt.t).he - 1].push(rt.price - da);
  }
  return buckets.map((xs, i) => {
    const n = xs.length;
    if (n === 0) {
      return { he: i + 1, n, mean: null, stdev: null, pctRtAbove: null, p10: null, p25: null, p75: null, p90: null };
    }
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const stdev = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    const sorted = [...xs].sort((a, b) => a - b);
    return {
      he: i + 1,
      n,
      mean,
      stdev,
      pctRtAbove: xs.filter((x) => x > 0).length / n,
      p10: quantile(sorted, 0.1),
      p25: quantile(sorted, 0.25),
      p75: quantile(sorted, 0.75),
      p90: quantile(sorted, 0.9),
    };
  });
}

export interface HeatRow {
  /** Central operating day, YYYY-MM-DD. */
  day: string;
  /** Index 0 = HE1 … 23 = HE24; the repeated hour is averaged into HE2. */
  cells: Array<number | null>;
  /** Around-the-clock mean of the hours present. */
  atc: number | null;
  /** Mean of HE7–HE22. */
  peak: number | null;
  /** Hours priced (23–25 on a full day, depending on DST). */
  hours: number;
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** Hourly prices laid out as operating day × hour ending, newest day first. */
export function priceHeatmap(prices: HourlyPrice[]): HeatRow[] {
  const days = new Map<string, number[][]>();
  for (const p of prices) {
    const { day, he } = centralHourEnding(p.t);
    const row = days.get(day) ?? Array.from({ length: 24 }, () => []);
    row[he - 1].push(p.price);
    days.set(day, row);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, row]) => {
      const cells = row.map(mean);
      const all = row.flat();
      return {
        day,
        cells,
        atc: mean(all),
        peak: mean(row.flatMap((xs, i) => (isPeakHour(i + 1) ? xs : []))),
        hours: all.length,
      };
    });
}
