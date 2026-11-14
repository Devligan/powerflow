/**
 * Which pages a signed-out visitor may see (src/proxy.ts enforces it). Kept
 * apart from the proxy so the rules are tested without a session or a
 * Supabase client: one wrong entry either exposes a desk page or locks a
 * friend out of a page they were sent.
 */

// The password pages explain an expired or cross-browser link themselves,
// so they must render for a visitor whose link did not sign them in.
export const PUBLIC_PATHS = [
  "/", "/login", "/signup", "/auth", "/privacy", "/terms",
  "/forgot-password", "/reset-password",
  // How the market works, readable before signing up.
  "/learn",
  // How fills, marks and settlement follow ERCOT, readable before signing up.
  "/methodology",
  // What the platform checks about itself: data freshness and the ledger.
  "/status",
];

// "/auth/" is a prefix, not a path: the OAuth and email-link callback
// (/auth/callback) is reached by a visitor who is not signed in *yet*, and
// sending them to /login would drop the code they arrived with.
export const PUBLIC_PREFIXES = ["/leaderboard", "/auth/"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Pages a signed-in trader is sent past, to the desk. */
export function sendsSignedInToDesk(pathname: string): boolean {
  return pathname === "/" || pathname === "/login" || pathname === "/signup";
}
