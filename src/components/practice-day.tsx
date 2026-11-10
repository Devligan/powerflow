"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTimeZone } from "@/components/time-zone";
import { dateTime } from "@/lib/time";
import type { PracticeStep } from "@/lib/practice";

interface PracticeState {
  days: string[];
  day: string | null;
  clock: { now: string; mode: "REPLAY" | "LIVE" } | null;
  reached: PracticeStep | null;
  schedule: Record<PracticeStep, string> | null;
  results: {
    positions: number;
    settled: number;
    realizedPnl: string;
    unrealizedPnl: string;
  } | null;
}

const STEPS: Array<{ step: PracticeStep; title: string; body: string; link?: { href: string; label: string } }> = [
  {
    step: "bid",
    title: "Open bidding",
    body: "08:00 Central the day before. Bid on the day's hours from Markets — the day-ahead market closes at 10:00.",
    link: { href: "/markets", label: "Go to Markets" },
  },
  {
    step: "clearing",
    title: "Run the day-ahead clearing",
    body: "14:00 Central the day before. ERCOT has published the clearing prices, and every bid they crossed is filled at them.",
    link: { href: "/orders", label: "See your orders" },
  },
  {
    step: "delivery",
    title: "Deliver the day",
    body: "Every hour has run in real time. Positions are marked on the real-time prices, the side of the bet that pays.",
    link: { href: "/positions", label: "See your positions" },
  },
  {
    step: "settle",
    title: "Settle",
    body: "Real-time prices are final two Business Days later, and the day's positions are cashed out at them.",
  },
];

const ORDER: PracticeStep[] = STEPS.map((s) => s.step);

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function money(v: string): string {
  const n = Number(v);
  const s = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

/**
 * A practice day: one past operating day, run the way ERCOT runs it, on the
 * practice desk's own clock (src/lib/practice.ts). Each step moves the clock;
 * the server then fills the bids the clearing crossed and settles what is
 * final, so the whole cycle takes minutes instead of days.
 */
export function PracticeDay() {
  const router = useRouter();
  const tz = useTimeZone();
  const [state, setState] = useState<PracticeState | null>(null);
  const [day, setDay] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/practice")
      .then(async (res) => ({ res, d: await res.json().catch(() => null) }))
      .then(({ res, d }) => {
        if (!alive) return;
        if (!res.ok) {
          setError(d?.error ?? "The practice day could not be loaded.");
          return;
        }
        setState(d);
        setDay((cur) => cur || d.day || d.days[0] || "");
      })
      .catch(() => {
        if (alive) setError("The practice day could not be loaded.");
      });
    return () => {
      alive = false;
    };
  }, []);

  async function go(step: PracticeStep) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day, step }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setError(d?.error ?? "The practice clock could not be moved.");
      } else {
        setState(d);
        router.refresh();
      }
    } catch {
      setError("The practice clock could not be moved.");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/desk", { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(d?.error ?? "The practice desk could not be reset.");
        return;
      }
      router.refresh();
    } catch {
      setError("The practice desk could not be reset.");
    } finally {
      setBusy(false);
      setConfirmReset(false);
    }
  }

  // Steps count as done only for the day the desk is on.
  const onThisDay = state?.day === day;
  const reachedIndex = onThisDay && state?.reached ? ORDER.indexOf(state.reached) : -1;
  const results = onThisDay ? state?.results : null;

  return (
    <section className="card p-4" aria-labelledby="practice-day-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="practice-day-title" className="card-title mb-1">
            Practice day <span className="badge badge-amber ml-1">PRACTICE</span>
          </h2>
          <p className="caption t-mute max-w-prose">
            Pick a past operating day and run it the way ERCOT does: bid before the 10:00
            deadline, watch the day-ahead market clear, deliver against real time, settle.
            The whole cycle takes a few minutes here instead of four days.
          </p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="caption t-mute">Operating day</span>
          <select
            className="input text-sm"
            value={day}
            disabled={busy || !state}
            onChange={(e) => setDay(e.target.value)}
          >
            {(state?.days ?? []).map((d) => (
              <option key={d} value={d}>
                {dayLabel(d)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ol className="mt-4 grid gap-3 md:grid-cols-4">
        {STEPS.map((s, i) => {
          const done = i <= reachedIndex;
          const next = i === reachedIndex + 1;
          return (
            <li
              key={s.step}
              className={`rounded border p-3 ${next ? "border-amber-400/50" : "border-white/10"} ${done ? "opacity-80" : ""}`}
            >
              <div className="caption t-mute">
                Step {i + 1}
                {done && <span className="pos ml-2">done</span>}
              </div>
              <div className="mt-1 font-medium">{s.title}</div>
              <p className="caption t-mute mt-1">{s.body}</p>
              {onThisDay && state?.schedule && (
                <p className="caption t-dim mt-1 mono">{dateTime(state.schedule[s.step], tz)}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={`btn btn-sm ${next ? "btn-primary" : ""}`}
                  disabled={busy || !day}
                  onClick={() => go(s.step)}
                >
                  {done ? "Again" : "Go"}
                </button>
                {done && s.link && (
                  <Link href={s.link.href} className="caption t-accent hover:underline">
                    {s.link.label} →
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {results && (
        <div className="mt-4 rounded border border-white/10 p-3">
          <div className="caption t-mute">{dayLabel(day)} so far</div>
          {results.positions === 0 ? (
            <p className="caption mt-1">
              No positions on this day yet. Open bidding, then bid on its hours from Markets.
            </p>
          ) : (
            <p className="mt-1">
              {results.positions} position{results.positions === 1 ? "" : "s"} ·{" "}
              {results.settled} settled · realized{" "}
              <span className={Number(results.realizedPnl) >= 0 ? "pos" : "neg"}>
                {money(results.realizedPnl)}
              </span>
              {Number(results.unrealizedPnl) !== 0 && (
                <>
                  {" "}· open{" "}
                  <span className={Number(results.unrealizedPnl) >= 0 ? "pos" : "neg"}>
                    {money(results.unrealizedPnl)}
                  </span>
                </>
              )}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <span className="caption t-mute mono">
          {state?.clock ? `Practice clock: ${dateTime(state.clock.now, tz)}` : ""}
        </span>
        {confirmReset ? (
          <span className="flex items-center gap-2">
            <span className="caption">Delete the practice account and all its trades?</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={reset}>
              Delete and start over
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmReset(false)}>
              Keep it
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmReset(true)}>
            Start practice over
          </button>
        )}
      </div>
      {error && <p className="caption neg mt-2">{error}</p>}
    </section>
  );
}
