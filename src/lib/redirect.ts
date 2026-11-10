const ORIGIN = "https://internal.invalid";

/**
 * Only allow internal, same-origin relative redirects. Guards against open
 * redirects via query params like `?next=https://evil.com` or `//evil.com`.
 *
 * A prefix check is not enough on its own: URL parsers strip tabs and newlines
 * and treat `\` as `/`, so `/<tab>/evil.com` becomes `//evil.com` after it has
 * passed. Those characters are refused, and the verdict comes from resolving
 * the path the same way a redirect will.
 */
export function safeNextPath(
  value: string | null | undefined,
  fallback = "/dashboard"
): string {
  const raw = value?.trim() ?? "";
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\u0000-\u001f\\]/.test(raw)) {
    return fallback;
  }
  try {
    return new URL(raw, ORIGIN).origin === ORIGIN ? raw : fallback;
  } catch {
    return fallback;
  }
}
