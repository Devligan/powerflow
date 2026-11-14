import Link from "next/link";
import { requireUser, getUserProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getPortfolioSnapshot } from "@/lib/queries";
import { getMarketStatus } from "@/lib/markets";
import { deskCycle } from "@/lib/desk-cycle";
import { FirstTrade } from "@/components/first-trade";
import { MarketsStrip } from "@/components/markets-strip";
import { MarginSummary } from "@/components/margin-summary";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { Lamp } from "@/components/ui/lamp";
import {
  usd,
  sign,
  signedUsd,
  bpsToPercent,
  countdown,
  num,
  instrumentInfo,
  legsLabel,
  positionUnit,
  volumeUnitLabel,
  signTone,
} from "@/lib/format";
import { briefDateTime, requestTime } from "@/lib/time";
import { getViewerTimeZone } from "@/lib/time-zone-server";

export const dynamic = "force-dynamic";

const weekday = (day: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    Date.parse(`${day}T12:00:00Z`)
  );

/** One stage of the day-ahead cycle, as a card. */
function Stage({
  step,
  title,
  figure,
  tone,
  children,
  href,
  action,
  active,
}: {
  step: number;
  title: string;
  figure: string;
  tone?: "pos" | "neg";
  children: React.ReactNode;
  href: string;
  action: string;
  active: boolean;
}) {
  return (
    <li className={`card flex flex-col p-4 ${active ? "" : "opacity-70"}`}>
      <div className="caption t-mute">
        <span className="t-accent">{step}</span> · {title}
      </div>
      <div className={`mono mt-2 text-2xl font-medium ${tone ?? "t-fg"}`}>{figure}</div>
      <p className="mt-1.5 flex-1 text-[12.5px] leading-relaxed t-dim">{children}</p>
      <Link href={href} className="caption mt-3 t-accent hover:underline">
        {action} →
      </Link>
    </li>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  const { tz } = await getViewerTimeZone();
  const db = await createClient();
  const [snapshot, status, profile, ordersRes, everRes] = await Promise.all([
    getPortfolioSnapshot(user.id).catch(() => null),
    getMarketStatus().catch(() => null),
    getUserProfile(user.id).catch(() => null),
    db.from("paper_orders").select("delivery_start").eq("user_id", user.id).eq("status", "OPEN"),
    db.from("paper_orders").select("id", { count: "exact", head: true }).eq("user_id", user.id),
  ]);
  const everOrdered = everRes.error ? true : (everRes.count ?? 0) > 0;

  const met = snapshot?.metrics;
  // The chosen display name, never the email: the desk is what gets shared
  // on a screen or in a screenshot.
  const account = profile?.display_name || "trader";
  const openPositions = (snapshot?.positions ?? []).filter((p) => p.isOpen);

  const cycle = deskCycle(
    requestTime(),
    (ordersRes.data ?? []).map((o) => ({ deliveryStart: o.delivery_start })),
    openPositions
  );

  const stats: Array<{ label: string; value: string; tone?: "pos" | "neg" }> = [
    { label: "Equity", value: met ? usd(met.equity) : "—", tone: met ? signTone(met.totalPnl) : undefined },
    { label: "Total P&L", value: met ? signedUsd(met.totalPnl) : "—", tone: met ? signTone(met.totalPnl) : undefined },
    { label: "Realized", value: met ? signedUsd(met.realizedPnl) : "—", tone: met ? signTone(met.realizedPnl) : undefined },
    { label: "Unrealized", value: met ? signedUsd(met.unrealizedPnl) : "—", tone: met ? signTone(met.unrealizedPnl) : undefined },
    { label: "Return", value: met ? bpsToPercent(met.returnBps) : "—", tone: met ? signTone(met.returnBps) : undefined },
  ];
  if (met && met.deficit > 0n) stats.push({ label: "Owed", value: usd(met.deficit), tone: "neg" });

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={`Account · ${account}`}
        title="Desk"
        aside={
          status && (
            <span className="badge badge-green">
              <Lamp pulse={status.dataMode === "ERCOT_LIVE"} />
              {status.dataMode === "ERCOT_REPLAY" ? "ERCOT (history)" : "ERCOT MIS"}
            </span>
          )
        }
      >
        Your book through ERCOT&apos;s day-ahead cycle: bid before the gate, fill at the clearing, mark against real
        time, settle when the prices are final.
      </PageHeader>

      {/* A trader who has never bid: the first trade, walked through. */}
      {!everOrdered && <FirstTrade />}

      <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 ${stats.length > 5 ? "lg:grid-cols-6" : "lg:grid-cols-5"}`}>
        {stats.map((s, i) => (
          <Stat key={s.label} label={s.label} value={s.value} tone={s.tone} delay={i * 40} />
        ))}
      </div>

      {/* The cycle: where every bid and position stands, and what is next. */}
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="The day-ahead cycle">
        <Stage
          step={1}
          title="Bid"
          figure={countdown(cycle.minutesToGate)}
          href="/markets"
          action={`Bid on ${weekday(cycle.openDay)}`}
          active
        >
          until bids for {weekday(cycle.openDay)} close at 10:00 AM Central.{" "}
          {cycle.working > 0
            ? `${cycle.working} bid${cycle.working === 1 ? "" : "s"} working; you can still withdraw ${cycle.working === 1 ? "it" : "them"}.`
            : "No bids working."}
        </Stage>
        <Stage
          step={2}
          title="Clear"
          figure={String(cycle.awaitingClearing)}
          href="/orders"
          action="Orders"
          active={cycle.awaitingClearing > 0}
        >
          {cycle.awaitingClearing > 0
            ? `bid${cycle.awaitingClearing === 1 ? "" : "s"} locked in, filling at ERCOT's clearing price when it posts in the early afternoon.`
            : "bids waiting on a clearing. Bids lock in at the gate and fill when ERCOT posts the day-ahead prices."}
        </Stage>
        <Stage
          step={3}
          title="Deliver"
          figure={cycle.delivering.count > 0 ? signedUsd(cycle.delivering.unrealized) : "0"}
          tone={cycle.delivering.count > 0 ? signTone(cycle.delivering.unrealized) : undefined}
          href="/positions"
          action="Positions"
          active={cycle.delivering.count > 0}
        >
          {cycle.delivering.count > 0
            ? `marked so far on ${cycle.delivering.count} filled hour${cycle.delivering.count === 1 ? "" : "s"}, against each real-time price as it prints.`
            : "hours in delivery. A filled hour is marked against real time as the day runs."}
        </Stage>
        <Stage
          step={4}
          title="Settle"
          figure={cycle.settling.count > 0 ? signedUsd(cycle.settling.unrealized) : "0"}
          tone={cycle.settling.count > 0 ? signTone(cycle.settling.unrealized) : undefined}
          href="/analytics"
          action="Analytics"
          active={cycle.settling.count > 0}
        >
          {cycle.settling.count > 0
            ? `on ${cycle.settling.count} delivered hour${cycle.settling.count === 1 ? "" : "s"}, paid out when ERCOT calls the prices final${cycle.settling.nextFinalAt ? ` (next: ${briefDateTime(cycle.settling.nextFinalAt, tz)})` : ""}.`
            : "hours waiting to settle. ERCOT calls real-time prices final two business days after delivery."}
        </Stage>
      </ol>

      {/* Margin: what the open book requires, and the state the settlement leg
          will act on. */}
      <MarginSummary margin={snapshot?.margin ?? null} />

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="card-title mb-0">Settlement point monitor</h2>
          <Link href="/markets" className="caption t-accent hover:underline">
            All markets →
          </Link>
        </div>
        <MarketsStrip />
      </section>

      <section className="card">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="card-title mb-0">Open positions</h2>
          <Link href="/positions" className="caption t-accent hover:underline">
            Risk ladder and history →
          </Link>
        </div>
        {openPositions.length === 0 ? (
          <p className="py-6 text-center text-[13px] t-mute">
            No open positions.{" "}
            <Link href="/markets" className="t-accent hover:underline">
              Place a bid
            </Link>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Instrument</th>
                  <th>Delivery</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Avg entry</th>
                  <th className="text-right">Mark</th>
                  <th className="text-right">Unrealized</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.slice(0, 8).map((p) => {
                  const inst = instrumentInfo(p.instrument);
                  const legB = inst?.legs === 2 ? p.counterSettlementPoint : null;
                  return (
                    <tr key={p.id}>
                      <td className="whitespace-nowrap">
                        <Link href={`/markets/${p.settlementPoint}`} className="mono font-medium hover:underline">
                          {legsLabel(p.settlementPoint, legB)}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap t-dim">{inst ? inst.shortLabel : p.instrument}</td>
                      <td className="mono whitespace-nowrap t-mute">{briefDateTime(p.deliveryStart, tz)}</td>
                      <td className="mono whitespace-nowrap text-right">
                        {num(p.quantityMwh)} <span className="t-mute">{volumeUnitLabel(positionUnit(p.product))}</span>
                      </td>
                      <td className="mono text-right">{usd(p.averageEntryPrice)}</td>
                      <td className="mono text-right">{p.markPrice != null ? usd(p.markPrice) : "—"}</td>
                      <td className={`mono text-right ${signTone(p.unrealizedPnl) ?? ""}`}>{sign(p.unrealizedPnl)}</td>
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
