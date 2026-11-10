/**
 * Exact fixed-point decimal arithmetic using bigint.
 *
 * Convention: every money/quantity value is stored internally as a bigint
 * scaled by 1e6 (SCALE). `parseDec()` converts human values (string / number)
 * into that internal form. bigints are already internal and pass straight
 * through. The authoritative accounting lives in the PostgreSQL `execute_trade`
 * RPC (numeric); this module gives the same exactness for previews, analytics
 * and tests — never IEEE-754 floating point for money math.
 */

const SCALE = 1000000n; // 6 decimal places
export const DECIMAL_PLACES = 6;

export type Num = string | number | bigint;

/** Convert a human value to the internal scaled bigint. bigint passes through. */
export function parseDec(input: Num): bigint {
  if (typeof input === "bigint") return input;
  const s = typeof input === "number" ? String(input) : input.trim();
  if (!s) throw new Error("empty decimal value");

  const neg = s.startsWith("-");
  const unsigned = neg || s.startsWith("+") ? s.slice(1) : s;
  if (!unsigned) throw new Error(`invalid decimal value: ${input}`);

  let digits: string;
  if (unsigned.includes(".")) {
    const parts = unsigned.split(".");
    if (parts.length > 2) throw new Error(`invalid decimal value: ${input}`);
    const [int, frac] = parts;
    if (frac.length > DECIMAL_PLACES) {
      throw new Error(`too many decimal places (${s}): max ${DECIMAL_PLACES}`);
    }
    digits = int + frac.padEnd(DECIMAL_PLACES, "0");
  } else {
    digits = unsigned + "0".repeat(DECIMAL_PLACES);
  }
  if (!/^\d+$/.test(digits)) throw new Error(`invalid decimal value: ${input}`);
  const n = BigInt(digits);
  return neg ? -n : n;
}

/**
 * Parse a value read back from PostgreSQL.
 *
 * Postgres `numeric` is unconstrained: it keeps whatever scale the value has,
 * and arithmetic results routinely exceed the 6 decimals this project fixes
 * on (a weighted-average entry price like (500*60 + 300*70)/800, or any
 * division-based return, can come back with 16+ decimals). Routing those
 * through `parseDec` would throw `too many decimal places`, so DB-sourced
 * money is rounded (half up) onto the internal fixed point here instead.
 *
 * Use `parseDec` for user input, where over-precision should be rejected.
 */
export function parseDbDec(input: Num): bigint {
  if (typeof input === "bigint") return input;
  let s = typeof input === "number" ? String(input) : input.trim();
  if (!s) throw new Error("empty decimal value");

  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // Number#toString emits exponent form for very small magnitudes.
  if (/[eE]/.test(s)) {
    const n = Math.abs(Number(s));
    if (!Number.isFinite(n)) throw new Error(`invalid decimal value: ${input}`);
    s = n.toFixed(DECIMAL_PLACES);
  }

  const parts = s.split(".");
  if (parts.length > 2) throw new Error(`invalid decimal value: ${input}`);
  const [int = "", frac = ""] = parts;
  if ((int === "" && frac === "") || !/^\d*$/.test(int) || !/^\d*$/.test(frac)) {
    throw new Error(`invalid decimal value: ${input}`);
  }

  let scaled = BigInt(int + frac.padEnd(DECIMAL_PLACES, "0").slice(0, DECIMAL_PLACES));
  if (frac.length > DECIMAL_PLACES && frac.charAt(DECIMAL_PLACES) >= "5") {
    scaled += 1n;
  }
  return neg ? -scaled : scaled;
}

function asRaw(n: Num): bigint {
  return typeof n === "bigint" ? n : parseDec(n);
}

export function add(a: Num, b: Num): bigint {
  return asRaw(a) + asRaw(b);
}

export function sub(a: Num, b: Num): bigint {
  return asRaw(a) - asRaw(b);
}

/** Exactly multiply two scaled values. */
export function mul(a: Num, b: Num): bigint {
  return (asRaw(a) * asRaw(b)) / SCALE;
}

/** Multiply a scaled value by an integer scalar. */
export function mulScalar(a: Num, k: number | bigint): bigint {
  return asRaw(a) * BigInt(k);
}

/** Exactly divide two scaled values, rounded to nearest (half away from zero,
 *  as `parseDbDec` rounds). bigint division truncates toward zero, so rounding
 *  works on magnitudes: a negative average price must not drift up. */
export function div(a: Num, b: Num): bigint {
  const den = asRaw(b);
  if (den === 0n) throw new Error("division by zero");
  const num = asRaw(a) * SCALE;
  const rounded = (abs(num) + abs(den) / 2n) / abs(den);
  return num < 0n !== den < 0n ? -rounded : rounded;
}

export function negate(n: bigint): bigint {
  return -n;
}

export function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export function isZero(n: bigint): boolean {
  return n === 0n;
}

export function gt(a: Num, b: Num): boolean {
  return asRaw(a) > asRaw(b);
}

export function lt(a: Num, b: Num): boolean {
  return asRaw(a) < asRaw(b);
}

export function gte(a: Num, b: Num): boolean {
  return asRaw(a) >= asRaw(b);
}

export function lte(a: Num, b: Num): boolean {
  return asRaw(a) <= asRaw(b);
}

export function eq(a: Num, b: Num): boolean {
  return asRaw(a) === asRaw(b);
}

/** Render an internal value to a string with at most `places` decimals. */
export function format(n: bigint, places = 2): string {
  const neg = n < 0n;
  const absN = neg ? -n : n;
  const int = absN / SCALE;
  let frac = (absN % SCALE).toString().padStart(DECIMAL_PLACES, "0");
  if (places < DECIMAL_PLACES) frac = frac.slice(0, places);
  frac = frac.replace(/0+$/, "");
  const body = frac.length > 0 ? `${int}.${frac}` : `${int}`;
  return neg ? `-${body}` : body;
}

/** Grouped thousands formatting of the integer part. */
export function formatGrouped(n: bigint, places = 2): string {
  const neg = n < 0n;
  const absN = neg ? -n : n;
  const int = (absN / SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (absN % SCALE).toString().padStart(DECIMAL_PLACES, "0");
  if (places < DECIMAL_PLACES) frac = frac.slice(0, places);
  frac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac.length > 0 ? `.${frac}` : ""}`;
}

/**
 * Money for display: rounded half away from zero to `places`, always shown to
 * that many decimals and grouped — $9.20, not $9.2; +134.93, not +134.92 —
 * the way a desk quotes $/MWh and P&L. Unsigned: callers put the sign where
 * it belongs (ahead of a currency symbol).
 */
export function formatMoneyAbs(n: bigint, places = 2): string {
  const p = Math.max(0, Math.min(places, DECIMAL_PLACES));
  const absN = n < 0n ? -n : n;
  const unit = 10n ** BigInt(DECIMAL_PLACES - p);
  const rounded = (absN + unit / 2n) / unit; // in units of 10^-p
  const scale = 10n ** BigInt(p);
  const int = (rounded / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = p > 0 ? `.${(rounded % scale).toString().padStart(p, "0")}` : "";
  return `${int}${frac}`;
}

export { SCALE };