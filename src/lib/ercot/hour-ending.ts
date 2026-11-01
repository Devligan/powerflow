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

/** ERCOT's on-peak hours: HE7–HE22 (06:00–22:00 Central). */
export function isPeakHour(he: number): boolean {
  return he >= 7 && he <= 22;
}
