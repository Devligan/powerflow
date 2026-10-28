import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  admin,
  createTestUser,
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
 * goes through execute_trade, so idempotency, cash, position and audit
 * guarantees are the instant engine's, unchanged.
 *
 * Everything here runs on the live DAM series (the orderable forward
 * market): the tested interval is always a published-but-undelivered hour,
 * which the D-1 posting guarantees exists at any wall-clock instant.
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
  /** A published, undelivered interval and its actual print. */
  let deliveryStart: string;
  let deliveryEnd: string;
  let print: number;
  let createdUserIds: string[] = [];

  beforeAll(async () => {
    db = admin();
    userA = await createTestUser("orders-a");
    userB = await createTestUser("orders-b");
    clientA = await userClient(userA);
    clientB = await userClient(userB);
    createdUserIds = [userA.id, userB.id];

    const { data: market } = await db
      .from("markets")
      .select("id")
      .eq("settlement_point", POINT)
      .single();
    marketId = market!.id;

    // The D-1 posting guarantees a published, undelivered DAM hour at any
    // instant: pick the earliest one. (Delivery end strictly in the future,
    // publication already visible.)
    const { data: rows, error } = await db
      .from("market_prices")
      .select("delivery_timestamp, delivery_end, price")
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .gt("delivery_end", new Date().toISOString())
      .order("delivery_timestamp", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    expect(rows, "no published future DAM interval — D-1 posting missing").toBeTruthy();
    deliveryStart = rows![0].delivery_timestamp as string;
    deliveryEnd = rows![0].delivery_end as string;
    print = Number(rows![0].price);
  }, 30_000);

  afterAll(async () => {
    // Orders and their audit events cascade with the users (0026 FK); the
    // sweep's fills are ordinary trades, removed by the standard teardown.
    for (const id of createdUserIds) {
      await db.from("paper_orders").delete().eq("user_id", id);
      await db.from("audit_events").delete().eq("user_id", id);
      await db.from("trades").delete().eq("user_id", id);
      await db.from("positions").delete().eq("user_id", id);
      await db.from("paper_accounts").delete().eq("user_id", id);
      await db.from("profiles").delete().eq("id", id);
    }
  }, 30_000);

  const place = (
    client: SupabaseClient,
    userId: string,
    over: Record<string, unknown> = {}
  ) =>
    client.rpc("place_limit_order", {
      p_user_id: userId,
      p_market_id: marketId,
      p_instrument: "ENERGY_SPOT",
      p_product: PRODUCT,
      p_counter_market_id: null,
      p_side: "BUY",
      p_quantity_mwh: "10",
      p_limit_price: (print + 5).toFixed(2),
      p_delivery_start: deliveryStart,
      p_delivery_end: deliveryEnd,
      ...over,
    });

  const sweep = async () => {
    const { data, error } = await db.rpc("fill_crossing_limit_orders", {});
    expect(error).toBeNull();
    return data as { considered: number; filled: number; expired: number; errors: number };
  };

  it("fills a crossing buy at the actual print, through the instant engine", async () => {
    const { data: orderId, error } = await place(clientA, userA.id);
    expect(error).toBeNull();
    expect(orderId).toBeTruthy();

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
      .eq("instrument", "ENERGY_SPOT")
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

  it("leaves a non-crossing order open, and cancellation closes it", async () => {
    // A buy far below the print cannot cross on a real series this small.
    const { data: orderId, error } = await place(clientA, userA.id, {
      p_limit_price: (print / 2).toFixed(2),
    });
    expect(error).toBeNull();

    await sweep();
    const { data: order } = await db
      .from("paper_orders")
      .select("status")
      .eq("id", orderId!)
      .single();
    expect(order!.status).toBe("OPEN");

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

  it("expires an order past its expiry on the sweep", async () => {
    const { data: orderId, error } = await place(clientA, userA.id, {
      p_limit_price: (print / 2).toFixed(2),
      p_expires_at: new Date(Date.now() + 1_500).toISOString(),
    });
    expect(error).toBeNull();
    await new Promise((r) => setTimeout(r, 1_700));
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
    const { data: mine } = await place(clientB, userB.id, {
      p_limit_price: (print / 2).toFixed(2),
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
