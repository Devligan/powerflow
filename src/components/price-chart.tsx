"use client";

import { useMemo, useRef, useState } from "react";
import { parseDec, format } from "@/lib/money";

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
const WASH = "rgb(226 163 61 / 0.07)";

/** 2026-09-22 14:00Z */
function stamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/**
 * The forward curve.
 *
 * A control-room chart: hairline axes with labelled gridlines, a trace with no
 * decorative gradient behind it, and a crosshair that names the delivery
 * interval under the pointer. Knowing which interval a point belongs to is the
 * whole question on a forward curve, so it is answered on hover rather than
 * left to the reader to estimate from an axis.
 */
export function PriceChart({ points }: { points: ChartPoint[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (points.length === 0) return null;

    const values = points.map((p) => Number(parseDec(p.price)));
    let lo = values[0];
    let hi = values[0];
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // A flat series still needs a band, or every point divides by zero.
    const pad = hi === lo ? Math.max(1, Math.abs(hi) * 0.02) : (hi - lo) * 0.18;
    const yLo = lo - pad;
    const yHi = hi + pad;
    const band = yHi - yLo || 1;

    const n = values.length;
    const x = (i: number) => PAD_L + (i / Math.max(1, n - 1)) * (W - PAD_L - PAD_R);
    const y = (v: number) => PAD_T + (1 - (v - yLo) / band) * (BASE - PAD_T);

    const coords = values.map((v, i) => ({ x: x(i), y: y(v) }));
    const line = `M ${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" L ")}`;
    const area = `${line} L ${coords[coords.length - 1].x.toFixed(1)},${BASE} L ${coords[0].x.toFixed(1)},${BASE} Z`;

    // Three labelled gridlines spanning the band.
    const ticks = [0, 0.5, 1].map((t) => {
      const v = yLo + band * (1 - t);
      return { y: PAD_T + t * (BASE - PAD_T), label: `$${format(BigInt(Math.round(v)), 2)}` };
    });

    return { coords, line, area, ticks };
  }, [points]);

  if (points.length === 0 || !geo) {
    return (
      <div className="card text-[13px] t-mute">
        No price history published for this series yet.
      </div>
    );
  }

  const last = points[points.length - 1];
  const shown = hover != null ? points[hover] : last;
  const shownValue = Number(parseDec(shown.price));
  const first = points[0];
  const firstValue = Number(parseDec(first.price));
  const change = shownValue - firstValue;
  const changePct = firstValue === 0 ? 0 : (change / firstValue) * 100;

  const marker = geo.coords[hover ?? geo.coords.length - 1];

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const usable = W - PAD_L - PAD_R;
    const ratio = (vx - PAD_L) / usable;
    const idx = Math.round(ratio * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, idx)));
  }

  return (
    <div>
      {/* Readout: the hovered interval, or the latest one at rest. */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="mono text-xl font-semibold">
          ${format(parseDec(shown.price), 2)}
        </span>
        <span
          className={`mono text-[12px] ${change > 0 ? "pos" : change < 0 ? "neg" : "t-mute"}`}
        >
          {change > 0 ? "+" : ""}
          {format(BigInt(Math.round(change)), 2)} ({changePct >= 0 ? "+" : ""}
          {changePct.toFixed(2)}%)
        </span>
        <span className="caption">{stamp(shown.deliveryTimestamp)}</span>
        <span className="caption ml-auto">
          {hover != null ? "Hovering interval" : "Latest interval"}
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Forward curve, ${points.length} intervals. Latest $${format(parseDec(last.price), 2)} per MWh.`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Gridlines and their labels */}
        {geo.ticks.map((t) => (
          <g key={t.label}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={t.y}
              y2={t.y}
              stroke={AXIS}
              strokeWidth="1"
            />
            <text
              x={PAD_L - 8}
              y={t.y + 3}
              textAnchor="end"
              fontSize="9"
              fill="var(--text-mute)"
              className="mono"
            >
              {t.label}
            </text>
          </g>
        ))}

        {/* Vertical interval markers, one per day boundary is too dense, so a
            light column tint every 6th interval keeps the eye on the trace. */}
        {geo.coords.map((c, i) =>
          i % 6 === 0 ? (
            <line
              key={i}
              x1={c.x}
              x2={c.x}
              y1={PAD_T}
              y2={BASE}
              stroke={AXIS_SOFT}
              strokeWidth="1"
            />
          ) : null
        )}

        {/* A flat low-alpha wash, not a gradient: the trace is the subject. */}
        <path d={geo.area} fill={WASH} />

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
        <line
          x1={marker.x}
          x2={marker.x}
          y1={PAD_T}
          y2={BASE}
          stroke="var(--line-bright)"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
        <rect
          x={marker.x - 3}
          y={marker.y - 3}
          width="6"
          height="6"
          fill={ACCENT}
        />

        {/* Baseline and time bounds */}
        <line x1={PAD_L} x2={W - PAD_R} y1={BASE} y2={BASE} stroke={AXIS} />
        <text x={PAD_L} y={H - 7} fontSize="9" fill="var(--text-mute)" className="mono">
          {stamp(first.deliveryTimestamp)}
        </text>
        <text
          x={W - PAD_R}
          y={H - 7}
          textAnchor="end"
          fontSize="9"
          fill="var(--text-mute)"
          className="mono"
        >
          {stamp(last.deliveryTimestamp)}
        </text>
      </svg>
    </div>
  );
}
