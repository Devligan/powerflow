"use client";

import { useMemo, useRef, useState } from "react";
import { parseDec, format } from "@/lib/money";
import { shortDate } from "@/lib/time";
import { useTimeZone } from "@/components/time-zone";

export interface ChartPoint {
  deliveryTimestamp: string;
  price: string;
}

/* Geometry, in viewBox units. The left pad is the y-axis label gutter. */
const W = 640;
const H = 200;
const PAD_L = 52;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 24;
const BASE = H - PAD_B;

const AXIS = "rgb(230 227 221 / 0.1)";
const AXIS_SOFT = "rgb(230 227 221 / 0.06)";
const ACCENT = "#e2a33d";
const REFERENCE = "rgb(230 227 221 / 0.55)";
const WASH = "rgb(226 163 61 / 0.07)";

/** 2026-09-22 09:00 CDT, on the viewer's clock */
function stamp(iso: string, tz: string): string {
  return shortDate(iso, tz);
}

const money = (v: bigint) => `$${format(v, 2)}`;

/**
 * The forward curve, with what actually happened drawn against it.
 *
 * A control-room chart: hairline axes with labelled gridlines, the primary
 * series as the trace, an optional reference series as a quiet dashed line on
 * the same time axis, and a crosshair that names the delivery interval under
 * the pointer with both prices and their spread. For a day-ahead curve against
 * real time that spread is DART — the number a convergence position settles
 * on — so it is answered on hover rather than left to the reader to estimate.
 */
