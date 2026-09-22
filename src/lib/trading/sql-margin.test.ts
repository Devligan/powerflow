import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";

/**
 * Margin, against the real database (migration 0014).
 *
 * `margin.test.ts` tests the TypeScript mirror of these rules. This file tests
 * the SQL that actually moves the money: the funding step inside
 * `settle_delivered_positions`, `liquidate_to_fund`, the deficit it books when
 * even that is not enough, and `account_margin`. Postgres is the source of
 * truth.
 *
 * The case this exists for is the one the platform used to get wrong. A short
 * position's settlement is an *outflow* of `settlement_price × |qty|`, and
 * nothing bounds that by the account's cash — so a 20 MWh short settling at
 * 200 owes 4,000 against 100 of cash. Before 0014 the sweep hit 0001's
 * `cash_balance_nonneg` check, rolled that row back, and left the position open
 * with the whole loss unrealised, failing again on every future run:
 *
 *   {"failed": 1, "errors": ["... violates check constraint
 *                            \"cash_balance_nonneg\""], "settlement_due_remaining": 1}
 *
 * Cases 1-4 are the three ways that can now go and the reason it can no longer
 * get stuck.
 *
 * Two properties of the harness are deliberate:
 *
 *   * Each case builds its **own user**, so no case can be moved by another's
 *     leftover collateral — the funding step sells *every* long on the book, so
 *     a stray position from an earlier case would silently change the numbers.
 *   * Every sweep is scoped with `p_user_id`. Settlement is a global job, and
 *     the other database suites hold fixtures in these same shared tables; a
 *     test that proves one account's settlement must not close another's book.
 *     The scheduled path (null, i.e. every account) is covered by
 *     `sql-settlement.test.ts`.
 *
 * Opt in with `RUN_DB_TESTS=1`, since it creates real users in the configured
 * Supabase project.
 */
