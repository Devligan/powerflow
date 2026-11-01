import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";
import { loadFixturePoint } from "@/lib/testing/ercot-fixture";

/**
 * Margin, against the real database (migration 0014) on ACTUAL ERCOT data.
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
 * with the whole loss unrealised, failing again on every future run.
 *
 * The suite trades as a REPLAY DESK over the actual-ERCOT corpus
 * (`fixtures/ercot/replay-2026-09-20.json`, built by
 * `scripts/build-history-fixture.ts` from ERCOT MIS reports). Entries fill at
 * the day-ahead clearing (visible before the trading day); settlements pay the
 * actual real-time hourly value ERCOT printed for the hour; liquidation sells
 * at the engine's mark. Every number a case asserts on is derived from the
 * fixture — nothing is injected, and no synthetic price exists anywhere in
 * the path.
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
  /** This suite's own point: the other database suites trade HB_NORTH,
   *  HB_HOUSTON, HB_WEST/HB_PAN and HB_HUBAVG, and the fixture is read-only
   *  here — nothing can collide. */
  const POINT = "HB_SOUTH";
  /** The entry market: the day-ahead clearing, published before delivery. */
  const PRODUCT = "DAM_HOURLY";
  const HOUR = 3600_000;
  /** The desk trades the evening ramp and the hours around it — real scarcity
   *  pricing, which is exactly when funding is tested. */
  const BASE = 12;

  let db: SupabaseClient;
  let marketId: string;
  /** Fixture series (actual ERCOT data) for the point. */
  let dam: Map<string, { price: string }>;
  /** Every delivery hour of the operating day, in order. */
  let hours: string[];

  /** Each case trades its own hour: `slot(k)` = hours[BASE + k]. */
  const slot = (k: number) => hours[BASE + k];

  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

  const shift = (ts: string, hours: number) =>
    new Date(new Date(ts).getTime() + hours * HOUR).toISOString();

  /** The actual ERCOT day-ahead clearing of a delivery hour. A day-ahead
   *  ENERGY_SPOT settles at its own product's final — the clearing itself —
   *  so entry and settlement price coincide by construction and every case
   *  below isolates the CASH mechanics (funding, liquidation, deficit) from
   *  any DA→RT basis P&L. */
  const daClearing = (start: string): number => {
    const row = dam.get(start);
    expect(row, `fixture carries no day-ahead clearing for ${start}`).toBeTruthy();
    return Number(row!.price);
  };

  interface Desk {
    userId: string;
    client: SupabaseClient;
  }

  /** A user with an empty book, parked just before the trading day. Its own
   *  account bootstrap fills in the 0014 default margin rates (12% / 10%). */
  const freshDesk = async (label: string): Promise<Desk> => {
    const user = await createTestUser(`sql-margin-${label}`);
    const client = await userClient(user);
    const { error } = await client.rpc("set_sim_clock", {
      p_user_id: user.id,
      p_iso: shift(hours[BASE], -1),
    });
    expect(error).toBeNull();
    return { userId: user.id, client };
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

  /** Fill a position through the real user path at the desk's clock. A point
   *  entry costs exactly the fixture's actual day-ahead clearing for its
   *  interval — the engine, the catalog and ERCOT's published data agree. */
  const fill = async (
    desk: Desk,
    over: Record<string, unknown> = {}
  ): Promise<{ entryPrice: number; quantity: number }> => {
    const start = (over.p_delivery_start as string) ?? slot(1);
    const end = (over.p_delivery_end as string) ?? shift(start, 1);
    const { data, error } = await db.rpc("execute_trade", {
      p_user_id: desk.userId,
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
    if (error) throw new Error(`fill failed: ${error.message}`);
    const result = data as { execution_price: string; quantity_mwh: string };
    const entryPrice = Number(result.execution_price);
    if (over.p_instrument === undefined && over.p_counter_market_id === undefined) {
      near(entryPrice, daClearing(start));
    }
    return {
      entryPrice,
      quantity: Number(result.quantity_mwh),
    };
  };

  const positionAt = async (desk: Desk, start: string) => {
    const { data } = await db
      .from("positions")
      .select(
        "id, quantity_mwh, average_entry_price, realized_pnl, settled_at, settlement_trade_id"
      )
      .eq("user_id", desk.userId)
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
   * The frame every funding case builds from, priced entirely by the fixture:
   *
   *   short        −20 MWh for slot(1); entry at its day-ahead clearing, and
   *                its settlement is an outflow of slot(1)'s actual real-time
   *                value × 20
   *   collateral   +10 MWh at slot(6), undelivered at the sweep and therefore
   *                genuine collateral rather than a settled receipt
   *   cash         `cash` before the sweep
   *
   * Returns the fixture-derived numbers a case asserts on. The realized P&L
   * of the short is the DA→RT convergence on real data, not an assumption.
   */
  const losingShort = async (
    desk: Desk,
    o: { cash: number } = { cash: 100 }
  ) => {
    const short = await fill(desk, {
      p_side: "SELL",
      p_quantity_mwh: 20,
    });
    const collateral = await fill(desk, {
      p_quantity_mwh: 10,
      p_delivery_start: slot(6),
      p_delivery_end: shift(slot(6), 1),
    });

    await setCash(desk.userId, o.cash);

    return {
      cash: o.cash,
      shortEntry: short.entryPrice,
      collateralEntry: collateral.entryPrice,
      shortInterval: slot(1),
      collateralInterval: slot(6),
      /** Cash the short's settlement has to pay: a day-ahead ENERGY_SPOT
       *  settles at its own product's final — the clearing it was entered
       *  at — so the obligation is the entry clearing × the quantity. */
      required: daClearing(slot(1)) * 20,
      /** Cash selling the collateral raises: the engine sells at the mark,
       *  which before delivery is the day-ahead leg the desk paid. */
      collateralValue: daClearing(slot(6)) * 10,
      asOf: shift(slot(1), 1),
    };
  };

  beforeAll(async () => {
    db = admin();
    const point = await loadFixturePoint(db, POINT);
    marketId = point.marketId;
    dam = point.dam;

    hours = [...dam.keys()].sort();
    expect(hours.length).toBe(24);
  }, 240_000);

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

    // cash + collateral sold - the hour's actual real-time obligation.
    const cashAfter = await cash(desk.userId);
    near(cashAfter, f.cash + f.collateralValue - f.required);
    expect(cashAfter).toBeGreaterThanOrEqual(0);
    near(await deficit(desk.userId), 0);

    // The short is settled flat, with the whole DA→RT loss realised.
    const short = await positionAt(desk, f.shortInterval);
    expect(short!.qty).toBe(0);
    expect(short!.settledAt).not.toBeNull();
    expect(short!.settlementTradeId).not.toBeNull();
    near(short!.realized, (f.required / 20 - f.shortEntry) * -20);

    // The collateral was *sold*, not delivered: it is flat, realised, and
    // deliberately not marked as settled. It sold at its mark — its own
    // day-ahead leg — so the sale realises nothing.
    const collateral = await positionAt(desk, f.collateralInterval);
    expect(collateral!.qty).toBe(0);
    expect(collateral!.settledAt).toBeNull();
    expect(collateral!.settlementTradeId).toBeNull();
    near(collateral!.realized, 0);

    const settled = await tradesFor(desk.userId, "SETTLED");
    expect(settled).toHaveLength(1);
    expect(settled[0].side).toBe("BUY"); // buying back a short
    near(Number(settled[0].execution_price), f.required / 20);

    const liquidated = await tradesFor(desk.userId, "LIQUIDATED");
    expect(liquidated).toHaveLength(1);
    expect(liquidated[0].side).toBe("SELL"); // selling a long
    near(Number(liquidated[0].execution_price), f.collateralValue / 10);

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

    // Settlement converts unrealised into realised (here zero: a day-ahead
    // spot settles at its own clearing); realising collateral converts marked
    // value into cash. Neither moves equity.
    near(await openEquity(desk), equityBefore);
  });

  it("sells the largest exposure first, and only as much as the obligation needs", async () => {
    const desk = await freshDesk("order");
    // A second, smaller long that must survive untouched. Opened before the
    // frame drains cash to 100, since a buy has to be covered.
    await fill(desk, {
      p_quantity_mwh: 10,
      p_delivery_start: slot(8),
      p_delivery_end: shift(slot(8), 1),
    });
    const f = await losingShort(desk, { cash: 100 });

    // On this day's actual prices the big collateral alone covers the
    // obligation — it raises slightly more than the hour's real-time value —
    // and it is the larger of the two longs, so the engine must sell it
    // first and stop before touching the smaller one.
    expect(f.required).toBeLessThanOrEqual(f.collateralValue);
    expect(daClearing(slot(6)) * 10).toBeGreaterThan(daClearing(slot(8)) * 10);

    const summary = await settle(desk.userId, f.asOf);

    expect(summary.failed).toBe(0);
    expect(summary.liquidated).toBe(1);
    near(summary.raised, f.collateralValue);
    near(await cash(desk.userId), 100 + f.collateralValue - f.required);

    // Biggest exposure first: the big long went, the small one did not.
    const big = await positionAt(desk, f.collateralInterval);
    expect(big!.qty).toBe(0);
    expect(big!.settledAt).toBeNull();

    const smallAfter = await positionAt(desk, slot(8));
    expect(smallAfter!.qty).toBe(10);
    expect(smallAfter!.settledAt).toBeNull();
    expect(smallAfter!.settlementTradeId).toBeNull();

    const liquidated = await tradesFor(desk.userId, "LIQUIDATED");
    expect(liquidated).toHaveLength(1);
    near(Number(liquidated[0].execution_price), f.collateralValue / 10);
    // The untouched long is not flat, so it was never sold.
    expect(liquidated[0].delivery_start).not.toBe(slot(8));
  });

  it("books a deficit when even every long is not enough — and still settles the position", async () => {
    const desk = await freshDesk("deficit");
    // A naked short: no collateral at all, and no cash to speak of.
    const short = await fill(desk, {
      p_side: "SELL",
      p_quantity_mwh: 20,
    });
    await setCash(desk.userId, 0);

    const required = daClearing(slot(1)) * 20;
    const equityBefore = await openEquity(desk);
    expect(equityBefore).toBeLessThan(0);

    const summary = await settle(desk.userId, shift(slot(1), 1));

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
    near(await deficit(desk.userId), required);

    // The position settled anyway: realised P&L is zero (a day-ahead spot
    // settles at its own clearing) and the unpaid part is owed.
    const pos = await positionAt(desk, slot(1));
    expect(pos!.qty).toBe(0);
    expect(pos!.settledAt).not.toBeNull();
    near(pos!.realized, 0);

    const events = await eventsOf(desk.userId, "ACCOUNT_DEFICIT");
    expect(events).toHaveLength(1);
    const meta = events[0].metadata as Record<string, unknown>;
    near(Number(meta.shortfall), required);
    expect(meta.reason).toBe("SETTLEMENT_UNPAID");

    // Equity is unchanged — the account was already insolvent at the mark, and
    // settlement only says so in cash terms.
    near(await openEquity(desk), equityBefore);

    const margin = await marginOf(desk);
    expect(margin.tier).toBe("DEFICIT");
    expect(margin.equity).toBeLessThan(0);
  });

  it("applies a later receipt to the outstanding deficit before anything else", async () => {
    // Continues the deficit desk's story: the member wires funds, buys a
    // position that settles at a profit smaller than the debt, and every
    // cent of the receipt goes to the liability.
    const desk = await freshDesk("repay");
    await fill(desk, { p_side: "SELL", p_quantity_mwh: 20 });
    await setCash(desk.userId, 0);
    await settle(desk.userId, shift(slot(1), 1));

    const owed = await deficit(desk.userId);
    expect(owed).toBeGreaterThan(0);
    expect(await cash(desk.userId)).toBe(0);

    // The wire a real clearing house would demand, and then a position bought
    // with it. slot(2)'s actual clearing is a receipt smaller than the debt —
    // the guard below proves the case stays a partial repayment.
    await setCash(desk.userId, 5000);
    await fill(desk, {
      p_quantity_mwh: 10,
      p_delivery_start: slot(2),
      p_delivery_end: shift(slot(2), 1),
    });
    const receipt = daClearing(slot(2)) * 10;
    expect(receipt).toBeLessThan(owed);

    const cashBefore = await cash(desk.userId);
    const summary = await settle(desk.userId, shift(slot(2), 1));

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
      p_quantity_mwh: 10,
      p_delivery_start: slot(1),
      p_delivery_end: shift(slot(1), 1),
    });
    await setCash(desk.userId, 100);

    const summary = await settle(desk.userId, shift(slot(1), 1));

    expect(summary.failed).toBe(0);
    expect(summary.settled).toBe(1);
    expect(summary.funded).toBe(0);
    expect(summary.liquidated).toBe(0);
    near(summary.raised, 0);
    near(await cash(desk.userId), 100 + daClearing(slot(1)) * 10);
    near(await deficit(desk.userId), 0);
    expect(await tradesFor(desk.userId, "LIQUIDATED")).toHaveLength(0);
    expect(await eventsOf(desk.userId, "MARGIN_CALL")).toHaveLength(0);
    near((await positionAt(desk, slot(1)))!.realized, 0);
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
      p_delivery_start: slot(1),
      p_delivery_end: shift(slot(1), 1),
    });

    // Before delivery the position marks at its day-ahead leg — the actual
    // clearing the desk sold against — so every tier boundary below is
    // derived from ERCOT's published number, not an invented mark.
    const gross = daClearing(slot(1)) * 10;
    const used = gross * 0.12; // the account's default initial rate
    const maintenance = gross * 0.1; // the account's default maintenance rate

    for (const c of [
      // equity = cash − gross; OK needs equity ≥ initial margin.
      { cash: gross + used + 100, tier: "OK" },
      // maintenance ≤ equity < initial: WARNING.
      { cash: gross + (used + maintenance) / 2, tier: "WARNING" },
      // 0 < equity < maintenance: CALL.
      { cash: gross + maintenance / 3, tier: "CALL" },
      // equity ≤ 0: DEFICIT.
      { cash: gross - 30, tier: "DEFICIT" },
    ]) {
      await setCash(desk.userId, c.cash);
      const m = await marginOf(desk);
      near(m.equity, c.cash - gross);
      near(m.markedValue, -gross);
      near(m.usedMargin, used);
      near(m.maintenanceMargin, maintenance);
      near(m.availableMargin, c.cash - gross - used);
      near(m.marginRatio!, (c.cash - gross) / used);
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
        p_as_of: shift(slot(1), 1),
        p_user_id: theirs.userId,
      }),
      mine.client.rpc("liquidate_to_fund", {
        p_user_id: theirs.userId,
        p_need: 1,
        p_as_of: shift(slot(1), 1),
      }),
    ]) {
      const { error: denied } = await call;
      expect(denied).not.toBeNull();
    }
  });
});
