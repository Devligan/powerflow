/**
 * A labelled readout.
 *
 * The label is a faceplate caption and the figure is monospaced, so a grid of
 * these scans as a bank of instruments rather than as a wall of cards. `tone`
 * is only ever passed for figures where the sign carries meaning.
 */
export function Stat({
  label,
  value,
  tone,
  note,
  delay = 0,
}: {
  label: string;
  value: string;
  /** Sign meaning: long/profit or short/loss. Omit for neutral figures. */
  tone?: "pos" | "neg";
  /** Optional secondary line, e.g. the unit. */
  note?: string;
  /** Stagger for the entrance, in milliseconds. */
  delay?: number;
}) {
  return (
    <div className="card reveal" style={{ animationDelay: `${delay}ms` }}>
      <div className="caption">{label}</div>
      <div
        className={`mono mt-2 text-[1.0625rem] font-medium ${tone ?? "t-fg"}`}
      >
        {value}
      </div>
      {note && <div className="mt-1 text-[11px] t-mute">{note}</div>}
    </div>
  );
}
