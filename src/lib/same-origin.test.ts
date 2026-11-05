import { describe, expect, it } from "vitest";
import { isCrossSiteWrite } from "@/lib/same-origin";

const req = (h: Record<string, string>) => new Headers({ host: "powerflow.example", ...h });

describe("isCrossSiteWrite", () => {
  it("never refuses a read", () => {
    expect(isCrossSiteWrite("GET", req({ origin: "https://evil.example" }))).toBe(false);
    expect(isCrossSiteWrite("HEAD", req({ "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("allows the app's own pages", () => {
    expect(
      isCrossSiteWrite("POST", req({ origin: "https://powerflow.example", "sec-fetch-site": "same-origin" }))
    ).toBe(false);
  });

  it("refuses another site, by either header", () => {
    expect(isCrossSiteWrite("POST", req({ origin: "https://evil.example" }))).toBe(true);
    expect(isCrossSiteWrite("POST", req({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossSiteWrite("DELETE", req({ "sec-fetch-site": "same-site" }))).toBe(true);
  });

  it("refuses a look-alike origin and a sandboxed frame", () => {
    expect(isCrossSiteWrite("POST", req({ origin: "https://powerflow.example.evil.example" }))).toBe(true);
    expect(isCrossSiteWrite("POST", req({ origin: "null" }))).toBe(true);
  });

  it("compares against the host the visitor used, behind the edge", () => {
    const h = req({ origin: "https://powerflow.example", "x-forwarded-host": "powerflow.example", host: "internal" });
    expect(isCrossSiteWrite("POST", h)).toBe(false);
  });

  it("lets a non-browser client through: it has no victim's cookies", () => {
    expect(isCrossSiteWrite("POST", req({}))).toBe(false);
  });
});
