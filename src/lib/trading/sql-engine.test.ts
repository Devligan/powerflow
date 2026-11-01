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
  // The engine mechanics run on the DAY-AHEAD market: tomorrow's clearing is
  // published by ERCOT the day before delivery, so a forward fill through
  // the real user path prices against an actual ERCOT observation — the
  // genuine live-desk workflow. (The real-time series only exists after
  // delivery — that is ERCOT's own publication order — so it belongs to the
  // replay suites, where the clock drives delivery.)
  const PRODUCT = "DAM_HOURLY";
  const MARKET = "HB_NORTH";
  const HOUR = 3600_000;

  let db: SupabaseClient;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: SupabaseClient;
  let marketId: string;
  let price: number;
  let interval: string;
  let intervalEnd: string;
  /** Revision rows this suite published, removed at teardown. */
  const revisionIds: string[] = [];
  /** This run's start instant: the teardown sweep horizon. */
  let suiteStartedAt = new Date().toISOString();
  /** Monotonic stamp for revision publication times: the engine resolves
   *  visibility with the DATABASE's clock, so a revision stamped at the
   *  client's "now" can land in the DB's future when the two clocks skew —
   *  and the next fill would silently price at the previous observation.
   *  Stamping a margin behind the client clock keeps every revision visible
   *  immediately and in order. */
  let pubSeq = 0;
  const revisionInstant = () =>
    new Date(Date.now() - 10_000 + ++pubSeq).toISOString();

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
  /** "The market moved": a NEW publication of the interval at a later
   *  instant — the same mechanism production ingestion writes when ERCOT
   *  revises a price. The original observation is never edited; the as-of
   *  engine resolves the latest publication, which is now the revision. */
  const republish = async (newPrice: number) => {
    const { data: orig } = await db
      .from("market_prices")
      .select("id, source, venue, delivery_end")
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .eq("delivery_timestamp", interval)
      // The interval this suite picked is the latest VISIBLE one; among its
      // observations the engine resolves the latest publication, which is
      // the row a revision must anchor to.
      .lte("published_at", new Date().toISOString())
      .order("published_at", { ascending: false })
      .limit(1)
      .single();
    expect(orig).not.toBeNull();
    const { data: rev, error } = await db
      .from("market_prices")
      .insert({
        market_id: marketId,
        product: PRODUCT,
        delivery_timestamp: interval,
        delivery_end: orig!.delivery_end,
        price: String(newPrice),
        source: orig!.source,
        venue: orig!.venue,
        source_timestamp: revisionInstant(),
        published_at: revisionInstant(),
        is_final: true,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    revisionIds.push(rev!.id as string);
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

    // Self-healing against a crashed predecessor: revision rows from a run
    // whose afterAll never executed (killed battery, dropped connection)
    // would otherwise hijack the interval picker and every fill price in
    // this run. This suite's own revisions are what it can clean up
    // reliably — sweep any that predate this run's start.
    const startedAt = new Date().toISOString();
    suiteStartedAt = startedAt;
    client = await userClient(user);

    const { data: market } = await db
      .from("markets")
      .select("id")
      .eq("settlement_point", MARKET)
      .single();
    marketId = market!.id as string;

    // Pick the interval the way the engine prices: an observation is only
    // real to a live-mode account once its publication instant has passed.
    // DAM clears publish the day BEFORE delivery, so the newest published
    // clearing is a genuinely tradable forward interval. Within the
    // interval, latest publication wins (the revision rule).
    const { data: rows } = await db
      .from("market_prices")
      .select("delivery_timestamp, price")
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .lte("published_at", new Date().toISOString())
      .order("delivery_timestamp", { ascending: false })
      .order("published_at", { ascending: false })
      .limit(1);
    interval = rows![0].delivery_timestamp as string;
    price = Number(rows![0].price);
    intervalEnd = new Date(new Date(interval).getTime() + HOUR).toISOString();
  }, 120_000);

  // The original observations were never edited: removing this suite's
  // revisions restores the series exactly as it was found. The sweep by
  // run-start time also catches rows from a run whose teardown never ran
  // (killed battery, dropped connection) and would otherwise poison the
  // next run's interval picker.
  afterAll(async () => {
    await db
      .from("market_prices")
      .delete()
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .gte("published_at", new Date(new Date(suiteStartedAt).getTime() - 60_000).toISOString())
      .neq("source", "ERCOT_MIS_HISTORY");
    for (const id of revisionIds) {
      await db.from("market_prices").delete().eq("id", id);
    }
  }, 60_000);

  it("opens a long position and debits cash by exactly the notional", async () => {
    const before = await cash();
    const { data, error } = await db.rpc("execute_trade", trade());
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    await near(await cash(), before - 10 * price);
    const pos = (await position())!;
    expect(pos.qty).toBe(10);
    near(pos.avg, price);
    expect(pos.realized).toBe(0);
  }, 60_000);

  it("refuses a user's direct day-ahead fill: day-ahead positions are bids (0038)", async () => {
    // Fills come from the service-role order sweep (as above, via `db`); a
    // user session may only place an order before the 10:00 deadline.
    const { error } = await client.rpc("execute_trade", trade());
    expect(String(error?.message)).toMatch(/DAM_CLOSED|DAM_ORDER_REQUIRED/);
  });

  it("weights the average entry price when adding to a position", async () => {
    await republish(price + 20);
    const { error } = await db.rpc("execute_trade", trade({ p_quantity_mwh: 10, p_side: "BUY" }));
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
    const { error } = await db.rpc("execute_trade", trade({ p_quantity_mwh: 8, p_side: "SELL" }));
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
    const { error } = await db.rpc("execute_trade", trade({ p_quantity_mwh: 12, p_side: "SELL" }));
    expect(error).toBeNull();

    const pos = (await position())!;
    expect(pos.qty).toBe(0);
    near(pos.realized, before!.realized + (price - 3 - before!.avg) * 12);
    await republish(price);
  }, 60_000);

  it("flips through zero onto a new short basis", async () => {
    await db.rpc("execute_trade", trade({ p_quantity_mwh: 5, p_side: "BUY" }));
    await republish(price + 7);
    const { error } = await db.rpc("execute_trade", trade({ p_quantity_mwh: 8, p_side: "SELL" }));
    expect(error).toBeNull();

    const pos = (await position())!;
    expect(pos.qty).toBe(-3);
    near(pos.avg, price + 7); // the short is opened at the fill price, not the old basis
    await republish(price);
  }, 60_000);

  it("accumulates a short at a weighted average", async () => {
    await republish(price + 10);
    await db.rpc("execute_trade", trade({ p_quantity_mwh: 5, p_side: "SELL" }));
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
        // Several observations of one interval coexist under the revision
        // store (original + this suite's republishes); resolve the price the
        // way the engine does — latest publication wins.
        .order("published_at", { ascending: false })
        .limit(1)
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
    const { error } = await db.rpc(
      "execute_trade",
      trade({ p_quantity_mwh: 1000, p_delivery_start: farStart(), p_delivery_end: farEnd() })
    );
    expect(error).toBeTruthy();
    expect(error!.message).toContain("PRICE_UNAVAILABLE");

    const after = { cash: await cash(), ...(await counts()) };
    expect(after).toEqual(before);
  }, 60_000);

  it("refuses an order for an interval the feed has not priced", async () => {
    const { error } = await db.rpc(
      "execute_trade",
      trade({ p_delivery_start: farStart(), p_delivery_end: farEnd() })
    );
    expect(error).toBeTruthy();
    expect(error!.message).toContain("PRICE_UNAVAILABLE");
  }, 60_000);

  it("replays a duplicate order id instead of filling twice", async () => {
    const id = crypto.randomUUID();
    const first = await db.rpc("execute_trade", trade({ p_quantity_mwh: 4, p_client_order_id: id }));
    const before = { cash: await cash(), ...(await counts()) };

    const again = await db.rpc("execute_trade", trade({ p_quantity_mwh: 4, p_client_order_id: id }));
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
        db.rpc("execute_trade", trade({ p_quantity_mwh: 2, p_client_order_id: id }))
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
