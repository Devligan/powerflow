import { NextResponse } from "next/server";
import { format } from "@/lib/money";

/** Money value as a human decimal string (consumer parses with parseDec). */
export const m = (n: bigint) => format(n, 6);

export function ok<T>(data: T, init?: number): NextResponse {
  return NextResponse.json(data, { status: init ?? 200 });
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * A failure the caller cannot act on: logged here, generic there. Database
 * and driver messages name tables, columns and constraints, so they stay in
 * the server log.
 */
export function serverError(context: string, cause: unknown, message = "Something went wrong. Please try again."): NextResponse {
  console.error(`[api] ${context}: ${cause instanceof Error ? cause.message : String(cause)}`);
  return fail(message, 500);
}

/**
 * A public, identical-for-everyone response the CDN may serve. These reads run
 * expensive queries with the service role and need no session, so without this
 * every anonymous request would reach the database.
 */
export function okPublic<T>(data: T, seconds = 30): NextResponse {
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
    },
  });
}

/** Constant-time secret comparison for cron/auth-shared secret checks. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

/** Parse and validate an ISO date string; returns null when malformed. */
export function parseIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}