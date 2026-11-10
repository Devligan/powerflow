import { supabaseAdmin } from "@/lib/supabase/admin";
import { getSessionUser, getUserProfile } from "@/lib/auth";
import { ok, fail } from "@/lib/api";
import { AVATAR_BUCKET, removeAvatarAt } from "@/lib/account";
import { AVATAR_MAX_BYTES, avatarExtension, sniffImageType } from "@/lib/profile";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Upload a profile picture.
 *
 * The browser crops and scales the picture to a small square before sending
 * it (which also drops its EXIF metadata, location included); this handler
 * trusts none of that. It checks the size and the file's actual bytes, stores
 * it with the service role (the bucket has no write policies), and records the
 * public URL via set_profile_avatar, which a user session cannot call (0035).
 *
 * The file gets a random name, not the user's id: its URL is public on the
 * standings, and must not reveal who an account is.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  if (await overLimit(LIMITS.avatar, user.id)) return tooManyRequests(LIMITS.avatar);

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return fail("Attach an image as `file`.", 422);
  if (file.size > AVATAR_MAX_BYTES) return fail("Pictures must be 1 MB or smaller.", 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) return fail("Use a PNG, JPEG or WebP picture.", 415);

  const previous = (await getUserProfile(user.id))?.avatar_url ?? null;
  const path = `${crypto.randomUUID()}.${avatarExtension(type)}`;
  const admin = supabaseAdmin();
  const storage = admin.storage.from(AVATAR_BUCKET);
  const { error: upError } = await storage.upload(path, bytes, {
    contentType: type,
    // Every upload has a new name, so a cached copy is never stale; but a
    // removed picture should stop being served soon, so the CDN keeps it for
    // an hour, not a year.
    cacheControl: "3600",
    upsert: false,
  });
  if (upError) return fail("The picture could not be stored. Please try again.", 502);

  const avatarUrl = storage.getPublicUrl(path).data.publicUrl;
  const { error } = await admin.rpc("set_profile_avatar", {
    p_user_id: user.id,
    p_avatar_url: avatarUrl,
  });
  if (error) {
    await storage.remove([path]);
    return fail("The picture could not be saved to your profile.", 500);
  }

  await removeAvatarAt(previous);
  return ok({ avatarUrl });
}

/** Remove the profile picture; initials are shown instead. */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  const previous = (await getUserProfile(user.id))?.avatar_url ?? null;
  const { error } = await supabaseAdmin().rpc("set_profile_avatar", {
    p_user_id: user.id,
    p_avatar_url: null,
  });
  if (error) return fail("The picture could not be removed.", 500);
  await removeAvatarAt(previous);
  return ok({ avatarUrl: null });
}
