import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { damDeadlineUtc } from "@/lib/ercot/hour-ending";
import { parseDbDec } from "@/lib/money";
import { instrumentInfo, legsLabel, num, tradeSideLabel, usd } from "@/lib/format";
import { dateTime, requestTime, windowLabel } from "@/lib/time";
import { getViewerTimeZone } from "@/lib/time-zone-server";
import { OrderCancelButton } from "@/components/order-cancel-button";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  OPEN: "badge badge-green",
  FILLED: "badge badge-neutral",
  CANCELLED: "badge badge-neutral",
  EXPIRED: "badge badge-amber",
};

interface OrderRow {
  id: string;
  market_id: string;
  counter_market_id: string | null;
  product: string;
  instrument: string;
  side: "BUY" | "SELL";
  quantity_mwh: string;
  limit_price: string | null;
  status: string;
  delivery_start: string;
  delivery_end: string;
  filled_trade_id: string | null;
  created_at: string;
}

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
  // The caller's own orders, through their session: row-level security
  // shows it exactly those.
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

  // Past ERCOT's 10:00 deadline a bid can no longer be withdrawn (0043).
  const nowMs = requestTime();
  const locked = (deliveryStart: string) => {
    const deadline = damDeadlineUtc(Date.parse(deliveryStart));
    return deadline != null && nowMs >= deadline;
  };

  const pointById = new Map((markets ?? []).map((m) => [m.id, m.settlement_point]));
  const legs = (o: OrderRow) =>
    legsLabel(
      pointById.get(o.market_id) ?? null,
      o.counter_market_id ? pointById.get(o.counter_market_id) ?? null : null
    );

  // Bids are read by the hour they deliver: the working ones in the order
  // they clear, the history newest delivery first.
  const byDelivery = (a: OrderRow, b: OrderRow) =>
    Date.parse(a.delivery_start) - Date.parse(b.delivery_start) || legs(a).localeCompare(legs(b));
  const orders = (data ?? []) as OrderRow[];
  const open = orders.filter((o) => o.status === "OPEN").sort(byDelivery);
  const history = orders.filter((o) => o.status !== "OPEN").sort((a, b) => byDelivery(b, a));

  /** One bid as a desk reads it: side, size, price, where, and which hour. */
  function orderLine(o: OrderRow) {
    const inst = instrumentInfo(o.instrument);
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`mono font-medium ${o.side === "BUY" ? "pos" : "neg"}`}>
          {tradeSideLabel(o.instrument, o.side)}
        </span>
        <span className="mono">{num(parseDbDec(o.quantity_mwh), 1)} MW</span>
        <span className="t-mute">
          {o.limit_price == null ? "at the clearing price" : "limit"}
        </span>
        {o.limit_price != null && <span className="mono">{usd(parseDbDec(o.limit_price))}</span>}
        <span className="t-mute">·</span>
        <span className="mono font-medium">{legs(o)}</span>
        <span className="text-[12px] t-dim" title={`${o.instrument} · ${o.product}`}>
          {inst?.shortLabel ?? o.instrument}
        </span>
        <span className="basis-full text-[12px] t-mute">
          {windowLabel(Date.parse(o.delivery_start), Date.parse(o.delivery_end), tz)}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold">Orders</h1>
        <p className="hint mt-1 t-mute">
          Day-ahead bids close at 10:00 AM Central the day before each
          operating day. When ERCOT publishes the clearing prices, each order
          fills at the actual clearing price: always for an order at the
          clearing price, and for a limit only when the price crosses it. A
          bid can be withdrawn until the deadline, and not after.
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
                {orderLine(o)}
                {locked(o.delivery_start) ? (
                  <span className="caption t-mute">Bids closed · awaiting the clearing</span>
                ) : (
                  <OrderCancelButton orderId={o.id} />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">History</h2>
        {history.length === 0 ? (
          <p className="hint mt-2 t-mute">
            {open.length > 0
              ? "No finished orders yet."
              : "No orders yet. Place a day-ahead bid from any market page."}
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {history.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-2"
              >
                {orderLine(o)}
                <span className="flex flex-col items-end gap-1">
                  <span className={STATUS_TONE[o.status] ?? "badge badge-neutral"}>
                    {o.status}
                    {o.status === "FILLED" && o.filled_trade_id ? " · see trades" : ""}
                  </span>
                  <span className="caption t-mute">placed {dateTime(o.created_at, tz)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
