import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  admin,
  createReplayTestUser,
  dbTestsEnabled,
  userClient,
  type TestUser,
} from "@/lib/testing/db";

/**
 * Limit orders, against the real database and ACTUAL ERCOT data.
 *
 * A limit order is a commitment to a price, validated with the same rules
 * as an instant trade; the sweep fills it when the interval's actual print
 * crosses. The printed price is the fill — never the limit — and the fill
 * goes through execute_trade, so idempotency, position and audit guarantees
 * are the instant engine's, unchanged.
 *
 * Bids close at 10:00 Central the day before (0038) and clear ~13:30, so no
 * single instant has both an open gate and a visible price. The accounts here
 * replay a recent hour instead: placed on a clock before its gate, swept on a
 * clock after it cleared and before delivery, exactly as a live bid lives.
 */
describe.skipIf(!dbTestsEnabled())("limit orders (live database)", () => {
  const PRODUCT = "DAM_HOURLY";
  const POINT = "HB_HOUSTON";

  let db: SupabaseClient;
  let userA: TestUser;
  let userB: TestUser;
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let marketId: string;
  /** A recent cleared hour, and its actual print. */
  let deliveryStart: string;
  let deliveryEnd: string;
  let print: number;
  /** An hour before the bid deadline, when the hour can still be bid for. */
  let beforeGate: string;
  /** After the clearing was published, before delivery. */
  let afterClearing: string;

  beforeAll(async () => {
    db = admin();
    userA = await createReplayTestUser("orders-a");
    userB = await createReplayTestUser("orders-b");
    clientA = await userClient(userA);
    clientB = await userClient(userB);

    const { data: market } = await db
      .from("markets")
      .select("id")
      .eq("settlement_point", POINT)
      .single();
    marketId = market!.id;

    // The newest clearing published ahead of its delivery. Any such hour will
    // do: the clock replays it, and a fresh database holds only a day or two.
    const { data: rows, error } = await db
      .from("market_prices")
      .select("delivery_timestamp, delivery_end, price, published_at")
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .lte("published_at", new Date().toISOString())
      .order("delivery_timestamp", { ascending: false })
      .limit(48);
    if (error) throw new Error(error.message);
    const cleared = (rows ?? []).find(
      (r) => Date.parse(r.published_at as string) < Date.parse(r.delivery_timestamp as string)
    );
    expect(cleared, "no DAM hour published ahead of its delivery").toBeTruthy();
    deliveryStart = cleared!.delivery_timestamp as string;
    deliveryEnd = cleared!.delivery_end as string;
    print = Number(cleared!.price);

    const { data: gate, error: gateErr } = await db.rpc("dam_gate", {
      p_delivery_start: deliveryStart,
    });
    if (gateErr) throw new Error(gateErr.message);
    beforeGate = new Date(Date.parse(gate as string) - 3_600_000).toISOString();
    afterClearing = new Date(Date.parse(cleared!.published_at as string) + 60_000).toISOString();
  }, 30_000);

  const place = (
    client: SupabaseClient,
    userId: string,
    over: Record<string, unknown> = {}
  ) =>
    client.rpc("place_limit_order", {
      p_user_id: userId,
      p_market_id: marketId,
      p_instrument: "VIRTUAL",
      p_product: PRODUCT,
      p_counter_market_id: null,
      p_side: "BUY",
      p_quantity_mwh: "10",
      p_limit_price: (print + 5).toFixed(2),
      p_delivery_start: deliveryStart,
      p_delivery_end: deliveryEnd,
      ...over,
    });

  const setClock = async (userId: string, iso: string) => {
    // The service role moves clocks: no session may since 0055.
    const { error } = await admin().rpc("set_sim_clock", { p_user_id: userId, p_iso: iso });
    expect(error).toBeNull();
  };

  const sweep = async () => {
    const { data, error } = await db.rpc("fill_crossing_limit_orders", {});
    expect(error).toBeNull();
    return data as { considered: number; filled: number; expired: number; errors: number };
  };

  it("fills a crossing buy at the actual print, through the instant engine", async () => {
    await setClock(userA.id, beforeGate);
    const { data: orderId, error } = await place(clientA, userA.id);
    expect(error).toBeNull();
    expect(orderId).toBeTruthy();

    await setClock(userA.id, afterClearing);
    const summary = await sweep();
    expect(summary.filled).toBeGreaterThanOrEqual(1);

    const { data: order } = await db
      .from("paper_orders")
      .select("status, filled_trade_id")
      .eq("id", orderId!)
      .single();
    expect(order!.status).toBe("FILLED");
    expect(order!.filled_trade_id).toBeTruthy();

    // The fill is the PRINT, not the limit: trade price == the market print.
    const { data: trade } = await db
      .from("trades")
      .select("execution_price, quantity_mwh, side, status")
      .eq("id", order!.filled_trade_id!)
      .single();
    expect(Number(trade!.execution_price)).toBe(print);
    expect(Number(trade!.quantity_mwh)).toBe(10);
    expect(trade!.side).toBe("BUY");
    expect(trade!.status).toBe("EXECUTED");

    // And the position exists, marked from the same print.
    const { data: pos } = await db
      .from("positions")
      .select("quantity_mwh, average_entry_price")
      .eq("user_id", userA.id)
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .eq("instrument", "VIRTUAL")
      .eq("delivery_start", deliveryStart)
      .single();
    expect(Number(pos!.quantity_mwh)).toBe(10);
    expect(Number(pos!.average_entry_price)).toBe(print);

    // Sweep idempotency: re-running fills nothing more (the order is closed),
    // and the trade count for this order stays exactly one.
    const again = await sweep();
    expect(again.filled).toBe(0);
    const { count } = await db
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userA.id);
    expect(count).toBe(1);
  }, 60_000);

  it("ends a non-crossing order at the clearing", async () => {
    // A buy well below the print cannot cross, and the market only clears once.
    await setClock(userA.id, beforeGate);
    const { data: orderId, error } = await place(clientA, userA.id, {
      p_limit_price: (print - 20).toFixed(2),
    });
    expect(error).toBeNull();

    await setClock(userA.id, afterClearing);
    const summary = await sweep();
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    const { data: order } = await db
      .from("paper_orders")
      .select("status")
      .eq("id", orderId!)
      .single();
    expect(order!.status).toBe("EXPIRED");
  }, 60_000);

  it("closes an order on cancellation, before the deadline", async () => {
    await setClock(userA.id, beforeGate);
    const { data: orderId, error } = await place(clientA, userA.id, {
      p_limit_price: (print - 20).toFixed(2),
    });
    expect(error).toBeNull();

    // The owner cancels; the second cancel is refused — the order is gone.
    const { data: okCancel, error: cancelErr } = await clientA.rpc(
      "cancel_order",
      { p_user_id: userA.id, p_order_id: orderId }
    );
    expect(cancelErr).toBeNull();
    expect(okCancel).toBe(true);
    const { error: againErr } = await clientA.rpc("cancel_order", {
      p_user_id: userA.id,
      p_order_id: orderId,
    });
    expect(againErr!.message).toContain("ORDER_NOT_OPEN");
  }, 60_000);

  it("places one order per idempotency key, even sent concurrently (0057)", async () => {
    await setClock(userA.id, beforeGate);
    await setClock(userB.id, beforeGate);
    const key = `retry-${crypto.randomUUID()}`;
    const resting = { p_limit_price: (print - 20).toFixed(2), p_client_order_id: key };

    // A burst of retries of one request: every one answers with the same order.
    const burst = await Promise.all(Array.from({ length: 5 }, () => place(clientA, userA.id, resting)));
    for (const r of burst) expect(r.error).toBeNull();
    const ids = new Set(burst.map((r) => r.data));
    expect(ids.size).toBe(1);
    const [orderId] = [...ids];
    const { count } = await db
      .from("paper_orders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userA.id)
      .eq("client_order_id", key);
    expect(count).toBe(1);

    // A retry that arrives after the order closed still names it, rather than
    // placing it again.
    const { error: cancelErr } = await clientA.rpc("cancel_order", { p_user_id: userA.id, p_order_id: orderId });
    expect(cancelErr).toBeNull();
    const late = await place(clientA, userA.id, resting);
    expect(late.error).toBeNull();
    expect(late.data).toBe(orderId);

    // The same key for a different order is a client bug, not a retry.
    const reused = await place(clientA, userA.id, { ...resting, p_quantity_mwh: "11" });
    expect(reused.error?.message).toContain("IDEMPOTENCY_KEY_REUSED");

    // Keys are per account: another trader's identical key is their own order.
    const other = await place(clientB, userB.id, resting);
    expect(other.error).toBeNull();
    expect(other.data).not.toBe(orderId);

    // The control: without a key, the same request twice is two orders.
    const plain = { p_limit_price: (print - 20).toFixed(2) };
    const [a, b] = await Promise.all([place(clientA, userA.id, plain), place(clientA, userA.id, plain)]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.data).not.toBe(b.data);
  }, 60_000);

  it("expires an order past its expiry on the sweep", async () => {
    // Expiry is on the account's clock, so it is set from that clock.
    await setClock(userA.id, beforeGate);
    const { data: orderId, error } = await place(clientA, userA.id, {
      p_limit_price: (print - 20).toFixed(2),
      p_expires_at: new Date(Date.parse(beforeGate) + 3_000).toISOString(),
    });
    expect(error).toBeNull();
    await new Promise((r) => setTimeout(r, 3_200));
    const summary = await sweep();
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    const { data: order } = await db
      .from("paper_orders")
      .select("status")
      .eq("id", orderId!)
      .single();
    expect(order!.status).toBe("EXPIRED");
  }, 60_000);

  it("enforces ownership and the service-role boundary", async () => {
    // A user cannot place into someone else's account…
    const { error: foreignErr } = await place(clientA, userB.id);
    expect(foreignErr!.message).toContain("FORBIDDEN");
    // …nor cancel another user's order.
    await setClock(userB.id, beforeGate);
    const { data: mine } = await place(clientB, userB.id, {
      p_limit_price: (print - 20).toFixed(2),
    });
    const { error: stealErr } = await clientA.rpc("cancel_order", {
      p_user_id: userB.id,
      p_order_id: mine,
    });
    expect(stealErr!.message).toContain("FORBIDDEN");
    // And the sweep is a system job: an authenticated session cannot even
    // reach it (execute privilege is service_role-only), which is the
    // boundary at the right layer.
    const { error: sweepErr } = await clientA.rpc(
      "fill_crossing_limit_orders",
      {}
    );
    expect(sweepErr!.message).toMatch(/permission denied|FORBIDDEN/);

    // RLS: user A sees none of user B's orders.
    const { data: seen } = await clientA
      .from("paper_orders")
      .select("id")
      .eq("user_id", userB.id);
    expect(seen ?? []).toHaveLength(0);
  }, 60_000);
});
