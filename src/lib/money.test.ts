import { describe, expect, it } from "vitest";
import { cents, div, format, parseDbDec, parseDec } from "@/lib/money";

describe("cents", () => {
  it("rounds to the cent half away from zero, as Postgres round(x, 2) does", () => {
    expect(format(cents(parseDec("-186.075")), 6)).toBe("-186.08");
    expect(format(cents(parseDec("186.075")), 6)).toBe("186.08");
    expect(format(cents(parseDec("14.2749")), 6)).toBe("14.27");
    expect(format(cents(parseDec("-0.004999")), 6)).toBe("0");
    expect(cents(parseDec("12.34"))).toBe(parseDec("12.34"));
  });
});

describe("div", () => {
  it("rounds to nearest whichever way the quotient points", () => {
    expect(format(div("2", "3"), 6)).toBe("0.666667");
    // A negative average entry price: truncating toward zero read -0.666666.
    expect(format(div("-2", "3"), 6)).toBe("-0.666667");
    expect(format(div("2", "-3"), 6)).toBe("-0.666667");
    expect(format(div("-2", "-3"), 6)).toBe("0.666667");
  });

  it("is symmetric about zero on an exact half", () => {
    expect(div("0.000001", "2")).toBe(1n);
    expect(div("-0.000001", "2")).toBe(-1n);
  });

  it("refuses to divide by zero", () => {
    expect(() => div("1", "0")).toThrow(/division by zero/);
  });
});

describe("parseDec (user input floor)", () => {
  it("accepts up to the fixed-point scale", () => {
    expect(format(parseDec("63.75"), 6)).toBe("63.75");
    expect(format(parseDec("500"), 6)).toBe("500");
    expect(format(parseDec("-8.5"), 6)).toBe("-8.5");
  });

  it("still rejects precision beyond the fixed point", () => {
    expect(() => parseDec("1.2345678")).toThrow(/too many decimal places/);
  });
});

describe("parseDbDec (PostgreSQL numeric boundary)", () => {
  it("parses values that already fit the fixed point", () => {
    expect(parseDbDec("63.75")).toBe(parseDec("63.75"));
    expect(parseDbDec("500")).toBe(parseDec("500"));
    expect(parseDbDec("-8.5")).toBe(parseDec("-8.5"));
    expect(parseDbDec("+12.5")).toBe(parseDec("12.5"));
  });

  it("rounds Postgres numeric division results instead of throwing", () => {
    // (500*60 + 300*70)/800 — Postgres divides to 16 significant digits and
    // keeps the trailing zeros: 63.7500000000000000
    expect(format(parseDbDec("63.7500000000000000"), 6)).toBe("63.75");
    // (100*52.1234 + 200*46.5678)/300 → 48.41966666666666666667
    expect(format(parseDbDec("48.41966666666666666667"), 6)).toBe("48.419667");
    // get_leaderboard returns: (equity - starting_cash)/starting_cash * 10000
    expect(format(parseDbDec("400.0000000000000000"), 6)).toBe("400");
  });

  it("rounds half up, carrying into the integer part", () => {
    expect(format(parseDbDec("1.9999996"), 6)).toBe("2");
    expect(format(parseDbDec("-1.9999996"), 6)).toBe("-2");
    expect(format(parseDbDec("0.0000004"), 6)).toBe("0");
  });

  it("tolerates numbers with binary floating-point noise", () => {
    // 0.1 + 0.2 === 0.30000000000000004
    expect(format(parseDbDec(0.1 + 0.2), 6)).toBe("0.3");
    expect(format(parseDbDec(1e-7), 6)).toBe("0");
  });

  it("rejects non-numeric input", () => {
    expect(() => parseDbDec("")).toThrow();
    expect(() => parseDbDec("not-a-number")).toThrow();
    expect(() => parseDbDec("1.2.3")).toThrow();
    expect(() => parseDbDec("12,5")).toThrow();
  });
});
