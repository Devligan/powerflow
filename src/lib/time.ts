import { centralHourEnding } from "@/lib/ercot/hour-ending";

/**
 * Time display, in the viewer's own time zone.
 *
 * Instants are stored and computed in UTC. What the desk shows is the
 * viewer's wall clock: their browser reports its zone (TimeZoneSync stores it
 * in the `pf_tz` cookie so server-rendered pages agree), or they pick one in
 * Settings. Every function here takes that zone explicitly — there is no
 * implicit default to drift back to — and prints its abbreviation (CDT, PST,
 * GMT+1…) so the fall-back hour's two 1 AMs never read alike.
 *
 * ERCOT's own conventions are a different thing and stay in Central: an
 * operating day and its hour-ending (HE1–HE24) are defined on Central time,
 * so a delivery hour is named "HE13" wherever the viewer is, while its clock
 * times are shown in their zone.
 *
 * Browser-safe: used by server and client components alike.
 */

/** ERCOT's market clock, and the fallback before a viewer's zone is known. */
export const MARKET_TIME_ZONE = "America/Chicago";
export const TZ_COOKIE = "pf_tz";
/** Present when the viewer chose a zone in Settings instead of following the browser. */
export const TZ_MANUAL_COOKIE = "pf_tz_manual";

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? tz : MARKET_TIME_ZONE;
}

type TimeInput = string | number | Date | null | undefined;

function toMs(v: TimeInput): number | null {
  if (v == null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

// Intl construction dominates when a table formats hundreds of rows; keep one
// formatter per zone and shape.
const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${tz}|${key}`;
  let f = cache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });
    cache.set(k, f);
  }
  return f;
}

export interface ZonedParts {
  /** YYYY-MM-DD */
  date: string;
  hh: string;
  mm: string;
  ss: string;
  /** Abbreviation in effect at that instant: CDT, CST, PST, GMT+1… */
  zone: string;
}

/** The wall-clock fields of an instant in a zone. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const p = Object.fromEntries(
    fmt(tz, "parts", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(ms)
      .map((x) => [x.type, x.value])
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hh: p.hour === "24" ? "00" : p.hour,
    mm: p.minute,
    ss: p.second,
    zone: p.timeZoneName ?? tz,
  };
}

/**
 * "Wed, Nov 11, 4:00 PM": a near date in a badge or a dense table, where the
 * year and zone are already plain from the page around it.
 */
export function briefDateTime(v: TimeInput, tz: string): string {
  const ms = toMs(v);
  if (ms == null) return "—";
  return fmt(tz, "brief", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

/**
 * "Thu, Nov 12": the ERCOT operating day an instant falls in. Operating days
 * are Central whatever the viewer's zone, so this ignores it.
 */
export function operatingDayLabel(v: TimeInput): string {
  const ms = toMs(v);
  if (ms == null) return "—";
  return fmt(MARKET_TIME_ZONE, "opday", { weekday: "short", month: "short", day: "numeric" }).format(ms);
}

/** "2026-11-01" */
export function localDate(v: TimeInput, tz: string): string {
  const ms = toMs(v);
  return ms == null ? "—" : zonedParts(ms, tz).date;
}

/** "14:05 CST", or "14:05:09 CST" with seconds. */
export function localTime(v: TimeInput, tz: string, withSeconds = false): string {
  const ms = toMs(v);
  if (ms == null) return "—";
  const p = zonedParts(ms, tz);
  return `${p.hh}:${p.mm}${withSeconds ? `:${p.ss}` : ""} ${p.zone}`;
}

/** "2026-11-01 14:05 CST" — compact and sortable, for tables. */
export function shortDate(v: TimeInput, tz: string): string {
  const ms = toMs(v);
  if (ms == null) return "—";
  const p = zonedParts(ms, tz);
  return `${p.date} ${p.hh}:${p.mm} ${p.zone}`;
}

/** "Sun, Nov 1, 2026, 2:05 PM CST" */
export function dateTime(v: TimeInput, tz: string): string {
  const ms = toMs(v);
  if (ms == null) return "—";
  return fmt(tz, "datetime", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(ms);
}

/** UTC offset of a zone at an instant, in ms (wall − UTC). */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const [y, mo, d] = p.date.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d, Number(p.hh), Number(p.mm), Number(p.ss));
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * A `datetime-local` value ("2026-11-01T14:30") read as wall time in `tz`, as
 * a UTC instant. A repeated (fall-back) time resolves to its first occurrence;
 * a time inside a spring-forward gap does not exist → null.
 */
export function localToUtc(local: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const hits = new Set<number>();
  // An instant's offset is one of the offsets in force within a day of it.
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
    const t = wall - offsetAt(probe, tz);
    const p = zonedParts(t, tz);
    if (p.date === `${y}-${mo}-${d}` && p.hh === h && p.mm === mi) hits.add(t);
  }
  return hits.size ? Math.min(...hits) : null;
}

/** The inverse: a UTC instant as a `datetime-local` value in `tz`. */
export function utcToLocal(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.date}T${p.hh}:${p.mm}`;
}

/** The UTC instant a calendar day starts in `tz`. */
export function dayStartUtc(day: string, tz: string): number | null {
  return (
    localToUtc(`${day}T00:00`, tz) ??
    // Zones whose DST jump happens at midnight start that day at 01:00.
    localToUtc(`${day}T01:00`, tz)
  );
}

/**
 * "Sat, Oct 31 · 5:00 PM – 6:00 PM CDT · HE18": a delivery window on the
 * viewer's clock, with ERCOT's hour-ending (always Central) for a one-hour
 * window.
 */
export function windowLabel(startMs: number, endMs: number, tz: string): string {
  const dayOf = (ms: number) =>
    fmt(tz, "wday", { weekday: "short", month: "short", day: "numeric" }).format(ms);
  const time = (ms: number) => fmt(tz, "hm", { hour: "numeric", minute: "2-digit" }).format(ms);
  const zone = (ms: number) => zonedParts(ms, tz).zone;
  const day = dayOf(startMs);
  const startZone = zone(startMs);
  const endZone = zone(endMs);
  // A multi-hour window that ends on a later day names that day, or a 24-hour
  // block reads "1:00 AM – 1:00 AM". A single hour ending at midnight does not.
  const endDay = dayOf(endMs);
  const end =
    endMs - startMs > 3_600_000 && endDay !== day ? `${endDay} ${time(endMs)}` : time(endMs);
  // Across a DST change the two ends sit in different offsets; name both.
  let label =
    startZone === endZone
      ? `${day} · ${time(startMs)} – ${end} ${endZone}`
      : `${day} · ${time(startMs)} ${startZone} – ${end} ${endZone}`;
  if (endMs - startMs === 3_600_000) {
    const { he, repeated } = centralHourEnding(startMs);
    label += ` · HE${he}${repeated ? " (repeated)" : ""}`;
  }
  return label;
}

/**
 * The wall clock, for a server component. A server component renders once
 * per request, so this is that request's "now"; client components keep the
 * time in state instead.
 */
export function requestTime(): number {
  return Date.now();
}

/** "US Central", "Pacific"… a readable name for a zone, for captions. */
export function zoneName(tz: string, at = Date.now()): string {
  const long = fmt(tz, "long", { timeZoneName: "long" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return long ? long.replace(/ (Standard|Daylight) Time$/, " Time") : tz;
}
