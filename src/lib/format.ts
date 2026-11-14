import { parseDec, formatGrouped, formatMoneyAbs } from "@/lib/money";
import {
  getInstrument,
  unitForProduct,
  type SettlementRule,
} from "@/lib/ercot/types";
import type { VolumeUnit } from "@/lib/trading/accounting";

/** $1,234.56, or −$12.50: rounded to the cent and always shown to it, with
 *  the sign ahead of the currency symbol, as negative power prices (routine
 *  in ERCOT's west) are quoted. A value that rounds to zero is $0.00. */
export function usd(v: string | number | bigint, places = 2): string {
  const n = parseDec(v);
  const body = formatMoneyAbs(n, places);
  return n < 0n && /[1-9]/.test(body) ? `−$${body}` : `$${body}`;
}

/** +$1,234.56 / −$1,234.56 — the sign ahead of the currency symbol, for
 *  spreads and P&L where direction is the point. Zero is unsigned. */
export function signedUsd(v: string | number | bigint, places = 2): string {
  const n = parseDec(v);
  const body = `$${formatMoneyAbs(n, places)}`;
  if (!/[1-9]/.test(body)) return body;
  return n > 0n ? `+${body}` : `−${body}`;
}

/** 1,234.56 (no currency symbol) */
export function num(v: string | number | bigint, places = 2): string {
  return formatGrouped(parseDec(v), places);
}

/** Money from a raw bigint WITHOUT currency symbol. */
export function money(v: bigint, places = 2): string {
  return formatGrouped(v, places);
}

/**
 * The colour a figure takes: a gain "pos", a loss "neg", and nothing for zero
 * — a flat book is not a win. A decimal string is judged at the cent it is
 * shown to, so a figure that reads $0.00 is never coloured; a bigint or
 * number is compared with zero as it is.
 */
export function signTone(v: string | number | bigint): "pos" | "neg" | undefined {
  const n = typeof v === "string" ? Math.round(parseFloat(v) * 100) : v;
  if (typeof n === "number" && !Number.isFinite(n)) return undefined;
  return n > 0 ? "pos" : n < 0 ? "neg" : undefined;
}

/** Treat a value in basis points as a percent. 920 => "+9.20%" */
export function bpsToPercent(bps: number | bigint | string, signed = true): string {
  let v: number;
  if (typeof bps === "bigint") v = Number(bps);
  else if (typeof bps === "number") v = bps;
  else v = parseFloat(bps);
  // Whole basis points; the sign follows the rounded value, so a return of
  // a fraction of a basis point reads 0.00%, never −0.00%.
  const r = Number.isFinite(v) ? Math.round(v) : 0;
  // raw percent in scaled money units: pct = bps / 100
  const raw = (BigInt(r) * 1000000n) / 100n;
  const s = formatMoneyAbs(raw, 2);
  return `${r < 0 ? "−" : signed && r > 0 ? "+" : ""}${s}%`;
}

/**
 * A trade's side as an ERCOT desk says it: a virtual bought day-ahead is a
 * DEC and one sold is an INC; a PTP obligation is bought or sold as a path.
 * A settlement row is the position closing at delivery, not a new INC or DEC.
 */
export function tradeSideLabel(instrument: string, side: "BUY" | "SELL", status?: string): string {
  if (status === "SETTLED") return "SETTLE";
  if (instrument === "VIRTUAL") return side === "BUY" ? "DEC" : "INC";
  if (instrument === "PTP_OBLIGATION") return side === "BUY" ? "BUY PATH" : "SELL PATH";
  return side;
}

/** +1,234.56 / −1,234.56 — signed P&L with no currency symbol, rounded to
 *  the cent and always shown to it. One sign, never two. */
export function sign(v: string | bigint, places = 2): string {
  const n = typeof v === "bigint" ? v : parseDec(v);
  const body = formatMoneyAbs(n, places);
  if (!/[1-9]/.test(body)) return body;
  return `${n > 0n ? "+" : "−"}${body}`;
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

/** Time left on a deadline, as a desk reads it: "10h 32m", "45m". */
export function countdown(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
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