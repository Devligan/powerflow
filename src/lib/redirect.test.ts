import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/redirect";

describe("safeNextPath", () => {
  it("keeps an internal path, query included", () => {
    expect(safeNextPath("/markets/HB_NORTH?product=DAM_HOURLY")).toBe(
      "/markets/HB_NORTH?product=DAM_HOURLY"
    );
  });

  it("falls back on anything absent or absolute", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
    expect(safeNextPath("https://evil.example")).toBe("/dashboard");
    expect(safeNextPath("javascript:alert(1)")).toBe("/dashboard");
  });

  it("refuses protocol-relative forms", () => {
    expect(safeNextPath("//evil.example")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.example")).toBe("/dashboard");
  });

  // Each of these passes a prefix check, and a URL parser or browser then
  // strips the control character or folds the backslash into //evil.example.
  it.each(["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\\/evil.example", "/x\\..\\/evil.example"])(
    "refuses %j, which a URL parser would resolve off-site",
    (input) => {
      expect(safeNextPath(input)).toBe("/dashboard");
    }
  );

  it("never returns a path that resolves to another origin", () => {
    for (const input of ["/\t/evil.example", "/ /evil.example", "/%09/evil.example", "/.//evil.example"]) {
      const resolved = new URL(safeNextPath(input), "https://powerflow.example");
      expect(resolved.origin).toBe("https://powerflow.example");
    }
  });
});
