"use client";

import { useMemo, useState } from "react";
import { quantile, type HeatRow } from "@/lib/market-stats";

const HOURS = Array.from({ length: 24 }, (_, i) => i + 1);

/** "Sun 11/01" from a Central operating day. */
function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${wd} ${day.slice(5, 7)}/${day.slice(8, 10)}`;
}

const usd = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;

/**
 * Day-ahead clearing by operating day × hour ending.
 *
 * One hue for magnitude: amber deepens with price up to the 95th percentile
 * of the window, so a single scarcity spike cannot wash out every other day.
 * Negative prices — real in ERCOT's west and at night — take the steel hue
 * instead, so they read as a different side of zero rather than as "cheap".
 * Each cell names its price on hover; "Values" prints every number.
 */
export function PriceHeatmap({ rows, todayDay }: { rows: HeatRow[]; todayDay: string }) {
  const [values, setValues] = useState(false);

  const scale = useMemo(() => {
    const all = rows.flatMap((r) => r.cells.filter((c): c is number => c != null)).sort((a, b) => a - b);
    const top = Math.max(1, quantile(all, 0.95) ?? 1);
    const bottom = Math.min(0, all[0] ?? 0);
    return { top, bottom, max: all[all.length - 1] ?? 0 };
  }, [rows]);

  const fill = (v: number | null): string => {
    if (v == null) return "transparent";
    if (v < 0) {
      const a = 0.18 + 0.6 * Math.min(1, v / (scale.bottom || -1));
      return `rgb(143 169 184 / ${a.toFixed(3)})`;
    }
    const a = 0.05 + 0.8 * Math.min(1, v / scale.top);
    return `rgb(226 163 61 / ${a.toFixed(3)})`;
  };

  if (rows.length === 0) {
    return <p className="py-8 text-center text-[13px] t-mute">No day-ahead clearing published yet.</p>;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        {/* Scale legend: steel below zero, amber up to p95. */}
        <div className="flex items-center gap-2 caption">
          {scale.bottom < 0 && (
            <>
              <span className="mono">{usd(scale.bottom)}</span>
              <span className="inline-block h-2 w-8" style={{ background: "linear-gradient(90deg, rgb(143 169 184 / 0.78), rgb(143 169 184 / 0.18))" }} />
            </>
          )}
          <span className="mono">$0</span>
          <span className="inline-block h-2 w-20" style={{ background: "linear-gradient(90deg, rgb(226 163 61 / 0.05), rgb(226 163 61 / 0.85))" }} />
          <span className="mono">{usd(scale.top)}+</span>
          <span className="t-mute">(p95 · max {usd(scale.max)})</span>
        </div>
        <button type="button" className="btn btn-sm ml-auto" onClick={() => setValues((v) => !v)}>
          {values ? "Hide values" : "Values"}
        </button>
      </div>

      <div className="scroll-thin overflow-x-auto">
        <table className="w-full border-separate text-[10px]" style={{ borderSpacing: 2 }}>
          <thead>
            <tr className="caption">
              <th className="sticky left-0 z-10 bg-[var(--ink-panel)] pr-2 text-left font-normal">Day</th>
              {HOURS.map((h) => (
                <th key={h} className="min-w-[1.4rem] text-center font-normal">
                  {h}
                </th>
              ))}
              <th className="pl-2 text-right font-normal">Peak</th>
              <th className="pl-2 text-right font-normal">ATC</th>
            </tr>
          </thead>
          <tbody className="mono">
            {rows.map((r) => (
              <tr key={r.day}>
                <th
                  scope="row"
                  className={`sticky left-0 z-10 whitespace-nowrap bg-[var(--ink-panel)] pr-2 text-left font-normal ${r.day === todayDay ? "t-accent" : "t-dim"}`}
                >
                  {dayLabel(r.day)}
                  {r.day > todayDay ? " ›" : ""}
                </th>
                {r.cells.map((c, i) => (
                  <td
                    key={i}
                    title={c == null ? `${dayLabel(r.day)} HE${i + 1}: not published` : `${dayLabel(r.day)} HE${i + 1}: ${usd(c)}`}
                    className="h-[18px] text-center leading-[18px]"
                    style={{ background: fill(c), color: values ? "var(--text)" : "transparent" }}
                  >
                    {c == null ? "" : Math.round(c)}
                  </td>
                ))}
                <td className="whitespace-nowrap pl-2 text-right">{r.peak == null ? "—" : usd(r.peak)}</td>
                <td className="whitespace-nowrap pl-2 text-right t-dim">{r.atc == null ? "—" : usd(r.atc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caption mt-2">
        Hour ending, Central. Peak = HE7–HE22 average; ATC = around the clock. A › marks a day that has
        not started yet. The fall-back day&apos;s repeated HE2 is averaged into one cell.
      </p>
    </div>
  );
}
