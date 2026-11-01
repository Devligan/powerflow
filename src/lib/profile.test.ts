import { describe, it, expect } from "vitest";
import {
  displayNameProblem,
  describeProfileError,
  initials,
  normalizeDisplayName,
  recoveryAgeSeconds,
  sniffImageType,
  usernameProblem,
} from "@/lib/profile";

describe("username rules (mirror of update_profile)", () => {
  it("accepts the stored format after normalising", () => {
    expect(usernameProblem("  Desk_Alpha ")).toBeNull();
  });
  it("refuses the wrong length or characters", () => {
    expect(usernameProblem("ab")).not.toBeNull();
    expect(usernameProblem("a".repeat(31))).not.toBeNull();
    expect(usernameProblem("desk-alpha")).not.toBeNull();
    expect(usernameProblem("désk")).not.toBeNull();
  });
  it("refuses a reserved name unless it is already yours", () => {
    expect(usernameProblem("admin")).toMatch(/reserved/);
    expect(usernameProblem("admin", "admin")).toBeNull();
  });
});

describe("display name rules", () => {
  it("collapses whitespace like the database", () => {
    expect(normalizeDisplayName("  Alpha \n  Trader ")).toBe("Alpha Trader");
  });
  it("counts code points, not UTF-16 units", () => {
    expect(displayNameProblem("⚡".repeat(40))).toBeNull();
    expect(displayNameProblem("😀".repeat(40))).toBeNull();
    expect(displayNameProblem("😀".repeat(41))).not.toBeNull();
  });
  it("refuses an empty name", () => {
    expect(displayNameProblem("   ")).not.toBeNull();
  });
});

describe("describeProfileError", () => {
  it("maps the database codes", () => {
    expect(describeProfileError("USERNAME_TAKEN")).toMatch(/taken/);
    expect(describeProfileError("something else")).toMatch(/could not be saved/);
  });
});

describe("initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Alpha Bravo Trader")).toBe("AT");
    expect(initials("desk_alpha")).toBe("DA");
    expect(initials("")).toBe("?");
  });
});

describe("sniffImageType", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
  it("recognises PNG, JPEG and WebP by magic number", () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    const webp = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);
    expect(sniffImageType(webp)).toBe("image/webp");
  });
  it("refuses anything else, SVG included", () => {
    expect(sniffImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });
});

describe("recoveryAgeSeconds", () => {
  it("reads the newest recovery entry", () => {
    const amr = [
      { method: "password", timestamp: 100 },
      { method: "recovery", timestamp: 900 },
    ];
    expect(recoveryAgeSeconds(amr, 1000)).toBe(100);
  });
  it("is null for a session that never followed a link", () => {
    expect(recoveryAgeSeconds([{ method: "password", timestamp: 1 }], 10)).toBeNull();
    expect(recoveryAgeSeconds(undefined, 10)).toBeNull();
  });
});
