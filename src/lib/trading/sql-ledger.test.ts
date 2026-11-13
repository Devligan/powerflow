import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, markLedgerStaged, userClient, type TestUser } from "@/lib/testing/db";

/**
 * The ledger reconciliation (0054), shown to ring.
 *
 * Every other DB suite runs `ledger_violations` over the accounts it drove
 * through the engine before tearing them down (`src/lib/testing/db.ts`), which
 * proves the engine keeps the books balanced. A check that never fails proves
 * nothing about itself, though, so this suite breaks the books on purpose, one
 * invariant at a time, with the service role (the only writer that can), and
 * asserts each break is caught, named and sized — then repairs it and asserts
 * the account is clean again.
 *
 * It needs no prices: every row it plants is on its own fresh account, in a
 * window a month out that nothing prices or settles, so it claims no market.
 */
describe.skipIf(!dbTestsEnabled())("ledger reconciliation (live database)", () => {
  const DAY = 86_400_000;
  let db: SupabaseClient;
  let user: TestUser;
  let marketId: string;
  let start: string;
  let end: string;
  /** Rows planted by a case, removed after it so the next starts clean. */
  const planted: Array<() => PromiseLike<unknown>> = [];

  type Violation = { check_name: string; user_id: string; entity_id: string; detail: Record<string, unknown> };

  const violations = async (): Promise<Violation[]> => {
    const { data, error } = await db.rpc("ledger_violations", { p_user_ids: [user.id] });
    expect(error).toBeNull();
    return data as Violation[];
  };

  beforeAll(async () => {
    db = admin();
    user = await createTestUser("ledger");
    const { data: market } = await db.from("markets").select("id").eq("settlement_point", "HB_WEST").single();
    marketId = market!.id as string;
    // A whole hour a month out: past ERCOT's bid window, so nothing prices it.
    const hour = Math.floor((Date.now() + 30 * DAY) / 3_600_000) * 3_600_000;
    start = new Date(hour).toISOString();
    end = new Date(hour + 3_600_000).toISOString();
  });

  afterEach(async () => {
    for (const undo of planted.splice(0).reverse()) await undo();
    expect(await violations()).toEqual([]);
  });

  it("a fresh account reconciles", async () => {
    expect(await violations()).toEqual([]);
  });

  it("catches cash that no fill explains, to the cent and below", async () => {
    const { data } = await db.from("paper_accounts").select("cash_balance").eq("user_id", user.id).single();
    const cash = String(data!.cash_balance);
    await db.from("paper_accounts").update({ cash_balance: "100000.000001" }).eq("user_id", user.id);
    planted.push(() => db.from("paper_accounts").update({ cash_balance: cash }).eq("user_id", user.id));

    const found = await violations();
    expect(found.map((v) => v.check_name)).toEqual(["cash_reconciles"]);
    expect(Number(found[0].detail.gap)).toBeCloseTo(0.000001, 9);
  });

  it("catches a deficit that no settlement explains", async () => {
    await db.from("paper_accounts").update({ deficit: "250" }).eq("user_id", user.id);
    planted.push(() => db.from("paper_accounts").update({ deficit: "0" }).eq("user_id", user.id));

    const found = await violations();
    expect(found.map((v) => v.check_name)).toEqual(["cash_reconciles"]);
    expect(Number(found[0].detail.gap)).toBe(-250);
  });

  it("catches a position no fill opened", async () => {
    const { data, error } = await db
      .from("positions")
      .insert({
        user_id: user.id,
        market_id: marketId,
        product: "DAM_HOURLY",
        instrument: "ENERGY_SPOT",
        delivery_start: start,
        delivery_end: end,
        quantity_mwh: 5,
        average_entry_price: 40,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    planted.push(() => db.from("positions").delete().eq("id", data!.id));

    const found = await violations();
    expect(found.map((v) => v.check_name)).toEqual(["positions_match_trades"]);
    expect(found[0].entity_id).toBe(data!.id);
    expect(Number(found[0].detail.position_quantity)).toBe(5);
    expect(Number(found[0].detail.fills_net)).toBe(0);
  });

  it("catches a fill written outside the engine: unpaid, unheld and unaudited", async () => {
    const { data, error } = await db
      .from("trades")
      .insert({
        user_id: user.id,
        market_id: marketId,
        product: "DAM_HOURLY",
        instrument: "ENERGY_SPOT",
        side: "BUY",
        quantity_mwh: 3,
        delivery_start: start,
        delivery_end: end,
        execution_price: 20,
        price_timestamp: new Date().toISOString(),
        status: "EXECUTED",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    // Trades are immutable (0016), so this one stays until the cascade, and
    // the account is exempt from the teardown check.
    const found = await violations();
    expect(found.map((v) => v.check_name).sort()).toEqual([
      "cash_reconciles",
      "fills_audited",
      "positions_match_trades",
    ]);
    expect(Number(found.find((v) => v.check_name === "cash_reconciles")!.detail.gap)).toBe(60);
    expect(found.find((v) => v.check_name === "fills_audited")!.entity_id).toBe(data!.id);

    // A position "settled" by that fill: flat and pointing at a trade, as the
    // constraint demands, but the trade is an ordinary buy, not a settlement.
    const { error: settledErr } = await db.from("positions").insert({
      user_id: user.id,
      market_id: marketId,
      product: "DAM_HOURLY",
      instrument: "ENERGY_SPOT",
      delivery_start: start,
      delivery_end: new Date(Date.parse(end) + 3_600_000).toISOString(),
      quantity_mwh: 0,
      settled_at: new Date().toISOString(),
      settlement_trade_id: data!.id,
    });
    expect(settledErr).toBeNull();
    const traced = (await violations()).filter((v) => v.check_name === "settlements_trace");
    expect(traced).toHaveLength(1);
    expect(traced[0].detail.trade_status).toBe("EXECUTED");

    // A fresh account for the remaining cases, since this one cannot be repaired.
    markLedgerStaged(user.id);
    user = await createTestUser("ledger-next");
  });

  it("catches a bid marked filled with no fill behind it", async () => {
    const { data, error } = await db
      .from("paper_orders")
      .insert({
        user_id: user.id,
        market_id: marketId,
        product: "DAM_HOURLY",
        instrument: "ENERGY_SPOT",
        side: "BUY",
        quantity_mwh: 1,
        limit_price: 50,
        delivery_start: start,
        delivery_end: end,
        expires_at: start,
        status: "FILLED",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    planted.push(() => db.from("paper_orders").delete().eq("id", data!.id));

    const found = await violations();
    expect(found.map((v) => v.check_name)).toEqual(["fills_match_orders"]);
    expect(found[0].entity_id).toBe(data!.id);
  });

  it("records an audit that lists every check, and keeps it from the public", async () => {
    const { data, error } = await db.rpc("record_ledger_audit");
    expect(error).toBeNull();
    const audit = data as { ok: boolean; checks: Array<{ check: string; violations: number }>; accounts: number };
    // The database is shared with suites that stage books by hand, so only the
    // shape is this suite's to assert: every check present, counts numeric.
    expect(audit.checks.map((c) => c.check)).toEqual([
      "cash_reconciles",
      "positions_match_trades",
      "settlements_trace",
      "fills_match_orders",
      "fills_audited",
    ]);
    expect(audit.checks.every((c) => Number.isInteger(c.violations))).toBe(true);
    expect(audit.accounts).toBeGreaterThan(0);

    const session = await userClient(user);
    const call = await session.rpc("ledger_violations", { p_user_ids: [user.id] });
    expect(call.error).not.toBeNull();
    const record = await session.rpc("record_ledger_audit");
    expect(record.error).not.toBeNull();
    const read = await session.from("ledger_audits").select("id").limit(1);
    expect(read.data ?? []).toEqual([]);
  });
});
