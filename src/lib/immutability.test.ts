import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";

/**
 * `trades` and `audit_events` are append-only, against the real database.
 *
 * The history is the record of what moved money, so a record that can be edited
 * or removed is not a record. 0001 states the guarantee — "nothing may mutate
 * executed trades or audit events, even through the service role" — and 0005
 * broke it while trying to keep account teardown working.
 *
 * Every attempt here uses the **service-role** client deliberately, not a user
 * session. RLS already filters a user's writes: neither table has an UPDATE or
 * DELETE policy, so a user's statement matches zero rows and changes nothing
 * whether or not the trigger works — a user-session test would pass for the
 * wrong reason. `service_role` bypasses RLS, so on this path the trigger is the
 * only control, which is exactly the claim being tested.
 *
 * The distinction that matters, and that 0005 got wrong, is trigger depth:
 *
 *   outside any trigger ............ 0
 *   inside a trigger function ...... 1     <- a direct mutation
 *   during an ON DELETE CASCADE .... 2     <- account teardown, must pass
 *
 * Gating on `> 0` exempted the direct case too, and the UPDATE variant failed
 * silently: a BEFORE UPDATE trigger returning `old` makes Postgres rewrite the
 * row with its previous values and report success, so the data looked intact
 * and nothing raised. These tests assert on the raised error, not only on the
 * value, so that a silent no-op cannot pass them.
 *
 * Opt in with `npm run test:db`.
 */
describe.skipIf(!dbTestsEnabled())("trades and audit events are immutable (live database)", () => {
  const MARKET = "HB_HUBAVG";
  const PRODUCT = "RTM_HOURLY";
  const HOUR = 3600_000;

  let db: SupabaseClient;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: SupabaseClient;
  let marketId: string;
  /** A future, priced interval, so a real fill can be made through the normal
   *  user path rather than by inserting rows behind the engine's back. */
  let start: string;
  let end: string;

  let tradeId: string;
  let auditEventId: string;

  /** Fill a position for `owner` through the real RPC, returning the trade id. */
  const fill = async (owner: { id: string }, where: SupabaseClient): Promise<string> => {
    const { data, error } = await where.rpc("execute_trade", {
      p_user_id: owner.id,
      p_market_id: marketId,
      p_counter_market_id: null,
      p_instrument: "ENERGY_SPOT",
      p_product: PRODUCT,
      p_side: "BUY",
      p_quantity_mwh: 10,
      p_delivery_start: start,
      p_delivery_end: end,
      p_client_order_id: crypto.randomUUID(),
    });
    if (error) throw new Error(`fill failed: ${error.message}`);
    return (data as { trade_id: string }).trade_id;
  };

  beforeAll(async () => {
    db = admin();
    user = await createTestUser("immutability");
    client = await userClient(user);

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
    start = rows![0].delivery_timestamp as string;
    end = new Date(new Date(start).getTime() + HOUR).toISOString();

    tradeId = await fill(user, client);

    const { data: events } = await db
      .from("audit_events")
      .select("id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1);
    auditEventId = events![0].id as string;
  }, 120_000);

  describe("trades", () => {
    it("refuses an update, and does not quietly no-op it", async () => {
      const { error } = await db
        .from("trades")
        .update({ quantity_mwh: 999, execution_price: 0 })
        .eq("id", tradeId);

      // The error is the assertion that catches 0005: returning `old` made
      // Postgres report success while writing the previous values back.
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable/i);

      const { data } = await db.from("trades").select("quantity_mwh").eq("id", tradeId).single();
      expect(Number(data!.quantity_mwh)).toBe(10);
    });

    it("refuses a delete, and the trade is still there", async () => {
      const { error } = await db.from("trades").delete().eq("id", tradeId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable/i);

      const { data } = await db.from("trades").select("id").eq("id", tradeId);
      expect(data).toHaveLength(1);
    });

    it("refuses a delete even for a trade no position references", async () => {
      // The FK from `positions.settlement_trade_id` is NO ACTION, so a settled
      // trade is incidentally protected. That is not the guarantee: most trades
      // have nothing pointing at them and must be refused on their own.
      const { data: unreferenced } = await db
        .from("trades")
        .select("id")
        .eq("user_id", user.id)
        .limit(1);
      const id = unreferenced![0].id as string;

      const { error } = await db.from("trades").delete().eq("id", id);
      expect(error).not.toBeNull();

      const { data } = await db.from("trades").select("id").eq("id", id);
      expect(data).toHaveLength(1);
    });
  });

  describe("audit events", () => {
    it("refuses an update, and does not quietly no-op it", async () => {
      const { error } = await db
        .from("audit_events")
        .update({ event_type: "POSITION_SETTLED" })
        .eq("id", auditEventId);

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable/i);

      const { data } = await db
        .from("audit_events")
        .select("event_type")
        .eq("id", auditEventId)
        .single();
      expect(data!.event_type).not.toBe("POSITION_SETTLED");
    });

    it("refuses a delete, and the event is still there", async () => {
      const { error } = await db.from("audit_events").delete().eq("id", auditEventId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable/i);

      const { data } = await db.from("audit_events").select("id").eq("id", auditEventId);
      expect(data).toHaveLength(1);
    });
  });

  describe("the exemption that has to survive", () => {
    it("still lets account teardown cascade the history away", async () => {
      // The guard exists so deleting a user does not abort on their own
      // immutability triggers. That must keep working, or every suite's
      // teardown — and account deletion in production — breaks instead.
      const victim = await createTestUser("immutability-cascade");
      const victimClient = await userClient(victim);
      await fill(victim, victimClient);

      const owned = async (table: string, column: string) => {
        const { data, error } = await db.from(table).select(column).eq(column, victim.id);
        expect(error).toBeNull();
        return (data ?? []).length;
      };

      // History exists before the teardown.
      expect(await owned("trades", "user_id")).toBe(1);
      expect(await owned("audit_events", "user_id")).toBeGreaterThan(0);
      expect(await owned("profiles", "id")).toBe(1);

      const { error } = await db.auth.admin.deleteUser(victim.id);
      expect(error).toBeNull();

      // And the cascade took all of it.
      expect(await owned("trades", "user_id")).toBe(0);
      expect(await owned("audit_events", "user_id")).toBe(0);
      expect(await owned("positions", "user_id")).toBe(0);
      expect(await owned("paper_accounts", "user_id")).toBe(0);
      expect(await owned("profiles", "id")).toBe(0);
    }, 120_000);
  });
});
