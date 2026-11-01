import { redirect } from "next/navigation";
import { requireUser, getUserProfile, ensureUserRecords } from "@/lib/auth";
import { safeNextPath } from "@/lib/redirect";
import { ProfileForm } from "@/components/account/profile-form";
import { AvatarEditor } from "@/components/account/avatar-editor";

export const dynamic = "force-dynamic";

/**
 * First stop after sign-up: the trader chooses the name the desk and the
 * standings will show. Saving it (update_profile) marks the profile onboarded;
 * until then the shell sends the account back here.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: rawNext } = await searchParams;
  const next = safeNextPath(rawNext);
  const user = await requireUser();
  let profile = await getUserProfile(user.id).catch(() => null);
  if (!profile) {
    await ensureUserRecords(user);
    profile = await getUserProfile(user.id);
  }
  if (!profile) throw new Error("Your account could not be loaded.");
  if (profile.onboarded_at !== null) redirect(next);

  return (
    <div className="card p-0">
      <div className="border-b border-white/10 px-6 py-4">
        <p className="caption">Account created</p>
        <h1 className="card-title mt-1.5 mb-0">Choose your trader name</h1>
        <p className="mt-1.5 text-[12px] t-mute">
          Your $100,000 paper account is ready. Pick how other traders will
          see you. You can change any of this later in Settings.
        </p>
      </div>
      <div className="space-y-6 p-6">
        <div>
          <p className="label">Profile picture · optional</p>
          <AvatarEditor
            initialUrl={profile.avatar_url}
            name={profile.display_name ?? profile.username}
          />
        </div>
        <ProfileForm
          mode="welcome"
          next={next}
          initial={{
            username: profile.username,
            displayName: profile.display_name ?? "",
            leaderboardOptIn: profile.leaderboard_opt_in,
          }}
        />
      </div>
    </div>
  );
}
