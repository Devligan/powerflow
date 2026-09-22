import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPositionsView } from "@/lib/queries";
import {
  usd,
  sign,
  num,
  shortDate,
  instrumentInfo,
  legsLabel,
  positionUnit,
  volumeUnitLabel,
} from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default async function PositionsPage() {
  const user = await requireUser();
  const positions = await getPositionsView(user.id);
  const open = positions.filter((p) => p.isOpen);
  const flat = positions.filter((p) => !p.isOpen);

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
                  <th></th>
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
                      <td className="mono whitespace-nowrap font-medium">
                        {legsLabel(p.settlementPoint, legB)}
                      </td>
                      <td>
                        {inst ? (
                          <div className="flex flex-col gap-1">
                            <span className="whitespace-nowrap">
                              {inst.shortLabel}
                            </span>
                            <span className="flex items-center gap-1">
                              <span className={`badge ${inst.tone}`}>
                                {inst.ruleLabel}
                              </span>
                              <span className="mono text-[10px] t-mute">
                                {p.product}
                              </span>
                            </span>
                          </div>
                        ) : (
                          <span className="t-mute">{p.instrument}</span>
                        )}
                      </td>
                      <td className="mono whitespace-nowrap t-mute">
                        {inst?.rule === "AVERAGE"
                          ? `${p.deliveryStart.slice(0, 10)} → ${p.deliveryEnd.slice(0, 10)}`
                          : showClosed
                            ? shortDate(p.deliveryStart)
                            : p.deliveryStart.slice(0, 16).replace("T", " ")}
                      </td>
                      <td className="whitespace-nowrap">
                        {p.settlement === "SETTLED" ? (
                          <span className="badge badge-neutral">
                            Settled {p.settledAt ? shortDate(p.settledAt) : ""}
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
                        className={`mono text-right ${p.realizedPnl >= 0n ? "pos" : "neg"}`}
                      >
                        {sign(p.realizedPnl)}
                      </td>
                      <td
                        className={`mono text-right ${p.unrealizedPnl > 0n ? "pos" : p.unrealizedPnl < 0n ? "neg" : ""}`}
                      >
                        {sign(p.unrealizedPnl)}
                      </td>
                      <td>
                        <Link
                          href={`/markets/${p.settlementPoint}`}
                          className="caption t-accent hover:underline"
                        >
                          Trade →
                        </Link>
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
        instruments, and a spread is held separately from either leg. Once a
        position has delivered it is cashed out automatically at its own
        instrument price, recording realized P&L without you closing it.
      </PageHeader>
      {table("Open positions", open, false)}
      {flat.length > 0 && table("Closed and full history", flat, true)}
    </div>
  );
}
