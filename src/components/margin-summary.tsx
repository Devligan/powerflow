import Link from "next/link";
import type { CreditView, MarginView } from "@/lib/queries";
import type { MarginTier } from "@/lib/trading/margin";
import { usd } from "@/lib/format";
import { Lamp } from "@/components/ui/lamp";

/**
 * The account's margin state, as the settlement leg sees it.
 *
 * Worth surfacing because it is the account's early warning: a real desk
 * monitors margin continuously, while this platform acts at the moment an
 * obligation is due. Between trades the tier is the only place a thinning
 * buffer is visible, so it is shown whenever there is an open book.
 */

const TIER: Record<
  MarginTier,
  { label: string; badge: string; note: string }
> = {
  OK: {
    label: "OK",
    badge: "badge badge-green",
    note: "Equity covers the initial margin on the open book.",
  },
  WARNING: {
    label: "Warning",
    badge: "badge badge-amber",
    note: "Equity is below the initial margin. Closing positions restores the buffer.",
  },
  CALL: {
    label: "Margin call",
    badge: "badge badge-red",
    note: "Equity is below maintenance. A settlement that needs cash will be funded by selling your longs.",
  },
  DEFICIT: {
    label: "Deficit",
    badge: "badge badge-red",
    note: "Settlement cash could not be paid in full. The unpaid remainder is owed to the clearing house and reduces equity.",
  },
};

export function MarginSummary({
  margin,
  credit,
}: {
  margin: MarginView | null;
  credit: CreditView | null;
}) {
  if (!margin) return null;

  const tier = TIER[margin.tier];
  const hasBook = margin.usedMargin > 0n || margin.deficit > 0n;
  const held = credit ? credit.bidCollateral + credit.positionCollateral : 0n;

  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="card-title mb-0">Margin and credit</h2>
        <span className={tier.badge}>
          <Lamp pulse={margin.tier !== "OK"} />
          {tier.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <Figure label="Equity" value={usd(margin.equity)} />
        {/* What limits a new bid: the same figures the order check uses. */}
        <Figure label="Collateral held" value={credit ? usd(held) : "—"} />
        <Figure
          label="Available to bid"
          value={credit ? usd(credit.availableCredit) : "—"}
          tone={credit && credit.availableCredit < 0n ? "neg" : undefined}
        />
        <Figure label="Initial margin" value={usd(margin.usedMargin)} />
        <Figure label="Maintenance" value={usd(margin.maintenanceMargin)} />
      </div>

      <p className="mt-3 text-[11px] leading-relaxed t-mute">
        {credit && credit.openBids > 0 && (
          <>
            {credit.openBids} open bid{credit.openBids === 1 ? " holds" : "s hold"}{" "}
            <span className="mono">{usd(credit.bidCollateral)}</span> of collateral until{" "}
            {credit.openBids === 1 ? "it fills or is" : "they fill or are"} cancelled. A new bid holds MW × its
            point&apos;s 95th-percentile day-ahead/real-time gap (at least $10/MW) and must fit in what is
            available.{" "}
          </>
        )}
        {hasBook
          ? tier.note
          : credit && credit.openBids > 0
            ? "No filled position needs margin yet."
            : "No open bids or positions, so nothing is held."}
      </p>

      <div className="mt-3 space-y-2">
        {margin.deficit > 0n && (
          <p className="note note-error">
            Owed <span className="mono">{usd(margin.deficit)}</span>. Every
            settlement receipt is applied to this before anything else.
          </p>
        )}

        {margin.unpricedPositions > 0 && (
          <p className="note note-warn">
            {margin.unpricedPositions} open position
            {margin.unpricedPositions === 1 ? "" : "s"} cannot be priced, so the
            requirements above understate the account.{" "}
            <Link href="/positions" className="underline">
              View positions
            </Link>
          </p>
        )}
      </div>
    </section>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "neg";
}) {
  return (
    <div>
      <div className="caption">{label}</div>
      <div className={`mono mt-1.5 text-[13px] ${tone ?? "t-fg"}`}>{value}</div>
    </div>
  );
}
