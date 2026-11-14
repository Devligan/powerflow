import Link from "next/link";
import { requireUser, getUserProfile } from "@/lib/auth";
import { FirstTrade } from "@/components/first-trade";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Whether the trader has ever placed a bid. */
async function hasEverOrdered(userId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin()
    .from("paper_orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}
import { getPortfolioSnapshot } from "@/lib/queries";
import { getMarketStatus } from "@/lib/markets";
import { MarketsStrip } from "@/components/markets-strip";
import { InstrumentBreakdownTable } from "@/components/instrument-breakdown";
import { MarginSummary } from "@/components/margin-summary";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { Lamp } from "@/components/ui/lamp";
import {
  usd,
  sign, signedUsd,
  bpsToPercent,
  num,
  instrumentInfo,
  legsLabel,
  positionUnit,
  volumeUnitLabel, signTone } from "@/lib/format";
import { localTime } from "@/lib/time";
import { getViewerTimeZone } from "@/lib/time-zone-server";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();
  const { tz } = await getViewerTimeZone();
  const [snapshot, status, profile, everOrdered] = await Promise.all([
    getPortfolioSnapshot(user.id).catch(() => null),
    getMarketStatus().catch(() => null),
    getUserProfile(user.id).catch(() => null),
    hasEverOrdered(user.id).catch(() => true),
  ]);

  const met = snapshot?.metrics;
  // The chosen display name, never the email: the desk is what gets shared
  // on a screen or in a screenshot.
  const account = profile?.display_name || "trader";

  const stats: Array<{ label: string; value: string; tone?: "pos" | "neg" }> = [
    {
      label: "Equity",
      value: met ? usd(met.equity) : "—",
      tone:
        met ? signTone(met.totalPnl) : undefined,
    },
    { label: "Cash", value: met ? usd(met.cashBalance) : "—" },
    {
      label: "Total P&L",
      value: met ? signedUsd(met.totalPnl) : "—",
      tone: met && met.totalPnl > 0n ? "pos" : met && met.totalPnl < 0n ? "neg" : undefined,
    },
    { label: "Return", value: met ? bpsToPercent(met.returnBps) : "—" },
    { label: "Gross exposure", value: met ? usd(met.grossNotional) : "—" },
  ];

  const openPositions = (snapshot?.positions ?? []).filter((p) => p.isOpen);
  const breakdown = met?.byInstrument ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={`Account · ${account}`}
        title="Desk"
        aside={
          <>
            {status && (
              <span className="badge badge-green">
                <Lamp pulse={status.dataMode === "ERCOT_LIVE"} />
                {status.dataMode === "ERCOT_REPLAY" ? "ERCOT (history)" : "ERCOT MIS"}
              </span>
            )}
            <Link href="/portfolio" className="btn btn-sm">
              Portfolio
            </Link>
          </>
        }
      >
        Marked to ERCOT&apos;s latest prices and recomputed from executed
        trades. Every price is actual ERCOT MIS data, labelled with its report
        source and publication time.
      </PageHeader>

      {/* A trader who has never bid: the first trade, walked through. */}
      {!everOrdered && <FirstTrade />}

      {/* Bank of readouts. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {stats.map((s, i) => (
          <Stat
            key={s.label}
            label={s.label}
            value={s.value}
            tone={s.tone}
            delay={i * 40}
          />
        ))}
      </div>

      {/* Margin: what the open book requires, and the state the settlement leg
          will act on. */}
      <MarginSummary margin={snapshot?.margin ?? null} />

      {/* Exposure by instrument: the level risk is actually held at, so a
          spread reads as one position rather than as its two legs. */}
      {breakdown.length > 0 && (
        <section className="card">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="card-title mb-0">Exposure by instrument</h2>
            <Link href="/portfolio" className="caption t-accent hover:underline">
              Full portfolio →
            </Link>
          </div>
          <InstrumentBreakdownTable rows={breakdown} />
        </section>
      )}

      {/* Live market strip */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="card-title mb-0">Settlement point monitor</h2>
          <Link href="/markets" className="caption t-accent hover:underline">
            All markets →
          </Link>
        </div>
        <MarketsStrip />
      </section>

      {/* Positions preview */}
      <section className="card">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="card-title mb-0">Open positions</h2>
          <Link href="/positions" className="caption t-accent hover:underline">
            Manage →
          </Link>
        </div>
        {openPositions.length === 0 ? (
          <p className="py-6 text-center text-[13px] t-mute">
            No open positions.{" "}
            <Link href="/markets" className="t-accent hover:underline">
              Start trading
            </Link>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Market / legs</th>
                  <th>Instrument</th>
                  <th>Delivery</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Avg entry</th>
                  <th className="text-right">Mark</th>
                  <th className="text-right">Unrealized</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.slice(0, 6).map((p) => {
                  const inst = instrumentInfo(p.instrument);
                  const legB = inst?.legs === 2 ? p.counterSettlementPoint : null;
                  return (
                    <tr key={p.id}>
                      <td className="whitespace-nowrap">
                        <Link
                          href={`/markets/${p.settlementPoint}`}
                          className="font-medium hover:underline"
                        >
                          {legsLabel(p.settlementPoint, legB)}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap t-dim">
                        {inst ? inst.shortLabel : p.instrument}
                      </td>
                      <td className="mono t-mute">
                        {localTime(p.deliveryStart, tz)}
                      </td>
                      <td className="mono whitespace-nowrap text-right">
                        {num(p.quantityMwh)}{" "}
                        <span className="t-mute">
                          {volumeUnitLabel(positionUnit(p.product))}
                        </span>
                      </td>
                      <td className="mono text-right">{usd(p.averageEntryPrice)}</td>
                      <td className="mono text-right">
                        {p.markPrice != null ? usd(p.markPrice) : "—"}
                      </td>
                      <td
                        className={`mono text-right ${p.unrealizedPnl > 0n ? "pos" : p.unrealizedPnl < 0n ? "neg" : ""}`}
                      >
                        {sign(p.unrealizedPnl)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
