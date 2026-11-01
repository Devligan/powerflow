"use client";

import { useState } from "react";
import type { DartHour } from "@/lib/market-stats";

/* Geometry, in viewBox units. */
const W = 640;
const H = 210;
const PAD_L = 52;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 22;
const BASE = H - PAD_B;

const AXIS = "rgb(230 227 221 / 0.1)";
const PEAK_WASH = "rgb(230 227 221 / 0.03)";
const LONG = "#5ec98b";
const SHORT = "#e2664e";

const usd = (v: number, signed = false) =>
  `${signed && v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * DART by hour ending: the mean of real time minus day-ahead, as a bar from
 * zero, with the p10–p90 band as a whisker. Above zero real time cleared over
 * day-ahead (an INC earned); below, a DEC did. On-peak hours (HE7–HE22) sit on
 * a faint wash, since that is how blocks and most virtual strategies split the
 * day. Hover or focus names the hour; the table view carries every value.
 */
export function DartChart({ stats, days }: { stats: DartHour[]; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  const priced = stats.filter((s) => s.mean != null);
  if (priced.length === 0) {
    return <p className="py-8 text-center text-[13px] t-mute">Not enough settled hours yet.</p>;
  }

  // The y band covers every whisker and zero, so no bar or band is clipped.
  const lo = Math.min(0, ...priced.map((s) => s.p10 ?? s.mean!));
  const hi = Math.max(0, ...priced.map((s) => s.p90 ?? s.mean!));
  const pad = (hi - lo) * 0.08 || 1;
  const yLo = lo - pad;
  const band = hi + pad - yLo;
  const y = (v: number) => PAD_T + (1 - (v - yLo) / band) * (BASE - PAD_T);
  const slot = (W - PAD_L - PAD_R) / 24;
  const x = (he: number) => PAD_L + (he - 1) * slot;
  const zeroY = y(0);

  const shown = stats[(hover ?? -1)] ?? null;
  const best = priced.reduce((a, b) => (Math.abs(b.mean!) > Math.abs(a.mean!) ? b : a));

  return (
    <div>
      <div className="mb-2 flex min-h-[2.5rem] flex-wrap items-baseline gap-x-3 gap-y-1">
        {shown && shown.mean != null ? (
          <>
            <span className="caption t-accent">HE{shown.he}</span>
            <span className={`mono text-lg font-semibold ${shown.mean > 0 ? "pos" : shown.mean < 0 ? "neg" : ""}`}>
              {usd(shown.mean, true)}
            </span>
            <span className="mono text-[12px] t-dim">
              RT above DA {pct(shown.pctRtAbove!)} · σ {usd(shown.stdev!)} · p10 {usd(shown.p10!, true)} · p90{" "}
              {usd(shown.p90!, true)} · {shown.n} hours
            </span>
          </>
        ) : (
          <span className="text-[12px] t-dim">
            Widest average gap: <span className="mono">HE{best.he}</span>{" "}
            <span className={`mono ${best.mean! > 0 ? "pos" : "neg"}`}>{usd(best.mean!, true)}</span>
            {best.mean! > 0 ? " — real time has cleared above day-ahead" : " — real time has cleared below day-ahead"},
            {" "}{pct(best.mean! > 0 ? best.pctRtAbove! : 1 - best.pctRtAbove!)} of the time.
          </span>
        )}
        <button type="button" className="btn btn-sm ml-auto" onClick={() => setTable((t) => !t)}>
          {table ? "Chart" : "Table"}
        </button>
      </div>

      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="caption text-left">
                <th className="py-1 pr-3">Hour</th>
                <th className="py-1 pr-3 text-right">Mean RT−DA</th>
                <th className="py-1 pr-3 text-right">RT above DA</th>
                <th className="py-1 pr-3 text-right">σ</th>
                <th className="py-1 pr-3 text-right">p10</th>
                <th className="py-1 pr-3 text-right">p90</th>
                <th className="py-1 text-right">Hours</th>
              </tr>
            </thead>
            <tbody className="mono">
              {stats.map((s) => (
                <tr key={s.he} className="border-t border-white/5">
                  <td className="py-1 pr-3">HE{s.he}</td>
                  <td className={`py-1 pr-3 text-right ${s.mean! > 0 ? "pos" : s.mean! < 0 ? "neg" : ""}`}>
                    {s.mean == null ? "—" : usd(s.mean, true)}
                  </td>
                  <td className="py-1 pr-3 text-right">{s.pctRtAbove == null ? "—" : pct(s.pctRtAbove)}</td>
                  <td className="py-1 pr-3 text-right">{s.stdev == null ? "—" : usd(s.stdev)}</td>
                  <td className="py-1 pr-3 text-right">{s.p10 == null ? "—" : usd(s.p10, true)}</td>
                  <td className="py-1 pr-3 text-right">{s.p90 == null ? "—" : usd(s.p90, true)}</td>
                  <td className="py-1 text-right">{s.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`Mean real-time minus day-ahead by hour ending over ${days} days. Widest: HE${best.he} at ${usd(best.mean!, true)}.`}
          onMouseLeave={() => setHover(null)}
        >
          {/* On-peak band, HE7–HE22. */}
          <rect x={x(7)} y={PAD_T} width={slot * 16} height={BASE - PAD_T} fill={PEAK_WASH} />
          <text x={x(7) + 3} y={PAD_T + 9} fontSize="8" fill="var(--text-mute)" className="mono">
            on-peak HE7–22
          </text>

          {[hi, 0, lo].map((v, i) => (
            <g key={i}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--line-bright)" : AXIS} />
              <text x={PAD_L - 8} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-mute)" className="mono">
                {usd(v, true)}
              </text>
            </g>
          ))}

          {stats.map((s) => {
            const left = x(s.he);
            const active = hover === s.he - 1;
            return (
              <g
                key={s.he}
                tabIndex={0}
                onMouseEnter={() => setHover(s.he - 1)}
                onFocus={() => setHover(s.he - 1)}
                onBlur={() => setHover(null)}
                className="outline-none"
              >
                {/* Hit area: the whole column, wider than the bar. */}
                <rect x={left} y={PAD_T} width={slot} height={BASE - PAD_T} fill={active ? "rgb(230 227 221 / 0.05)" : "transparent"} />
                {s.mean != null && (
                  <>
                    {s.p10 != null && s.p90 != null && (
                      <line
                        x1={left + slot / 2}
                        x2={left + slot / 2}
                        y1={y(s.p90)}
                        y2={y(s.p10)}
                        stroke="var(--line-bright)"
                        strokeWidth="1"
                      />
                    )}
                    <rect
                      x={left + 2}
                      width={slot - 4}
                      y={Math.min(zeroY, y(s.mean))}
                      height={Math.max(1, Math.abs(y(s.mean) - zeroY))}
                      fill={s.mean >= 0 ? LONG : SHORT}
                      opacity={active || hover == null ? 0.8 : 0.45}
                    />
                  </>
                )}
                {(s.he === 1 || s.he % 3 === 0) && (
                  <text x={left + slot / 2} y={H - 8} textAnchor="middle" fontSize="9" fill="var(--text-mute)" className="mono">
                    {s.he}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={PAD_L} x2={W - PAD_R} y1={BASE} y2={BASE} stroke={AXIS} />
        </svg>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-4 caption">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-3" style={{ background: LONG, opacity: 0.8 }} /> RT above DA · INC earned
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-3" style={{ background: SHORT, opacity: 0.8 }} /> RT below DA · DEC earned
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-px" style={{ background: "var(--line-bright)" }} /> p10–p90
        </span>
        <span>Hour ending, Central · last {days} days</span>
      </div>
    </div>
  );
}
