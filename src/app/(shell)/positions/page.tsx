import Link from "next/link";
import { requireDesk } from "@/lib/desk";
import { getPositionsView } from "@/lib/queries";
import {
  usd,
  sign,
  num,
  instrumentInfo,
  legsLabel,
  positionUnit,
  volumeUnitLabel,
} from "@/lib/format";
import { briefDateTime, localDate, windowLabel } from "@/lib/time";
import { getViewerTimeZone } from "@/lib/time-zone-server";
import { PageHeader } from "@/components/ui/page-header";
import { RiskLadder } from "@/components/risk-ladder";
import { buildLadder } from "@/lib/risk-ladder";

export const dynamic = "force-dynamic";

/** "Wed, Nov 11 · 7:00 AM – 8:00 AM CST · HE8" as the day over the window. */
function DeliveryWindow({ label }: { label: string }) {
  const [day, ...rest] = label.split(" · ");
  return (
    <>
      <div>{day}</div>
      {rest.length > 0 && <div>{rest.join(" · ")}</div>}
    </>
  );
}

export default async function PositionsPage() {
  const { desk } = await requireDesk();
  const { tz } = await getViewerTimeZone();
  const positions = await getPositionsView(desk.accountUserId);
  // A book is read by delivery: the open one in the order it delivers, the
  // history newest first. Ties by point keep a block's legs together.
  const byDelivery = (a: (typeof positions)[number], b: (typeof positions)[number]) =>
    Date.parse(a.deliveryStart) - Date.parse(b.deliveryStart) ||
    a.settlementPoint.localeCompare(b.settlementPoint);
  const open = positions.filter((p) => p.isOpen).sort(byDelivery);
  const flat = positions.filter((p) => !p.isOpen).sort((a, b) => byDelivery(b, a));

  function table(title: string, rows: typeof open, showClosed: boolean) {
    return (
      <section className="card p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 px-4 py-3">
          <h2 className="card-title mb-0">{title}</h2>
          <span className="caption">
            {rows.length} position{rows.length === 1 ? "" : "s"}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-[13px] t-mute">
            {showClosed ? "No closed positions yet." : "No open positions. "}
            <Link href="/markets" className="t-accent hover:underline">
              Trade now
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
                  <th>Settlement</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Avg entry</th>
                  <th className="text-right">Mark</th>
                  <th className="text-right">Realized</th>
                  <th className="text-right">Unrealized</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const inst = instrumentInfo(p.instrument);
                  // A second leg is only meaningful for a path instrument; a
                  // stale counter point on a single-leg row must not render.
                  const legB = inst?.legs === 2 ? p.counterSettlementPoint : null;
                  return (
                    <tr key={p.id}>
                      {/* The market is the way back to trade it. */}
                      <td className="mono whitespace-nowrap font-medium">
                        <Link href={`/markets/${p.settlementPoint}`} className="hover:underline" title={`Trade ${p.settlementPoint}`}>
                          {legsLabel(p.settlementPoint, legB)}
                        </Link>
                      </td>
                      <td>
                        {inst ? (
                          <div className="flex flex-col items-start gap-1">
                            <span className="whitespace-nowrap" title={p.product}>
                              {inst.shortLabel}
                            </span>
                            <span className={`badge ${inst.tone}`}>{inst.ruleLabel}</span>
                          </div>
                        ) : (
                          <span className="t-mute">{p.instrument}</span>
                        )}
                      </td>
                      {/* The viewer's clock, with ERCOT's hour ending; a
                          window instrument by its dates. */}
                      {/* The day on one line and the window on the next, so the
                          book fits a laptop screen without a scrollbar. A table
                          cell ignores max-width, so the break is explicit. */}
                      <td className="whitespace-nowrap text-[12px] t-dim">
                        {inst?.rule === "AVERAGE" ? (
                          `${localDate(p.deliveryStart, tz)} → ${localDate(p.deliveryEnd, tz)}`
                        ) : (
                          <DeliveryWindow
                            label={windowLabel(Date.parse(p.deliveryStart), Date.parse(p.deliveryEnd), tz)}
                          />
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        {p.settlement === "SETTLED" ? (
                          <span className="badge badge-neutral">
                            Settled {p.settledAt ? briefDateTime(p.settledAt, tz) : ""}
                          </span>
                        ) : p.settlement === "FINALIZING" ? (
                          // Delivered and priced, but ERCOT can still correct
                          // the price until it is final; it settles then.
                          <span
                            className="badge badge-blue"
                            title="ERCOT's prices are final at 16:00 Central on the second business day after the operating day; it settles then, at any corrected price."
                          >
                            Final {briefDateTime(p.finalAt, tz)}
                          </span>
                        ) : p.settlement === "AWAITING" ? (
                          // Due and priced: the next sweep cashes it out.
                          <span className="badge badge-blue">Settles next run</span>
                        ) : p.settlement === "AWAITING_PRICE" ? (
                          // Due but the feed has not published its interval, so
                          // it stays open rather than settling at a stale price.
                          <span className="badge badge-amber">Awaiting price</span>
                        ) : (
                          <span className="t-mute">—</span>
                        )}
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
                        className={`mono text-right ${p.realizedPnl > 0n ? "pos" : p.realizedPnl < 0n ? "neg" : "t-mute"}`}
                      >
                        {sign(p.realizedPnl)}
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
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Book"
        title="Positions"
        aside={<span className="badge badge-neutral">{open.length} open</span>}
      >
        A day-ahead and a real-time position on the same hour are different
        instruments, and a spread is held separately from either leg. A
        delivered position is cashed out automatically once ERCOT&apos;s prices
        for its operating day are final (16:00 Central, two business days
        later, after any corrections), recording realized P&L without you
        closing it.
      </PageHeader>
      <RiskLadder
        ladder={buildLadder(
          open.map((p) => {
            const inst = instrumentInfo(p.instrument);
            return {
              instrument: p.instrument,
              legs: legsLabel(p.settlementPoint, inst?.legs === 2 ? p.counterSettlementPoint : null),
              instrumentLabel: inst?.shortLabel ?? p.instrument,
              deliveryStart: p.deliveryStart,
              deliveryEnd: p.deliveryEnd,
              quantityMwh: p.quantityMwh,
              unrealizedPnl: p.unrealizedPnl,
              marked: p.markPrice != null,
            };
          })
        )}
      />
      {table("Open positions", open, false)}
      {flat.length > 0 && table("Closed and full history", flat, true)}
    </div>
  );
}
