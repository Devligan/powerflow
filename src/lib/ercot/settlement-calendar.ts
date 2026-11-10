/**
 * ERCOT's settlement calendar: when a day's prices become final.
 *
 * Nodal Protocols 6.3 and 4.5.3, and ERCOT's "Price Validation and
 * Corrections" business practice: real-time Settlement Point Prices are final
 * at 16:00 Central on the second Business Day after the Operating Day, and
 * day-ahead prices at 10:00 Central on that same day. Until then ERCOT can
 * still correct them, and it does (its NP4-197 report posts the corrections,
 * typically shortly before that 16:00). A position is therefore not settled
 * until the prices it settles on are final.
 *
 * A Business Day (Protocols Section 2.1) is Monday through Friday, excluding
 * the observed holidays: New Year's Day, Martin Luther King, Jr. Day (since
 * 2020, NPRR943), Memorial Day, Independence Day, Labor Day, Thanksgiving
 * Thursday and Friday, and two days at Christmas designated by ERCOT's CEO.
 *
 * Mirror of `public.ercot_holidays` and `public.ercot_price_final_at` (0044);
 * the DB suite `sql-calendar.test.ts` pins one to the other. Browser-safe.
 */

import { centralHourEnding, hourEndingStartUtc } from "@/lib/ercot/hour-ending";

const DAY_MS = 86_400_000;

function ymd(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function dow(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  const first = dow(ymd(y, m, 1));
  return ymd(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}

function lastWeekday(y: number, m: number, weekday: number): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastDow = dow(ymd(y, m, last));
  return ymd(y, m, last - ((lastDow - weekday + 7) % 7));
}

/** A fixed-date holiday on a weekend is observed on the nearest weekday. */
function observed(day: string): string {
  const d = dow(day);
  return d === 6 ? addDays(day, -1) : d === 0 ? addDays(day, 1) : day;
}

/**
 * The two Christmas days. ERCOT's CEO designates them each year; this follows
 * the years ERCOT has published (2021: Fri 24 and Mon 27; 2025: Thu 25 and
 * Fri 26; 2026: Thu 24 and Fri 25), which keep the pair next to the weekend.
 */
function christmas(y: number): [string, string] {
  switch (dow(ymd(y, 12, 25))) {
    case 1: // Monday: Christmas and the day after
      return [ymd(y, 12, 25), ymd(y, 12, 26)];
    case 2: // Tuesday: the Eve and Christmas
    case 3: // Wednesday
    case 5: // Friday
      return [ymd(y, 12, 24), ymd(y, 12, 25)];
    case 4: // Thursday: Christmas and the Friday
      return [ymd(y, 12, 25), ymd(y, 12, 26)];
    case 6: // Saturday: the Friday before and the Monday after
      return [ymd(y, 12, 24), ymd(y, 12, 27)];
    default: // Sunday: the Friday before and the Monday after
      return [ymd(y, 12, 23), ymd(y, 12, 26)];
  }
}

/** ERCOT's observed holidays falling in calendar year `y`, with names. */
export function ercotHolidays(y: number): Array<{ day: string; name: string }> {
  const out: Array<{ day: string; name: string }> = [];
  // New Year's Day on a Saturday is observed on the Friday before, in the
  // previous calendar year; next year's may therefore fall in this one.
  for (const [year, label] of [
    [y, "New Year's Day"],
    [y + 1, "New Year's Day"],
  ] as const) {
    const day = observed(ymd(year, 1, 1));
    if (day.startsWith(`${y}-`)) out.push({ day, name: label });
  }
  if (y >= 2020) out.push({ day: nthWeekday(y, 1, 1, 3), name: "Martin Luther King, Jr. Day" });
  out.push({ day: lastWeekday(y, 5, 1), name: "Memorial Day" });
  out.push({ day: observed(ymd(y, 7, 4)), name: "Independence Day" });
  out.push({ day: nthWeekday(y, 9, 1, 1), name: "Labor Day" });
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  out.push({ day: thanksgiving, name: "Thanksgiving Day" });
  out.push({ day: addDays(thanksgiving, 1), name: "Day after Thanksgiving" });
  const [c1, c2] = christmas(y);
  out.push({ day: c1, name: "Christmas" }, { day: c2, name: "Christmas" });
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

const holidayCache = new Map<number, Set<string>>();

function holidaySet(y: number): Set<string> {
  let set = holidayCache.get(y);
  if (!set) {
    set = new Set(ercotHolidays(y).map((h) => h.day));
    holidayCache.set(y, set);
  }
  return set;
}

export function isErcotBusinessDay(day: string): boolean {
  const d = dow(day);
  if (d === 0 || d === 6) return false;
  return !holidaySet(Number(day.slice(0, 4))).has(day);
}

/** The `n`th Business Day after `day` (YYYY-MM-DD), `n` ≥ 1. */
export function businessDayAfter(day: string, n: number): string {
  let cur = day;
  for (let left = n; left > 0; ) {
    cur = addDays(cur, 1);
    if (isErcotBusinessDay(cur)) left--;
  }
  return cur;
}

/** Whether a product's prices come out of real time (else the day-ahead
 *  market, whose energy and AS prices share the day-ahead deadline). */
function isRealTime(product: string): boolean {
  return product.startsWith("RTM");
}

/**
 * When ERCOT's price for the interval starting at `intervalStartMs` is final:
 * 16:00 Central (real time) or 10:00 Central (day ahead) on the second
 * Business Day after the interval's Operating Day.
 */
export function priceFinalAt(product: string, intervalStartMs: number): number {
  const { day } = centralHourEnding(intervalStartMs);
  const finalDay = businessDayAfter(day, 2);
  // The start of HE17 is 16:00 and HE11 is 10:00; neither is ever skipped.
  return hourEndingStartUtc(finalDay, isRealTime(product) ? 17 : 11)!;
}

/** Settlement rules whose value is a real-time outcome (0021/0023). */
const REAL_TIME_RULES = new Set(["CONVERGENCE", "CONGESTION_CONVERGENCE"]);

/**
 * When a position's settlement price is final: the finality of the last
 * interval it settles on. Convergence instruments settle on real time
 * whatever product they were bid in. Mirror of `public.position_final_at`.
 */
export function positionFinalAt(
  settlementRule: string | undefined,
  product: string,
  deliveryEndMs: number
): number {
  const settledOn = settlementRule && REAL_TIME_RULES.has(settlementRule) ? "RTM_HOURLY" : product;
  return priceFinalAt(settledOn, deliveryEndMs - 1);
}
