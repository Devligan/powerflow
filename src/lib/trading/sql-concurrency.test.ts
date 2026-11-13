import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, markLedgerStaged, userClient } from "@/lib/testing/db";

/**
 * Races against the cash balance.
 *
 * `execute_trade` takes `select ... for update` on the caller's `paper_accounts`
 * row before it checks capital, so two orders should be serialized rather than
 * both reading the same balance and both spending it. That is a claim about
 * concurrency in a live database, and it cannot be read off the source: it only
 * holds if the lock is taken on the same row *before* the check, the transaction
 * is allowed to commit between waiters, and nothing (a fast path, a cached
 * balance, a check placed above the lock) lets a second caller through.
 *
 * So each case below fires genuinely simultaneous requests with *distinct* order
 * ids — distinct, so they are two real orders and not one replayed — and then
 * asserts on Postgres: how many fills landed, what the position is, and that
 * cash was never driven negative.
 *
 * Each case gets its own account, with `cash_balance` and `max_gross_notional`
 * set directly through the service role. That is deliberate test setup — the
 * starting condition is not what is under test; the behaviour under contention
 * is.
 *
 * Opt in with `RUN_DB_TESTS=1`.
 */
describe.skipIf(!dbTestsEnabled())("cash and exposure under contention (live database)", () => {
  // The day-ahead market: tomorrow's clearing is published by ERCOT the day
  // before delivery, so forward fills price against actual observations.
  // Deliberately not HB_NORTH: `sql-engine.test.ts` republishes that
  // interval's price.
  const PRODUCT = "DAM_HOURLY";
  const MARKET = "HB_HOUSTON";
  const HOUR = 3600_000;

  let db: SupabaseClient;
  let marketId: string;
  let interval: string;
  let intervalEnd: string;
  let price: number;

  const round = (n: number) => Number(n.toFixed(6));
  // Tolerance rather than an exact round-trip: `Number(n.toFixed(6))` yields
  // `-0` for a tiny negative residue, and `toBe(-0)` fails against `0` — an
  // artifact of the comparison, not of the money.
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

  const cashOf = async (userId: string): Promise<number> => {
    const { data } = await db
      .from("paper_accounts")
      .select("cash_balance")
      .eq("user_id", userId)
      .single();
    return Number(data!.cash_balance);
  };

  const tradeCount = async (userId: string): Promise<number> => {
    const { count } = await db
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    return count ?? 0;
  };

  const openQty = async (userId: string): Promise<number> => {
    const { data } = await db
      .from("positions")
      .select("quantity_mwh")
      .eq("user_id", userId);
    return (data ?? []).reduce((s, p) => s + Number(p.quantity_mwh), 0);
  };

  /** Cash and exposure are set explicitly, so the only thing in play is the race. */
  const freshAccount = async (
    cashMultiple: number,
    limitMultiple = 1_000
  ): Promise<{ userId: string; client: SupabaseClient }> => {
    const user = await createTestUser("sql-race");
    const client = await userClient(user);
    markLedgerStaged(user.id);
    const { error } = await db
      .from("paper_accounts")
      .update({
        cash_balance: String(round(price * cashMultiple)),
        max_gross_notional: String(round(price * limitMultiple)),
      })
      .eq("user_id", user.id);
    expect(error).toBeNull();
    return { userId: user.id, client };
  };

  const order = (userId: string, over: Record<string, unknown> = {}) => ({
    p_user_id: userId,
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
    const { data: market } = await db
      .from("markets")
      .select("id")
      .eq("settlement_point", MARKET)
      .single();
    marketId = market!.id as string;

    // Pick the interval the way the engine prices: latest delivery whose
    // publication instant has passed, latest publication within it. See the
    // trading-engine suite for the full rationale.
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

    // A wide feed horizon is assumed elsewhere; fail loudly rather than
    // producing a confusing rejection if the feed is stale.
    expect(price).toBeGreaterThan(0);
  }, 120_000);

  it("when cash covers one of two racing orders, exactly one fills", async () => {
    const { userId } = await freshAccount(15); // 15 × notional of one order
    const cashBefore = await cashOf(userId);

    const responses = await Promise.all([
      db.rpc("execute_trade", order(userId)),
      db.rpc("execute_trade", order(userId)),
    ]);

    const ok = responses.filter((r) => !r.error);
    const failed = responses.filter((r) => r.error);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error!.message).toContain("INSUFFICIENT_CAPITAL");

    expect(await tradeCount(userId)).toBe(1);
    expect(await openQty(userId)).toBe(10);
    const cashAfter = await cashOf(userId);
    near(cashAfter, cashBefore - 10 * price);
    expect(cashAfter).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("when cash covers both, both fill — the lock serializes rather than blocks", async () => {
    const { userId } = await freshAccount(20);
    const cashBefore = await cashOf(userId);

    const responses = await Promise.all([
      db.rpc("execute_trade", order(userId)),
      db.rpc("execute_trade", order(userId)),
    ]);
    expect(responses.every((r) => !r.error)).toBe(true);

    expect(await tradeCount(userId)).toBe(2);
    expect(await openQty(userId)).toBe(20);
    near(await cashOf(userId), cashBefore - 20 * price);
  }, 120_000);

  it("a burst cannot spend cash the account does not have", async () => {
    const { userId } = await freshAccount(25); // room for two, not three
    const cashBefore = await cashOf(userId);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => db.rpc("execute_trade", order(userId)))
    );

    // Regardless of arrival order, the balance only funds two fills.
    expect(responses.filter((r) => !r.error)).toHaveLength(2);
    expect(
      responses.filter((r) => r.error && r.error.message.includes("INSUFFICIENT_CAPITAL"))
    ).toHaveLength(4);

    expect(await tradeCount(userId)).toBe(2);
    expect(await openQty(userId)).toBe(20);

    // The money invariant: cash moved by exactly the signed notional of what
    // actually executed, and was never allowed to go negative.
    const cashAfter = await cashOf(userId);
    expect(cashAfter).toBeGreaterThanOrEqual(0);
    near(cashAfter, cashBefore - 20 * price);

    const { data: rows } = await db
      .from("trades")
      .select("side, quantity_mwh, execution_price")
      .eq("user_id", userId);
    const signedNotional = (rows ?? []).reduce(
      (sum, t) =>
        sum + (t.side === "BUY" ? -1 : 1) * Number(t.quantity_mwh) * Number(t.execution_price),
      0
    );
    near(cashAfter, cashBefore + signedNotional);
  }, 120_000);

  it("when the exposure limit funds one of two racing orders, exactly one fills", async () => {
    // Room for one 10 MWh leg (gross 10P) and not for two (20P).
    const { userId } = await freshAccount(1_000, 15);
    const cashBefore = await cashOf(userId);

    const responses = await Promise.all([
      db.rpc("execute_trade", order(userId)),
      db.rpc("execute_trade", order(userId)),
    ]);

    const failed = responses.filter((r) => r.error);
    expect(responses.filter((r) => !r.error)).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error!.message).toContain("EXPOSURE_LIMIT_EXCEEDED");

    expect(await tradeCount(userId)).toBe(1);
    expect(await openQty(userId)).toBe(10);
    near(await cashOf(userId), cashBefore - 10 * price);
  }, 120_000);

  it("a rejection racing a fill still writes nothing of its own", async () => {
    const { userId } = await freshAccount(15);
    const before = await tradeCount(userId);

    const [accepted, rejected] = await Promise.all([
      db.rpc("execute_trade", order(userId)),
      db.rpc("execute_trade", order(userId, { p_quantity_mwh: 1_000 })), // far beyond cash
    ]);
    expect(accepted.error).toBeNull();
    expect(rejected.error).toBeTruthy();

    // Exactly one trade row: the rejected order left no partial fill, no
    // position, no audit row, and no cash movement behind it.
    expect(await tradeCount(userId)).toBe(before + 1);
    const { count: audit } = await db
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("event_type", "TRADE_EXECUTED");
    expect(audit).toBe(1);
    expect(await openQty(userId)).toBe(10);
  }, 120_000);
});
