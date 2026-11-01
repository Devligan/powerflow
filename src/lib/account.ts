import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  PASSWORD_LINK_WINDOW_S,
  avatarPathFromUrl,
  recoveryAgeSeconds,
} from "@/lib/profile";

/**
 * Server-side account helpers shared by the settings routes and pages.
 *
 * The session cookies are httpOnly, so the browser cannot call Supabase Auth
 * itself: every change to an email, a password or a session goes through a
 * route handler here, using the request's own session.
 */

export const AVATAR_BUCKET = "avatars";

/** Where an emailed auth link lands: the callback, then `next`. */
export function authCallbackUrl(req: Request, next: string): string {
  const origin = new URL(req.url).origin;
  return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

/**
 * Whether this session may set a new password now: it must have been opened
 * by an emailed password link within the window. Read from the verified
 * token's `amr` claim, so neither the browser nor a stale page can assert it.
 */
export async function passwordLinkStatus(): Promise<
  { ok: true; secondsLeft: number } | { ok: false; reason: "NO_LINK" | "EXPIRED" }
> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return { ok: false, reason: "NO_LINK" };
  const age = recoveryAgeSeconds(data.claims.amr, Math.floor(Date.now() / 1000));
  if (age == null) return { ok: false, reason: "NO_LINK" };
  if (age > PASSWORD_LINK_WINDOW_S) return { ok: false, reason: "EXPIRED" };
  return { ok: true, secondsLeft: PASSWORD_LINK_WINDOW_S - age };
}

/**
 * Delete the stored file behind a picture URL (on replace, removal or account
 * deletion). A URL that is not in our bucket — an OAuth provider's picture —
 * has nothing of ours to delete.
 */
export async function removeAvatarAt(url: string | null | undefined): Promise<void> {
  const path = avatarPathFromUrl(url, AVATAR_BUCKET);
  if (!path) return;
  await supabaseAdmin().storage.from(AVATAR_BUCKET).remove([path]);
}
