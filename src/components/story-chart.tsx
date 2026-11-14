import type { MarketStory } from "@/lib/market-story";

/**
 * One operating day at one hub: the day-ahead price against real time, with
 * the gap between them shaded hour by hour and the widest one called out.
 *
 * Server-rendered and static. The shapes are an SVG stretched to the box
 * (strokes stay crisp with non-scaling-stroke); every label is HTML placed in
 * percent, so text stays readable from a phone to a wide screen.
 */

const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** Hour-ending marks on the axis: midnight, 6 AM, noon, 6 PM. */
const AXIS: Array<[number, string]> = [
  [1, "12 AM"],
  [7, "6 AM"],
  [13, "Noon"],
  [19, "6 PM"],
];

export function StoryChart({ story }: { story: MarketStory }) {
  const { hours, peak } = story;
  const n = hours.length;
  const values = hours.flatMap((h) => [h.da, h.rt]).filter((v): v is number => v != null);
  const hi = Math.max(...values, 0);
  const lo = Math.min(...values, 0);
  const pad = (hi - lo) * 0.08 || 1;
  const top = hi + pad;
  const bottom = lo - pad;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (v: number) => ((top - v) / (top - bottom)) * 100;

  /** Polyline runs, broken where an hour has no price. */
  const runs = (pick: (i: number) => number | null) => {
    const out: string[] = [];
    let run: string[] = [];
    hours.forEach((_, i) => {
      const v = pick(i);
      if (v == null) {
        if (run.length) out.push(run.join(" "));
        run = [];
      } else run.push(`${x(i)},${y(v)}`);
    });
    if (run.length) out.push(run.join(" "));
    return out;
  };

  const peakIndex = hours.findIndex((h) => h.startMs === peak.startMs);
  const peakX = x(peakIndex);
  const peakTop = y(Math.max(peak.da, peak.rt));
  const up = peak.dart > 0;
  const ticks = [top - pad, lo < 0 && hi > 0 ? 0 : null, bottom + pad].filter((v): v is number => v != null);

  return (
    <figure className="m-0">
      <div className="relative h-[240px] pl-12 sm:h-[320px] sm:pl-14">
        {/* y axis */}
        {ticks.map((v) => (
          <span
            key={v}
            className="mono absolute left-0 -translate-y-1/2 text-[10px] t-mute"
            style={{ top: `${y(v)}%` }}
          >
            {money(v)}
          </span>
        ))}

        <div className="relative h-full">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
            {ticks.map((v) => (
              <line key={v} x1="0" x2="100" y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray={v === 0 ? "4 4" : undefined} />
            ))}
            {hours.map((h, i) =>
              h.da == null || h.rt == null ? null : (
                <rect
                  key={h.startMs}
                  x={(i / n) * 100 + 0.12}
                  width={100 / n - 0.24}
                  y={Math.min(y(h.da), y(h.rt))}
                  height={Math.max(Math.abs(y(h.da) - y(h.rt)), 0.4)}
                  fill={h.rt >= h.da ? "var(--long)" : "var(--short)"}
                  opacity={i === peakIndex ? 0.7 : 0.22}
                />
              )
            )}
            {runs((i) => hours[i].da).map((points) => (
              <polyline key={`da${points}`} points={points} fill="none" stroke="var(--steel)" strokeWidth="1.5" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
            ))}
            {runs((i) => hours[i].rt).map((points) => (
              <polyline key={`rt${points}`} points={points} fill="none" stroke="var(--text)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>

          {/* the widest gap, called out */}
          <div
            className="absolute whitespace-nowrap"
            style={{
              left: `${peakX}%`,
              top: `${peakTop}%`,
              transform: `translate(${peakX > 80 ? "-100%" : peakX < 20 ? "0" : "-50%"}, calc(-100% - 8px))`,
            }}
          >
            <span className={`mono rounded-sm border px-2 py-1 text-[12px] ${up ? "border-[var(--long-line)] pos" : "border-[var(--short-line)] neg"} bg-[var(--ink)]`}>
              {up ? "+" : "−"}${Math.abs(peak.dart).toLocaleString("en-US", { maximumFractionDigits: 0 })}/MWh
            </span>
          </div>
        </div>
      </div>

      {/* x axis */}
      <div className="relative ml-12 h-5 sm:ml-14">
        {AXIS.map(([he, label]) => {
          const i = hours.findIndex((h) => h.he === he);
          return i < 0 ? null : (
            <span key={he} className="mono absolute -translate-x-1/2 pt-1.5 text-[10px] t-mute" style={{ left: `${(i / n) * 100}%` }}>
              {label}
            </span>
          );
        })}
      </div>

      <figcaption className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] t-dim">
        <span className="flex items-center gap-2">
          <svg width="22" height="6" aria-hidden="true"><line x1="0" x2="22" y1="3" y2="3" stroke="var(--steel)" strokeWidth="1.5" strokeDasharray="5 4" /></svg>
          Day-ahead, set the afternoon before
        </span>
        <span className="flex items-center gap-2">
          <svg width="22" height="6" aria-hidden="true"><line x1="0" x2="22" y1="3" y2="3" stroke="var(--text)" strokeWidth="2" /></svg>
          Real time, as it happened
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 bg-[var(--long)] opacity-60" aria-hidden="true" />
          <span className="inline-block h-2.5 w-2.5 bg-[var(--short)] opacity-60" aria-hidden="true" />
          The gap: what a virtual bid is paid
        </span>
      </figcaption>
    </figure>
  );
}
