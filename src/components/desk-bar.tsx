"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { DeskKind } from "@/lib/desk";

/**
 * Which account the desk is trading: the live one, the practice desk (its
 * own $100,000 and clock, created on first use), or a challenge's desk.
 * Every desk page reads the choice server-side, so switching is a cookie and
 * a refresh.
 */
export function DeskBar({
  kind,
  challenge,
}: {
  kind: DeskKind;
  challenge: { slug: string; title: string } | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(desk: "LIVE" | "PRACTICE") {
    if (busy || desk === kind) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/desk", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desk }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? "Could not switch desks.");
        return;
      }
      // The practice day lives on the desk page.
      if (desk === "PRACTICE" && pathname !== "/dashboard") router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Could not switch desks.");
    } finally {
      setBusy(false);
    }
  }

  const away = kind !== "LIVE";
  return (
    <div className={`border-b ${away ? "border-amber-400/30 bg-amber-400/[0.06]" : "border-white/5 bg-[var(--ink-panel)]"}`}>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
        <span className="caption t-mute">Trading</span>
        <div role="group" aria-label="Desk" className="flex overflow-hidden rounded border border-white/10">
          {(["LIVE", "PRACTICE"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={kind === d}
              disabled={busy}
              onClick={() => choose(d)}
              className={`caption px-2.5 py-1 ${kind === d ? (d === "PRACTICE" ? "bg-amber-400/20 t-accent" : "bg-white/10") : "t-mute hover:bg-white/5"}`}
            >
              {d === "LIVE" ? "Live" : "Practice"}
            </button>
          ))}
          {kind === "CHALLENGE" && (
            <span aria-current="true" className="caption bg-amber-400/20 px-2.5 py-1 t-accent">
              Challenge
            </span>
          )}
        </div>
        <span className="caption t-mute">
          {kind === "PRACTICE"
            ? "Practice account: its own $100,000 and clock. Nothing here touches your live book or the standings."
            : kind === "CHALLENGE"
              ? `${challenge?.title ?? "Challenge"}: a fresh $100,000 desk on the challenge's days.`
              : "Your live account, on the standings if you opt in."}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <Link href="/learn" className="caption t-mute hover:underline">
            How it works
          </Link>
          <Link href={challenge ? `/challenges/${challenge.slug}` : "/challenges"} className="caption t-accent hover:underline">
            {challenge ? "Challenge standings →" : "Challenges →"}
          </Link>
        </span>
        {error && <span className="caption neg">{error}</span>}
      </div>
    </div>
  );
}
