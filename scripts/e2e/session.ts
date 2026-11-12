// A signed-in session against a deployed site, for the end-to-end checks
// (scripts/e2e/*.ts): @supabase/ssr's own cookies, carried on every request
// exactly as the browser would, plus the small helpers both checks share.
import { createServerClient } from "@supabase/ssr";
import type { Loose } from "./db";

export interface Response {
  status: number;
  json: Loose;
  text: string;
}

export type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

export async function signIn(site: string, email: string, password: string): Promise<Call> {
  const jar = new Map<string, string>();
  const ssr = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cs) => cs.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error } = await ssr.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in: ${error.message}`);

  return async (method, path, body) => {
    const res = await fetch(site + path, {
      method,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const value = pair.slice(i + 1);
      if (value) jar.set(pair.slice(0, i), value);
      else jar.delete(pair.slice(0, i));
    }
    const text = await res.text();
    let json: Loose = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
}

/** HE18 (17:00 Central) of an operating day, in UTC ms. */
export function he18(day: string): number {
  const [y, mo, d] = day.split("-").map(Number);
  return [5, 6].map((h) => Date.UTC(y, mo - 1, d, 17 + h)).find((t) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23", day: "numeric" }).formatToParts(t);
    return Number(parts.find((p) => p.type === "hour")!.value) === 17 && Number(parts.find((p) => p.type === "day")!.value) === d;
  })!;
}

/** A named pass/fail list, printed at the end; the exit code is whether all passed. */
export function checklist() {
  const results: Array<[string, boolean, string]> = [];
  return {
    check: (name: string, ok: boolean, detail = "") => void results.push([name, ok, detail]),
    report(): never {
      for (const [name, ok, detail] of results) console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
      // Exit even if a connection was left open by a failure.
      process.exit(results.every(([, ok]) => ok) ? 0 : 1);
    },
  };
}
