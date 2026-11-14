import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  admin,
  cleanupTestUsers,
  createReplayTestUser,
  dbTestsEnabled,
  markLedgerStaged,
  userClient,
} from "@/lib/testing/db";
import { OBS_KEY } from "@/lib/testing/ercot-fixture";

/**
 * Engine regressions (0043), each written against the bug it pins.
 *
 * The other suites replay actual ERCOT data; several cases here need a price
 * ERCOT has not printed on the days the corpus covers (a spread below −$2,000,
 * a real-time hour that never posted), so this suite publishes its own
 * observations on a day no ingestion reaches, labelled GENERATED, on load zones
 * no other suite writes. The day-ahead calendar below is ERCOT's: bids close at
 * 10:00 Central the day before, and the clearing posts at about 13:30.
 */
describe.skipIf(!dbTestsEnabled())("engine regressions (live database)", () => {
  const HOUR = 3_600_000;
  const MINUTE = 60_000;
  const SOURCE_LABEL = "TEST (GENERATED)";

  /** Operating day 2025-06-10, in daylight time: HE18 starts 22:00Z. */
  const GATE = "2025-06-09T15:00:00.000Z";
  const CLEARING = "2025-06-09T18:30:00.000Z";
  const BEFORE_GATE = at(GATE, -HOUR);
  const AFTER_GATE = at(GATE, MINUTE);
  const AFTER_CLEARING = at(CLEARING, MINUTE);
  /** Its real-time prices are final Thu 2025-06-12, 16:00 Central (0044). */
  const AFTER_FINAL = "2025-06-12T21:01:00.000Z";
  const he =(n: number) => at("2025-06-10T05:00:00.000Z", (n - 1) * HOUR);

  function at(iso: string, deltaMs: number): string {
    return new Date(Date.parse(iso) + deltaMs).toISOString();
  }

  let db: SupabaseClient;
  /** Path instruments and virtuals: source and sink. */
  let aen: string;
  let cps: string;
  /** Energy, for the cash-funded settlement case. */
  let lcra: string;
  const publishedIds: string[] = [];

  const market = async (point: string): Promise<string> => {
    const { data, error } = await db
      .from("markets")
      .upsert(
        { settlement_point: point, settlement_point_type: "LOAD_ZONE", active: true },
        { onConflict: "settlement_point" }
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data!.id as string;
  };

  const publish = async (
    marketId: string,
    product: "DAM_HOURLY" | "RTM_HOURLY" | "RTM_15MIN",
    start: string,
    price: number,
    publishedAt: string,
    isFinal = product !== "RTM_15MIN"
  ) => {
    const minutes = product === "RTM_15MIN" ? 15 : 60;
    const { data, error } = await db
      .from("market_prices")
      .upsert(
        {
          market_id: marketId,
          product,
          delivery_timestamp: start,
          delivery_end: at(start, minutes * MINUTE),
          price: String(price),
          venue: product === "DAM_HOURLY" ? "DAM" : "RTM",
          source: SOURCE_LABEL,
          source_timestamp: publishedAt,
          published_at: publishedAt,
          is_final: isFinal,
        },
        { onConflict: OBS_KEY }
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    publishedIds.push(data!.id as string);
  };

  const dayAhead = (marketId: string, start: string, price: number) =>
    publish(marketId, "DAM_HOURLY", start, price, CLEARING);
  const realTime = (marketId: string, start: string, price: number) =>
    publish(marketId, "RTM_HOURLY", start, price, at(start, HOUR + 2 * MINUTE));

  interface Desk {
    id: string;
    client: SupabaseClient;
    clock(iso: string): Promise<void>;
  }

  const desk = async (label: string, iso: string): Promise<Desk> => {
    const user = await createReplayTestUser(`sql-audit-${label}`);
    const client = await userClient(user);
    const clock = async (to: string) => {
      const { error } = await admin().rpc("set_sim_clock", { p_user_id: user.id, p_iso: to });
      expect(error).toBeNull();
    };
    await clock(iso);
    return { id: user.id, client, clock };
  };

  const bid = (d: Desk, start: string, over: Record<string, unknown> = {}) =>
    d.client.rpc("place_limit_order", {
      p_user_id: d.id,
      p_market_id: aen,
      p_instrument: "VIRTUAL",
      p_product: "DAM_HOURLY",
      p_counter_market_id: null,
      p_side: "BUY",
      p_quantity_mwh: "10",
      p_limit_price: null,
      p_delivery_start: start,
      p_delivery_end: at(start, HOUR),
      ...over,
    });

  const placed = async (d: Desk, start: string, over: Record<string, unknown> = {}) => {
    const { data, error } = await bid(d, start, over);
    expect(error).toBeNull();
    return data as string;
  };

  const sweep = async (d: Desk) => {
    const { data, error } = await db.rpc("fill_crossing_limit_orders", {
      p_limit: 500,
      p_user_id: d.id,
    });
    expect(error).toBeNull();
    return data as { filled: number; expired: number; errors: number; error_samples: unknown[] };
  };

  const settle = async (d: Desk, limit = 500, asOf: string | null = null) => {
    const { data, error } = await db.rpc("settle_delivered_positions", {
      p_as_of: asOf,
      p_limit: limit,
      p_user_id: d.id,
    });
    expect(error).toBeNull();
    return data as { settled: number; deferred: number; failed: number; liquidated: number; deficits: number };
  };

  const order = async (id: string) => {
    const { data } = await db
      .from("paper_orders")
      .select("status, expires_at, filled_trade_id")
      .eq("id", id)
      .single();
    return data!;
  };

  const account = async (d: Desk) => {
    const { data } = await db
      .from("paper_accounts")
      .select("cash_balance, deficit")
      .eq("user_id", d.id)
      .single();
    return { cash: Number(data!.cash_balance), deficit: Number(data!.deficit) };
  };

  const setCash = async (d: Desk, amount: number) => {
    markLedgerStaged(d.id);
    const { error } = await db
      .from("paper_accounts")
      .update({ cash_balance: String(amount) })
      .eq("user_id", d.id);
    expect(error).toBeNull();
  };

  const marks = async (d: Desk) => {
    const { data, error } = await d.client.rpc("position_marks", { p_user_id: d.id });
    expect(error).toBeNull();
    return data as Array<{ position_id: string; mark_price: number | null }>;
  };

  beforeAll(async () => {
    db = admin();
    [aen, cps, lcra] = await Promise.all([market("LZ_AEN"), market("LZ_CPS"), market("LZ_LCRA")]);

    await dayAhead(aen, he(10), 30);
    await dayAhead(aen, he(11), 30);
    await dayAhead(aen, he(14), 40);
    await realTime(aen, he(14), 55);
    await dayAhead(aen, he(15), 40);
    await dayAhead(aen, he(17), 40);

    await dayAhead(aen, he(18), 30);
    await dayAhead(cps, he(18), 45);
    await publish(aen, "RTM_15MIN", he(18), 31, at(he(18), 17 * MINUTE));
    await publish(cps, "RTM_15MIN", he(18), 52, at(he(18), 17 * MINUTE));
    await realTime(aen, he(18), 33);
    await realTime(cps, he(18), 60);

    // A scarcity hour: the source prints at the cap while the sink is curtailed.
    await dayAhead(aen, he(19), 3000);
    await dayAhead(cps, he(19), 40);
    await realTime(aen, he(19), 4500);
    await realTime(cps, he(19), -50);

    await dayAhead(aen, he(20), 40);
    await dayAhead(aen, he(21), 40);
    await realTime(aen, he(21), 25);

    await dayAhead(lcra, he(10), 100);
    await dayAhead(lcra, he(12), 100);
  }, 60_000);

  afterAll(async () => {
    // Users first: a fill's trade row references the observation it priced.
    await cleanupTestUsers();
    for (let i = 0; i < publishedIds.length; i += 100) {
      await db.from("market_prices").delete().in("id", publishedIds.slice(i, i + 100));
    }
  }, 60_000);

  describe("the life of a bid", () => {
    it("keeps a bid alive until its delivery, however far out it was placed", async () => {
      // Thirteen days out: inside ERCOT's fourteen-day window, beyond the old
      // seven-day default.
      const d = await desk("far-out", at(he(17), -13 * 24 * HOUR));
      const id = await placed(d, he(17));

      // The default used to be 7 days, so anything further out expired before
      // the market it was bidding into had even opened.
      expect(Date.parse((await order(id)).expires_at)).toBe(Date.parse(he(17)));

      await d.clock(AFTER_CLEARING);
      expect((await sweep(d)).filled).toBe(1);
      expect((await order(id)).status).toBe("FILLED");
    }, 60_000);

    it("takes a day's bids from fourteen days before it, as ERCOT does", async () => {
      // Operating Day 2025-06-10 opens at 00:00 CDT on 2025-05-27.
      const OPENS = "2025-05-27T05:00:00.000Z";
      const d = await desk("window", at(OPENS, -MINUTE));
      const early = await bid(d, he(17));
      expect(early.error?.message).toContain("DAM_NOT_OPEN");

      await d.clock(at(OPENS, MINUTE));
      expect((await bid(d, he(17))).error).toBeNull();
    }, 60_000);

    it("takes quantities on ERCOT's 0.1 MW grid", async () => {
      const d = await desk("increment", BEFORE_GATE);
      const off = await bid(d, he(17), { p_quantity_mwh: "1.05" });
      expect(off.error?.message).toContain("QUANTITY_INCREMENT");
      expect((await bid(d, he(17), { p_quantity_mwh: "1.5" })).error).toBeNull();
    }, 60_000);

    it("locks a bid at the deadline: it cannot be withdrawn once bids have closed", async () => {
      const d = await desk("cancel", BEFORE_GATE);
      const early = await placed(d, he(17));
      const late = await placed(d, he(17));

      expect((await d.client.rpc("cancel_order", { p_user_id: d.id, p_order_id: early })).error).toBeNull();

      await d.clock(AFTER_GATE);
      const { error } = await d.client.rpc("cancel_order", { p_user_id: d.id, p_order_id: late });
      expect(error?.message).toContain("DAM_CLOSED");
      expect((await order(late)).status).toBe("OPEN");
    }, 60_000);

    it("ends a limit bid the moment the market clears through it, freeing its collateral", async () => {
      const d = await desk("no-cross", BEFORE_GATE);
      const id = await placed(d, he(17), { p_limit_price: "35" });

      await d.clock(AFTER_CLEARING);
      const summary = await sweep(d);
      expect(summary.filled).toBe(0);
      expect((await order(id)).status).toBe("EXPIRED");
    }, 60_000);

    it("fills at the clearing even when the clock jumps straight past delivery", async () => {
      const d = await desk("jump", BEFORE_GATE);
      const id = await placed(d, he(14));

      // ERCOT cleared this bid the day before; moving the clock past delivery
      // does not change that, and it used to expire the bid unfilled.
      await d.clock(at(he(15), 10 * MINUTE));
      expect((await sweep(d)).filled).toBe(1);

      const row = await order(id);
      expect(row.status).toBe("FILLED");
      const { data: trade } = await db
        .from("trades")
        .select("execution_price, price_timestamp")
        .eq("id", row.filled_trade_id!)
        .single();
      expect(Number(trade!.execution_price)).toBe(40);
      expect(Date.parse(trade!.price_timestamp as string)).toBeLessThan(Date.parse(he(14)));

      await d.clock(AFTER_FINAL);
      const summary = await settle(d);
      expect(summary.settled).toBe(1);
      expect((await account(d)).cash).toBe(100_000 + (55 - 40) * 10);
    }, 60_000);

    it("does not fill from a clearing published after delivery started", async () => {
      await publish(lcra, "DAM_HOURLY", he(16), 40, at(he(16), HOUR));
      const d = await desk("late-print", BEFORE_GATE);
      const id = await placed(d, he(16), { p_market_id: lcra });

      await d.clock(at(he(16), 2 * HOUR));
      expect((await sweep(d)).filled).toBe(0);
      expect((await order(id)).status).toBe("EXPIRED");
    }, 60_000);

    it("honours an expiry set before the clearing", async () => {
      const d = await desk("expiry", BEFORE_GATE);
      const id = await placed(d, he(17), { p_expires_at: at(GATE, -MINUTE) });

      await d.clock(AFTER_CLEARING);
      expect((await sweep(d)).filled).toBe(0);
      expect((await order(id)).status).toBe("EXPIRED");
    }, 60_000);

    it("only lets the sweep fill at another instant", async () => {
      const d = await desk("as-of", BEFORE_GATE);
      const { error } = await d.client.rpc("execute_trade", {
        p_user_id: d.id,
        p_market_id: aen,
        p_counter_market_id: null,
        p_instrument: "VIRTUAL",
        p_product: "DAM_HOURLY",
        p_side: "BUY",
        p_quantity_mwh: "1",
        p_delivery_start: he(14),
        p_delivery_end: at(he(14), HOUR),
        p_client_order_id: crypto.randomUUID(),
        p_as_of: AFTER_CLEARING,
      });
      // Since 0046 a session cannot call the fill at all.
      expect(error?.code).toBe("42501");
    }, 60_000);
  });

  describe("path obligations", () => {
    it("marks a PTP from fill through delivery, never as unpriced", async () => {
      const d = await desk("ptp-mark", BEFORE_GATE);
      await placed(d, he(18), { p_instrument: "PTP_OBLIGATION", p_counter_market_id: cps });
      await d.clock(AFTER_CLEARING);
      expect((await sweep(d)).filled).toBe(1);

      // Cleared, no real time yet: it carries the spread it was bought at.
      expect((await marks(d))[0].mark_price).toBe(15);

      // Mid-hour: the first 15-minute prints of each leg.
      await d.clock(at(he(18), 20 * MINUTE));
      expect((await marks(d))[0].mark_price).toBe(21);

      // The hour has posted.
      await d.clock(at(he(18), 70 * MINUTE));
      expect((await marks(d))[0].mark_price).toBe(27);

      const { data } = await d.client.rpc("account_margin", { p_user_id: d.id });
      expect(Number(data[0].unpriced_positions)).toBe(0);
      expect(Number(data[0].equity)).toBe(100_000 + (27 - 15) * 10);
    }, 60_000);

    it("fills and settles a spread beyond any single point's price bounds", async () => {
      const d = await desk("ptp-scarcity", BEFORE_GATE);
      const id = await placed(d, he(19), {
        p_instrument: "PTP_OBLIGATION",
        p_counter_market_id: cps,
        p_quantity_mwh: "1",
      });

      // Day-ahead spread 40 − 3000 = −2960; real-time −50 − 4500 = −4550.
      await d.clock(AFTER_CLEARING);
      const swept = await sweep(d);
      expect(swept.error_samples).toEqual([]);
      expect((await order(id)).status).toBe("FILLED");

      await d.clock(AFTER_FINAL);
      const summary = await settle(d);
      expect(summary.failed).toBe(0);
      expect(summary.settled).toBe(1);
      expect((await account(d)).cash).toBe(100_000 - 1590);
    }, 60_000);
  });

  describe("settlement", () => {
    it("sells collateral before booking a deficit the account can cover", async () => {
      const d = await desk("funding", AFTER_CLEARING);
      const fill = (side: string, start: string, qty: number) =>
        db.rpc("execute_trade", {
          p_user_id: d.id,
          p_market_id: lcra,
          p_counter_market_id: null,
          p_instrument: "ENERGY_SPOT",
          p_product: "DAM_HOURLY",
          p_side: side,
          p_quantity_mwh: qty,
          p_delivery_start: start,
          p_delivery_end: at(start, HOUR),
          p_client_order_id: crypto.randomUUID(),
        });
      expect((await fill("BUY", he(12), 20)).error).toBeNull();
      expect((await fill("SELL", he(10), 10)).error).toBeNull();

      // The short owes $1,000 against $600: a $400 gap, and a $2,000 long to
      // sell. More cash than the gap is not the same as enough cash.
      await setCash(d, 600);
      const summary = await settle(d, 500, at(he(10), HOUR));

      expect(summary.liquidated).toBe(1);
      expect(summary.deficits).toBe(0);
      expect(await account(d)).toEqual({ cash: 1600, deficit: 0 });
    }, 60_000);

    it("does not let an unpriced hour stop the positions behind it settling", async () => {
      const d = await desk("starvation", BEFORE_GATE);
      await placed(d, he(20));
      await placed(d, he(21));
      await d.clock(AFTER_CLEARING);
      expect((await sweep(d)).filled).toBe(2);

      // HE20 never gets a real-time price; HE21 does.
      await d.clock(AFTER_FINAL);
      const summary = await settle(d, 1);
      expect(summary.deferred).toBe(1);
      expect(summary.settled).toBe(1);
    }, 60_000);
  });

  describe("credit", () => {
    it("counts an open loss against what a new bid can post", async () => {
      const d = await desk("credit", BEFORE_GATE);
      await placed(d, he(21), { p_quantity_mwh: "50" });
      await d.clock(AFTER_CLEARING);
      expect((await sweep(d)).filled).toBe(1);

      // Covers every bid's collateral on cash alone; the position, already
      // printed at 25 against its 40 entry, is $750 under water.
      const { data: factor } = await db.rpc("bid_exposure_factor", { p_market_id: aen });
      await setCash(d, 51 * Number(factor) + 100);
      await d.clock(at(he(22), 10 * MINUTE));

      const { error } = await bid(d, at(he(18), 2 * 24 * HOUR), { p_quantity_mwh: "1" });
      expect(error?.message).toContain("CREDIT_LIMIT_EXCEEDED");
    }, 60_000);
  });
});
