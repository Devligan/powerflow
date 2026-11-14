import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "@/proxy";
import { isPublicPath, sendsSignedInToDesk } from "@/lib/route-access";

/**
 * Who may see what. Every page in src/app is classified here on purpose: a
 * new page fails this suite until someone decides whether a signed-out
 * visitor may open it.
 */
const PUBLIC = new Set([
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/privacy",
  "/terms",
  "/learn",
  "/engineering",
  "/status",
  "/leaderboard",
  "/challenges/[slug]",
]);
const SIGNED_IN = new Set([
  "/dashboard",
  "/markets",
  "/markets/[settlementPoint]",
  "/portfolio",
  "/positions",
  "/orders",
  "/trades",
  "/analytics",
  "/settings",
  "/challenges",
  "/welcome",
]);

/** Every page route under src/app, route groups removed. */
function pageRoutes(dir = join(process.cwd(), "src", "app")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...pageRoutes(path));
    else if (name === "page.tsx") {
      const rel = relative(join(process.cwd(), "src", "app"), dir)
        .split(sep)
        .filter((s) => s && !/^\(.*\)$/.test(s));
      out.push("/" + rel.join("/"));
    }
  }
  return out;
}

const sample = (route: string) => route.replace(/\[[^\]]+\]/g, "abcd2345");

describe("route access", () => {
  it("classifies every page, so a new one is a decision rather than an accident", () => {
    const routes = pageRoutes();
    // A walk that found nothing would pass the check below vacuously.
    expect(new Set(routes)).toEqual(new Set([...PUBLIC, ...SIGNED_IN]));
    const unclassified = routes.filter((r) => !PUBLIC.has(r) && !SIGNED_IN.has(r));
    expect(unclassified, "add each new page to PUBLIC or SIGNED_IN above").toEqual([]);
  });

  it("lets a signed-out visitor see exactly the public pages", () => {
    for (const route of PUBLIC) expect(isPublicPath(sample(route)), route).toBe(true);
    for (const route of SIGNED_IN) expect(isPublicPath(sample(route)), route).toBe(false);
  });

  it("keeps the OAuth callback public and sends a signed-in trader past the front door", () => {
    expect(isPublicPath("/auth/callback")).toBe(true);
    expect(isPublicPath("/challenges")).toBe(false);
    for (const p of ["/", "/login", "/signup"]) expect(sendsSignedInToDesk(p)).toBe(true);
    expect(sendsSignedInToDesk("/learn")).toBe(false);
    expect(sendsSignedInToDesk("/challenges/abcd2345")).toBe(false);
  });

  it("runs the proxy on every page, and never on the metadata files a crawler fetches", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const route of [...PUBLIC, ...SIGNED_IN]) expect(matcher.test(sample(route)), route).toBe(true);
    expect(matcher.test("/api/orders")).toBe(true);
    for (const path of [
      "/manifest.webmanifest",
      "/robots.txt",
      "/sitemap.xml",
      "/icon.svg",
      "/icon-app/192",
      "/apple-icon",
      "/opengraph-image",
      "/_next/static/chunks/x.js",
    ]) {
      expect(matcher.test(path), path).toBe(false);
    }
  });

  it("names no page /icon…, which the matcher would skip and so never protect", () => {
    expect(pageRoutes().filter((r) => r.startsWith("/icon"))).toEqual([]);
  });
});
