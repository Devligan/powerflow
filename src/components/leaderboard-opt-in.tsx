"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Join or leave the standings. The server records the change; the page
 * re-renders so the table reflects it at once.
 */
export function LeaderboardOptIn({ optedIn }: { optedIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/leaderboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optIn: !optedIn }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Could not update your standing");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update your standing");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card flex flex-wrap items-center justify-between gap-3">
      <p className="text-[13px] t-dim">
        {optedIn
          ? "You are listed in the standings. Only your name, picture and aggregate figures are shown."
          : "Your account is private, so you are not listed. Join to show your name and aggregate figures — never your positions or trades."}{" "}
        <Link href="/settings#profile" className="t-accent hover:underline">
          Edit your profile
        </Link>
      </p>
      <span className="flex items-center gap-2">
        {error && <span role="alert" className="text-[11px] t-short">{error}</span>}
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          aria-pressed={optedIn}
          className={optedIn ? "btn btn-sm" : "btn btn-primary btn-sm"}
        >
          {busy ? "Saving…" : optedIn ? "Leave the standings" : "Join the standings"}
        </button>
      </span>
    </div>
  );
}
