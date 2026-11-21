import { describe, expect, it } from "vitest";
import { OrderRequest, idempotencyKey } from "@/lib/trading/order-request";

const base = {
  marketId: "00000000-0000-4000-8000-000000000001",
  side: "BUY",
  quantityMwh: "10",
  deliveryStart: "2026-11-25T12:00:00.000Z",
  deliveryEnd: "2026-11-25T13:00:00.000Z",
};

const firstMessage = (body: Record<string, unknown>) => {
  const r = OrderRequest.safeParse({ ...base, ...body });
  return r.success ? null : r.error.issues[0]?.message;
};

describe("OrderRequest", () => {
  it("accepts a plain order", () => {
    expect(OrderRequest.safeParse(base).success).toBe(true);
    expect(OrderRequest.safeParse({ ...base, limitPrice: "-12.5" }).success).toBe(true);
  });

  // Each of these reached parseDec and threw, which the route turned into a 500.
  it.each(["1e2", "NaN", "0x10", "Infinity", "1,000", " 10", "-5", ""])(
    "refuses quantity %j as malformed, without throwing",
    (q) => {
      expect(() => OrderRequest.safeParse({ ...base, quantityMwh: q })).not.toThrow();
      expect(firstMessage({ quantityMwh: q })).toBe("Quantity must be a positive decimal number");
    }
  );

  it.each(["NaN", "1e3", "--5", "$20", ""])("refuses limit price %j as malformed, without throwing", (p) => {
    expect(() => OrderRequest.safeParse({ ...base, limitPrice: p })).not.toThrow();
    expect(firstMessage({ limitPrice: p })).toBe("Limit price must be a number");
  });

  it("still applies the bounds to well-formed numbers", () => {
    expect(firstMessage({ quantityMwh: "0" })).toBe("Quantity must be > 0 and <= 1000 MWh");
    expect(firstMessage({ quantityMwh: "1000.1" })).toBe("Quantity must be > 0 and <= 1000 MWh");
    expect(firstMessage({ limitPrice: "5000.01" })).toMatch(/^Limit price must be between/);
    expect(firstMessage({ limitPrice: "-250.01" })).toMatch(/^Limit price must be between/);
  });

  it("refuses a number sent as JSON number rather than a string", () => {
    expect(() => OrderRequest.safeParse({ ...base, quantityMwh: 1e2 })).not.toThrow();
    expect(OrderRequest.safeParse({ ...base, quantityMwh: 1e2 }).success).toBe(false);
  });

  it("bounds clientOrderId as the database does", () => {
    expect(OrderRequest.safeParse({ ...base, clientOrderId: "k".repeat(128) }).success).toBe(true);
    expect(OrderRequest.safeParse({ ...base, clientOrderId: "k".repeat(129) }).success).toBe(false);
    expect(OrderRequest.safeParse({ ...base, clientOrderId: "   " }).success).toBe(false);
  });
});

describe("idempotencyKey", () => {
  it("takes the header or the body, and none is no key", () => {
    expect(idempotencyKey("abc", undefined)).toEqual({ ok: true, key: "abc" });
    expect(idempotencyKey(null, "abc")).toEqual({ ok: true, key: "abc" });
    expect(idempotencyKey("abc", "abc")).toEqual({ ok: true, key: "abc" });
    expect(idempotencyKey(null, undefined)).toEqual({ ok: true, key: null });
    expect(idempotencyKey("  ", undefined)).toEqual({ ok: true, key: null });
  });

  it("refuses two different keys, and an overlong header", () => {
    expect(idempotencyKey("abc", "xyz").ok).toBe(false);
    expect(idempotencyKey("k".repeat(129), undefined).ok).toBe(false);
  });
});
