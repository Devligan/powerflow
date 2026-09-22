"use client";

import { useMemo } from "react";
import { parseDec, format } from "@/lib/money";

interface SeriesItem {
  day: string;
  pnl: string;
}

interface MarketItem {
  market: string;
  pnl: string;
}

const AXIS = "rgb(230 227 221 / 0.1)";
const LONG = "#5ec98b";
const SHORT = "#e2664e";

/** 2026-09-21 */
function day(iso: string): string {
  return iso.slice(5, 10);
}

/**
 * The two performance views.
 *
 * Both carry a labelled zero line, because on a P&L chart the question is
 * always which side of zero a figure sits on. The cumulative curve is coloured
 * by where it finishes, and the per-market bars are drawn square and centred
 * rather than as rounded pills, so the geometry itself states the sign.
 */
export function AnalyticsCharts({
  pnlByDay,
  pnlByMarket,
}: {
  pnlByDay: SeriesItem[];
  pnlByMarket: MarketItem[];
}) {
  const curve = useMemo(() => {
    if (pnlByDay.length === 0) return null;

    const W = 640;
    const H = 210;
    const padL = 62;
    const padR = 14;
    const padT = 14;
    const padB = 26;
    const base = H - padB;

    const values = pnlByDay.map((d) => Number(parseDec(d.pnl)));
    let lo = Math.min(0, ...values);
    let hi = Math.max(0, ...values);
    if (lo === hi) {
      lo = -1;
      hi = 1;
    }
    const pad = (hi - lo) * 0.12;
    const yLo = lo - pad;
    const yHi = hi + pad;
    const band = yHi - yLo || 1;

    const n = values.length;
    const x = (i: number) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
    const y = (v: number) => padT + (1 - (v - yLo) / band) * (base - padT);

    const coords = values.map((v, i) => ({ x: x(i), y: y(v) }));
    const line = `M ${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" L ")}`;
    const zeroY = y(0);
    const area = `${line} L ${coords[n - 1].x.toFixed(1)},${zeroY.toFixed(1)} L ${coords[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`;

    return {
      W,
      H,
      padL,
      padR,
      padT,
      base,
      line,
      area,
      coords,
      zeroY,
      yLo,
      band,
      last: values[n - 1],
      labels: pnlByDay.map((d) => day(d.day)),
    };
  }, [pnlByDay]);

  const markets = useMemo(() => {
    if (pnlByMarket.length === 0) return null;
    const rows = pnlByMarket.map((m) => ({
      label: m.market,
      value: Number(parseDec(m.pnl)),
    }));
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
    const total = rows.reduce((acc, r) => acc + r.value, 0);
    return { rows, maxAbs, total };
  }, [pnlByMarket]);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* ---- Cumulative realized P&L ---------------------------------- */}
      <section className="card">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="card-title mb-0">Cumulative realized P&amp;L</h2>
          {curve && (
            <span
              className={`mono text-[12px] ${curve.last > 0 ? "pos" : curve.last < 0 ? "neg" : "t-mute"}`}
            >
              {curve.last > 0 ? "+" : ""}
              {format(BigInt(Math.round(curve.last)), 0)}
            </span>
          )}
        </div>

        {!curve ? (
          <p className="py-10 text-center text-[13px] t-mute">
            Trade to build a P&amp;L curve.
          </p>
        ) : (
          <svg
            viewBox={`0 0 ${curve.W} ${curve.H}`}
            className="w-full"
            role="img"
            aria-label={`Cumulative realized P&L across ${pnlByDay.length} days, ending at ${format(BigInt(Math.round(curve.last)), 0)}.`}
          >
            {/* Band gridlines with money labels */}
            {[0, 0.5, 1].map((t) => {
              const v = curve.yLo + curve.band * (1 - t);
              const gy = curve.padT + t * (curve.base - curve.padT);
              return (
                <g key={t}>
                  <line
                    x1={curve.padL}
                    x2={curve.W - curve.padR}
                    y1={gy}
                    y2={gy}
                    stroke={AXIS}
                  />
                  <text
                    x={curve.padL - 8}
                    y={gy + 3}
                    textAnchor="end"
                    fontSize="9"
                    fill="var(--text-mute)"
                    className="mono"
                  >
                    {format(BigInt(Math.round(v)), 0)}
                  </text>
                </g>
              );
            })}

            <path
              d={curve.area}
              fill={curve.last >= 0 ? "rgb(94 201 139 / 0.09)" : "rgb(226 102 78 / 0.09)"}
            />

            {/* The zero line, stated rather than implied. */}
            <line
              x1={curve.padL}
              x2={curve.W - curve.padR}
              y1={curve.zeroY}
              y2={curve.zeroY}
              stroke="var(--line-bright)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />

            <path
              d={curve.line}
              fill="none"
              stroke={curve.last >= 0 ? LONG : SHORT}
              strokeWidth="1.6"
              strokeLinejoin="round"
              className="draw"
              style={{ "--pf-length": 2400 } as React.CSSProperties}
            />

            <line
              x1={curve.padL}
              x2={curve.W - curve.padR}
              y1={curve.base}
              y2={curve.base}
              stroke={AXIS}
            />
            <text
              x={curve.padL}
              y={curve.H - 8}
              fontSize="9"
              fill="var(--text-mute)"
              className="mono"
            >
              {curve.labels[0]}
            </text>
            <text
              x={curve.W - curve.padR}
              y={curve.H - 8}
              textAnchor="end"
              fontSize="9"
              fill="var(--text-mute)"
              className="mono"
            >
              {curve.labels[curve.labels.length - 1]}
            </text>
          </svg>
        )}
      </section>

      {/* ---- P&L by settlement point ---------------------------------- */}
      <section className="card">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="card-title mb-0">P&amp;L by settlement point</h2>
          {markets && (
            <span className="caption">{markets.rows.length} points</span>
          )}
        </div>

        {!markets ? (
          <p className="py-10 text-center text-[13px] t-mute">
            No realized P&amp;L yet.
          </p>
        ) : (
          <div className="space-y-2.5">
            {markets.rows.map((m) => {
              const pct = (Math.abs(m.value) / markets.maxAbs) * 100;
              return (
                <div
                  key={m.label}
                  className="grid grid-cols-[6.5rem_1fr_4.5rem] items-center gap-3"
                >
                  <span className="mono truncate text-[11px] t-dim">
                    {m.label}
                  </span>
                  {/* A zero-centred track: bars grow out from the centre line,
                      so the sign is visible in the geometry. */}
                  <div className="relative h-3">
                    <span className="absolute inset-y-0 left-1/2 w-px bg-white/15" />
                    <span
                      className="absolute top-1/2 h-2 -translate-y-1/2"
                      style={{
                        width: `${pct / 2}%`,
                        left: m.value >= 0 ? "50%" : `${50 - pct / 2}%`,
                        background: m.value >= 0 ? LONG : SHORT,
                        opacity: 0.75,
                      }}
                    />
                  </div>
                  <span
                    className={`mono text-right text-[11px] ${m.value > 0 ? "pos" : m.value < 0 ? "neg" : "t-mute"}`}
                  >
                    {m.value > 0 ? "+" : ""}
                    {format(BigInt(Math.round(m.value)), 0)}
                  </span>
                </div>
              );
            })}
            <div className="flex items-baseline justify-between border-t border-white/10 pt-3">
              <span className="caption">Total realized</span>
              <span
                className={`mono text-[13px] ${markets.total > 0 ? "pos" : markets.total < 0 ? "neg" : "t-mute"}`}
              >
                {markets.total > 0 ? "+" : ""}
                {format(BigInt(Math.round(markets.total)), 2)}
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
