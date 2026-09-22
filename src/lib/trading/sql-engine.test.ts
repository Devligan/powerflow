import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";

/**
 * The trading engine, against the real database.
 *
 * `src/lib/trading/accounting.test.ts` tests the TypeScript mirror of the
 * weighted-average rules. This file tests the SQL that actually moves cash —
 * `execute_trade`, its position upsert, and `position_marks` — through the same
 * authenticated client the application uses, then asserts on the rows it wrote.
 * Postgres is the source of truth here; a shared TypeScript implementation
 * agreeing with itself proves nothing about the deployed function.
 *
 * Opt in with `RUN_DB_TESTS=1`, since it creates real users in the configured
 * Supabase project.
 */
describe.skipIf(!dbTestsEnabled())("trading engine (live database)", () => {
  const PRODUCT = "RTM_HOURLY";
  const MARKET = "HB_NORTH";
  const HOUR = 3600_000;

  let db: SupabaseClient;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: SupabaseClient;
  let marketId: string;
  let price: number;
  let interval: string;
  let intervalEnd: string;
  const originalPrices = new Map<string, number>();

  // Tolerance rather than an exact round-trip: `Number(n.toFixed(6))` yields
  // `-0` for a tiny negative residue, and `toBe(-0)` fails against `0` — an
  // artifact of the comparison, not of the money.
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

  const cash = async (): Promise<number> => {
    const { data } = await db.from("paper_accounts").select("cash_balance").eq("user_id", user.id).single();
    return Number(data!.cash_balance);
  };
  const counts = async () => {
    const [trades, positions, audit] = await Promise.all([
      db.from("trades").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      db.from("positions").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      db.from("audit_events").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    ]);
    return { trades: trades.count ?? 0, positions: positions.count ?? 0, audit: audit.count ?? 0 };
  };
  const position = async (market = marketId, start = interval) => {
    const { data } = await db
      .from("positions")
      .select("quantity_mwh, average_entry_price, realized_pnl")
      .eq("user_id", user.id)
      .eq("market_id", market)
      .eq("delivery_start", start)
      .maybeSingle();
    if (!data) return null;
    return {
      qty: Number(data.quantity_mwh),
      avg: Number(data.average_entry_price),
      realized: Number(data.realized_pnl),
    };
  };
  /** Republish an interval at a new price — in a feed-driven system that is
   *  what "the market moved" means for an already-published interval. */
  const republish = async (newPrice: number) => {
    const { error } = await db
      .from("market_prices")
      .update({ price: String(newPrice) })
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .eq("delivery_timestamp", interval);
    expect(error).toBeNull();
  };

  const trade = (over: Record<string, unknown> = {}) => ({
    p_user_id: user.id,
    p_market_id: marketId,
    p_counter_market_id: null,
    p_instrument: "ENERGY_SPOT",
    p_product: PRODUCT,
    p_side: "BUY",
    p_quantity_mwh: 10,
    p_delivery_start: interval,
    p_delivery_end: intervalEnd,
    p_client_order_id: crypto.randomUUID(),
    ...over,
  });

  beforeAll(async () => {
    db = admin();
    user = await createTestUser("sql-engine");
    client = await userClient(user);

    const { data: market } = await db
      .from("markets")
      .select("id")
      .eq("settlement_point", MARKET)
      .single();
    marketId = market!.id as string;

    const { data: rows } = await db
      .from("market_prices")
      .select("delivery_timestamp, price")
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .order("delivery_timestamp", { ascending: false })
      .limit(1);
    interval = rows![0].delivery_timestamp as string;
    price = Number(rows![0].price);
    intervalEnd = new Date(new Date(interval).getTime() + HOUR).toISOString();
    originalPrices.set(interval, price);
  }, 120_000);

  // These tests revise the published price of one interval to exercise realized
  // P&L; leave the store as it was found.
  afterAll(async () => {
    for (const [ts, p] of originalPrices) {
      await db
        .from("market_prices")
        .update({ price: String(p) })
        .eq("market_id", marketId)
        .eq("product", PRODUCT)
        .eq("delivery_timestamp", ts);
    }
  }, 60_000);

  it("opens a long position and debits cash by exactly the notional", async () => {
    const before = await cash();
    const { data, error } = await client.rpc("execute_trade", trade());
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    await near(await cash(), before - 10 * price);
    const pos = (await position())!;
    expect(pos.qty).toBe(10);
    near(pos.avg, price);
    expect(pos.realized).toBe(0);
  }, 60_000);

  it("weights the average entry price when adding to a position", async () => {
    await republish(price + 20);
    const { error } = await client.rpc("execute_trade", trade({ p_quantity_mwh: 10, p_side: "BUY" }));
    expect(error).toBeNull();
    const pos = (await position())!;
    expect(pos.qty).toBe(20);
    near(pos.avg, (10 * price + 10 * (price + 20)) / 20);
    await republish(price);
  }, 60_000);

  it("realizes P&L only on the closed part of a partial close", async () => {
    const before = await position();
    await republish(price + 5);
    const cashBefore = await cash();
    const { error } = await client.rpc("execute_trade", trade({ p_quantity_mwh: 8, p_side: "SELL" }));
    expect(error).toBeNull();

    const pos = (await position())!;
    expect(pos.qty).toBe(12);
    near(pos.avg, before!.avg); // unchanged by a close
    near(pos.realized, (price + 5 - before!.avg) * 8);
    await near(await cash(), cashBefore + 8 * (price + 5));
    await republish(price);
  }, 60_000);

  it("full close leaves no position and the whole P&L realized", async () => {
    const before = await position();
    await republish(price - 3);
    const { error } = await client.rpc("execute_trade", trade({ p_quantity_mwh: 12, p_side: "SELL" }));
    expect(error).toBeNull();

    const pos = (await position())!;
    expect(pos.qty).toBe(0);
    near(pos.realized, before!.realized + (price - 3 - before!.avg) * 12);
    await republish(price);
  }, 60_000);

  it("flips through zero onto a new short basis", async () => {
    await client.rpc("execute_trade", trade({ p_quantity_mwh: 5, p_side: "BUY" }));
    await republish(price + 7);
    const { error } = await client.rpc("execute_trade", trade({ p_quantity_mwh: 8, p_side: "SELL" }));
    expect(error).toBeNull();

    const pos = (await position())!;
    expect(pos.qty).toBe(-3);
    near(pos.avg, price + 7); // the short is opened at the fill price, not the old basis
    await republish(price);
  }, 60_000);

  it("accumulates a short at a weighted average", async () => {
    await republish(price + 10);
    await client.rpc("execute_trade", trade({ p_quantity_mwh: 5, p_side: "SELL" }));
    const pos = (await position())!;
    expect(pos.qty).toBe(-8);
    near(pos.avg, (3 * (price + 7) + 5 * (price + 10)) / 8);
    await republish(price);
  }, 60_000);

  it("marks each position at its own interval price, and P&L decomposes exactly", async () => {
    const { data: marks, error } = await client.rpc("position_marks", { p_user_id: user.id });
    expect(error).toBeNull();

    const { data: positions } = await db
      .from("positions")
      .select("id, market_id, product, delivery_start, quantity_mwh, average_entry_price, realized_pnl")
      .eq("user_id", user.id);
    const open = (positions ?? []).filter((p) => Number(p.quantity_mwh) !== 0);

    // Strict pricing means an open position on a published interval is always
    // markable — and marked at *its own* price, not at a leg or a neighbour.
    expect((marks ?? []).length).toBe(open.length);
    let marked = 0;
    for (const m of (marks ?? []) as Array<{ position_id: string; mark_price: number }>) {
      const pos = positions!.find((p) => p.id === m.position_id)!;
      expect(pos).toBeTruthy();
      const { data: px } = await db
        .from("market_prices")
        .select("price")
        .eq("market_id", pos.market_id)
        .eq("product", pos.product)
        .eq("delivery_timestamp", pos.delivery_start)
        .single();
      near(Number(m.mark_price), Number(px!.price));
      marked += Number(pos.quantity_mwh) * Number(m.mark_price);
    }

    // cash moved by exactly the signed notional of every fill
    const { data: tradeRows } = await db
      .from("trades")
      .select("side, quantity_mwh, execution_price")
      .eq("user_id", user.id);
    const signedNotional = (tradeRows ?? []).reduce(
      (sum, t) =>
        sum + (t.side === "BUY" ? -1 : 1) * Number(t.quantity_mwh) * Number(t.execution_price),
      0
    );
    const { data: acct } = await db
      .from("paper_accounts")
      .select("starting_cash, cash_balance")
      .eq("user_id", user.id)
      .single();
    const starting = Number(acct!.starting_cash);
    const cashNow = Number(acct!.cash_balance);
    near(cashNow, starting + signedNotional);

    // equity  = cash + marked value
    // total P&L = equity − starting cash
    //            = realized (banked) + unrealized (open marked vs its basis)
    // The two sides are computed from different columns, so agreement is a
    // statement about the engine, not about arithmetic.
    const realized = (positions ?? []).reduce((s, p) => s + Number(p.realized_pnl), 0);
    const openCost = open.reduce(
      (s, p) => s + Number(p.quantity_mwh) * Number(p.average_entry_price),
      0
    );
    const unrealized = marked - openCost;
    near(cashNow + marked - starting, realized + unrealized);
  }, 60_000);

  it("a rejected trade writes nothing at all", async () => {
    const before = { cash: await cash(), ...(await counts()) };
    const { error } = await client.rpc(
      "execute_trade",
      trade({ p_quantity_mwh: 1000, p_delivery_start: farStart(), p_delivery_end: farEnd() })
    );
    expect(error).toBeTruthy();
    expect(error!.message).toContain("PRICE_UNAVAILABLE");

    const after = { cash: await cash(), ...(await counts()) };
    expect(after).toEqual(before);
  }, 60_000);

  it("refuses an order for an interval the feed has not priced", async () => {
    const { error } = await client.rpc(
      "execute_trade",
      trade({ p_delivery_start: farStart(), p_delivery_end: farEnd() })
    );
    expect(error).toBeTruthy();
    expect(error!.message).toContain("PRICE_UNAVAILABLE");
  }, 60_000);

  it("replays a duplicate order id instead of filling twice", async () => {
    const id = crypto.randomUUID();
    const first = await client.rpc("execute_trade", trade({ p_quantity_mwh: 4, p_client_order_id: id }));
    const before = { cash: await cash(), ...(await counts()) };

    const again = await client.rpc("execute_trade", trade({ p_quantity_mwh: 4, p_client_order_id: id }));
    expect(again.error).toBeNull();
    expect((again.data as { trade_id: string }).trade_id).toBe(
      (first.data as { trade_id: string }).trade_id
    );
    expect((again.data as { replayed?: boolean }).replayed).toBe(true);

    const after = { cash: await cash(), ...(await counts()) };
    expect(after).toEqual(before);
  }, 60_000);

  it("fills exactly once when the same order id arrives concurrently", async () => {
    const id = crypto.randomUUID();
    const before = { cash: await cash(), ...(await counts()) };

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.rpc("execute_trade", trade({ p_quantity_mwh: 2, p_client_order_id: id }))
      )
    );
    for (const r of responses) expect(r.error).toBeNull();

    const ids = new Set(responses.map((r) => (r.data as { trade_id: string }).trade_id));
    expect(ids.size).toBe(1);

    const after = { cash: await cash(), ...(await counts()) };
    expect(after.trades).toBe(before.trades + 1);
    expect(after.audit).toBe(before.audit + 1);
    near(after.cash, before.cash - 2 * price);

    const { count } = await db
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("client_order_id", id);
    expect(count).toBe(1);
  }, 120_000);

  function farStart() {
    return new Date(new Date(interval).getTime() + 20 * 24 * HOUR).toISOString();
  }
  function farEnd() {
    return new Date(new Date(farStart()).getTime() + HOUR).toISOString();
  }
});
