/**
 * Only allow internal, same-origin relative redirects. Guards against open
 * redirects via query params like `?next=https://evil.com` or `//evil.com`.
 */
export function safeNextPath(
  value: string | null | undefined,
  fallback = "/dashboard"
): string {
  const raw = value?.trim() ?? "";
  if (
    raw.startsWith("/") &&
    !raw.startsWith("//") &&
    !raw.startsWith("/\\")
  ) {
    return raw;
  }
  return fallback;
}