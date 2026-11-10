"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTimeZone } from "@/components/time-zone";
import { Avatar } from "@/components/ui/avatar";
import { dateTime } from "@/lib/time";
import { dayLabel } from "@/lib/challenge-schedule";

interface Move {
  kind: "bid" | "clearing" | "finish";
  day: string | null;
  at: string;
}

interface ChallengeState {
  challenge: { slug: string; title: string; firstDay: string; lastDay: string };
  days: string[];
  moves: Move[];
  standings: Array<{
    rank: number | null;
    displayName: string;
    avatarUrl: string | null;
    isViewer: boolean;
    status: "ACTIVE" | "FINISHED";
    pnl: string | null;
  }>;
  entry: {
    status: "ACTIVE" | "FINISHED";
    pnl: string | null;
    deskId: string | null;
    clock: string | null;
    next: Move | null;
  } | null;
}

function money(v: string | null): string {
  if (v == null) return "—";
  const n = Number(v);
  const s = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

function moveLabel(m: Move): string {
  if (m.kind === "finish") return "Finish and score";
  return m.kind === "bid" ? `Open bidding for ${dayLabel(m.day!)}` : `Run the clearing for ${dayLabel(m.day!)}`;
}

/**
 * A challenge, as its entrant plays it: enter, then make each move in order
 * (open a day's bidding, bid from Markets, run its clearing), then finish to
 * settle at the last day's final prices. The engine holds the clock to
 * forward moves inside the challenge; this only offers the next one.
 *
 * `compact` is the desk-page version: the controls without the standings.
 */
export function ChallengeView({ slug, activeDeskId, compact = false }: { slug: string; activeDeskId: string | null; compact?: boolean }) {
  const router = useRouter();
  const tz = useTimeZone();
  const [state, setState] = useState<ChallengeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/challenges/${slug}`)
      .then(async (res) => ({ res, d: await res.json().catch(() => null) }))
      .then(({ res, d }) => {
        if (!alive) return;
        if (res.ok) setState(d);
        else setError(d?.error ?? "The challenge could not be loaded.");
      })
      .catch(() => alive && setError("The challenge could not be loaded."));
    return () => {
      alive = false;
    };
  }, [slug]);

  async function act(action: "enter" | "trade" | "move" | "finish") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setError(d?.error ?? "That did not work. Please try again.");
        return;
      }
      setState(d);
      if (action === "enter" || action === "trade") router.push("/dashboard");
      router.refresh();
    } catch {
      setError("That did not work. Please try again.");
    } finally {
      setBusy(false);
      setConfirmFinish(false);
    }
  }

  if (!state) {
    return <section className="card p-4">{error ? <p className="caption neg">{error}</p> : <p className="caption t-mute">Loading…</p>}</section>;
  }

  const { entry } = state;
  const onThisDesk = entry?.deskId != null && entry.deskId === activeDeskId;
  const next = entry?.next ?? null;
  const days = `${dayLabel(state.days[0])}${state.days.length > 1 ? ` – ${dayLabel(state.days[state.days.length - 1])}` : ""}`;

  return (
    <div className="space-y-4">
      <section className="card p-4" aria-labelledby={`challenge-${slug}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id={`challenge-${slug}`} className="card-title mb-1">
              {state.challenge.title} <span className="badge badge-amber ml-1">CHALLENGE</span>
            </h2>
            <p className="caption t-mute">
              {days} · {state.days.length} operating day{state.days.length === 1 ? "" : "s"} · a fresh $100,000 desk for
              every entrant · the clock only moves forward
            </p>
          </div>
          {compact && (
            <Link href={`/challenges/${slug}`} className="caption t-accent hover:underline">
              Standings →
            </Link>
          )}
        </div>

        <div className="mt-4">
          {!entry && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act("enter")}>
                Enter this challenge
              </button>
              <span className="caption t-mute">
                Your display name appears on its standings. Your live account is not touched.
              </span>
            </div>
          )}

          {entry?.status === "ACTIVE" && (
            <div className="space-y-3">
              {!onThisDesk && (
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act("trade")}>
                    Trade this challenge
                  </button>
                  <span className="caption t-mute">Switches your desk to this challenge&apos;s account.</span>
                </div>
              )}
              {onThisDesk && (
                <>
                  <p className="caption t-mute mono">
                    Challenge clock: {entry.clock ? dateTime(entry.clock, tz) : "—"}
                  </p>
                  {next && next.kind !== "finish" && (
                    <div className="flex flex-wrap items-center gap-3">
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act("move")}>
                        {moveLabel(next)}
                      </button>
                      <span className="caption t-mute">
                        {next.kind === "bid"
                          ? "Then bid on that day's hours from Markets before 10:00 Central."
                          : "Bids still open before the deadline fill at ERCOT's clearing price."}
                      </span>
                      <Link href="/markets" className="caption t-accent hover:underline">
                        Markets →
                      </Link>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    {confirmFinish || next?.kind === "finish" ? (
                      <>
                        <button type="button" className={`btn btn-sm ${next?.kind === "finish" ? "btn-primary" : ""}`} disabled={busy} onClick={() => act("finish")}>
                          Finish and score
                        </button>
                        <span className="caption t-mute">
                          Settles every position at the last day&apos;s final prices. Your entry then closes.
                        </span>
                      </>
                    ) : (
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmFinish(true)}>
                        Finish early…
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {entry?.status === "FINISHED" && (
            <p>
              Your result:{" "}
              <span className={Number(entry.pnl) >= 0 ? "pos" : "neg"}>{money(entry.pnl)}</span>
            </p>
          )}
        </div>
        {error && <p className="caption neg mt-2">{error}</p>}
      </section>

      {!compact && (
        <section className="card p-4">
          <h2 className="card-title">Standings</h2>
          {state.standings.length === 0 ? (
            <p className="caption t-mute">Nobody has entered yet. Share this page&apos;s link with your friends.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Trader</th>
                    <th className="text-right">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {state.standings.map((r, i) => (
                    <tr key={i} aria-current={r.isViewer ? "true" : undefined}>
                      <td className="mono">{r.rank ?? "—"}</td>
                      <td>
                        <span className="flex items-center gap-2">
                          <Avatar url={r.avatarUrl} name={r.displayName} size={22} />
                          {r.displayName}
                          {r.isViewer && <span className="badge badge-neutral">you</span>}
                        </span>
                      </td>
                      <td className={`mono text-right ${r.pnl == null ? "t-mute" : Number(r.pnl) >= 0 ? "pos" : "neg"}`}>
                        {r.status === "FINISHED" ? money(r.pnl) : "playing"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
