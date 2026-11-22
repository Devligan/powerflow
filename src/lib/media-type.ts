/**
 * Which content type a write to the API must carry, or null when it is fine.
 *
 * Every write route reads JSON, except a picture upload, which is a
 * multipart form. Nothing else is accepted (#71): text/plain,
 * application/x-www-form-urlencoded and multipart/form-data are what an HTML
 * form can send to another site without a CORS preflight, so a JSON route
 * that parsed them anyway would leave cross-site forgery to the Origin check
 * and SameSite alone. Requiring the type a form cannot send is the further
 * layer OWASP's CSRF guidance recommends.
 *
 * A write with no body (cancel an order, sign out other devices) sends no
 * type, and needs none.
 */
export function requiredMediaType(
  method: string,
  pathname: string,
  headers: { get(name: string): string | null }
): string | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const expected =
    pathname === "/api/account/avatar" && method === "POST" ? "multipart/form-data" : "application/json";

  const raw = headers.get("content-type");
  if (raw === null) {
    const length = headers.get("content-length");
    const hasBody = headers.get("transfer-encoding") !== null || (length !== null && length !== "0");
    return hasBody ? expected : null;
  }
  const type = raw.split(";")[0].trim().toLowerCase();
  return type === expected ? null : expected;
}
