import { createHash } from "node:crypto";
import type { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fail } from "@/lib/api";

/**
 * Per-subject request limits, counted in Postgres (rate_limit_hit, 0042) so
 * they hold across every serverless instance.
 *
 * Supabase Auth's own limits cannot do this job: sign-in runs server-side, so
 * Auth sees this app's address for every visitor. Its per-IP limit either
 * lumps all visitors together or, with enough function instances, is spread
 * thin enough to brute-force past. Only this layer knows who is asking.
 */

export interface Limit {
  name: string;
  max: number;
  windowSeconds: number;
}

export const LIMITS = {
  loginByIp: { name: "login-ip", max: 30, windowSeconds: 300 },
  loginByAttempt: { name: "login-attempt", max: 10, windowSeconds: 900 },
  // Above any real person's retries, so a stranger guessing at an address
  // slows down without being able to lock its owner out for long.
  loginByEmail: { name: "login-email", max: 30, windowSeconds: 900 },
  forgotByIp: { name: "forgot-ip", max: 10, windowSeconds: 900 },
  forgotByEmail: { name: "forgot-email", max: 3, windowSeconds: 3600 },
  accountEmail: { name: "account-email", max: 5, windowSeconds: 3600 },
  avatar: { name: "avatar", max: 10, windowSeconds: 3600 },
  // One ticket is up to 25 hours of 4 bid-curve steps: 100 requests.
  orders: { name: "orders", max: 120, windowSeconds: 60 },
  profile: { name: "profile", max: 20, windowSeconds: 60 },
  usernameCheck: { name: "username-check", max: 60, windowSeconds: 60 },
  publicRead: { name: "public-read", max: 120, windowSeconds: 60 },
  // An account's own book: each read replays up to its whole history.
  reads: { name: "reads", max: 60, windowSeconds: 60 },
  // A CSV of every trade: far heavier than a page of them.
  export: { name: "export", max: 6, windowSeconds: 60 },
} as const satisfies Record<string, Limit>;

/** A key that identifies the subject without storing who it is. */
export function rateLimitKey(limit: Limit, subject: string): string {
  const digest = createHash("sha256").update(subject).digest("base64url");
  return `${limit.name}:${digest}`;
}

/**
 * Count one request; true when it is over the limit.
 *
 * A failure here lets the request through: the limiter guards against abuse,
 * and an outage of it must not also take sign-in down.
 */
export async function overLimit(limit: Limit, subject: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin().rpc("rate_limit_hit", {
      p_key: rateLimitKey(limit, subject),
      p_max: limit.max,
      p_window_seconds: limit.windowSeconds,
    });
    if (error) throw new Error(error.message);
    return data === false;
  } catch (e) {
    console.error(`[rate-limit] ${limit.name}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

export function tooManyRequests(limit: Limit): NextResponse {
  return fail("Too many requests. Wait a little and try again.", 429, {
    "Retry-After": String(limit.windowSeconds),
  });
}

/** The visitor's address, as Vercel's edge reports it. */
export function clientIp(req: Request): string {
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
