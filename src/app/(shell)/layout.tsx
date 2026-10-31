import Link from "next/link";
import { getSessionUser, ensureUserRecords, getUserProfile } from "@/lib/auth";
import { Nav } from "@/components/nav";
import { SetupBanner } from "@/components/setup-banner";

export default async function ShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser().catch(() => null);
  let profile = null;
  if (user) {
    profile = await getUserProfile(user.id).catch(() => null);
    if (!profile) {
      // Not swallowed: this throws if the user really has no account, so a
      // broken bootstrap surfaces instead of rendering an empty shell.
      await ensureUserRecords(user);
      profile = await getUserProfile(user.id).catch(() => null);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SetupBanner />
      <Nav
        user={Boolean(user)}
        displayName={profile?.display_name ?? profile?.username ?? ""}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-7">
        {children}
      </main>
      <footer className="border-t border-white/10 bg-[var(--ink-panel)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="caption">
            PowerFlow · paper trading desk · no real orders or money ·{" "}
            <Link href="/privacy" className="hover:underline">Privacy</Link> ·{" "}
            <Link href="/terms" className="hover:underline">Terms</Link>
          </p>
          <p className="caption">
            All timestamps UTC · prices are actual ERCOT MIS publications
          </p>
        </div>
      </footer>
    </div>
  );
}
