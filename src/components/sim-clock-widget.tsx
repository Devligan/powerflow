"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { localToUtc, shortDate, zoneName, zonedParts } from "@/lib/time";
import { useTimeZone } from "@/components/time-zone";

/**
 * The simulation clock control.
 *
 * Shows the account's simulation time and mode; lets the desk jump the clock
 * to any instant (or back to live). Engine functions resolve this clock on
 * every fill, mark and settlement, so moving it is moving the market the desk
 * sees — bounded by what ERCOT had actually published by then.
 */

interface ClockState {
  offsetSeconds: number;
  mode: "REPLAY" | "LIVE";
  now: string;
  wallNow: string;
}

export function SimClockWidget() {
  const router = useRouter();
  const tz = useTimeZone();
  const [clock, setClock] = useState<ClockState | null>(null);
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/clock")
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.clock) setClock(d.clock);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function apply(to: string | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/clock", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d?.error ?? "Could not set the clock");
      } else {
        setClock(d.clock);
        router.refresh();
      }
    } catch {
      setError("Could not set the clock");
    } finally {
      setBusy(false);
    }
  }

  const replay = clock?.mode === "REPLAY";

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="caption t-mute">Simulation clock</div>
          <div className="mono text-lg font-medium">
            {clock ? shortDate(clock.now, tz) : "…"}
            <span className={`ml-2 badge ${replay ? "badge-amber" : "badge-green"}`}>
              {replay ? "REPLAY" : "LIVE"}
            </span>
          </div>
          <div className="caption t-mute">
            {clock && replay
              ? `Trading a historical market · offset ${
                  clock.offsetSeconds >= 0 ? "+" : ""
                }${clock.offsetSeconds}s`
              : "Following the wall clock"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            className="input mono text-sm"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-label={`Simulation time (${zoneName(tz)})`}
            title={`Your time zone (${zoneName(tz)}), like the clock beside it`}
          />
          <span className="caption t-mute">
            {clock ? zonedParts(Date.parse(clock.wallNow), tz).zone : ""}
          </span>
          <button
            className="btn btn-sm"
            disabled={busy || !target}
            // datetime-local has no zone and `new Date()` would read it as the
            // browser's zone; read it in the zone the desk is shown in.
            onClick={() => {
              const ms = localToUtc(target, tz);
              if (ms == null) {
                setError("That time does not exist in your time zone (it falls in a daylight-saving gap).");
                return;
              }
              apply(new Date(ms).toISOString());
            }}
          >
            Jump
          </button>
          {replay && (
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => apply(null)}
            >
              Back to live
            </button>
          )}
        </div>
      </div>
      {error && <p className="caption neg mt-2">{error}</p>}
    </section>
  );
}
