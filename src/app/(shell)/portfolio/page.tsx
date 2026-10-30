import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPortfolioSnapshot } from "@/lib/queries";
import { usd, sign, bpsToPercent, num, volumeUnitLabel } from "@/lib/format";
import { parseDec } from "@/lib/money";
import {
  InstrumentBreakdownTable,
  PositionAllocationTable,
} from "@/components/instrument-breakdown";
import { MarginSummary } from "@/components/margin-summary";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const user = await requireUser();
  const snapshot = await getPortfolioSnapshot(user.id);

  const met = snapshot.metrics;
  const openPositions = snapshot.positions.filter((p) => p.isOpen);
  // Both sides in the same fixed-point scale: grossNotional is already scaled,
  // so dividing it by the limit in plain dollars read a million times too high.
  const exposureLimit = parseDec(snapshot.account.maxGrossNotional || "0");
  const exposureBps =
    exposureLimit > 0n ? Number((parseDec(met.grossNotional) * 10_000n) / exposureLimit) : 0;
  const exposurePct = exposureBps / 100;
  const exposureTone =
    exposurePct > 85 ? "var(--short)" : exposurePct > 70 ? "var(--accent)" : "var(--long)";

  const cards: Array<{ label: string; value: string; tone?: "pos" | "neg" }> = [
    { label: "Cash", value: usd(met.cashBalance) },
    { label: "Marked value", value: usd(met.markedValue) },
    ...(met.deficit > 0n
      ? [{ label: "Owed", value: usd(met.deficit), tone: "neg" as const }]
      : []),
    {
      label: "Equity",
      value: usd(met.equity),
      tone: met.totalPnl >= 0n ? ("pos" as const) : ("neg" as const),
    },
    {
      label: "Total P&L",
      value: sign(met.totalPnl),
      tone: met.totalPnl > 0n ? ("pos" as const) : ("neg" as const),
    },
    {
      label: "Return",
      value: bpsToPercent(met.returnBps),
      tone: met.returnBps >= 0n ? ("pos" as const) : ("neg" as const),
    },
    {
      label: "Realized",
      value: sign(met.realizedPnl),
      tone: met.realizedPnl >= 0n ? ("pos" as const) : ("neg" as const),
    },
    {
      label: "Unrealized",
      value: sign(met.unrealizedPnl),
      tone: met.unrealizedPnl >= 0n ? ("pos" as const) : ("neg" as const),
    },
  ];

  // One readout per unit actually held: a capacity position is never reported
  // as energy, and an empty unit is never claimed.
  for (const v of met.volumes) {
    cards.push({
      label: `Long / short · ${volumeUnitLabel(v.unit)}`,
      value: `${num(v.long)} / ${num(v.short)}`,
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Account"
        title="Portfolio"
        aside={
          <Link href="/analytics" className="btn btn-sm">
            Analytics
          </Link>
        }
      >
        Every figure is recomputed from the executed blotter rather than carried
        forward as a running total.
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {cards.map((c, i) => (
          <Stat
            key={c.label}
            label={c.label}
            value={c.value}
            tone={c.tone}
            delay={i * 35}
          />
        ))}
      </div>

      <MarginSummary margin={snapshot.margin} />

      <section className="card">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="card-title mb-0">Gross exposure</h2>
          <span className="mono text-[12px] t-dim">
            {usd(met.grossNotional)}{" "}
            <span className="t-mute">/ {usd(exposureLimit)}</span>
          </span>
        </div>
        <div className="meter">
          <span
            style={{
              width: `${Math.min(100, exposurePct)}%`,
              background: exposureTone,
            }}
          />
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-2">
          <p className="caption">
            Buys must be fully covered by cash; gross exposure is capped per
            account.
          </p>
          <span className="mono text-[12px] t-dim">{exposurePct.toFixed(2)}%</span>
        </div>
      </section>

      {/* Risk is read at instrument level: a spread is one exposure, not the
          sum of its two legs. Rows sum to the totals above. */}
      <section className="card">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="card-title mb-0">By instrument</h2>
          <span className="caption">
            {met.byInstrument.length} instrument
            {met.byInstrument.length === 1 ? "" : "s"} held
          </span>
        </div>
        {met.byInstrument.length === 0 ? (
          <p className="py-6 text-center text-[13px] t-mute">
            Nothing allocated yet.{" "}
            <Link href="/markets" className="t-accent hover:underline">
              Browse markets
            </Link>
          </p>
        ) : (
          <InstrumentBreakdownTable rows={met.byInstrument} />
        )}
      </section>

      {openPositions.length > 0 && (
        <section className="card">
          <h2 className="card-title">Open positions</h2>
          <PositionAllocationTable
            positions={openPositions}
            totalGross={met.grossNotional}
          />
        </section>
      )}
    </div>
  );
}
