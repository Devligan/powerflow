/**
 * Profile rules, mirrored from `update_profile` (0035) so forms can say what
 * is wrong before a round trip. The database is still the authority: these
 * checks only ever reject what it would also reject.
 *
 * Browser-safe: imported by the settings and welcome forms.
 */

export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
export const DISPLAY_NAME_MAX = 40;

/** Names nobody can switch to (an account already holding one keeps it). */
export const RESERVED_USERNAMES: readonly string[] = [
  "admin", "administrator", "root", "support", "help", "system", "staff",
  "moderator", "mod", "official", "security", "api", "null", "undefined",
  "settings", "account", "powerflow", "ercot",
];

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Why a username would be refused, or null if it is acceptable. */
export function usernameProblem(raw: string, current?: string | null): string | null {
  const u = normalizeUsername(raw);
  if (!USERNAME_PATTERN.test(u)) {
    return "3–30 characters: lowercase letters, digits and underscores.";
  }
  if (u !== current && RESERVED_USERNAMES.includes(u)) {
    return "That name is reserved.";
  }
  return null;
}

/** Whitespace runs collapse to one space, as the database stores it. */
export function normalizeDisplayName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function displayNameProblem(raw: string): string | null {
  const d = normalizeDisplayName(raw);
  // Code points, like Postgres char_length — not UTF-16 units.
  const len = [...d].length;
  if (len < 1) return "Enter the name other traders will see.";
  if (len > DISPLAY_NAME_MAX) return `At most ${DISPLAY_NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(d)) return "That name contains characters that cannot be shown.";
  return null;
}

/** The database's refusal codes, in words. */
export function describeProfileError(message: string): string {
  if (message.includes("USERNAME_TAKEN")) return "That username is already taken.";
  if (message.includes("USERNAME_RESERVED")) return "That name is reserved.";
  if (message.includes("USERNAME_INVALID")) {
    return "Usernames are 3–30 characters: lowercase letters, digits and underscores.";
  }
  if (message.includes("DISPLAY_NAME_INVALID")) {
    return `Display names are 1–${DISPLAY_NAME_MAX} characters.`;
  }
  return "Your profile could not be saved. Please try again.";
}

/** Up to two initials for an avatar placeholder. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/[\s_.-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const second = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + second).toUpperCase();
}

/* ---------------------------------------------------------------------
 * Avatars
 * ------------------------------------------------------------------- */

/** The bucket's own limit (0035); the client resizes well under it. */
export const AVATAR_MAX_BYTES = 1024 * 1024;
/** Edge length the client crops and scales a picture to. */
export const AVATAR_SIZE = 256;

export type AvatarType = "image/png" | "image/jpeg" | "image/webp";

/**
 * The image type from the file's own bytes. The declared Content-Type is the
 * uploader's claim; the magic number is what the file is. Anything else
 * (SVG, which can carry script, among them) is refused.
 */
export function sniffImageType(bytes: Uint8Array): AvatarType | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  // "RIFF" <size> "WEBP"
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

export function avatarExtension(type: AvatarType): string {
  return type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp";
}

/**
 * The object path inside the avatars bucket that a stored picture URL points
 * at, or null for anything else (an OAuth provider's picture, a foreign URL).
 * Pictures are named randomly, never by user id: the URL is public, and it
 * must not be a way to learn who an account is.
 */
export function avatarPathFromUrl(
  url: string | null | undefined,
  bucket = "avatars",
  /** This project's Supabase origin: only its own URLs name our files. */
  storageOrigin?: string
): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (storageOrigin && parsed.origin !== new URL(storageOrigin).origin) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  if (!parsed.pathname.startsWith(marker)) return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname.slice(marker.length));
  } catch {
    return null;
  }
  // The bucket is flat, so a real object has no separators in its name.
  return path && !/[/\\]|\.\./.test(path) ? path : null;
}

/* ---------------------------------------------------------------------
 * Password changes
 * ------------------------------------------------------------------- */

export const PASSWORD_MIN = 8;

/**
 * How long after following an emailed password link the new password may be
 * set. The link signs the browser in with a `recovery` session; past this
 * window the trader asks for a fresh link, so an unattended session cannot be
 * used to change the password.
 */
export const PASSWORD_LINK_WINDOW_S = 30 * 60;

interface AmrEntry {
  method?: string;
  timestamp?: number;
}

/**
 * Seconds since this session was established through an emailed recovery
 * link, from the access token's `amr` claim, or null if it never was.
 */
export function recoveryAgeSeconds(amr: unknown, nowS: number): number | null {
  if (!Array.isArray(amr)) return null;
  const stamps = (amr as AmrEntry[])
    .filter((e) => e?.method === "recovery" && typeof e.timestamp === "number")
    .map((e) => e.timestamp as number);
  if (stamps.length === 0) return null;
  return Math.max(0, nowS - Math.max(...stamps));
}
