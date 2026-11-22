/**
 * The Content-Security-Policy, built per request (#72).
 *
 * Scripts run only with this response's nonce: Next attaches it to its own
 * scripts, and 'strict-dynamic' extends trust to the chunks they load. An
 * injected <script> or onerror= handler carries no nonce and does not run.
 * That is the backstop for the day an injection gets past React's escaping.
 * 'unsafe-inline' switched it off, and was only there for pages Next
 * prerendered. Every page now renders per request.
 *
 * Styles keep 'unsafe-inline': a nonce cannot cover style= attributes, and
 * CSS cannot run code.
 */
export function contentSecurityPolicy(nonce: string, supabaseUrl: string | undefined): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    // Avatars come from Supabase Storage or an OAuth provider's CDN.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${supabaseUrl ? ` ${supabaseUrl}` : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** API answers are JSON: they load nothing, and nothing may frame them. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

/** 128 random bits, base64: unguessable, and new for every response. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}
