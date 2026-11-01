import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, loadTestEnv, userClient } from "@/lib/testing/db";

/**
 * The authorization boundary, attacked rather than read.
 *
 * Policies can look right and still not apply: RLS can be off on the table the
 * policy was written for, a view can run with the owner's rights, or a
 * `SECURITY DEFINER` function can be executable by a role nobody intended.
 * So this suite authenticates as a real second user with the anon key — the
 * credentials a browser actually holds — and tries to read and write the first
 * user's money.
 *
 * Two users, one hostile to the other. Owner-side reads through the service
 * role are the control: they must see what the attacker cannot.
 */
describe.skipIf(!dbTestsEnabled())("authorization boundary (live database)", () => {
  // The day-ahead market: tomorrow's clearing is published by ERCOT the day
  // before delivery, so a forward fill prices against an actual observation.
  const PRODUCT = "DAM_HOURLY";
  /**
   * This suite's own market. It pins the victim's cash to the price it reads
   * from the market's latest interval, so any suite that *republishes* that
   * interval moves the expected value out from under it. `sql-engine` owns
   * HB_NORTH, and the gap-fill suite deletes and re-ingests LZ_WEST; every
   * database suite here therefore claims a series no other one writes.
   */
  const MARKET = "LZ_AEN";

  let db: SupabaseClient;
  let victim: Awaited<ReturnType<typeof createTestUser>>;
  let attacker: Awaited<ReturnType<typeof createTestUser>>;
  let attackerClient: SupabaseClient;
  let anonClient: SupabaseClient;
  let marketId: string;
  let interval: string;
  let intervalEnd: string;
  let victimPrice: number;
  let victimTradeId: string;

  const theirs = (client: SupabaseClient, table: string) =>
    client.from(table).select("*").eq("user_id", victim.id);
  const view = (client: SupabaseClient, table: string) => client.from(table).select("*");

  beforeAll(async () => {
    loadTestEnv();
    db = admin();
    victim = await createTestUser("rls-victim");
    attacker = await createTestUser("rls-attacker");
    attackerClient = await userClient(attacker);
    // No sign-in at all: the bare anon key, i.e. an unauthenticated visitor.
    anonClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const { data: market } = await db
      .from("markets")
      .select("id")
      .eq("settlement_point", MARKET)
      .single();
    marketId = market!.id as string;

    // Pick the interval the way the engine prices: latest delivery whose
    // publication instant has passed, latest publication within it — and
    // still ahead of delivery, since a real-time hour is not tradable after
    // it has delivered. See the trading-engine suite for the full rationale.
    const { data: rows } = await db
      .from("market_prices")
      .select("delivery_timestamp, price")
      .eq("market_id", marketId)
      .eq("product", PRODUCT)
      .gt("delivery_timestamp", new Date().toISOString())
      .lte("published_at", new Date().toISOString())
      .order("delivery_timestamp", { ascending: false })
      .order("published_at", { ascending: false })
      .limit(1);
    interval = rows![0].delivery_timestamp as string;
    victimPrice = Number(rows![0].price);
    intervalEnd = new Date(new Date(interval).getTime() + 3600_000).toISOString();

    // Give the victim something worth taking.
    const { data, error } = await db.rpc("execute_trade", {
      p_user_id: victim.id,
      p_market_id: marketId,
      p_counter_market_id: null,
      p_instrument: "ENERGY_SPOT",
      p_product: PRODUCT,
      p_side: "BUY",
      p_quantity_mwh: 10,
      p_delivery_start: interval,
      p_delivery_end: intervalEnd,
      p_client_order_id: `victim-key-${Date.now()}`,
    });
    expect(error).toBeNull();
    victimTradeId = (data as { trade_id: string }).trade_id;
  }, 120_000);

  describe("reads", () => {
    it("returns only the caller's own rows, even when asked for someone else's", async () => {
      for (const table of ["paper_accounts", "positions", "trades", "audit_events"]) {
        const { data: unfiltered, error: e1 } = await view(attackerClient, table);
        expect(e1).toBeNull();
        expect(
          (unfiltered ?? []).every((r) => (r as { user_id: string }).user_id === attacker.id),
          `${table} leaked rows on an unfiltered read`
        ).toBe(true);

        const { data: targeted, error: e2 } = await theirs(attackerClient, table);
        expect(e2).toBeNull();
        expect(targeted ?? [], `${table} leaked rows to a filtered read`).toHaveLength(0);
      }
    });

    it("confirms the control: the owner's rows really are there", async () => {
      const { data } = await theirs(db, "trades");
      expect(data).toHaveLength(1);
      expect(data![0].id).toBe(victimTradeId);
      const { data: acct } = await theirs(db, "paper_accounts");
      expect(Number(acct![0].cash_balance)).toBe(100000 - 10 * victimPrice);
    });

    it("hides other people's profiles", async () => {
      const { data } = await attackerClient.from("profiles").select("*");
      expect((data ?? []).every((p) => (p as { id: string }).id === attacker.id)).toBe(true);
      const { data: targeted } = await attackerClient
        .from("profiles")
        .select("*")
        .eq("id", victim.id);
      expect(targeted ?? []).toHaveLength(0);
    });

    it("gives an unauthenticated visitor nothing from the user tables", async () => {
      for (const table of ["paper_accounts", "positions", "trades", "audit_events", "profiles"]) {
        const { data, error } = await anonClient.from(table).select("*");
        // either an empty set or a permission error; both are fine, data is not
        expect(data ?? [], `anon read ${table}`).toHaveLength(0);
        if (error) expect(error.code).toBeTruthy();
      }
    });
  });

  describe("writes", () => {
    it("cannot mint a paper account, a position, a fill or an audit record", async () => {
      const attempts: Array<[string, PromiseLike<{ error: unknown }>]> = [
        [
          "paper_accounts",
          attackerClient.from("paper_accounts").insert({
            user_id: attacker.id,
            starting_cash: 1_000_000,
            cash_balance: 1_000_000,
            max_gross_notional: 50_000_000,
          }),
        ],
        [
          "positions",
          attackerClient.from("positions").insert({
            user_id: attacker.id,
            market_id: marketId,
            product: PRODUCT,
            instrument: "ENERGY_SPOT",
            delivery_start: interval,
            delivery_end: intervalEnd,
            quantity_mwh: 999,
            average_entry_price: 0,
            realized_pnl: 0,
          }),
        ],
        [
          "trades",
          attackerClient.from("trades").insert({
            user_id: attacker.id,
            market_id: marketId,
            product: PRODUCT,
            venue: "RTM",
            instrument: "ENERGY_SPOT",
            counter_market_id: null,
            side: "BUY",
            quantity_mwh: 999,
            delivery_start: interval,
            delivery_end: intervalEnd,
            execution_price: 0.01,
            price_timestamp: interval,
            status: "EXECUTED",
            created_at: new Date().toISOString(),
            executed_at: new Date().toISOString(),
          }),
        ],
        [
          "audit_events",
          attackerClient.from("audit_events").insert({
            user_id: attacker.id,
            event_type: "FABRICATED",
            entity_type: "user",
            entity_id: attacker.id,
            metadata: {},
          }),
        ],
      ];

      for (const [table, attempt] of attempts) {
        const { error } = await attempt;
        expect(error, `insert into ${table} was allowed`).toBeTruthy();
      }

      // and nothing was written
      const { count } = await db
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("user_id", attacker.id);
      expect(count).toBe(0);
      const { count: accts } = await db
        .from("paper_accounts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", attacker.id);
      expect(accts).toBe(1); // the one the signup trigger made, at $100k
    });

    // Note the shape of a blocked UPDATE/DELETE: with no policy the row is
    // simply invisible to the statement, so it matches nothing and Postgres
    // reports **success with zero rows affected** rather than raising. An
    // attacker gets no error to learn from — and, importantly, neither does a
    // test that asserts on `error`. The authoritative check is that the row is
    // unchanged, which is what these assert; `data` (via `.select()`) pins the
    // zero-rows-matched half so a future grant/policy change can't silently
    // turn "filtered" into "blocked by nothing at all".
    it("cannot raise its own cash balance or relax its own risk limits", async () => {
      const before = await db
        .from("paper_accounts")
        .select("cash_balance, starting_cash, max_gross_notional")
        .eq("user_id", attacker.id)
        .single();

      const { data, error } = await attackerClient
        .from("paper_accounts")
        .update({ cash_balance: 999_999_999, max_gross_notional: 999_999_999 })
        .eq("user_id", attacker.id)
        .select();
      if (!error) expect(data ?? []).toHaveLength(0);

      const after = await db
        .from("paper_accounts")
        .select("cash_balance, starting_cash, max_gross_notional")
        .eq("user_id", attacker.id)
        .single();
      expect(after.data).toEqual(before.data);
      expect(Number(after.data!.cash_balance)).toBe(100000);
      expect(Number(after.data!.max_gross_notional)).toBe(500000);
    });

    it("cannot rewrite the victim's positions or fills", async () => {
      const posBefore = await theirs(db, "positions").single();
      const tradeBefore = await theirs(db, "trades").single();

      const posUpdate = await attackerClient
        .from("positions")
        .update({ quantity_mwh: 500, average_entry_price: 0, realized_pnl: 1_000_000 })
        .eq("user_id", victim.id)
        .select();
      if (!posUpdate.error) expect(posUpdate.data ?? []).toHaveLength(0);

      const tradeUpdate = await attackerClient
        .from("trades")
        .update({ execution_price: 0, quantity_mwh: 999 })
        .eq("user_id", victim.id)
        .select();
      if (!tradeUpdate.error) expect(tradeUpdate.data ?? []).toHaveLength(0);

      expect((await theirs(db, "positions").single()).data).toEqual(posBefore.data);
      expect((await theirs(db, "trades").single()).data).toEqual(tradeBefore.data);
    });

    it("cannot delete the victim's history", async () => {
      const { data, error } = await attackerClient
        .from("trades")
        .delete()
        .eq("user_id", victim.id)
        .select();
      if (!error) expect(data ?? []).toHaveLength(0);

      const { count } = await db
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("user_id", victim.id);
      expect(count).toBe(1);
    });
  });

  describe("functions", () => {
    it("cannot trade, or read marks, on someone else's account", async () => {
      const cashBefore = await db
        .from("paper_accounts")
        .select("cash_balance")
        .eq("user_id", victim.id)
        .single();

      const traded = await attackerClient.rpc("execute_trade", {
        p_user_id: victim.id,
        p_market_id: marketId,
        p_counter_market_id: null,
        p_instrument: "ENERGY_SPOT",
        p_product: PRODUCT,
        p_side: "SELL",
        p_quantity_mwh: 10,
        p_delivery_start: interval,
        p_delivery_end: intervalEnd,
        p_client_order_id: `attack-${Date.now()}`,
      });
      expect(traded.error).toBeTruthy();
      expect(String(traded.error?.message)).toContain("FORBIDDEN");

      const marks = await attackerClient.rpc("position_marks", { p_user_id: victim.id });
      expect(marks.error).toBeTruthy();
      expect(String(marks.error?.message)).toContain("FORBIDDEN");

      const cashAfter = await db
        .from("paper_accounts")
        .select("cash_balance")
        .eq("user_id", victim.id)
        .single();
      expect(cashAfter.data!.cash_balance).toBe(cashBefore.data!.cash_balance);
    }, 60_000);

    it("cannot replay another user's order id as if it were its own", async () => {
      // The victim's trade carries a client order id. Ids are per-user, so the
      // attacker using the same string must get its *own* fill, never the
      // victim's execution — otherwise the id would be a cross-user read.
      const { data: victimTrade } = await db
        .from("trades")
        .select("client_order_id")
        .eq("id", victimTradeId)
        .single();
      const shared = victimTrade!.client_order_id as string;

      const { data, error } = await db.rpc("execute_trade", {
        p_user_id: attacker.id,
        p_market_id: marketId,
        p_counter_market_id: null,
        p_instrument: "ENERGY_SPOT",
        p_product: PRODUCT,
        p_side: "BUY",
        p_quantity_mwh: 1,
        p_delivery_start: interval,
        p_delivery_end: intervalEnd,
        p_client_order_id: shared,
      });
      expect(error).toBeNull();
      expect((data as { trade_id: string }).trade_id).not.toBe(victimTradeId);
      expect((data as { replayed?: boolean }).replayed).toBe(false);

      const { count } = await db
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("user_id", attacker.id)
        .eq("client_order_id", shared);
      expect(count).toBe(1);
      // the victim's own row is untouched
      const { count: victimCount } = await db
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("user_id", victim.id);
      expect(victimCount).toBe(1);
    }, 60_000);
  });

  describe("SECURITY DEFINER surfaces", () => {
    // A DEFINER function runs with its *owner's* rights, so an over-broad
    // EXECUTE grant on one is privilege escalation rather than a curiosity.
    // These are the functions a browser can reach directly through PostgREST;
    // Supabase's default privileges hand `anon` EXECUTE on every function
    // created in `public`, which is exactly how the bootstrap hole existed.
    const auditCount = async () => {
      const { count } = await db
        .from("audit_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", victim.id);
      return count ?? 0;
    };

    it("does not let an unauthenticated visitor write into someone's audit log", async () => {
      const before = await auditCount();

      const { error } = await anonClient.rpc("ensure_user_records", {
        p_user_id: victim.id,
        p_email: "attacker@evil.test",
      });
      expect(error, "anon reached ensure_user_records").toBeTruthy();
      expect(error!.code).toBe("42501"); // permission denied

      // The forgery must not have landed: this log is immutable by design.
      expect(await auditCount()).toBe(before);
    });

    it("does not let another authenticated user bootstrap someone else's records", async () => {
      const before = await auditCount();

      const { error } = await attackerClient.rpc("ensure_user_records", {
        p_user_id: victim.id,
        p_email: "attacker@evil.test",
      });
      expect(error, "a user session reached ensure_user_records").toBeTruthy();
      expect(error!.code).toBe("42501");

      expect(await auditCount()).toBe(before);
    });

    it("does not expose the raw user ids get_leaderboard returns to a browser", async () => {
      // get_leaderboard returns `user_id uuid`. Every call site is server-side
      // with the service role, so a browser has no reason to hold it — and it
      // is the list that would make harvesting cross-user ids trivial.
      for (const client of [anonClient, attackerClient]) {
        const { error } = await client.rpc("get_leaderboard", { p_top: 5 });
        expect(error).toBeTruthy();
        expect(error!.code).toBe("42501");
      }

      // The supported path still works.
      const { data, error } = await db.rpc("get_leaderboard", { p_top: 5 });
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    });

    it("does not hand ingestion telemetry to a logged-in user", async () => {
      const { data } = await attackerClient.from("ingestion_runs").select("*");
      expect(data ?? []).toHaveLength(0);
    });

    // The two functions below are the one place this suite's earlier version
    // stopped short: it attacked the boundary from a *signed-in* session, which
    // is why an `anon` grant survived every migration that claimed to close it.
    // `revoke execute … from public` removes only the implicit PUBLIC grant;
    // Supabase's default privileges grant EXECUTE *explicitly* to anon as well,
    // and a `create or replace` keeps it. `execute_trade` then ran far enough to
    // raise its own FORBIDDEN, and `position_marks` — guarded by
    // `auth.uid() is not null and auth.uid() <> p_user_id`, which a NULL uid
    // satisfies — returned the named user's marks to a caller with no session at
    // all. These assert the grant itself, so either one becoming anonymously
    // executable again fails the suite.
    it("cannot execute_trade or read position_marks without a session", async () => {
      const traded = await anonClient.rpc("execute_trade", {
        p_user_id: victim.id,
        p_market_id: marketId,
        p_counter_market_id: null,
        p_instrument: "ENERGY_SPOT",
        p_product: PRODUCT,
        p_side: "BUY",
        p_quantity_mwh: 1,
        p_delivery_start: interval,
        p_delivery_end: intervalEnd,
        p_client_order_id: `anon-${Date.now()}`,
      });
      expect(traded.error, "anon reached execute_trade").toBeTruthy();
      expect(traded.error!.code).toBe("42501"); // permission denied

      const marks = await anonClient.rpc("position_marks", { p_user_id: victim.id });
      expect(marks.error, "anon reached position_marks").toBeTruthy();
      expect(marks.error!.code).toBe("42501");
      expect(marks.data ?? [], "anon was handed position marks").toHaveLength(0);

      // Neither attempt moved the victim's money.
      const { count } = await db
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("user_id", victim.id);
      expect(count).toBe(1);
    }, 60_000);

    it("still lets the service role read the marks the read side depends on", async () => {
      const { data, error } = await db.rpc("position_marks", { p_user_id: victim.id });
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    }, 60_000);
  });
});
