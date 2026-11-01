import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { passwordLinkStatus } from "@/lib/account";
import { ResetPasswordForm, RequestNewLink } from "./reset-password-form";

export const dynamic = "force-dynamic";

/**
 * Where an emailed password link lands (forgotten password, or "Change
 * password" in Settings). The form appears only for a session the link itself
 * opened, recently; the API enforces the same rule.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ link?: string }>;
}) {
  const { link } = await searchParams;
  const user = await getSessionUser().catch(() => null);
  const status = user ? await passwordLinkStatus() : null;

  let body: React.ReactNode;
  if (status?.ok) {
    body = (
      <ResetPasswordForm email={user?.email ?? ""} minutesLeft={Math.floor(status.secondsLeft / 60)} />
    );
  } else {
    const why =
      link === "invalid"
        ? "That link is invalid or has already been used. Links work once, for an hour, and only in the browser that asked for them."
        : status?.reason === "EXPIRED"
          ? "That link was opened too long ago. Ask for a fresh one to continue."
          : "Open the link we emailed you to choose a new password.";
    body = (
      <div className="space-y-4">
        <div className="note note-warn">{why}</div>
        {user ? (
          <RequestNewLink email={user.email ?? ""} />
        ) : (
          <Link href="/forgot-password" className="btn btn-primary w-full">
            Email me a new link
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="card p-0">
      <div className="border-b border-white/10 px-6 py-4">
        <h1 className="card-title mb-0">Choose a new password</h1>
        <p className="mt-1.5 text-[12px] t-mute">
          Confirmed by email, so only the owner of the inbox can change it.
        </p>
      </div>
      <div className="space-y-4 p-6">
        {body}
        <p className="border-t border-white/10 pt-4 text-[12px] t-mute">
          <Link href={user ? "/settings" : "/login"} className="t-accent hover:underline">
            {user ? "Back to settings" : "Back to sign in"}
          </Link>
        </p>
      </div>
    </div>
  );
}
