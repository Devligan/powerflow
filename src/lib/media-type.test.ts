import { describe, expect, it } from "vitest";
import { requiredMediaType } from "@/lib/media-type";

const h = (headers: Record<string, string>) => new Headers(headers);

describe("requiredMediaType (#71)", () => {
  it("never constrains a read", () => {
    expect(requiredMediaType("GET", "/api/orders", h({ "content-type": "text/plain" }))).toBeNull();
    expect(requiredMediaType("HEAD", "/api/orders", h({}))).toBeNull();
  });

  it("accepts JSON, with or without parameters", () => {
    expect(requiredMediaType("POST", "/api/orders", h({ "content-type": "application/json" }))).toBeNull();
    expect(
      requiredMediaType("POST", "/api/orders", h({ "content-type": "Application/JSON; charset=utf-8" }))
    ).toBeNull();
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/xml"])(
    "refuses %s on a JSON route",
    (type) => {
      expect(requiredMediaType("POST", "/api/orders", h({ "content-type": type }))).toBe("application/json");
      expect(requiredMediaType("DELETE", "/api/account", h({ "content-type": type }))).toBe("application/json");
    }
  );

  it("refuses a body sent with no type", () => {
    expect(requiredMediaType("POST", "/api/orders", h({ "content-length": "42" }))).toBe("application/json");
    expect(requiredMediaType("POST", "/api/orders", h({ "transfer-encoding": "chunked" }))).toBe(
      "application/json"
    );
  });

  it("lets a write with no body through", () => {
    expect(requiredMediaType("DELETE", "/api/orders/x", h({}))).toBeNull();
    expect(requiredMediaType("POST", "/api/account/password/link", h({ "content-length": "0" }))).toBeNull();
  });

  it("wants a multipart form for a picture upload, and nothing else", () => {
    expect(
      requiredMediaType("POST", "/api/account/avatar", h({ "content-type": "multipart/form-data; boundary=abc" }))
    ).toBeNull();
    expect(requiredMediaType("POST", "/api/account/avatar", h({ "content-type": "application/json" }))).toBe(
      "multipart/form-data"
    );
    expect(requiredMediaType("POST", "/api/account/avatar", h({ "content-type": "text/plain" }))).toBe(
      "multipart/form-data"
    );
    // Removing the picture has no body.
    expect(requiredMediaType("DELETE", "/api/account/avatar", h({}))).toBeNull();
  });
});
