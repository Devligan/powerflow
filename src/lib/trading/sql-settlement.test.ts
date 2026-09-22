import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";

/**
 * Automatic settlement, against the real database (migration 0013).
 *
 * `src/lib/settlement.test.ts` tests the TypeScript mirror of the settlement
 * rules. This file tests the SQL that actually moves the money: the
 * `settle_delivered_positions` sweep, the SETTLED trade it writes, the audit
 * event, and the terminal state it leaves on the position. Postgres is the
 * source of truth; a shared TypeScript implementation agreeing with itself
 * proves nothing about the deployed function.
 *
 * Settlement is time-gated: only positions whose delivery window has passed are
 * eligible, and `execute_trade` refuses a past delivery. So each case fills a
 * position normally (a real, priced, future interval — the genuine user path)
 * and then runs the sweep with `p_as_of` at that window's end. The RPC takes
 * `p_as_of` precisely so this is deterministic. The application never passes it
 * — a client that could would force-settle its own undelivered positions — and
 * the function is service-role only regardless.
 *
 * Prices are read off the *fill* rather than assumed to be the base interval's
 * price: every interval has its own price, so a case computes its move relative
 * to what it actually paid.
 *
 * Opt in with `RUN_DB_TESTS=1`, since it creates real users in the configured
 * Supabase project.
 */
