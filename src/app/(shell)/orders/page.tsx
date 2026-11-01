import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { format, parseDbDec } from "@/lib/money";
import { legsLabel, usd } from "@/lib/format";
import { dateTime, windowLabel } from "@/lib/time";
import { getViewerTimeZone } from "@/lib/time-zone-server";
import { OrderCancelButton } from "@/components/order-cancel-button";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  OPEN: "badge badge-green",
  FILLED: "badge badge-neutral",
  CANCELLED: "badge badge-neutral",
  EXPIRED: "badge badge-amber",
};

/**
 * The order book: day-ahead bids and offers waiting for the market to clear,
 * and their outcomes.
 *
 * An order is a commitment to a price, not a fill — this page is where a
 * resting order waits visibly, and where its eventual fill (with the trade
 * that realized it), cancellation, or expiry is recorded. Filled rows carry
 * their trade id, tying the book to the trade history.
 */
export default async function OrdersPage() {
  const user = await getSessionUser();
  const { tz } = await getViewerTimeZone();
  const db = await createClient();
  const [{ data }, { data: markets }] = await Promise.all([
    user
      ? db
          .from("paper_orders")
          .select(
            "id, market_id, counter_market_id, product, instrument, side, quantity_mwh, limit_price, order_type, status, delivery_start, delivery_end, filled_trade_id, created_at"
          )
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [] }),
    db.from("markets").select("id, settlement_point"),
  ]);

  const pointById = new Map((markets ?? []).map((m) => [m.id, m.settlement_point]));
  const legs = (o: { market_id: string; counter_market_id: string | null }) =>
    legsLabel(
      pointById.get(o.market_id) ?? null,
      o.counter_market_id ? pointById.get(o.counter_market_id) ?? null : null
    );

  const orders = data ?? [];
  const open = orders.filter((o) => o.status === "OPEN");
  const history = orders.filter((o) => o.status !== "OPEN");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold">Orders</h1>
        <p className="caption mt-1 t-mute">
          Day-ahead bids close at 10:00 AM Central the day before each
          operating day. When ERCOT publishes the clearing prices, each order
          fills at the actual clearing price: always for an order at the
          clearing price, and for a limit only when the price crosses it.
        </p>
      </header>

      {open.length > 0 && (
        <section className="card">
          <h2 className="card-title">Working ({open.length})</h2>
          <div className="mt-3 space-y-2">
            {open.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-3 border border-white/10 px-3 py-2"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className={o.side === "BUY" ? "mono pos" : "mono neg"}>
                    {o.side}
                  </span>
                  <span className="mono">{format(parseDbDec(o.quantity_mwh), 2)} MWh</span>
                  {o.limit_price == null ? (
                    <span className="t-mute">at the clearing price</span>
                  ) : (
                    <>
                      <span className="t-mute">@ limit</span>
                      <span className="mono">{usd(parseDbDec(o.limit_price))}</span>
                    </>
                  )}
                  <span className="t-mute">·</span>
                  <span className="mono font-medium">{legs(o)}</span>
                  <span className="text-[12px]">
                    {o.instrument} · {o.product}
                  </span>
                  <span className="caption t-mute">
                    delivery{" "}
                    {windowLabel(Date.parse(o.delivery_start), Date.parse(o.delivery_end), tz)}
                  </span>
                </div>
                <OrderCancelButton orderId={o.id} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">History</h2>
        {history.length === 0 ? (
          <p className="caption mt-2 t-mute">
            No orders yet. Place a day-ahead bid from any market page.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {history.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-2"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className={o.side === "BUY" ? "mono pos" : "mono neg"}>
                    {o.side}
                  </span>
                  <span className="mono">{format(parseDbDec(o.quantity_mwh), 2)}</span>
                  <span className="t-mute">@</span>
                  <span className="mono">
                    {o.limit_price == null ? "clearing" : format(parseDbDec(o.limit_price), 2)}
                  </span>
                  <span className="t-mute">·</span>
                  <span className="mono">{legs(o)}</span>
                  <span className="t-mute">· {o.instrument}</span>
                  <span className="caption t-mute">
                    placed {dateTime(o.created_at, tz)}
                  </span>
                </div>
                <span className={STATUS_TONE[o.status] ?? "badge badge-neutral"}>
                  {o.status}
                  {o.status === "FILLED" && o.filled_trade_id ? " · see trades" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
