import type { Ladder } from "@/lib/risk-ladder";

const fmt = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
};

/** "Mon 11/02" from YYYY-MM-DD. */
function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${wd} ${day.slice(5, 7)}/${day.slice(8, 10)}`;
}

/**
 * Open exposure by delivery hour. Long cells take the long tint and short the
 * short tint, deepening with size relative to the largest cell; every cell
 * prints its MWh, so the colour is never the only carrier of the number.
 */
export function RiskLadder({ ladder }: { ladder: Ladder }) {
  if (ladder.rows.length === 0) return null;

  const max = Math.max(1e-9, ...ladder.rows.flatMap((r) => [...r.cells.values()].map(Math.abs)));
  const tint = (v: number | undefined) => {
    if (v == null || v === 0) return undefined;
    const a = (0.12 + 0.55 * Math.min(1, Math.abs(v) / max)).toFixed(3);
    return v > 0 ? `rgb(94 201 139 / ${a})` : `rgb(226 102 78 / ${a})`;
  };

  // Day headers span their hours.
  const days: Array<{ day: string; span: number }> = [];
  for (const c of ladder.columns) {
    const last = days[days.length - 1];
    if (last && last.day === c.day) last.span += 1;
    else days.push({ day: c.day, span: 1 });
  }

  return (
    <section className="card p-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 px-4 py-3">
        <h2 className="card-title mb-0">Risk ladder</h2>
        <span className="caption">net MWh by delivery hour · hour ending, Central</span>
      </div>
      <div className="scroll-thin overflow-x-auto p-4">
        <table className="border-separate text-[11px]" style={{ borderSpacing: 2 }}>
          <thead>
            <tr className="caption">
              <th className="sticky left-0 z-10 bg-[var(--ink-panel)]" />
              {days.map((d) => (
                <th key={d.day} colSpan={d.span} className="border-b border-white/10 px-1 pb-1 text-left font-normal">
                  {dayLabel(d.day)}
                </th>
              ))}
              <th colSpan={3} />
            </tr>
            <tr className="caption">
              <th className="sticky left-0 z-10 bg-[var(--ink-panel)] pr-3 text-left font-normal">Instrument · legs</th>
              {ladder.columns.map((c) => (
                <th key={c.t} className="min-w-[2.6rem] text-center font-normal">
                  HE{c.he}
                  {c.repeated ? "*" : ""}
                </th>
              ))}
              <th className="pl-3 text-right font-normal">Net</th>
              <th className="pl-3 text-right font-normal">Gross</th>
              <th className="pl-3 text-right font-normal">Unrealized</th>
            </tr>
          </thead>
          <tbody className="mono">
            {ladder.rows.map((r) => (
              <tr key={r.key}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 whitespace-nowrap bg-[var(--ink-panel)] pr-3 text-left font-normal"
                >
                  <span className="font-medium">{r.legs}</span>{" "}
                  <span className="t-mute">· {r.instrumentLabel}</span>
                </th>
                {ladder.columns.map((c) => {
                  const v = r.cells.get(c.t);
                  return (
                    <td
                      key={c.t}
                      className="h-6 px-1 text-center"
                      style={{ background: tint(v) }}
                      title={v == null ? undefined : `${dayLabel(c.day)} HE${c.he}: ${fmt(v)} MWh`}
                    >
                      {v == null ? "" : fmt(v)}
                    </td>
                  );
                })}
                <td className={`pl-3 text-right ${r.netMwh > 0 ? "pos" : r.netMwh < 0 ? "neg" : ""}`}>{fmt(r.netMwh)}</td>
                <td className="pl-3 text-right t-dim">{fmt(r.grossMwh).replace("+", "")}</td>
                <td className={`whitespace-nowrap pl-3 text-right ${r.unrealized > 0 ? "pos" : r.unrealized < 0 ? "neg" : ""}`}>
                  {r.unmarked > 0 ? (
                    <span className="badge badge-amber" title={`${r.unmarked} position(s) cannot be marked yet`}>
                      unpriced
                    </span>
                  ) : (
                    `${fmt(r.unrealized)}`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint mt-3">
          A block, swap or price option is spread evenly across its window. Different instruments are kept on
          separate rows — a basis MWh and an energy MWh are not the same exposure.
        </p>
      </div>
    </section>
  );
}
