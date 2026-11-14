import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPositionsView, getSettlementFills } from "@/lib/queries";
import {
  usd,
  sign,
  signedUsd,
  num,
  instrumentInfo,
  legsLabel,
  positionUnit,
  tradeSideLabel,
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
  const user = await requireUser();
  const { tz } = await getViewerTimeZone();
  const positions = await getPositionsView(user.id);
  // A book is read by delivery: the open one in the order it delivers, the
  // history newest first. Ties by point keep a block's legs together.
  const byDelivery = (a: (typeof positions)[number], b: (typeof positions)[number]) =>
    Date.parse(a.deliveryStart) - Date.parse(b.deliveryStart) ||
    a.settlementPoint.localeCompare(b.settlementPoint);
  const open = positions.filter((p) => p.isOpen).sort(byDelivery);
  const flat = positions.filter((p) => !p.isOpen).sort((a, b) => byDelivery(b, a));
  const fills = await getSettlementFills(
    user.id,
    flat.map((p) => p.settlementTradeId).filter((id): id is string => id != null)
  );

  /** Market and instrument cells, shared by both tables. */
  function nameCells(p: (typeof positions)[number]) {
    const inst = instrumentInfo(p.instrument);
    // A second leg is only meaningful for a path instrument; a stale counter
    // point on a single-leg row must not render.
    const legB = inst?.legs === 2 ? p.counterSettlementPoint : null;
    return (
      <>
        {/* The market is the way back to trade it. */}
        <td className="mono whitespace-nowrap font-medium">
          <Link href={`/markets/${p.settlementPoint}`} className="hover:underline" title={`Trade ${p.settlementPoint}`}>
            {legsLabel(p.settlementPoint, legB)}
          </Link>
        </td>
        <td>
          {inst ? (
            <span className="whitespace-nowrap" title={inst.ruleLabel}>
              {inst.shortLabel}
            </span>
          ) : (
            <span className="t-mute">{p.instrument}</span>
          )}
        </td>
        {/* The day on one line and the window on the next, so the book fits a
            laptop screen without a scrollbar. A table cell ignores max-width,
            so the break is explicit. A window instrument shows its dates. */}
        <td className="whitespace-nowrap text-[12px] t-dim">
          {inst?.rule === "AVERAGE" ? (
            `${localDate(p.deliveryStart, tz)} → ${localDate(p.deliveryEnd, tz)}`
          ) : (
            <DeliveryWindow label={windowLabel(Date.parse(p.deliveryStart), Date.parse(p.deliveryEnd), tz)} />
          )}
        </td>
      </>
    );
  }

  /**
   * What a closed position was, read off the fill that settled it: the side
   * it held (the opposite of the closing fill), the size, what it was entered
   * at and the final price it settled at. One closed by an offsetting trade
   * before settlement has no such fill and shows its entry and P&L alone.
   */
  function history(rows: typeof flat) {
    return (
      <section className="card p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 px-4 py-3">
          <h2 className="card-title mb-0">History</h2>
          <span className="caption">
            {rows.length} position{rows.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Instrument</th>
                <th>Delivery</th>
                <th>Side</th>
                <th className="text-right">Size</th>
                <th className="text-right" title="The day-ahead price the position was filled at">
                  Entry
                </th>
                <th className="text-right" title="The final price it settled at">
                  Settled at
                </th>
                <th className="text-right">P&amp;L</th>
                <th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const fill = p.settlementTradeId ? fills.get(p.settlementTradeId) : undefined;
                return (
                  <tr key={p.id}>
                    {nameCells(p)}
                    <td className="mono whitespace-nowrap text-[12px]">
                      {fill ? tradeSideLabel(p.instrument, fill.side === "BUY" ? "SELL" : "BUY") : <span className="t-mute">—</span>}
                    </td>
                    <td className="mono whitespace-nowrap text-right">
                      {fill ? (
                        <>
                          {num(fill.quantityMwh)}{" "}
                          <span className="t-mute">{volumeUnitLabel(positionUnit(p.product))}</span>
                        </>
                      ) : (
                        <span className="t-mute">—</span>
                      )}
                    </td>
                    <td className="mono text-right">{usd(p.averageEntryPrice)}</td>
                    <td className="mono text-right">{fill ? usd(fill.price) : <span className="t-mute">—</span>}</td>
                    <td
                      className={`mono text-right ${p.realizedPnl > 0n ? "pos" : p.realizedPnl < 0n ? "neg" : "t-mute"}`}
                    >
                      {signedUsd(p.realizedPnl)}
                    </td>
                    <td className="whitespace-nowrap text-[12px] t-dim">
                      {p.settledAt ? `Settled ${briefDateTime(p.settledAt, tz)}` : "Closed before settlement"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  function table(title: string, rows: typeof open) {
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
                  return (
                    <tr key={p.id}>
                      {nameCells(p)}
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
        Every hour you hold, marked against ERCOT&apos;s real-time price as it
        prints. A delivered hour cashes out by itself once ERCOT calls its
        prices final (4:00 PM Central, two business days later, after any
        corrections), so there is nothing to close.
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
      {table("Open positions", open)}
      {flat.length > 0 && history(flat)}
    </div>
  );
}