export function PriceChart({
  points,
  reference,
  label = "Price",
  referenceLabel = "Reference",
  nowMs,
}: {
  points: ChartPoint[];
  reference?: ChartPoint[];
  label?: string;
  referenceLabel?: string;
  /** Draw a "now" rule at this instant when it falls inside the axis. */
  nowMs?: number;
}) {
  const tz = useTimeZone();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (points.length === 0) return null;
    const ref = reference ?? [];
    const main = points.map((p) => ({ t: Date.parse(p.deliveryTimestamp), v: parseDec(p.price) }));
    const alt = ref.map((p) => ({ t: Date.parse(p.deliveryTimestamp), v: parseDec(p.price) }));
    const all = [...main, ...alt];

    let lo = Number(all[0].v);
    let hi = lo;
    let tLo = all[0].t;
    let tHi = all[0].t;
    for (const p of all) {
      const v = Number(p.v);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      if (p.t < tLo) tLo = p.t;
      if (p.t > tHi) tHi = p.t;
    }
    // A flat series still needs a band, or every point divides by zero.
    const pad = hi === lo ? Math.max(1e6, Math.abs(hi) * 0.02) : (hi - lo) * 0.18;
    const yLo = lo - pad;
    const band = hi + pad - yLo || 1;
    const span = tHi - tLo || 1;

    const x = (t: number) => PAD_L + ((t - tLo) / span) * (W - PAD_L - PAD_R);
    const y = (v: bigint) => PAD_T + (1 - (Number(v) - yLo) / band) * (BASE - PAD_T);
    const path = (series: Array<{ t: number; v: bigint }>) =>
      series.length ? `M ${series.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" L ")}` : "";

    const coords = main.map((p) => ({ x: x(p.t), y: y(p.v) }));
    const line = path(main);
    const area = `${line} L ${coords[coords.length - 1].x.toFixed(1)},${BASE} L ${coords[0].x.toFixed(1)},${BASE} Z`;

    // Three labelled gridlines spanning the band.
    const ticks = [0, 0.5, 1].map((f) => ({
      y: PAD_T + f * (BASE - PAD_T),
      label: money(BigInt(Math.round(yLo + band * (1 - f)))),
    }));

    const refAt = new Map(alt.map((p) => [p.t, p.v]));
    const nowX = nowMs != null && nowMs >= tLo && nowMs <= tHi ? x(nowMs) : null;
    return { main, coords, line, area, refLine: path(alt), refAt, ticks, nowX, tLo, span };
  }, [points, reference, nowMs]);

  if (points.length === 0 || !geo) {
    return (
      <div className="card text-[13px] t-mute">
        No price history published for this series yet.
      </div>
    );
  }

  const idx = hover ?? geo.main.length - 1;
  const shown = geo.main[idx];
  const shownRef = geo.refAt.get(shown.t);
  const marker = geo.coords[idx];

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || !geo) return;
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const t = geo.tLo + ((vx - PAD_L) / (W - PAD_L - PAD_R)) * geo.span;
    let best = 0;
    for (let i = 1; i < geo.main.length; i++) {
      if (Math.abs(geo.main[i].t - t) < Math.abs(geo.main[best].t - t)) best = i;
    }
    setHover(best);
  }

  const spread = shownRef != null ? shownRef - shown.v : null;

  return (
    <div>
      {/* Readout: the hovered interval, or the latest one at rest. */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="caption t-accent">{label}</span>
        <span className="mono text-xl font-semibold">{money(shown.v)}</span>
        {reference && (
          <span className="mono text-[12px] t-dim">
            {referenceLabel} {shownRef != null ? money(shownRef) : "not yet published"}
          </span>
        )}
        {spread != null && (
          <span className={`mono text-[12px] ${spread > 0n ? "pos" : spread < 0n ? "neg" : "t-mute"}`}>
            spread {spread > 0n ? "+" : ""}
            {money(spread)}
          </span>
        )}
        <span className="caption">{stamp(new Date(shown.t).toISOString(), tz)}</span>
        <span className="caption ml-auto">{hover != null ? "Hovering interval" : "Latest interval"}</span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`${label}, ${points.length} intervals${reference ? `, with ${referenceLabel}` : ""}.`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {geo.ticks.map((t) => (
          <g key={t.label}>
            <line x1={PAD_L} x2={W - PAD_R} y1={t.y} y2={t.y} stroke={AXIS} strokeWidth="1" />
            <text x={PAD_L - 8} y={t.y + 3} textAnchor="end" fontSize="9" fill="var(--text-mute)" className="mono">
              {t.label}
            </text>
          </g>
        ))}

        {/* A light column every 6th interval keeps the eye on the trace. */}
        {geo.coords.map((c, i) =>
          i % 6 === 0 ? (
            <line key={i} x1={c.x} x2={c.x} y1={PAD_T} y2={BASE} stroke={AXIS_SOFT} strokeWidth="1" />
          ) : null
        )}

        {geo.nowX != null && (
          <g>
            <line x1={geo.nowX} x2={geo.nowX} y1={PAD_T} y2={BASE} stroke="var(--line-bright)" strokeWidth="1" />
            <text x={geo.nowX + 4} y={PAD_T + 8} fontSize="9" fill="var(--text-mute)" className="mono">
              now
            </text>
          </g>
        )}

        {/* A flat low-alpha wash, not a gradient: the trace is the subject. */}
        <path d={geo.area} fill={WASH} />

        {geo.refLine && (
          <path d={geo.refLine} fill="none" stroke={REFERENCE} strokeWidth="1.2" strokeDasharray="3 3" strokeLinejoin="round" />
        )}

        <path
          d={geo.line}
          fill="none"
          stroke={ACCENT}
          strokeWidth="1.6"
          strokeLinejoin="round"
          className="draw"
          style={{ "--pf-length": 2400 } as React.CSSProperties}
        />

        {/* Crosshair at the hovered interval, latest interval at rest. */}
        <line x1={marker.x} x2={marker.x} y1={PAD_T} y2={BASE} stroke="var(--line-bright)" strokeWidth="1" strokeDasharray="2 3" />
        <rect x={marker.x - 3} y={marker.y - 3} width="6" height="6" fill={ACCENT} />

        <line x1={PAD_L} x2={W - PAD_R} y1={BASE} y2={BASE} stroke={AXIS} />
        <text x={PAD_L} y={H - 7} fontSize="9" fill="var(--text-mute)" className="mono">
          {stamp(new Date(geo.tLo).toISOString(), tz)}
        </text>
        <text x={W - PAD_R} y={H - 7} textAnchor="end" fontSize="9" fill="var(--text-mute)" className="mono">
          {stamp(new Date(geo.tLo + geo.span).toISOString(), tz)}
        </text>
      </svg>

      {reference && (
        <div className="mt-2 flex flex-wrap items-center gap-4 caption">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-4" style={{ background: ACCENT }} /> {label}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t border-dashed" style={{ borderColor: REFERENCE }} /> {referenceLabel}
          </span>
        </div>
      )}
    </div>
  );
}
