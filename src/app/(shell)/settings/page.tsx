import Link from "next/link";
import { requireUser, getUserProfile } from "@/lib/auth";
import { centralDate, dateTime } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { AvatarEditor } from "@/components/account/avatar-editor";
import { ProfileForm } from "@/components/account/profile-form";
import {
  DeleteAccount,
  EmailChange,
  PasswordChange,
  PrivacyToggle,
  SignOutOthers,
} from "./settings-sections";

export const dynamic = "force-dynamic";

const PROVIDER_NAMES: Record<string, string> = {
  email: "Email and password",
  google: "Google",
  github: "GitHub",
  apple: "Apple",
  discord: "Discord",
  gitlab: "GitLab",
  slack_oidc: "Slack",
};

function Section({
  id,
  title,
  description,
  children,
  tone,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`card scroll-mt-24 ${tone === "danger" ? "border-[var(--short-line)]" : ""}`}
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div>
          <h2 id={`${id}-title`} className="card-title mb-0">
            {title}
          </h2>
          {description && (
            <p className="mt-2 text-[12px] leading-relaxed t-mute">{description}</p>
          )}
        </div>
        <div className="min-w-0 space-y-4">{children}</div>
      </div>
    </section>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; password?: string; link?: string }>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const profile = await getUserProfile(user.id);
  if (!profile) throw new Error("Your profile could not be loaded.");

  const name = profile.display_name ?? profile.username;
  const providers = Array.from(
    new Set((user.identities ?? []).map((i) => i.provider))
  );
  const hasPassword = providers.includes("email");
  const pendingEmail = user.new_email ?? null;

  // What an emailed link that brought the trader here did.
  let notice: { tone: "ok" | "warn" | "error"; text: string } | null = null;
  if (params.password === "changed") {
    notice = { tone: "ok", text: "Your password has been changed. Other devices were signed out." };
  } else if (params.link === "invalid") {
    notice = {
      tone: "error",
      text: "That link is invalid or has expired. Links work once, and only in the browser that asked for them.",
    };
  } else if (params.email === "confirmed" || params.link === "partial") {
    notice = pendingEmail
      ? {
          tone: "warn",
          text: `Confirmation received. Now follow the link sent to the other address to finish switching to ${pendingEmail}.`,
        }
      : { tone: "ok", text: `Your email address is now ${user.email}.` };
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader kicker="Account" title="Settings">
        Your profile, privacy and sign-in. Changes to your email and password
        are confirmed by email before they take effect.
      </PageHeader>

      {notice && (
        <div role="status" className={`note note-${notice.tone}`}>
          {notice.text}
        </div>
      )}

      <nav aria-label="Settings sections" className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        {[
          ["profile", "Profile"],
          ["privacy", "Privacy"],
          ["sign-in", "Sign-in & security"],
          ["data", "Your data"],
          ["delete", "Delete account"],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="t-dim hover:underline">
            {label}
          </a>
        ))}
      </nav>

      <Section
        id="profile"
        title="Profile"
        description="How other traders see you on the standings."
      >
        <AvatarEditor initialUrl={profile.avatar_url} name={name} />
        <ProfileForm
          mode="settings"
          initial={{
            username: profile.username,
            displayName: profile.display_name ?? "",
            leaderboardOptIn: profile.leaderboard_opt_in,
          }}
        />
      </Section>

      <Section
        id="privacy"
        title="Privacy"
        description={
          <>
            Your positions, trades and orders are never visible to anyone else,
            either way. See the <Link href="/privacy" className="hover:underline">privacy policy</Link>.
          </>
        }
      >
        <PrivacyToggle listed={profile.leaderboard_opt_in} />
      </Section>

      <Section
        id="sign-in"
        title="Sign-in & security"
        description="Both changes are confirmed through your inbox."
      >
        <EmailChange email={user.email ?? ""} pendingEmail={pendingEmail} />
        <div className="border-t border-white/10 pt-4">
          <PasswordChange email={user.email ?? ""} hasPassword={hasPassword} />
        </div>
        <div className="border-t border-white/10 pt-4">
          <p className="label">Sign-in methods</p>
          <ul className="space-y-1 text-[12.5px] t-dim">
            {providers.length === 0 ? (
              <li>Email and password</li>
            ) : (
              providers.map((p) => <li key={p}>{PROVIDER_NAMES[p] ?? p}</li>)
            )}
          </ul>
          <p className="mt-2 text-[11px] t-mute">
            Last sign-in {user.last_sign_in_at ? dateTime(user.last_sign_in_at) : "—"}.
          </p>
        </div>
        <div className="border-t border-white/10 pt-4">
          <SignOutOthers />
        </div>
      </Section>

      <Section id="data" title="Your data" description="A copy of your activity, any time.">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[12.5px]">
          <dt className="t-mute">Member since</dt>
          <dd className="mono">{centralDate(profile.created_at)}</dd>
          <dt className="t-mute">Account ID</dt>
          <dd className="mono truncate t-dim">{user.id}</dd>
        </dl>
        <a href="/api/trades/export" className="btn btn-sm inline-flex">
          Download trade blotter (CSV)
        </a>
      </Section>

      <Section
        id="delete"
        title="Delete account"
        tone="danger"
        description="Permanent. There is no undo and no recovery."
      >
        <DeleteAccount username={profile.username} />
      </Section>
    </div>
  );
}
