import { parseDec, formatGrouped } from "@/lib/money";
import {
  getInstrument,
  unitForProduct,
  type SettlementRule,
} from "@/lib/ercot/types";
import type { VolumeUnit } from "@/lib/trading/accounting";

/** $1,234.56 */
export function usd(v: string | number | bigint, places = 2): string {
  return `$${formatGrouped(parseDec(v), places)}`;
}

const CENTRAL = "America/Chicago";

/** "5 PM" — the Central wall-clock hour of an instant (DST-aware). */
export function centralHour(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, hour: "numeric" }).format(ms);
}

/**
 * "Sat, Oct 31 · 5:00 PM – 6:00 PM CDT · HE18": a UTC delivery window in the
 * terms ERCOT and its traders use — Central wall time, with the offset in
 * effect on that date, and the hour-ending number for a one-hour window.
 */
export function centralWindowLabel(startMs: number, endMs: number): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(startMs);
  const time = (ms: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, hour: "numeric", minute: "2-digit" }).format(ms);
  const zone = (ms: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, timeZoneName: "short" })
      .formatToParts(ms)
      .find((p) => p.type === "timeZoneName")?.value ?? "CT";
  const startZone = zone(startMs);
  const endZone = zone(endMs);
  // Across a DST change the two ends sit in different offsets; name both.
  let label =
    startZone === endZone
      ? `${day} · ${time(startMs)} – ${time(endMs)} ${endZone}`
      : `${day} · ${time(startMs)} ${startZone} – ${time(endMs)} ${endZone}`;
  if (endMs - startMs === 3_600_000) {
    // Hour ending, numbered from the Central hour the interval *starts* in —
    // the inverse of deliveryCentralToUtc. On the fall-back day HE2 occurs
    // twice (the second is ERCOT's repeated hour); in spring HE3 is skipped.
    const centralH = (ms: number) =>
      Number(new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, hour: "numeric", hourCycle: "h23" }).format(ms));
    const startHour = centralH(startMs);
    const repeated = centralH(startMs - 3_600_000) === startHour;
    label += ` · HE${startHour + 1}${repeated ? " (repeated)" : ""}`;
  }
  return label;
}

/** +$1,234.56 / −$1,234.56 — the sign ahead of the currency symbol, for
 *  spreads and P&L where direction is the point. Zero is unsigned. */
export function signedUsd(v: string | number | bigint, places = 2): string {
  const n = parseDec(v);
  const body = usd(n < 0n ? -n : n, places);
  return n > 0n ? `+${body}` : n < 0n ? `−${body}` : body;
}

/** 1,234.56 (no currency symbol) */
export function num(v: string | number | bigint, places = 2): string {
  return formatGrouped(parseDec(v), places);
}

/** Money from a raw bigint WITHOUT currency symbol. */
export function money(v: bigint, places = 2): string {
  return formatGrouped(v, places);
}

/** Treat a value in basis points as a percent. 920 => "+9.20%" */
export function bpsToPercent(bps: number | bigint | string, signed = true): string {
  let v: number;
  if (typeof bps === "bigint") v = Number(bps);
  else if (typeof bps === "number") v = bps;
  else v = parseFloat(bps);
  if (!Number.isFinite(v)) v = 0;
  // raw percent in scaled money units: pct = bps / 100
  const raw = (BigInt(Math.round(v)) * 1000000n) / 100n;
  let s = money(raw, 2);
  if (s.startsWith("-")) s = s.slice(1);
  return `${v < 0 ? "-" : signed ? "+" : ""}${s}%`;
}

