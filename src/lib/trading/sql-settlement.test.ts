import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";
import { loadFixturePoint } from "@/lib/testing/ercot-fixture";

/**
 * Automatic settlement, against the real database (migration 0013) on
 * ACTUAL ERCOT data.
 *
 * `src/lib/settlement.test.ts` tests the TypeScript mirror of the settlement
 * rules. This file tests the SQL that actually moves the money: the
 * `settle_delivered_positions` sweep, the SETTLED trade it writes, the audit
 * event, and the terminal state it leaves on the position. Postgres is the
 * source of truth; a shared TypeScript implementation agreeing with itself
 * proves nothing about the deployed function.
 *
 * The suite trades as a REPLAY DESK. ERCOT's own publication order makes a
 * live forward fill of a real-time hour impossible — a real-time settlement
 * price only exists after the hour — so each case enters at the day-ahead
 * clearing for a historical operating day and settles at that day's actual
 * real-time hourly settlement value: the DA→RT lifecycle a desk lives
 * through. Every expected price is read from the fixture (actual ERCOT MIS
 * data, built by scripts/build-history-fixture.ts); nothing is injected.
 *
 * Instruments follow ERCOT's own economics: a day-ahead ENERGY_SPOT held to
 * delivery settles at its own clearing — flat, because the DA price IS its
 * settlement — so every case that carries DA→RT P&L trades DART_SPREAD
 * (CONVERGENCE: enter at the day-ahead leg, settle at the real-time final).
 * A basis settles as the difference of its two legs' day-ahead finals, and
 * a block settles at the average of its window's day-ahead clearings.
 *
 * The clock is set once, before the trading day, and every entry fills at
 * that simulated instant — the day-ahead clearings are visible (ERCOT posted
 * them the day before), the real-time outcomes are not (§7's look-ahead
 * rule). The sweep advances time by being called with `p_as_of` at each
 * case's delivery end, which is what makes that position due. Cases occupy
 * distinct hours of the day, so one case's sweep never reaches a later
 * case's position; the one position that must survive every sweep is closed
 * explicitly once its assertion has been made.
 *
 * Opt in with `RUN_DB_TESTS=1`, since it creates real users in the configured
 * Supabase project.
 */
