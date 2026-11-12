"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LocalClock } from "@/components/ui/clock";

/**
 * What "now" is on the live desk: the wall clock, always (0053). The live
 * account trades today's market as ERCOT publishes it; replaying a past day
 * happens on the practice desk or a challenge desk, each with its own
 * $100,000, so practice never moves this balance.
 */
export function LiveDeskCard() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function practise() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/desk", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desk: "PRACTICE" }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? "Could not open the practice desk.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not open the practice desk.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="caption t-mute">Clock</div>
          <div className="mono text-lg font-medium">
            <LocalClock />
            <span className="ml-2 badge badge-green">LIVE</span>
          </div>
          <div className="hint t-mute">
            Your live account trades today&apos;s market as ERCOT publishes it. To replay a past day,
            use the practice desk: its own $100,000 and clock, so nothing there touches this balance.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-sm" disabled={busy} onClick={practise}>
            Practise a past day
          </button>
          <Link href="/challenges" className="btn btn-sm">
            Challenges
          </Link>
        </div>
      </div>
      {error && <p className="hint neg mt-2">{error}</p>}
    </section>
  );
}