describe.skipIf(!dbTestsEnabled())("margin and settlement funding (live database)", () => {
  /** The other database suites hold fixtures in HB_NORTH/HB_HOUSTON (engine,
   *  concurrency) and HB_WEST/HB_PAN (settlement), so this suite moves prices
   *  only in a market of its own. */
  const MARKET = "HB_SOUTH";
  const PRODUCT = "RTM_HOURLY";
  const HOUR = 3600_000;

  let db: SupabaseClient;
  let marketId: string;
  /** The earliest RTM_HOURLY interval that has not started yet. */
  let base: string;
  /** Every price this suite moved, keyed for restoration. */
  const republished = new Map<string, number>();

  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

  const shift = (ts: string, hours: number) =>
    new Date(new Date(ts).getTime() + hours * HOUR).toISOString();

  const key = (ts: string) => `${MARKET}|${PRODUCT}|${ts}`;

  interface Desk {
    userId: string;
    client: SupabaseClient;
  }

  /** A user with an empty book. Its own account bootstrap fills in the
   *  0014 default margin rates (12% / 10%). */
  const freshDesk = async (label: string): Promise<Desk> => {
    const user = await createTestUser(`sql-margin-${label}`);
    return { userId: user.id, client: await userClient(user) };
  };

  const settle = async (userId: string, asOf: string, limit = 500) => {
    const { data, error } = await db.rpc("settle_delivered_positions", {
      p_as_of: asOf,
      p_limit: limit,
      p_user_id: userId,
    });
    expect(error).toBeNull();
    return data as {
      considered: number;
      settled: number;
      deferred: number;
      failed: number;
      funded: number;
      liquidated: number;
      raised: number;
      deficits: number;
      settlement_due_remaining: number;
      deferred_position_ids: string[];
      errors: Array<{ position_id?: string; error: string }>;
    };
  };

  const cash = async (userId: string): Promise<number> => {
    const { data } = await db
      .from("paper_accounts")
      .select("cash_balance")
      .eq("user_id", userId)
      .single();
    return Number(data!.cash_balance);
  };

  const deficit = async (userId: string): Promise<number> => {
    const { data } = await db
      .from("paper_accounts")
      .select("deficit")
      .eq("user_id", userId)
      .single();
    return Number(data!.deficit);
  };

  /**
   * Stand the account's cash where a case needs it.
   *
   * A real member would wire funds, and the platform has no deposit path — so
   * this is the fixture for "the member's cash is X". It is deliberately not a
   * shortcut around the behaviour under test: every case moves money through
   * the engine and asserts on what the engine did with it.
   */
  const setCash = async (userId: string, amount: number) => {
    const { error } = await db
      .from("paper_accounts")
      .update({ cash_balance: String(amount) })
      .eq("user_id", userId);
    expect(error).toBeNull();
  };

  const fill = async (
    desk: Desk,
    over: Record<string, unknown> = {}
  ): Promise<{ entryPrice: number; quantity: number }> => {
    const { data, error } = await desk.client.rpc("execute_trade", {
      p_user_id: desk.userId,
      p_market_id: marketId,
      p_counter_market_id: null,
      p_instrument: "ENERGY_SPOT",
      p_product: PRODUCT,
      p_side: "BUY",
      p_quantity_mwh: 10,
      p_delivery_start: shift(base, 2),
      p_delivery_end: shift(base, 3),
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

  /** Move a published price, remembering the original for restoration. Takes
   *  the market **id**: filtering `market_id` by a settlement point's ticker
   *  silently matches nothing. */
  const republish = async (ts: string, price: number) => {
    const k = key(ts);
    if (!republished.has(k)) {
      const { data } = await db
        .from("market_prices")
        .select("price")
        .eq("market_id", marketId)
        .eq("product", PRODUCT)
        .eq("delivery_timestamp", ts)
        .single();
      expect(data).not.toBeNull();
      republished.set(k, Number(data!.price));
    }
    const { error } = await db
      .from("market_prices")
      .update({ price: String(price) })
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .eq("delivery_timestamp", ts);
    expect(error).toBeNull();
  };

  const positionAt = async (userId: string, start: string) => {
    const { data } = await db
      .from("positions")
      .select(
        "id, quantity_mwh, average_entry_price, realized_pnl, settled_at, settlement_trade_id"
      )
      .eq("user_id", userId)
      .eq("market_id", marketId)
      .eq("instrument", "ENERGY_SPOT")
      .eq("product", PRODUCT)
      .eq("delivery_start", start)
      .maybeSingle();
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

  const tradesFor = async (userId: string, status?: string) => {
    let q = db
      .from("trades")
      .select("id, status, side, quantity_mwh, execution_price, delivery_start")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    if (status) q = q.eq("status", status);
    const { data } = await q;
    return data ?? [];
  };

  const eventsOf = async (userId: string, type: string) => {
    const { data } = await db
      .from("audit_events")
      .select("id, entity_id, entity_type, metadata")
      .eq("user_id", userId)
      .eq("event_type", type);
    return data ?? [];
  };

  /** Equity from trusted data, deficit included:
   *  cash + Σ mark × signed qty - deficit. Marks come from the engine's own
   *  `position_marks`, so no instrument price is recomputed here. */
  const openEquity = async (desk: Desk): Promise<number> => {
    const [acct, pos, marks] = await Promise.all([
      db.from("paper_accounts").select("cash_balance, deficit").eq("user_id", desk.userId).single(),
      db.from("positions").select("id, quantity_mwh").eq("user_id", desk.userId).neq("quantity_mwh", 0),
      desk.client.rpc("position_marks", { p_user_id: desk.userId }),
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
    return (
      Number(acct.data!.cash_balance) + marked - Number(acct.data!.deficit)
    );
  };

  const marginOf = async (desk: Desk) => {
    const { data, error } = await desk.client.rpc("account_margin", {
      p_user_id: desk.userId,
    });
    expect(error).toBeNull();
    const row = (data as Array<Record<string, unknown>>)[0];
    return {
      cashBalance: Number(row.cash_balance),
      markedValue: Number(row.marked_value),
      deficit: Number(row.deficit),
      equity: Number(row.equity),
      usedMargin: Number(row.used_margin),
      maintenanceMargin: Number(row.maintenance_margin),
      availableMargin: Number(row.available_margin),
      marginRatio: row.margin_ratio == null ? null : Number(row.margin_ratio),
      unpricedPositions: Number(row.unpriced_positions),
      tier: row.tier as string,
    };
  };

  /**
   * The frame every case builds from: an account holding a losing short with a
   * long as collateral, then swept.
   *
   *   short      −20 MWh, entry at the published price, settles at `shortPrice`
   *   long       +10 MWh at `collateralPrice`, undelivered and therefore
   *              genuine collateral rather than a settled receipt
   *   cash       `cash` before the sweep
   *
   * Returns both entry prices so a case can compute the realised P&L it
   * expects rather than assuming the fill price.
   */
  const losingShort = async (
    desk: Desk,
    o: { cash: number; shortPrice: number; collateralPrice: number } = {
      cash: 100,
      shortPrice: 60,
      collateralPrice: 200,
    }
  ) => {
    const short = await fill(desk, {
      p_side: "SELL",
      p_quantity_mwh: 20,
      p_delivery_start: shift(base, 2),
      p_delivery_end: shift(base, 3),
    });
    const collateral = await fill(desk, {
      p_side: "BUY",
      p_quantity_mwh: 10,
      p_delivery_start: shift(base, 6),
      p_delivery_end: shift(base, 7),
    });

    await setCash(desk.userId, o.cash);
    await republish(shift(base, 2), o.shortPrice);
    await republish(shift(base, 6), o.collateralPrice);

    return {
      cash: o.cash,
      shortPrice: o.shortPrice,
      collateralPrice: o.collateralPrice,
      shortInterval: shift(base, 2),
      collateralInterval: shift(base, 6),
      /** Cash the short's settlement has to pay. */
      required: o.shortPrice * 20,
      /** Cash the collateral sale raises. */
      collateralValue: o.collateralPrice * 10,
      shortEntry: short.entryPrice,
      collateralEntry: collateral.entryPrice,
      asOf: shift(base, 3),
    };
  };

  beforeAll(async () => {
    db = admin();
    const { data: m } = await db
      .from("markets")
      .select("id")
      .eq("settlement_point", MARKET)
      .single();
    marketId = m!.id as string;

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

  it("funds a short's settlement by selling collateral, and books no deficit", async () => {
    const desk = await freshDesk("funded");
    const f = await losingShort(desk);
    const equityBefore = await openEquity(desk);

    const summary = await settle(desk.userId, f.asOf);

    expect(summary.failed).toBe(0);
    expect(summary.settled).toBe(1);
    expect(summary.funded).toBe(1);
    expect(summary.liquidated).toBe(1);
    expect(summary.deficits).toBe(0);
    near(summary.raised, f.collateralValue);
    // Nothing is left due: the state that used to be unreachable.
    expect(summary.settlement_due_remaining).toBe(0);

    // 100 + 2,000 raised - 1,200 owed.
    const cashAfter = await cash(desk.userId);
    near(cashAfter, f.cash + f.collateralValue - f.required);
    expect(cashAfter).toBeGreaterThanOrEqual(0);
    near(await deficit(desk.userId), 0);

    // The short is settled flat, with the whole loss realised.
    const short = await positionAt(desk.userId, f.shortInterval);
    expect(short!.qty).toBe(0);
    expect(short!.settledAt).not.toBeNull();
    expect(short!.settlementTradeId).not.toBeNull();
    near(short!.realized, (f.shortPrice - f.shortEntry) * -20);

    // The collateral was *sold*, not delivered: it is flat, realised, and
    // deliberately not marked as settled.
    const collateral = await positionAt(desk.userId, f.collateralInterval);
    expect(collateral!.qty).toBe(0);
    expect(collateral!.settledAt).toBeNull();
    expect(collateral!.settlementTradeId).toBeNull();
    near(collateral!.realized, (f.collateralPrice - f.collateralEntry) * 10);

    const settled = await tradesFor(desk.userId, "SETTLED");
    expect(settled).toHaveLength(1);
    expect(settled[0].side).toBe("BUY"); // buying back a short
    near(Number(settled[0].execution_price), f.shortPrice);

    const liquidated = await tradesFor(desk.userId, "LIQUIDATED");
    expect(liquidated).toHaveLength(1);
    expect(liquidated[0].side).toBe("SELL"); // selling a long
    near(Number(liquidated[0].execution_price), f.collateralPrice);

    // A call is recorded against the account, not the position, and once.
    const calls = await eventsOf(desk.userId, "MARGIN_CALL");
    expect(calls).toHaveLength(1);
    expect(calls[0].entity_type).toBe("paper_account");
    near(Number((calls[0].metadata as Record<string, unknown>).required_cash), f.required);

    const forced = await eventsOf(desk.userId, "FORCED_LIQUIDATION");
    expect(forced).toHaveLength(1);
    expect(forced[0].entity_id).toBe(collateral!.id);
    const forcedMeta = forced[0].metadata as Record<string, unknown>;
    expect(forcedMeta.reason).toBe("FUND_SETTLEMENT");
    expect(forcedMeta.trade_status).toBe("LIQUIDATED");
    expect(forcedMeta.delivered).toBe(false);

    const settledEvents = await eventsOf(desk.userId, "POSITION_SETTLED");
    expect(settledEvents).toHaveLength(1);
    expect((settledEvents[0].metadata as Record<string, unknown>).funded_by_liquidation).toBe(true);

    // Settlement converts unrealised into realised; realising collateral
    // converts marked value into cash. Neither moves equity.
    near(await openEquity(desk), equityBefore);
  });

  it("sells the largest exposure first, and only as much as the obligation needs", async () => {
    const desk = await freshDesk("order");
    // A second, smaller long that must survive untouched. Opened before the
    // frame drains cash to 100, since a buy has to be covered.
    await fill(desk, {
      p_side: "BUY",
      p_quantity_mwh: 10,
      p_delivery_start: shift(base, 8),
      p_delivery_end: shift(base, 9),
    });
    const f = await losingShort(desk, {
      cash: 100,
      shortPrice: 100, // owes 2,000, so 1,900 has to be raised
      collateralPrice: 300, // the big long alone raises 3,000
    });
    await republish(shift(base, 8), 50);

    const summary = await settle(desk.userId, f.asOf);

    expect(summary.failed).toBe(0);
    expect(summary.liquidated).toBe(1);
    near(summary.raised, 3000);
    near(await cash(desk.userId), 100 + 3000 - 2000);

    // Biggest exposure first: the 3,000 long went, the 500 one did not.
    const big = await positionAt(desk.userId, f.collateralInterval);
    expect(big!.qty).toBe(0);
    expect(big!.settledAt).toBeNull();

    const small = await positionAt(desk.userId, shift(base, 8));
    expect(small!.qty).toBe(10);
    expect(small!.settledAt).toBeNull();
    expect(small!.settlementTradeId).toBeNull();

    const liquidated = await tradesFor(desk.userId, "LIQUIDATED");
    expect(liquidated).toHaveLength(1);
    near(Number(liquidated[0].execution_price), 300);
    // The untouched long is not flat, so it was never sold.
    expect(liquidated[0].delivery_start).not.toBe(shift(base, 8));
  });

  it("books a deficit when even every long is not enough — and still settles the position", async () => {
    const desk = await freshDesk("deficit");
    const f = await losingShort(desk, {
      cash: 100,
      shortPrice: 500, // owes 10,000
      collateralPrice: 300, // collateral raises 3,000
    });
    const equityBefore = await openEquity(desk);
    expect(equityBefore).toBeLessThan(0);

    const summary = await settle(desk.userId, f.asOf);

    // The regression test for the state this platform could not reach: before
    // 0014 this was `failed: 1` with a check-constraint violation and a
    // position left open forever.
    expect(summary.failed).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.settled).toBe(1);
    expect(summary.deficits).toBe(1);
    expect(summary.settlement_due_remaining).toBe(0);

    // Cash stops at zero rather than going negative: what could not be paid is
    // recorded as a liability.
    const cashAfter = await cash(desk.userId);
    expect(cashAfter).toBe(0);
    expect(cashAfter).toBeGreaterThanOrEqual(0);
    near(await deficit(desk.userId), f.required - f.collateralValue - f.cash);

    // The position settled anyway: the whole loss is realised, and the unpaid
    // part is owed.
    const short = await positionAt(desk.userId, f.shortInterval);
    expect(short!.qty).toBe(0);
    expect(short!.settledAt).not.toBeNull();
    near(short!.realized, (f.shortPrice - f.shortEntry) * -20);

    const events = await eventsOf(desk.userId, "ACCOUNT_DEFICIT");
    expect(events).toHaveLength(1);
    const meta = events[0].metadata as Record<string, unknown>;
    near(Number(meta.shortfall), f.required - f.collateralValue - f.cash);
    expect(meta.reason).toBe("SETTLEMENT_UNPAID");

    // Equity is unchanged — the account was already insolvent at the mark, and
    // settlement only says so in cash terms.
    near(await openEquity(desk), equityBefore);

    const margin = await marginOf(desk);
    expect(margin.tier).toBe("DEFICIT");
    expect(margin.equity).toBeLessThan(0);
  });

  it("applies a later receipt to the outstanding deficit before anything else", async () => {
    const desk = await freshDesk("repay");
    const f = await losingShort(desk, {
      cash: 100,
      shortPrice: 500,
      collateralPrice: 300,
    });
    await settle(desk.userId, f.asOf);

    const owed = await deficit(desk.userId);
    expect(owed).toBeGreaterThan(0);
    expect(await cash(desk.userId)).toBe(0);

    // The wire a real clearing house would demand before letting the member
    // trade again, and then a position bought with it.
    await setCash(desk.userId, 5000);
    await fill(desk, {
      p_side: "BUY",
      p_quantity_mwh: 10,
      p_delivery_start: shift(base, 10),
      p_delivery_end: shift(base, 11),
    });
    // It settles at a profit, for less than the debt.
    await republish(shift(base, 10), 300);
    const cashBefore = await cash(desk.userId);
    const receipt = 300 * 10;
    expect(receipt).toBeLessThan(owed);

    const summary = await settle(desk.userId, shift(base, 11));

    expect(summary.failed).toBe(0);
    expect(summary.settled).toBe(1);
    expect(summary.funded).toBe(0); // a receipt never needs funding
    expect(summary.liquidated).toBe(0);
    near(await deficit(desk.userId), owed - receipt);
    // The whole receipt went to the debt, so cash did not move at all.
    near(await cash(desk.userId), cashBefore);

    const repaid = await eventsOf(desk.userId, "DEFICIT_REPAID");
    expect(repaid).toHaveLength(1);
    near(Number((repaid[0].metadata as Record<string, unknown>).repaid), receipt);
    expect(repaid[0].entity_type).toBe("position");
  });

  it("needs no funding when the settlement is a receipt", async () => {
    const desk = await freshDesk("receipt");
    const long = await fill(desk, {
      p_side: "BUY",
      p_quantity_mwh: 10,
      p_delivery_start: shift(base, 2),
      p_delivery_end: shift(base, 3),
    });
    await setCash(desk.userId, 100);
    await republish(shift(base, 2), 200);

    const summary = await settle(desk.userId, shift(base, 3));

    expect(summary.failed).toBe(0);
    expect(summary.settled).toBe(1);
    expect(summary.funded).toBe(0);
    expect(summary.liquidated).toBe(0);
    near(summary.raised, 0);
    near(await cash(desk.userId), 100 + 2000);
    near(await deficit(desk.userId), 0);
    expect(await tradesFor(desk.userId, "LIQUIDATED")).toHaveLength(0);
    expect(await eventsOf(desk.userId, "MARGIN_CALL")).toHaveLength(0);
    near(
      (await positionAt(desk.userId, shift(base, 2)))!.realized,
      (200 - long.entryPrice) * 10
    );
  });

  it("cannot settle or fund the same position twice", async () => {
    const desk = await freshDesk("idempotent");
    const f = await losingShort(desk);
    const first = await settle(desk.userId, f.asOf);
    const cashAfterFirst = await cash(desk.userId);

    const second = await settle(desk.userId, f.asOf);

    expect(first.settled).toBe(1);
    expect(second.considered).toBe(0);
    expect(second.settled).toBe(0);
    expect(second.funded).toBe(0);
    expect(second.liquidated).toBe(0);
    near(await cash(desk.userId), cashAfterFirst);
    expect(await tradesFor(desk.userId, "LIQUIDATED")).toHaveLength(1);
    expect(await eventsOf(desk.userId, "MARGIN_CALL")).toHaveLength(1);
  });

  it("reports the margin ladder an account's own numbers put it in", async () => {
    const desk = await freshDesk("ladder");
    await fill(desk, {
      p_side: "SELL",
      p_quantity_mwh: 10,
      p_delivery_start: shift(base, 2),
      p_delivery_end: shift(base, 3),
    });
    await republish(shift(base, 2), 58);

    // The account's defaults: 12% initial, 10% maintenance, on |10| × 58 = 580.
    const used = 580 * 0.12; // 69.6
    const maintenance = 580 * 0.1; // 58

    for (const c of [
      { cash: 1000, equity: 420, tier: "OK" },
      { cash: 640, equity: 60, tier: "WARNING" },
      { cash: 600, equity: 20, tier: "CALL" },
      { cash: 580, equity: 0, tier: "DEFICIT" },
      { cash: 500, equity: -80, tier: "DEFICIT" },
    ]) {
      await setCash(desk.userId, c.cash);
      const m = await marginOf(desk);
      near(m.equity, c.equity);
      near(m.markedValue, -580);
      near(m.usedMargin, used);
      near(m.maintenanceMargin, maintenance);
      near(m.availableMargin, c.equity - used);
      near(m.marginRatio!, c.equity / used);
      expect(m.unpricedPositions).toBe(0);
      expect(m.tier).toBe(c.tier);
    }
  });

  it("refuses another user's margin, and refuses an unauthenticated caller", async () => {
    const [mine, theirs] = await Promise.all([
      freshDesk("margin-mine"),
      freshDesk("margin-theirs"),
    ]);

    const { error } = await mine.client.rpc("account_margin", {
      p_user_id: theirs.userId,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");

    // The sweep and the liquidation helper are the service role's alone: both
    // close positions without their holder's consent. The ACL is the primary
    // control here; each also guards on `current_user` inside, so a mistakenly
    // re-granted EXECUTE would not by itself reopen them (0012's lesson).
    for (const call of [
      mine.client.rpc("settle_delivered_positions", {
        p_as_of: shift(base, 3),
        p_user_id: theirs.userId,
      }),
      mine.client.rpc("liquidate_to_fund", {
        p_user_id: theirs.userId,
        p_need: 1,
        p_as_of: shift(base, 3),
      }),
    ]) {
      const { error: denied } = await call;
      expect(denied).not.toBeNull();
    }
  });
});
