import { parseDec } from "@/lib/money";
import { signedUsd, usd } from "@/lib/format";
import type { MarketView } from "@/lib/markets";

/**
 * The tape: every hub and load zone's latest real-time hour, with how far it
 * landed from that hour's day-ahead price, running under the landing page's
 * header the way a quote board does. Server-rendered from the same query as
 * the markets page; the motion is CSS only, and stops for a reader who has
 * asked for stillness (the strip then scrolls by hand).
 */

const ORDER = ["HUB", "HUB_AVERAGE", "LOAD_ZONE"];

export function PriceTape({ markets }: { markets: MarketView[] }) {
  const rows = markets
    .filter((m) => m.price != null && ORDER.includes(m.type))
    .sort(
      (a, b) =>
        ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.settlementPoint.localeCompare(b.settlementPoint)
    );
  if (rows.length === 0) return null;

  const items = rows.map((m) => {
    const rt = parseDec(m.price!);
    const dart = m.dayAheadPrice != null ? rt - parseDec(m.dayAheadPrice) : null;
    return (
      <span key={m.id} className="flex items-baseline gap-2 whitespace-nowrap px-5">
        <span className="t-dim">{m.settlementPoint}</span>
        <span className="t-fg">{usd(rt)}</span>
        {dart != null && (
          <span className={dart > 0n ? "pos" : dart < 0n ? "neg" : "t-mute"}>
            {dart > 0n ? "▲" : dart < 0n ? "▼" : ""} {signedUsd(dart)}
          </span>
        )}
      </span>
    );
  });

  return (
    <div className="flex h-9 items-stretch border-b border-white/10 bg-[var(--ink)] mono text-[11.5px]">
      <span className="z-10 flex shrink-0 items-center gap-2 border-r border-white/10 bg-[var(--ink-panel)] px-3 caption">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--long)]" aria-hidden="true" />
        ERCOT real time <span className="hidden sm:inline">vs day-ahead</span>
      </span>
      <div className="tape relative min-w-0 flex-1 overflow-hidden" aria-label="Latest ERCOT real-time prices">
        <div className="tape-track flex h-full w-max items-center">
          <div className="flex">{items}</div>
          <div className="flex" aria-hidden="true">
            {items}
          </div>
        </div>
      </div>
    </div>
  );
}
