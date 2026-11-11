"use client";

import { useEffect, useState } from "react";
import { Term } from "@/components/term";
import type { RecapSummary } from "@/lib/practice-recap";

interface Recap extends RecapSummary {
  day: string;
  point: string;
  points: string[];
}

const usd = (v: number | null) =>
  v == null ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
const signed = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`);

/**
 * What the market did on the practice day at one point: each hour's
 * day-ahead clearing against real time, as of the practice clock. It is the
 * lesson of the exercise — which side of which hour would have paid.
 */
export function PracticeRecap({ refreshKey }: { refreshKey: string }) {
  const [point, setPoint] = useState("HB_NORTH");
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/practice/recap?point=${encodeURIComponent(point)}`)
      .then(async (res) => ({ res, d: await res.json().catch(() => null) }))
      .then(({ res, d }) => {
        if (!alive) return;
        if (res.ok) {
          setRecap(d);
          setError(null);
        } else {
          setError(d?.error ?? "The market recap could not be loaded.");
        }
      })
      .catch(() => alive && setError("The market recap could not be loaded."));
    return () => {
      alive = false;
    };
  }, [point, refreshKey]);

  if (error) return <p className="caption t-mute mt-4">{error}</p>;
  if (!recap || recap.hours.length === 0) return null;

  return (
    <div className="mt-4 rounded border border-white/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="caption t-mute">
          What the market did · <Term k="dam">day-ahead</Term> vs <Term k="rt">real time</Term> ·{" "}
          <Term k="dart">DART</Term> per MW
        </div>
        <select className="input text-sm" value={point} onChange={(e) => setPoint(e.target.value)} aria-label="Settlement point">
          {recap.points.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {recap.priced === 0 ? (
        <p className="caption mt-2">
          Real time for this day is not published yet at the practice clock — that is the bet. Deliver the day to see
          how it came in.
        </p>
      ) : (
        <p className="mt-2 text-[13px]">
          {recap.bestDec ? (
            <>
              Best <Term k="virtual">DEC</Term>: HE{recap.bestDec.he}, <span className="pos">+${recap.bestDec.perMw.toFixed(2)}/MW</span>.{" "}
            </>
          ) : (
            "No hour paid a DEC. "
          )}
          {recap.bestInc ? (
            <>
              Best INC: HE{recap.bestInc.he}, <span className="pos">+${recap.bestInc.perMw.toFixed(2)}/MW</span>.{" "}
            </>
          ) : (
            "No hour paid an INC. "
          )}
          <span className="t-mute">Average real time minus day-ahead: {signed(recap.meanDart)}.</span>
        </p>
      )}

      <div className="mt-2 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Hour</th>
              <th className="text-right">Day-ahead</th>
              <th className="text-right">Real time</th>
              <th className="text-right">RT − DA</th>
            </tr>
          </thead>
          <tbody>
            {recap.hours.map((h) => (
              <tr key={h.startMs}>
                <td className="mono">HE{h.he}</td>
                <td className="mono text-right">{usd(h.da)}</td>
                <td className="mono text-right">{usd(h.rt)}</td>
                <td className={`mono text-right ${h.dart == null ? "t-mute" : h.dart > 0 ? "pos" : h.dart < 0 ? "neg" : ""}`}>
                  {signed(h.dart)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