export function sign(v: string | bigint, places = 2): string {
  const n = typeof v === "bigint" ? v : parseDec(v);
  const prefix = n > 0n ? "+" : n < 0n ? "-" : "";
  return `${prefix}${formatGrouped(n, places)}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toUTCString().replace("GMT", "UTC");
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ").concat("Z");
}

/**
 * How a quantity unit is written.
 *
 * An unknown unit is labelled as unclassified rather than defaulted to MWh,
 * so a quantity whose unit could not be established is never presented as
 * energy delivered.
 */
export function volumeUnitLabel(unit: VolumeUnit | null | undefined): string {
  switch (unit) {
    case "MWH":
      return "MWh";
    case "MW":
      return "MW";
    default:
      return "unclassified";
  }
}

/** The unit a position's quantity is held in, from its product. */
export function positionUnit(product: string): VolumeUnit {
  return unitForProduct(product) ?? "UNKNOWN";
}

export interface InstrumentInfo {
  /** Instrument code as persisted. */
  code: string;
  /** Table-sized name. */
  shortLabel: string;
  /** Full name, for a title/tooltip. */
  label: string;
  /** Settlement rule, raw. A window instrument's delivery is a period, not an
   *  interval, so callers need the rule itself and not just its label. */
  rule: SettlementRule;
  /** Settlement rule in words. */
  ruleLabel: string;
  /** Badge class for the rule. */
  tone: string;
  /** How many legs the position has: 0 = legless financial, 2 = path pair. */
  legs: number;
}

/** Settlement rule as humans read it. Every rule must appear here — an
 *  instrument that cannot be described must not be displayable either. */
const RULE_DISPLAY: Record<
  SettlementRule,
  { label: string; tone: string; optionSuffix: boolean }
> = {
  POINT: { label: "Point", tone: "badge-neutral", optionSuffix: false },
  DIFFERENCE: { label: "Spread", tone: "badge-blue", optionSuffix: true },
  CONVERGENCE: { label: "Convergence", tone: "badge-amber", optionSuffix: false },
  CONGESTION_CONVERGENCE: {
    label: "DA→RT congestion",
    tone: "badge-amber",
    optionSuffix: true,
  },
  AVERAGE: { label: "Window avg", tone: "badge-blue", optionSuffix: true },
};

/**
 * Display form of an instrument: what it is and how it settles.
 *
 * Returns null for an unknown code rather than inventing a description, so an
 * unrecognized instrument (a code the UI drifted past) is visible as missing
 * instead of labelled wrongly.
 */
export function instrumentInfo(code: string | null | undefined): InstrumentInfo | null {
  if (!code) return null;
  const def = getInstrument(code);
  if (!def) return null;
  const rule = RULE_DISPLAY[def.settlementRule];
  // An option can only pay out where an obligation pays both ways, so the
  // distinction belongs next to the rule that applies it.
  const optionSuffix =
    rule.optionSuffix && def.optionType === "OPTION" ? " · option" : "";
  return {
    code: def.code,
    shortLabel: def.shortLabel,
    label: def.label,
    rule: def.settlementRule,
    ruleLabel: `${rule.label}${optionSuffix}`,
    tone: rule.tone,
    legs: def.legs,
  };
}

/**
 * The settlement points a position sits on: a single point, or a path.
 *
 * `counter` is only rendered when the instrument actually has a second leg, so
 * a stale counter point on a single-leg row can never look like a spread.
 */
export function legsLabel(
  legA: string | null | undefined,
  legB: string | null | undefined
): string {
  if (!legA) return "—";
  return legB ? `${legA} → ${legB}` : legA;
}

export interface SourceInfo {
  label: string;
  tone: "live" | "sim" | "seed";
}

/**
 * How a data source is presented. The GENERATED token decides the tone: any
 * generated source is labelled as generated wherever it surfaces, per the
 * rule that invented prices must never wear ERCOT's name. ERCOT sources are
 * distinguished by whether they are the live feed or the historical corpus.
 */
export function sourceInfo(source: string | null | undefined): SourceInfo {
  if (source === "ERCOT_MIS") return { label: "ERCOT MIS", tone: "live" };
  if (source === "ERCOT_MIS_HISTORY")
    return { label: "ERCOT (history)", tone: "live" };
  if (source === "SEEDED (GENERATED)")
    return { label: "Retired synthetic seed (not ERCOT)", tone: "sim" };
  if (source && source.includes("GENERATED"))
    return { label: "Synthetic feed (not ERCOT)", tone: "sim" };
  if (source) return { label: source, tone: "live" };
  return { label: "No data", tone: "seed" };
}