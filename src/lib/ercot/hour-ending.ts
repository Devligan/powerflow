/**
 * ERCOT's hour-ending convention, read back from a UTC delivery instant.
 *
 * An hour is numbered by the Central hour it STARTS in, plus one — the inverse
 * of `deliveryCentralToUtc` — and belongs to the operating day it starts in, so
 * HE24 (23:00–24:00) is still that day. On the fall-back day HE2 occurs twice
 * (the second is ERCOT's repeated hour); on the spring-forward day HE3 never
 * occurs.
 */

const CENTRAL = "America/Chicago";
const HOUR_MS = 3_600_000;

// One formatter, reused: Intl construction dominates when this runs per hour
// over weeks of history.
const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: CENTRAL,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function centralDayHour(ms: number): { day: string; hour: number } {
  const p = Object.fromEntries(PARTS.formatToParts(ms).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

export interface HourEnding {
  /** Central operating day, YYYY-MM-DD. */
  day: string;
  /** 1–24. */
  he: number;
  /** The second HE2 of the fall-back day. */
  repeated: boolean;
}

export function centralHourEnding(startMs: number): HourEnding {
  const { day, hour } = centralDayHour(startMs);
  const repeated = centralDayHour(startMs - HOUR_MS).hour === hour;
  return { day, he: hour + 1, repeated };
}

/**
 * The UTC start of an operating day's hour ending — the first occurrence on
 * the fall-back day, null for the spring-forward gap (HE3). Browser-safe twin
 * of `deliveryCentralToUtc`, which lives with the MIS parser.
 */
export function hourEndingStartUtc(day: string, he: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m || !Number.isInteger(he) || he < 1 || he > 24) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), he - 1);
  // CDT (−5) first, so the repeated hour resolves to its first occurrence.
  for (const offsetHours of [5, 6]) {
    const t = wall + offsetHours * HOUR_MS;
    const got = centralHourEnding(t);
    if (got.day === day && got.he === he && !got.repeated) return t;
  }
  return null;
}

export interface OperatingHour extends HourEnding {
  /** UTC start of the hour. */
  startMs: number;
}

/**
 * Every hour of a Central operating day, in delivery order: 24 normally, 23
 * on the spring-forward day (no HE3), 25 on the fall-back day (HE2 twice).
 */
export function operatingDayHours(day: string): OperatingHour[] {
  const first = hourEndingStartUtc(day, 1);
  if (first == null) return [];
  const out: OperatingHour[] = [];
  for (let t = first; out.length < 25; t += HOUR_MS) {
    const h = centralHourEnding(t);
    if (h.day !== day) break;
    out.push({ ...h, startMs: t });
  }
  return out;
}

/** The Central calendar day before `day` (YYYY-MM-DD). */
function previousDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * ERCOT's day-ahead deadline for the operating day a delivery starts in:
 * 10:00 Central on the day before (the start of HE11 that day). Mirror of
 * `dam_gate` (0038). Bids for that operating day are accepted only before it.
 */
export function damDeadlineUtc(deliveryStartMs: number): number | null {
  const { day } = centralHourEnding(deliveryStartMs);
  return hourEndingStartUtc(previousDay(day), 11);
}

/** How many days before its operating day ERCOT starts taking day-ahead bids
 *  (NP4-450). */
export const DAM_BID_WINDOW_DAYS = 14;

/**
 * When ERCOT starts taking day-ahead bids for the operating day a delivery
 * starts in: 00:00 Central, fourteen days before it. Mirror of
 * `dam_bid_window_opens` (0045).
 */
export function damBidWindowOpensUtc(deliveryStartMs: number): number | null {
  const { day } = centralHourEnding(deliveryStartMs);
  const [y, m, d] = day.split("-").map(Number);
  const opens = new Date(Date.UTC(y, m - 1, d - DAM_BID_WINDOW_DAYS)).toISOString().slice(0, 10);
  return hourEndingStartUtc(opens, 1);
}

/** The last operating day already open for day-ahead bids at `nowMs`. */
export function lastOpenOperatingDay(nowMs: number): string {
  const [y, m, d] = centralHourEnding(nowMs).day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + DAM_BID_WINDOW_DAYS)).toISOString().slice(0, 10);
}

/** Products cleared by the day-ahead market (bid before its deadline). */
export function isDayAheadProduct(code: string): boolean {
  return code.startsWith("DAM");
}

/**
 * The first ERCOT operating day still open for day-ahead bids at `nowMs`:
 * tomorrow before 10:00 Central, the day after from then on.
 */
export function firstOpenOperatingDay(nowMs: number): string {
  let day = centralHourEnding(nowMs).day;
  for (let i = 0; i < 4; i++) {
    const [y, m, d] = day.split("-").map(Number);
    day = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const first = hourEndingStartUtc(day, 1);
    const deadline = first == null ? null : damDeadlineUtc(first);
    if (deadline != null && nowMs < deadline) return day;
  }
  return day;
}

/**
 * NERC holidays, which the power industry trades as weekend days (a 2x16
 * peak, not 5x16): New Year's Day, Memorial Day, Independence Day, Labor Day,
 * Thanksgiving and Christmas. One that falls on a Sunday is observed on the
 * Monday; a Saturday one is not moved.
 */
export function isNercHoliday(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number);
  const dow = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
  const nthWeekday = (mm: number, weekday: number, n: number) => {
    const first = dow(y, mm, 1);
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  };
  const lastWeekday = (mm: number, weekday: number) => {
    const days = new Date(Date.UTC(y, mm, 0)).getUTCDate();
    const lastDow = dow(y, mm, days);
    return days - ((lastDow - weekday + 7) % 7);
  };
  const fixed: Array<[number, number]> = [[1, 1], [7, 4], [12, 25]];
  for (const [mm, dd] of fixed) {
    if (m === mm && d === dd && dow(y, mm, dd) !== 0) return true;
    // Sunday holiday → Monday off.
    if (dow(y, mm, dd) === 0 && m === mm && d === dd + 1) return true;
  }
  if (m === 5 && d === lastWeekday(5, 1)) return true; // Memorial Day
  if (m === 9 && d === nthWeekday(9, 1, 1)) return true; // Labor Day
  if (m === 11 && d === nthWeekday(11, 4, 4)) return true; // Thanksgiving
  return false;
}

/**
 * Whether an operating day trades as a peak weekday (5x16) or a weekend /
 * NERC-holiday day (2x16). Off-peak hours (7x8) are the same every day.
 */
export function isPeakWeekday(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow >= 1 && dow <= 5 && !isNercHoliday(day);
}

/** ERCOT's on-peak hours: HE7–HE22 (06:00–22:00 Central). */
export function isPeakHour(he: number): boolean {
  return he >= 7 && he <= 22;
}
