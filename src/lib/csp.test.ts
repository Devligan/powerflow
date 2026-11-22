import { describe, expect, it } from "vitest";
import { API_CONTENT_SECURITY_POLICY, contentSecurityPolicy, newNonce } from "@/lib/csp";

const directives = (policy: string) =>
  new Map(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)] as const));

describe("contentSecurityPolicy (#72)", () => {
  const policy = directives(contentSecurityPolicy("abc123", "https://proj.supabase.co"));

  it("runs only scripts carrying this response's nonce", () => {
    expect(policy.get("script-src")).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
  });

  it("never allows inline or eval'd script", () => {
    const all = [...policy.values()].flat();
    expect(policy.get("script-src")).not.toContain("'unsafe-inline'");
    expect(all).not.toContain("'unsafe-eval'");
  });

  it("keeps framing, plugins, <base> and off-site forms shut", () => {
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
  });

  it("fetches only from this app and its Supabase project", () => {
    expect(policy.get("connect-src")).toEqual(["'self'", "https://proj.supabase.co"]);
    expect(directives(contentSecurityPolicy("n", undefined)).get("connect-src")).toEqual(["'self'"]);
  });

  it("gives API answers nothing to load", () => {
    expect(API_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});

describe("newNonce", () => {
  it("is 128 bits of base64, new every time", () => {
    const nonces = new Set(Array.from({ length: 50 }, newNonce));
    expect(nonces.size).toBe(50);
    for (const n of nonces) {
      expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    }
  });
});
