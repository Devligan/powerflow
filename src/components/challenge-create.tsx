"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { dayLabel } from "@/lib/challenge-schedule";

/** Start a challenge on recent, already-settled operating days. */
export function ChallengeCreate({ days, maxDays }: { days: string[]; maxDays: number }) {
  const router = useRouter();
  // Oldest first in the picker reads like a calendar; the newest settled day
  // that leaves room for a two-day run is the default start.
  const ordered = [...days].reverse();
  const [title, setTitle] = useState("");
  const [firstDay, setFirstDay] = useState(ordered[Math.max(0, ordered.length - 2)] ?? "");
  const [count, setCount] = useState(Math.min(2, ordered.length));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A run may only use days that are already settled.
  const startIndex = ordered.indexOf(firstDay);
  const maxCount = startIndex < 0 ? 1 : Math.min(maxDays, ordered.length - startIndex);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/challenges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, firstDay, days: Math.min(count, maxCount) }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setError(d?.error ?? "The challenge could not be created.");
        return;
      }
      router.push(`/challenges/${d.challenge.slug}`);
    } catch {
      setError("The challenge could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} className="card p-4">
      <h2 className="card-title">Start a challenge</h2>
      <p className="hint t-mute mb-3">
        Pick a run of past operating days. Everyone who enters trades exactly those days, as ERCOT ran them, on a
        fresh $100,000 desk; the best P&amp;L wins. Share the link with your friends.
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <label className="flex flex-col gap-1">
          <span className="caption t-mute">Name</span>
          <input
            className="input"
            value={title}
            maxLength={60}
            required
            minLength={3}
            placeholder="Friday night power league"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="caption t-mute">First day</span>
          <select className="input" value={firstDay} onChange={(e) => setFirstDay(e.target.value)}>
            {ordered.map((d) => (
              <option key={d} value={d}>
                {dayLabel(d)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="caption t-mute">Days</span>
          <select className="input" value={Math.min(count, maxCount)} onChange={(e) => setCount(Number(e.target.value))}>
            {Array.from({ length: maxCount }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || title.trim().length < 3 || !firstDay}>
          Create
        </button>
      </div>
      {error && <p className="hint neg mt-2">{error}</p>}
    </form>
  );
}
