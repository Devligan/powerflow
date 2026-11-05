/**
 * Whether a state-changing request came from another site.
 *
 * The session cookie's SameSite=Lax keeps it off cross-site POSTs, but two
 * things it does not cover: an unauthenticated route (a cross-site form can
 * POST a text/plain body that parses as JSON to /api/auth/login and sign a
 * visitor into the attacker's account), and a sibling subdomain, which counts
 * as same-site. Browsers state the true origin here and scripts cannot forge
 * it, so the answer is read from these headers.
 *
 * A request with neither header is not from a browser (a scheduler, curl): it
 * has no victim's cookies to abuse, and the routes it reaches do their own auth.
 */
export function isCrossSiteWrite(
  method: string,
  headers: { get(name: string): string | null }
): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;

  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;

  const origin = headers.get("origin");
  if (!origin) return false;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // Includes the literal "null" a sandboxed frame sends.
  }
}