describe.skipIf(!dbTestsEnabled())("automatic settlement (live database)", () => {
  // Hubs of its own: the live suites (engine, concurrency, immutability,
  // RLS) trade their own points, and this suite reads the fixture rather
  // than writing prices, so nothing here can collide with them.
  const POINT = "HB_WEST";
  const COUNTER = "HB_PAN";
  /** The entry market: the day-ahead clearing, published before delivery. */
  const PRODUCT = "DAM_HOURLY";
  /** A product whose series starts mid-day, so an earlier interval is
   *  guaranteed to have no price at all — used for the unpriced-settlement
   *  case. */
  const UNPRICED_PRODUCT = "RTM_15MIN";
  const HOUR = 3600_000;
  /** The day's early hours go to the replay and engine suites' eyes; this
   *  desk starts a little into the day. */
  const FIRST = 2;

  let db: SupabaseClient;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: SupabaseClient;
  let marketId: string;
  let counterId: string;

  /** Fixture series (actual ERCOT data) for the point and the counter point. */
  let dam: Map<string, { price: string }>;
  let rtHour: Map<string, { price: string }>;
  let damCounter: Map<string, { price: string }>;
  /** Every delivery hour of the operating day, in order. */
  let hours: string[];

  /** Each case trades its own hour: `slot(k)` = hours[FIRST + k]. */
  const slot = (k: number) => hours[FIRST + k];

  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

  const shift = (ts: string, hours: number) =>
    new Date(new Date(ts).getTime() + hours * HOUR).toISOString();

  /** The actual ERCOT real-time settlement value of a delivery hour. */
  const rtFinal = (start: string): number => {
    const row = rtHour.get(start);
    expect(row, `fixture carries no RT hourly final for ${start}`).toBeTruthy();
    return Number(row!.price);
  };
  /** The actual ERCOT day-ahead clearing at the counter point. */
  const daClearingCounter = (start: string): number => {
    const row = damCounter.get(start);
    expect(row, `fixture carries no counter day-ahead clearing for ${start}`).toBeTruthy();
    return Number(row!.price);
  };
  /** The actual ERCOT day-ahead clearing of a delivery hour. */
  const daClearing = (start: string): number => {
    const row = dam.get(start);
    expect(row, `fixture carries no day-ahead clearing for ${start}`).toBeTruthy();
    return Number(row!.price);
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

  /** Fill a position through the real user path, returning what was paid.
   *  A point entry is asserted to cost exactly the fixture's actual day-ahead
   *  clearing for its interval — the statement that the engine, the catalog
   *  and ERCOT's published data agree. */
  const fill = async (
    over: Record<string, unknown> = {}
  ): Promise<{ entryPrice: number; quantity: number }> => {
    const start = over.p_delivery_start as string;
    const end =
      (over.p_delivery_end as string | undefined) ?? shift(start, 1);
    const { data, error } = await client.rpc("execute_trade", {
      p_user_id: user.id,
      p_market_id: marketId,
      p_counter_market_id: null,
      p_instrument: "ENERGY_SPOT",
      p_product: PRODUCT,
      p_side: "BUY",
      p_quantity_mwh: 10,
      p_delivery_start: start,
      p_delivery_end: end,
      p_client_order_id: crypto.randomUUID(),
      ...over,
    });
    expect(error, `fill failed: ${error?.message}`).toBeNull();
    const result = data as { execution_price: string; quantity_mwh: string };
    const entryPrice = Number(result.execution_price);
    // ENERGY_SPOT and DART_SPREAD both enter at the day-ahead leg — the
    // clearing itself for a spot fill, the DA leg of the convergence for
    // the virtual. Anything composed (a basis) prices by its own rule.
    if (
      over.p_counter_market_id === undefined &&
      (over.p_instrument === undefined || over.p_instrument === "DART_SPREAD")
    ) {
      near(entryPrice, daClearing(start));
    }
    return { entryPrice, quantity: Number(result.quantity_mwh) };
  };

  beforeAll(async () => {
    db = admin();
    user = await createTestUser("sql-settlement");
    client = await userClient(user);

    const point = await loadFixturePoint(db, POINT);
    const counter = await loadFixturePoint(db, COUNTER);
    marketId = point.marketId;
    counterId = counter.marketId;
    dam = point.dam;
    rtHour = point.rtHour;
    damCounter = counter.dam;

    hours = [...dam.keys()].sort();
    expect(hours.length).toBe(24);
    // Every hour this desk trades must carry an actual RT settlement final —
    // the whole point of the replay desk.
    for (let k = FIRST; k <= FIRST + 21; k++) {
      expect(rtHour.has(hours[k]), `missing RT final at ${hours[k]}`).toBe(true);
    }

    // The desk sits just before the trading day: clearings visible, outcomes
    // not yet. Every entry below fills at this simulated instant.
    const { error: clockErr } = await client.rpc("set_sim_clock", {
      p_user_id: user.id,
      p_iso: shift(hours[FIRST], -1),
    });
    expect(clockErr).toBeNull();
  }, 240_000);

  it("leaves a position that has not delivered untouched", async () => {
    // The day's last hour: every sweep this suite runs, at an earlier case's
    // delivery end, predates this window, so it is never swept by them.
    const start = hours[23];
    const end = shift(start, 1);
    await fill({ p_side: "BUY", p_delivery_start: start, p_delivery_end: end });

    // Sweep as of a time that predates this window: it is not delivered.
    const summary = await settle(shift(slot(FIRST), 1));
    expect(summary.failed).toBe(0);

    const pos = await positionAt(marketId, start, "ENERGY_SPOT");
    expect(pos!.qty).toBe(10);
    expect(pos!.settledAt).toBeNull();

    // The assertion is made; now close the position so no later sweep can
    // move this desk's cash underneath a later case's expectations.
    await fill({ p_side: "SELL", p_delivery_start: start, p_delivery_end: end });
  });

  it("settles a long at the actual real-time price, banking the result and leaving equity unchanged", async () => {
    const start = slot(2);
    const end = shift(start, 1);
    const { entryPrice } = await fill({
      p_instrument: "DART_SPREAD",
      p_side: "BUY",
      p_delivery_start: start,
      p_delivery_end: end,
    });
    // The real-time settlement of this hour, from ERCOT's own data.
    const settlementPrice = rtFinal(start);
    expect(Math.abs(settlementPrice - entryPrice)).toBeGreaterThan(0.25);

    const cashBefore = await cash();
    const equityBefore = await openEquity();

    const summary = await settle(end);
    expect(summary.failed).toBe(0);
    expect(summary.settled).toBeGreaterThanOrEqual(1);


    const pos = await positionAt(marketId, start, "DART_SPREAD");
    expect(pos!.qty).toBe(0);
    expect(pos!.avg).toBeCloseTo(entryPrice, 6);
    expect(pos!.settledAt).not.toBeNull();
    expect(pos!.settlementTradeId).not.toBeNull();
    near(pos!.realized, (settlementPrice - entryPrice) * 10);

    // A long is sold at settlement.
    near((await cash()) - cashBefore, settlementPrice * 10);

    // Settlement moves equity by exactly the realized P&L — the DA→RT basis
    // jump — and by nothing else: no double-counted mark, no leaked cash.
    near((await openEquity()) - equityBefore, (settlementPrice - entryPrice) * 10);

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
    near(Number(meta.realized_delta), (settlementPrice - entryPrice) * 10);
  });

  it("settles a short at the actual real-time price, banking the result", async () => {
    const start = slot(3);
    const end = shift(start, 1);
    const { entryPrice } = await fill({
      p_instrument: "DART_SPREAD",
      p_side: "SELL",
      p_delivery_start: start,
      p_delivery_end: end,
    });
    const settlementPrice = rtFinal(start);

    const cashBefore = await cash();
    const equityBefore = await openEquity();

    const summary = await settle(end);
    expect(summary.failed).toBe(0);

    const pos = await positionAt(marketId, start, "DART_SPREAD");
    expect(pos!.qty).toBe(0);
    // A short profits as the price falls. The engine realizes the signed
    // expression (settlement − avg) × qty, so with qty = −10 a rising RT
    // price realizes negative P&L for the short.
    near(pos!.realized, (settlementPrice - entryPrice) * -10);

    // Buying the short back settles in cash at the real-time price.
    near((await cash()) - cashBefore, settlementPrice * -10);
    near((await openEquity()) - equityBefore, (entryPrice - settlementPrice) * 10);

    const mine = await settledTradesAt(start);
    expect(mine).toHaveLength(1);
    expect(mine[0].side).toBe("BUY");
    near(Number(mine[0].execution_price), settlementPrice);
  });

  it("settles a two-sided spread at the composed actual price, not a point price", async () => {
    const start = slot(4);
    const end = shift(start, 1);
    const { entryPrice: entrySpread } = await fill({
      p_instrument: "BASIS_SPREAD",
      p_counter_market_id: counterId,
      p_side: "BUY",
      p_delivery_start: start,
      p_delivery_end: end,
    });

    // Both legs settle at their actual day-ahead finals; the spread's
    // settlement is the DIFFERENCE composition the engine settles:
    // sink minus source — the counter point's clearing minus this point's.
    const settlementSpread = daClearingCounter(start) - daClearing(start);
    // And the entry was that same composition at the same instant's
    // clearings — what the desk paid is exactly what it will settle at,
    // because a day-ahead basis has no second market to converge to.
    near(entrySpread, daClearingCounter(start) - daClearing(start));

    const cashBefore = await cash();
    const equityBefore = await openEquity();

    await settle(end);

    const pos = await positionAt(marketId, start, "BASIS_SPREAD", PRODUCT, counterId);
    expect(pos!.qty).toBe(0);
    near(pos!.avg, entrySpread);
    near(pos!.realized, (settlementSpread - entrySpread) * 10);
    // Equity moves by the realized spread, and nothing else.
    near((await openEquity()) - equityBefore, (settlementSpread - entrySpread) * 10);

    const mine = await settledTradesAt(start);
    expect(mine).toHaveLength(1);
    expect(mine[0].instrument).toBe("BASIS_SPREAD");
    expect(mine[0].counter_market_id).toBe(counterId);
    near(Number(mine[0].execution_price), settlementSpread);
    // A composed instrument has no single price row behind it.
    expect(mine[0].market_price_id).toBeNull();
    // Cash settled at the composed price.
    near((await cash()) - cashBefore, settlementSpread * 10);
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
    const pointStart = slot(5);
    const pointEnd = shift(pointStart, 1);
    await fill({
      p_instrument: "DART_SPREAD",
      p_side: "BUY",
      p_delivery_start: pointStart,
      p_delivery_end: pointEnd,
    });

    const spreadStart = slot(6);
    const spreadEnd = shift(spreadStart, 1);
    const spread = await fill({
      p_instrument: "BASIS_SPREAD",
      p_counter_market_id: counterId,
      p_side: "BUY",
      p_delivery_start: spreadStart,
      p_delivery_end: spreadEnd,
    });
    const spreadSettlement = daClearingCounter(spreadStart) - daClearing(spreadStart);

    // One sweep, both positions, point position first.
    const summary = await settle(spreadEnd);
    expect(summary.failed).toBe(0);
    expect(summary.settled).toBe(2);

    const pointTrade = (await settledTradesAt(pointStart))[0];
    const spreadTrade = (await settledTradesAt(spreadStart))[0];

    // A single-interval leg names the price row it settled against...
    expect(pointTrade.market_price_id).not.toBeNull();
    near(Number(pointTrade.execution_price), rtFinal(pointStart));

    // ...and the composed one must not, even though a point position settled
    // immediately before it in the same sweep.
    expect(spreadTrade.instrument).toBe("BASIS_SPREAD");
    expect(spreadTrade.market_price_id).toBeNull();
    near(Number(spreadTrade.execution_price), spreadSettlement);
    near(
      (await positionAt(marketId, spreadStart, "BASIS_SPREAD", PRODUCT, counterId))!.realized,
      (spreadSettlement - spread.entryPrice) * 10
    );
  });

  it("settles a block forward at its actual window average", async () => {
    const start = slot(8);
    const end = shift(start, 4); // a 4-interval window
    const { entryPrice: entryAvg } = await fill({
      p_instrument: "BLOCK_FORWARD",
      p_side: "BUY",
      p_delivery_start: start,
      p_delivery_end: end,
    });

    // The actual day-ahead settlement of the whole window, per ERCOT's
    // equal-time rule over its four hours.
    let settleSum = 0;
    for (let i = 0; i < 4; i++) settleSum += daClearing(shift(start, i));
    const settlementAvg = settleSum / 4;

    await settle(end);

    const pos = await positionAt(marketId, start, "BLOCK_FORWARD");
    expect(pos!.qty).toBe(0);
    near(pos!.avg, entryAvg);
    near(pos!.realized, (settlementAvg - entryAvg) * 10);

    const mine = await settledTradesAt(start);
    expect(mine).toHaveLength(1);
    near(Number(mine[0].execution_price), settlementAvg);
    expect(isAt(mine[0].delivery_end, end)).toBe(true);
  });

  it("does not settle a position the user already closed", async () => {
    const start = slot(12);
    const end = shift(start, 1);
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
    const start = slot(14);
    const end = shift(start, 1);
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
    const start = slot(16);
    const end = shift(start, 1);
    await fill({
      p_instrument: "DART_SPREAD",
      p_side: "BUY",
      p_delivery_start: start,
      p_delivery_end: end,
    });

    const settlementPrice = rtFinal(start);
    const cashBefore = await cash();
    const [a, b] = await Promise.all([settle(end), settle(end)]);

    // Between them, exactly one settlement — `FOR UPDATE SKIP LOCKED` plus the
    // `settled_at is null` predicate is what makes that so.
    expect(a.settled + b.settled).toBe(1);

    const pos = await positionAt(marketId, start, "DART_SPREAD");
    expect(pos!.settledAt).not.toBeNull();
    expect(await settledTradesAt(start)).toHaveLength(1);
    // Cash moved once, for the closing side only.
    near((await cash()) - cashBefore, settlementPrice * 10);
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

    // Delivered as of a mid-day instant (before the final cases' windows), and
    // unpriced: due, but not settleable. The instant is deliberately before
    // the day's last hour so this sweep cannot reach the surviving position.
    const summary = await settle(shift(slot(12), 1));
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
    const start = slot(18);
    const end = shift(start, 1);
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
    const start = slot(20);
    const end = shift(start, 1);
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