describe.skipIf(!dbTestsEnabled())("automatic settlement (live database)", () => {
  // HB_WEST/HB_PAN: the other database suites republish HB_NORTH and
  // HB_HOUSTON, so moving a price there could race them.
  const MARKET = "HB_WEST";
  const COUNTER = "HB_PAN";
  const PRODUCT = "RTM_HOURLY";
  /** A product whose series starts mid-day, so an earlier interval is
   *  guaranteed to have no price at all — used for the unpriced-settlement
   *  case. */
  const UNPRICED_PRODUCT = "RTM_15MIN";
  const HOUR = 3600_000;

  let db: SupabaseClient;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: SupabaseClient;
  let marketId: string;
  let counterId: string;

  /** Base interval: the earliest RTM_HOURLY interval that has not started yet,
   *  so it is priced and `execute_trade` accepts it. Every case offsets from
   *  here, which keeps each window inside the published horizon and apart from
   *  the others. */
  let base: string;

  /** Prices this suite republished, restored in afterAll. */
  const republished = new Map<string, number>();

  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

  const shift = (ts: string, hours: number) =>
    new Date(new Date(ts).getTime() + hours * HOUR).toISOString();

  const key = (market: string, product: string, ts: string) => `${market}|${product}|${ts}`;

  /**
   * Scoped to this suite's own account. The sweep is global by default — which
   * is how the cron job calls it — but every database suite shares one
   * database, and an unscoped sweep at `p_as_of` settles *every* delivered
   * position in it, including the desks the margin suite is mid-way through
   * funding. That made these suites order-dependent. Scoping costs no coverage
   * of the production path: the unscoped call is exercised by the cron route,
   * and the ACL test below calls it unscoped from a user session (and is
   * refused).
   */
  const settle = async (asOf: string, limit = 500) => {
    const { data, error } = await db.rpc("settle_delivered_positions", {
      p_as_of: asOf,
      p_limit: limit,
      p_user_id: user.id,
    });
    expect(error).toBeNull();
    return data as {
      considered: number;
      settled: number;
      deferred: number;
      failed: number;
      settlement_due_remaining: number;
      deferred_position_ids: string[];
      errors: Array<{ position_id?: string; error: string }>;
    };
  };

  const cash = async (): Promise<number> => {
    const { data } = await db
      .from("paper_accounts")
      .select("cash_balance")
      .eq("user_id", user.id)
      .single();
    return Number(data!.cash_balance);
  };

  const positionAt = async (
    marketIdArg: string,
    start: string,
    instrument: string,
    product = PRODUCT,
    counter: string | null = null
  ) => {
    let q = db
      .from("positions")
      .select(
        "id, quantity_mwh, average_entry_price, realized_pnl, settled_at, settlement_trade_id"
      )
      .eq("user_id", user.id)
      .eq("market_id", marketIdArg)
      .eq("instrument", instrument)
      .eq("product", product)
      .eq("delivery_start", start);
    // leg_key is a generated column, so match the counter leg explicitly
    // rather than relying on a NULL comparison.
    q = counter === null ? q.is("counter_market_id", null) : q.eq("counter_market_id", counter);
    const { data } = await q.maybeSingle();
    if (!data) return null;
    return {
      id: data.id as string,
      qty: Number(data.quantity_mwh),
      avg: Number(data.average_entry_price),
      realized: Number(data.realized_pnl),
      settledAt: data.settled_at as string | null,
      settlementTradeId: data.settlement_trade_id as string | null,
    };
  };

  const settledTrades = async () => {
    const { data } = await db
      .from("trades")
      .select(
        "id, side, quantity_mwh, execution_price, delivery_start, delivery_end, instrument, counter_market_id, market_price_id, status"
      )
      .eq("user_id", user.id)
      .eq("status", "SETTLED")
      .order("created_at", { ascending: true });
    return data ?? [];
  };

  /** Compare timestamps as instants. PostgREST renders a timestamptz as
   *  "…+00:00" where the values this suite builds end in ".000Z", so comparing
   *  the strings would silently find nothing. */
  const isAt = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();

  const settledTradesAt = async (start: string) =>
    (await settledTrades()).filter((t) => isAt(t.delivery_start, start));

  const settleEvents = async () => {
    const { data } = await db
      .from("audit_events")
      .select("id, entity_id, entity_type, metadata")
      .eq("user_id", user.id)
      .eq("event_type", "POSITION_SETTLED");
    return data ?? [];
  };

  /** Equity from trusted data: cash + Σ mark × signed qty over open positions.
   *  Marks come from the engine's own `position_marks` so an instrument price is
   *  never recomputed here from a point price. */
  const openEquity = async (): Promise<number> => {
    const [acct, pos, marks] = await Promise.all([
      db.from("paper_accounts").select("cash_balance").eq("user_id", user.id).single(),
      db.from("positions").select("id, quantity_mwh").eq("user_id", user.id).neq("quantity_mwh", 0),
      client.rpc("position_marks", { p_user_id: user.id }),
    ]);
    const markById = new Map(
      ((marks.data ?? []) as Array<{ position_id: string; mark_price: string | null }>).map((m) => [
        m.position_id,
        m.mark_price,
      ])
    );
    let marked = 0;
    for (const p of pos.data ?? []) {
      const mark = markById.get(p.id as string);
      if (mark == null) continue;
      marked += Number(mark) * Number(p.quantity_mwh);
    }
    return Number(acct.data!.cash_balance) + marked;
  };

  /** Fill a position through the real user path, returning what was paid. */
  const fill = async (
    over: Record<string, unknown> = {}
  ): Promise<{ entryPrice: number; quantity: number }> => {
    const { data, error } = await client.rpc("execute_trade", {
      p_user_id: user.id,
      p_market_id: marketId,
      p_counter_market_id: null,
      p_instrument: "ENERGY_SPOT",
      p_product: PRODUCT,
      p_side: "BUY",
      p_quantity_mwh: 10,
      p_delivery_start: base,
      p_delivery_end: shift(base, 1),
      p_client_order_id: crypto.randomUUID(),
      ...over,
    });
    if (error) throw new Error(`fill failed: ${error.message}`);
    const result = data as { execution_price: string; quantity_mwh: string };
    return {
      entryPrice: Number(result.execution_price),
      quantity: Number(result.quantity_mwh),
    };
  };

  /** Move a published price, remembering the original for restoration.
   *  Takes the market **id** — filtering `market_id` by a settlement point's
   *  ticker silently matches nothing. */
  const republish = async (marketIdArg: string, ts: string, price: number) => {
    const k = key(marketIdArg, PRODUCT, ts);
    if (!republished.has(k)) {
      const { data } = await db
        .from("market_prices")
        .select("price")
        .eq("market_id", marketIdArg)
        .eq("product", PRODUCT)
        .eq("delivery_timestamp", ts)
        .single();
      expect(data).not.toBeNull();
      republished.set(k, Number(data!.price));
    }
    const { error } = await db
      .from("market_prices")
      .update({ price: String(price) })
      .eq("market_id", marketIdArg)
      .eq("product", PRODUCT)
      .eq("delivery_timestamp", ts);
    expect(error).toBeNull();
  };

  beforeAll(async () => {
    db = admin();
    user = await createTestUser("sql-settlement");
    client = await userClient(user);

    const { data: m } = await db.from("markets").select("id").eq("settlement_point", MARKET).single();
    marketId = m!.id as string;
    const { data: c } = await db.from("markets").select("id").eq("settlement_point", COUNTER).single();
    counterId = c!.id as string;

    const { data: rows } = await db
      .from("market_prices")
      .select("delivery_timestamp")
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .gt("delivery_timestamp", new Date().toISOString())
      .order("delivery_timestamp", { ascending: true })
      .limit(1);
    base = rows![0].delivery_timestamp as string;
  }, 120_000);

  // Restore everything this suite moved, so the shared feed is left as found.
  afterAll(async () => {
    for (const [k, price] of republished) {
      const [market, product, ts] = k.split("|");
      await db
        .from("market_prices")
        .update({ price: String(price) })
        .eq("market_id", market)
        .eq("product", product)
        .eq("delivery_timestamp", ts);
    }
  }, 120_000);

  it("leaves a position that has not delivered untouched", async () => {
    // Deliberately past every `p_as_of` this suite uses, so it is never swept
    // by a later case and cannot move that case's cash. An earlier case that
    // left an in-range position open did exactly that: the next sweep settled
    // both, and the cash delta read as two settlements.
    const start = shift(base, 40);
    const end = shift(base, 41);
    await fill({ p_side: "BUY", p_delivery_start: start, p_delivery_end: end });

    // Sweep as of a time that predates this window: it is not delivered.
    const summary = await settle(shift(base, 1));
    expect(summary.failed).toBe(0);

    const pos = await positionAt(marketId, start, "ENERGY_SPOT");
    expect(pos!.qty).toBe(10);
    expect(pos!.settledAt).toBeNull();
  });

  it("settles a long at a higher price, banking the gain and leaving equity unchanged", async () => {
    const start = shift(base, 4);
    const end = shift(base, 5);
    const { entryPrice } = await fill({
      p_side: "BUY",
      p_delivery_start: start,
      p_delivery_end: end,
    });

    // The market moves after the fill: that is what makes settlement
    // interesting — unrealized P&L has to become realized.
    const settlementPrice = entryPrice + 5;
    await republish(marketId, start, settlementPrice);

    const cashBefore = await cash();
    const equityBefore = await openEquity();

    const summary = await settle(end);
    expect(summary.failed).toBe(0);
    expect(summary.settled).toBeGreaterThanOrEqual(1);

    const pos = await positionAt(marketId, start, "ENERGY_SPOT");
    expect(pos!.qty).toBe(0);
    expect(pos!.avg).toBeCloseTo(entryPrice, 6);
    expect(pos!.settledAt).not.toBeNull();
    expect(pos!.settlementTradeId).not.toBeNull();
    near(pos!.realized, 5 * 10);

    // A long is sold at settlement.
    near((await cash()) - cashBefore, settlementPrice * 10);

    // Settlement converts unrealized into realized; it must not create or
    // destroy equity.
    near(await openEquity(), equityBefore);

    const mine = await settledTradesAt(start);
    expect(mine).toHaveLength(1);
    expect(mine[0].side).toBe("SELL");
    expect(mine[0].quantity_mwh).toBe(10);
    near(Number(mine[0].execution_price), settlementPrice);
    // Provenance: a point fill points at its own interval's price row.
    expect(mine[0].market_price_id).not.toBeNull();

    const forThis = (await settleEvents()).filter((e) => e.entity_id === pos!.id);
    expect(forThis).toHaveLength(1);
    expect(forThis[0].entity_type).toBe("position");
    const meta = forThis[0].metadata as Record<string, unknown>;
    near(Number(meta.settlement_price), settlementPrice);
    near(Number(meta.realized_delta), 50);
  });

  it("settles a short at a lower price, banking the gain", async () => {
    const start = shift(base, 6);
    const end = shift(base, 7);
    const { entryPrice } = await fill({
      p_side: "SELL",
      p_delivery_start: start,
      p_delivery_end: end,
    });

    const settlementPrice = entryPrice - 4;
    await republish(marketId, start, settlementPrice);

    const cashBefore = await cash();
    const equityBefore = await openEquity();

    const summary = await settle(end);
    expect(summary.failed).toBe(0);

    const pos = await positionAt(marketId, start, "ENERGY_SPOT");
    expect(pos!.qty).toBe(0);
    // A short profits as the price falls: (avg − p) × |q|, which is the same
    // signed expression (p − avg) × q with q negative.
    near(pos!.realized, 4 * 10);

    // Buying the short back costs cash.
    near((await cash()) - cashBefore, settlementPrice * -10);
    near(await openEquity(), equityBefore);

    const mine = await settledTradesAt(start);
    expect(mine).toHaveLength(1);
    expect(mine[0].side).toBe("BUY");
    near(Number(mine[0].execution_price), settlementPrice);
  });

  it("settles a two-sided spread at the composed price, not a point price", async () => {
    const start = shift(base, 8);
    const end = shift(base, 9);
    const { entryPrice: entrySpread } = await fill({
      p_instrument: "BASIS_SPREAD",
      p_counter_market_id: counterId,
      p_side: "BUY",
      p_delivery_start: start,
      p_delivery_end: end,
    });

    // Move only the counter leg, so the spread itself moves by the same amount.
    const { data: counterRow } = await db
      .from("market_prices")
      .select("price")
      .eq("market_id", counterId)
      .eq("product", PRODUCT)
      .eq("delivery_timestamp", start)
      .single();
    await republish(counterId, start, Number(counterRow!.price) + 7);

    await settle(end);

    const pos = await positionAt(marketId, start, "BASIS_SPREAD", PRODUCT, counterId);
    expect(pos!.qty).toBe(0);
    near(pos!.avg, entrySpread);
    near(pos!.realized, 7 * 10);

    const mine = await settledTradesAt(start);
    expect(mine).toHaveLength(1);
    expect(mine[0].instrument).toBe("BASIS_SPREAD");
    expect(mine[0].counter_market_id).toBe(counterId);
    near(Number(mine[0].execution_price), entrySpread + 7);
    // A composed instrument has no single price row behind it.
    expect(mine[0].market_price_id).toBeNull();
  });

  it("does not carry one settlement's price row onto the next position's trade", async () => {
    // Regression (0015). The sweep resolved provenance into a variable that
    // was assigned only for a single-interval leg and never reset, so a
    // composed instrument settling *after* a point position inherited that
    // position's `market_price_id`. The sweep orders by `delivery_end`, so the
    // point position here is deliberately the earlier window: without the
    // reset, the spread's trade names a price row for an interval it does not
    // settle against, and the test above passes only because its sweep happens
    // to hold a single position.
    const pointStart = shift(base, 28);
    const pointEnd = shift(base, 29);
    const point = await fill({
      p_side: "BUY",
      p_delivery_start: pointStart,
      p_delivery_end: pointEnd,
    });
    await republish(marketId, pointStart, point.entryPrice + 3);

    const spreadStart = shift(base, 30);
    const spreadEnd = shift(base, 31);
    const spread = await fill({
      p_instrument: "BASIS_SPREAD",
      p_counter_market_id: counterId,
      p_side: "BUY",
      p_delivery_start: spreadStart,
      p_delivery_end: spreadEnd,
    });
    const { data: counterRow } = await db
      .from("market_prices")
      .select("price")
      .eq("market_id", counterId)
      .eq("product", PRODUCT)
      .eq("delivery_timestamp", spreadStart)
      .single();
    await republish(counterId, spreadStart, Number(counterRow!.price) + 5);

    // One sweep, both positions, point position first.
    const summary = await settle(spreadEnd);
    expect(summary.failed).toBe(0);
    expect(summary.settled).toBe(2);

    const pointTrade = (await settledTradesAt(pointStart))[0];
    const spreadTrade = (await settledTradesAt(spreadStart))[0];

    // A single-interval leg names the price row it settled against...
    expect(pointTrade.market_price_id).not.toBeNull();
    near(Number(pointTrade.execution_price), point.entryPrice + 3);

    // ...and the composed one must not, even though a point position settled
    // immediately before it in the same sweep.
    expect(spreadTrade.instrument).toBe("BASIS_SPREAD");
    expect(spreadTrade.market_price_id).toBeNull();
    near(Number(spreadTrade.execution_price), spread.entryPrice + 5);
    near(
      (await positionAt(marketId, spreadStart, "BASIS_SPREAD", PRODUCT, counterId))!.realized,
      5 * 10
    );
  });

  it("settles a block forward at its window average", async () => {
    const start = shift(base, 10);
    const end = shift(base, 14); // a 4-interval window
    const { entryPrice: entryAvg } = await fill({
      p_instrument: "BLOCK_FORWARD",
      p_side: "BUY",
      p_delivery_start: start,
      p_delivery_end: end,
    });

    // Lift one of the four intervals by 8: the window average moves by exactly
    // a quarter of that, whatever the other three intervals happen to be.
    // (Pricing it *at* entryAvg + 8 would only shift the average by 2 if that
    // interval already happened to equal the average.)
    const { data: inner } = await db
      .from("market_prices")
      .select("price")
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .eq("delivery_timestamp", shift(base, 11))
      .single();
    await republish(marketId, shift(base, 11), Number(inner!.price) + 8);

    await settle(end);

    const pos = await positionAt(marketId, start, "BLOCK_FORWARD");
    expect(pos!.qty).toBe(0);
    near(pos!.avg, entryAvg);
    near(pos!.realized, 2 * 10);

    const mine = await settledTradesAt(start);
    expect(mine).toHaveLength(1);
    near(Number(mine[0].execution_price), entryAvg + 2);
    expect(isAt(mine[0].delivery_end, end)).toBe(true);
  });

  it("does not settle a position the user already closed", async () => {
    const start = shift(base, 16);
    const end = shift(base, 17);
    await fill({ p_side: "BUY", p_delivery_start: start, p_delivery_end: end });
    await fill({ p_side: "SELL", p_delivery_start: start, p_delivery_end: end });

    await settle(end);

    const pos = await positionAt(marketId, start, "ENERGY_SPOT");
    expect(pos!.qty).toBe(0);
    // Flat because the user closed it, not because it settled.
    expect(pos!.settledAt).toBeNull();
    expect(pos!.settlementTradeId).toBeNull();
    expect(await settledTradesAt(start)).toHaveLength(0);
  });

  it("is idempotent: a second sweep over the same instant settles nothing", async () => {
    const start = shift(base, 18);
    const end = shift(base, 19);
    await fill({ p_side: "BUY", p_delivery_start: start, p_delivery_end: end });

    const first = await settle(end);
    expect(first.settled).toBeGreaterThanOrEqual(1);

    const posAfterFirst = await positionAt(marketId, start, "ENERGY_SPOT");
    const tradesAfterFirst = (await settledTrades()).length;
    const cashAfterFirst = await cash();

    // Same instant: everything settleable up to here is already settled, so a
    // repeat must be a no-op rather than a second cash movement.
    const second = await settle(end);
    expect(second.settled).toBe(0);

    const posAfterSecond = await positionAt(marketId, start, "ENERGY_SPOT");
    expect(posAfterSecond!.settledAt).toBe(posAfterFirst!.settledAt);
    expect(posAfterSecond!.settlementTradeId).toBe(posAfterFirst!.settlementTradeId);
    expect((await settledTrades()).length).toBe(tradesAfterFirst);
    near(await cash(), cashAfterFirst);
  });

  it("settles exactly once when two sweeps run concurrently", async () => {
    const start = shift(base, 20);
    const end = shift(base, 21);
    const { entryPrice } = await fill({
      p_side: "BUY",
      p_delivery_start: start,
      p_delivery_end: end,
    });

    const cashBefore = await cash();
    const [a, b] = await Promise.all([settle(end), settle(end)]);

    // Between them, exactly one settlement — `FOR UPDATE SKIP LOCKED` plus the
    // `settled_at is null` predicate is what makes that so.
    expect(a.settled + b.settled).toBe(1);

    const pos = await positionAt(marketId, start, "ENERGY_SPOT");
    expect(pos!.settledAt).not.toBeNull();
    expect(await settledTradesAt(start)).toHaveLength(1);
    // Cash moved once, for the closing side only.
    near((await cash()) - cashBefore, entryPrice * 10);
  });

  it("leaves a delivered position open and reports it when its interval is unpriced", async () => {
    // A position whose settlement interval was never published — the case the
    // sweep has to defer rather than guess through. Neither real path can
    // produce it: `execute_trade` refuses a past delivery, and strict pricing
    // (0011) refuses an unpriced interval. So the row is built by hand,
    // reproducing the position this database already carries from before 0011,
    // whose interval was never priced.
    //
    // Deleting a price row instead is not an option: the entry trade holds a
    // foreign key to it (`trades_market_price_id_fkey`), and trades are
    // immutable, so a published interval cannot be made unpriced after the
    // fact. That is itself worth knowing.
    const { data: earliest } = await db
      .from("market_prices")
      .select("delivery_timestamp")
      .eq("market_id", marketId)
      .eq("product", UNPRICED_PRODUCT)
      .order("delivery_timestamp", { ascending: true })
      .limit(1);
    // A day before that series begins is guaranteed to have no price at all.
    const start = shift(earliest![0].delivery_timestamp as string, -24);
    const end = new Date(new Date(start).getTime() + 15 * 60_000).toISOString();

    // Guard the assumption, so this fails loudly rather than passing vacuously
    // if the feed ever starts covering the interval.
    const { data: priced } = await db
      .from("market_prices")
      .select("id")
      .eq("market_id", marketId)
      .eq("product", UNPRICED_PRODUCT)
      .eq("delivery_timestamp", start);
    expect(priced).toHaveLength(0);

    const { data: productRow } = await db
      .from("products")
      .select("venue")
      .eq("code", UNPRICED_PRODUCT)
      .single();

    const { data: inserted, error: posErr } = await db
      .from("positions")
      .insert({
        user_id: user.id,
        market_id: marketId,
        product: UNPRICED_PRODUCT,
        instrument: "ENERGY_SPOT",
        counter_market_id: null,
        delivery_start: start,
        delivery_end: end,
        quantity_mwh: 10,
        average_entry_price: 40,
        realized_pnl: 0,
      })
      .select("id")
      .single();
    expect(posErr).toBeNull();
    const positionId = inserted!.id as string;

    // The entry trade and the cash it moved, so the book stays coherent.
    const { error: tradeErr } = await db.from("trades").insert({
      user_id: user.id,
      market_id: marketId,
      product: UNPRICED_PRODUCT,
      venue: productRow!.venue,
      instrument: "ENERGY_SPOT",
      counter_market_id: null,
      side: "BUY",
      quantity_mwh: 10,
      delivery_start: start,
      delivery_end: end,
      execution_price: 40,
      price_timestamp: start,
      // No price row exists for this interval, so there is none to point at.
      market_price_id: null,
      status: "EXECUTED",
    });
    expect(tradeErr).toBeNull();

    const cashBefore = await cash();
    await db
      .from("paper_accounts")
      .update({ cash_balance: String(cashBefore - 400) })
      .eq("user_id", user.id);

    // Delivered as of now, and unpriced: due, but not settleable.
    const summary = await settle(new Date().toISOString());
    expect(summary.failed).toBe(0);
    expect(summary.deferred).toBeGreaterThanOrEqual(1);
    expect(summary.deferred_position_ids).toContain(positionId);
    // Still due, so it is reported rather than silently dropped.
    expect(summary.settlement_due_remaining).toBeGreaterThanOrEqual(1);

    const after = await positionAt(marketId, start, "ENERGY_SPOT", UNPRICED_PRODUCT);
    // Untouched: not settled at a stale or invented price.
    expect(after!.qty).toBe(10);
    expect(after!.settledAt).toBeNull();
    expect(after!.realized).toBe(0);
    expect(await settledTradesAt(start)).toHaveLength(0);
    near(await cash(), cashBefore - 400);
  });

  it("refuses a settlement state that is not fully applied", async () => {
    const start = shift(base, 24);
    const end = shift(base, 25);
    await fill({ p_side: "BUY", p_delivery_start: start, p_delivery_end: end });
    const pos = await positionAt(marketId, start, "ENERGY_SPOT");

    // `position_settlement_state`: settled means flat *and* pointing at the
    // settlement trade. A half-applied write must be refused by the database,
    // not merely avoided by convention.
    const { error: stampOnly } = await db
      .from("positions")
      .update({ settled_at: new Date().toISOString() })
      .eq("id", pos!.id);
    expect(stampOnly).not.toBeNull();

    const { error: flatNoTrade } = await db
      .from("positions")
      .update({
        quantity_mwh: 0,
        settled_at: new Date().toISOString(),
        settlement_trade_id: null,
      })
      .eq("id", pos!.id);
    expect(flatNoTrade).not.toBeNull();

    // Nothing was applied.
    const after = await positionAt(marketId, start, "ENERGY_SPOT");
    expect(after!.qty).toBe(10);
    expect(after!.settledAt).toBeNull();
  });

  it("is not callable by an authenticated user", async () => {
    const start = shift(base, 26);
    const end = shift(base, 27);
    await fill({ p_side: "BUY", p_delivery_start: start, p_delivery_end: end });

    // Reachable with the anon key as a signed-in user, but the ACL denies it —
    // and the in-function `current_user` guard denies it independently, so a
    // mistaken future grant cannot reopen a sweep over every user's book.
    const { error } = await client.rpc("settle_delivered_positions", {
      p_as_of: end,
      p_limit: 10,
    });
    expect(error).not.toBeNull();

    const pos = await positionAt(marketId, start, "ENERGY_SPOT");
    expect(pos!.qty).toBe(10);
    expect(pos!.settledAt).toBeNull();
  });
});
