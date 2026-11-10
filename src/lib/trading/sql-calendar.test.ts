import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  admin,
  cleanupTestUsers,
  createTestUser,
  dbTestsEnabled,
  userClient,
} from "@/lib/testing/db";
import { OBS_KEY } from "@/lib/testing/ercot-fixture";
import {
  ercotHolidays,
  isErcotBusinessDay,
  priceFinalAt,
} from "@/lib/ercot/settlement-calendar";

/**
 * ERCOT's settlement calendar and price corrections (0044).
 *
 * Real-time prices are final at 16:00 Central on the second Business Day after
 * the Operating Day, and ERCOT corrects them until then (NP4-197). This suite
 * pins the SQL calendar to its TypeScript mirror, then follows one virtual
 * from its bid to a settlement on a corrected price.
 *
 * Like sql-audit, it publishes its own observations on a day no ingestion
 * reaches, labelled GENERATED, on load zones no other suite writes.
 */
describe.skipIf(!dbTestsEnabled())("settlement calendar (live database)", () => {
  const HOUR = 3_600_000;
  const MINUTE = 60_000;
  const SOURCE_LABEL = "TEST (GENERATED)";

  /** Operating Day Tue 2025-06-10: bids close Mon 10:00, prices final Thu 16:00. */
  const GATE = "2025-06-09T15:00:00.000Z";
  const CLEARING = "2025-06-09T18:30:00.000Z";
  const FINAL = "2025-06-12T21:00:00.000Z";
  const he = (n: number) => at("2025-06-10T05:00:00.000Z", (n - 1) * HOUR);

  function at(iso: string, deltaMs: number): string {
    return new Date(Date.parse(iso) + deltaMs).toISOString();
  }

  let db: SupabaseClient;
  let north: string;
  let south: string;
  const publishedIds: string[] = [];
  const docIds: string[] = [];

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
    isFinal: boolean
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
    return data!.id as string;
  };

  interface Desk {
    id: string;
    client: SupabaseClient;
    clock(iso: string): Promise<void>;
  }

  const desk = async (label: string, iso: string): Promise<Desk> => {
    const user = await createTestUser(`sql-calendar-${label}`);
    const client = await userClient(user);
    const clock = async (to: string) => {
      const { error } = await client.rpc("set_sim_clock", { p_user_id: user.id, p_iso: to });
      expect(error).toBeNull();
    };
    await clock(iso);
    return { id: user.id, client, clock };
  };

  /** A 10 MW DEC (buy day-ahead, sell real time), filled at the clearing. */
  const dec = async (d: Desk, marketId: string, start: string) => {
    const { error } = await d.client.rpc("place_limit_order", {
      p_user_id: d.id,
      p_market_id: marketId,
      p_instrument: "VIRTUAL",
      p_product: "DAM_HOURLY",
      p_counter_market_id: null,
      p_side: "BUY",
      p_quantity_mwh: "10",
      p_limit_price: null,
      p_delivery_start: start,
      p_delivery_end: at(start, HOUR),
    });
    expect(error).toBeNull();
    await d.clock(at(CLEARING, MINUTE));
    const { data, error: sweepErr } = await db.rpc("fill_crossing_limit_orders", {
      p_limit: 500,
      p_user_id: d.id,
    });
    expect(sweepErr).toBeNull();
    expect((data as { filled: number }).filled).toBe(1);
  };

  const settle = async (d: Desk) => {
    const { data, error } = await db.rpc("settle_delivered_positions", {
      p_as_of: null,
      p_limit: 500,
      p_user_id: d.id,
    });
    expect(error).toBeNull();
    return data as { settled: number; deferred: number; settlement_due_remaining: number };
  };

  const cash = async (d: Desk) => {
    const { data } = await db
      .from("paper_accounts")
      .select("cash_balance")
      .eq("user_id", d.id)
      .single();
    return Number(data!.cash_balance);
  };

  const mark = async (d: Desk) => {
    const { data, error } = await d.client.rpc("position_marks", { p_user_id: d.id });
    expect(error).toBeNull();
    return (data as Array<{ mark_price: number | null }>)[0].mark_price;
  };

  /** Runs `fn` over `items`, `size` at a time. */
  async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>) {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
    }
    return out;
  }

  beforeAll(async () => {
    db = admin();
    [north, south] = await Promise.all([market("LZ_NORTH"), market("LZ_SOUTH")]);
  }, 60_000);

  afterAll(async () => {
    // Users first: a fill's trade row references the observation it priced.
    await cleanupTestUsers();
    await db.from("market_prices").delete().eq("market_id", south).eq("source", SOURCE_LABEL);
    for (let i = 0; i < publishedIds.length; i += 100) {
      await db.from("market_prices").delete().in("id", publishedIds.slice(i, i + 100));
    }
    if (docIds.length) await db.from("ercot_price_correction_docs").delete().in("doc_id", docIds);
  }, 60_000);

  describe("the calendar", () => {
    it("observes the same holidays in SQL as in TypeScript", async () => {
      // Every day near a holiday, 2019–2032: the rule's edges are there.
      const days: string[] = [];
      for (let y = 2019; y <= 2032; y++) {
        for (const h of ercotHolidays(y)) {
          for (let k = -3; k <= 3; k++) {
            days.push(new Date(Date.parse(`${h.day}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10));
          }
        }
      }
      const unique = [...new Set(days)];
      const mismatches = (
        await inBatches(unique, 40, async (day) => {
          const { data, error } = await db.rpc("ercot_is_holiday", { p_day: day });
          expect(error).toBeNull();
          const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
          const sqlBusiness = !weekend && data === false;
          return sqlBusiness === isErcotBusinessDay(day) ? null : day;
        })
      ).filter(Boolean);
      expect(mismatches).toEqual([]);
    }, 120_000);

    it("finalizes each interval at the same instant in SQL as in TypeScript", async () => {
      // Every 11 hours across fifteen months: weekends, holidays, both DST changes.
      const instants: number[] = [];
      for (let t = Date.parse("2025-10-15T00:00:00Z"); t < Date.parse("2027-01-10T00:00:00Z"); t += 11 * HOUR) {
        instants.push(t);
      }
      const mismatches = (
        await inBatches(instants, 40, async (t) => {
          const product = t % 2 === 0 ? "RTM_HOURLY" : "DAM_HOURLY";
          const { data, error } = await db.rpc("ercot_price_final_at", {
            p_product: product,
            p_ts: new Date(t).toISOString(),
          });
          expect(error).toBeNull();
          return Date.parse(data as string) === priceFinalAt(product, t)
            ? null
            : `${product} ${new Date(t).toISOString()}: ${data}`;
        })
      ).filter(Boolean);
      expect(mismatches).toEqual([]);
    }, 120_000);
  });

  describe("finality", () => {
    it("promotes a real-time hour only once ERCOT has declared it final", async () => {
      const recent = new Date(Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR).toISOString();
      const now = new Date().toISOString();
      const old = await publish(north, "RTM_HOURLY", he(9), 30, at(he(9), HOUR + 2 * MINUTE), false);
      const young = await publish(north, "RTM_HOURLY", recent, 30, now, false);

      const { error } = await db.rpc("promote_rtm_finals");
      expect(error).toBeNull();

      const { data } = await db.from("market_prices").select("id, is_final").in("id", [old, young]);
      const final = new Map((data ?? []).map((r) => [r.id, r.is_final]));
      expect(final.get(old)).toBe(true);
      // Two Business Days have not passed since this hour: ERCOT can still correct it.
      expect(final.get(young)).toBe(false);
    }, 60_000);

    it("settles on the account's clock at ERCOT's deadline, not at the end of the day", async () => {
      await publish(north, "DAM_HOURLY", he(14), 30, CLEARING, true);
      await publish(north, "RTM_HOURLY", he(14), 45, at(he(14), HOUR + 2 * MINUTE), true);
      const d = await desk("deadline", at(GATE, -HOUR));
      await dec(d, north, he(14));

      // Delivered, priced, and marked: not yet final.
      await d.clock(at(he(15), 10 * MINUTE));
      let summary = await settle(d);
      expect(summary.settled).toBe(0);
      // Not due is not stuck: nothing is reported as waiting on the feed.
      expect(summary.settlement_due_remaining).toBe(0);
      expect(await mark(d)).toBe(45);

      await d.clock(at(FINAL, -MINUTE));
      expect((await settle(d)).settled).toBe(0);

      await d.clock(at(FINAL, MINUTE));
      summary = await settle(d);
      expect(summary.settled).toBe(1);
      expect(await cash(d)).toBe(100_000 + (45 - 30) * 10);
    }, 60_000);
  });

  describe("price corrections", () => {
    const POSTED = at(FINAL, -40 * MINUTE); // 15:20 Central, as ERCOT posts them

    it("settles on the price ERCOT corrected before its deadline", async () => {
      const quarter = (q: number) => at(he(15), (q - 1) * 15 * MINUTE);
      await publish(south, "DAM_HOURLY", he(15), 20, CLEARING, true);
      for (const [q, price] of [[1, 20], [2, 24], [3, 28], [4, 32]] as const) {
        await publish(south, "RTM_15MIN", quarter(q), price, at(quarter(q), 17 * MINUTE), false);
      }
      await publish(south, "RTM_HOURLY", he(15), 26, at(he(15), HOUR + 2 * MINUTE), false);

      const d = await desk("correction", at(GATE, -HOUR));
      await dec(d, south, he(15));

      const docId = `test-${crypto.randomUUID()}`;
      docIds.push(docId);
      const rows = [
        { market_id: south, delivery_timestamp: quarter(2), price: "40" },
        // An interval the store never held is not invented.
        { market_id: south, delivery_timestamp: he(16), price: "99" },
      ];
      const apply = () =>
        db.rpc("apply_rtm_price_corrections", {
          p_doc_id: docId,
          p_posted_at: POSTED,
          p_source: SOURCE_LABEL,
          p_rows: rows,
        });

      // A trader cannot publish prices.
      const { error: forbidden } = await d.client.rpc("apply_rtm_price_corrections", {
        p_doc_id: docId,
        p_posted_at: POSTED,
        p_source: SOURCE_LABEL,
        p_rows: rows,
      });
      expect(forbidden).not.toBeNull();

      const first = await apply();
      expect(first.error).toBeNull();
      expect(first.data).toEqual({ applied: true, intervals: 1, hours: 1 });
      // Once per document.
      expect((await apply()).data).toEqual({ applied: false, intervals: 0, hours: 0 });

      // The hour, re-averaged: (20 + 40 + 28 + 32) / 4.
      const { data: hourly } = await db
        .from("market_prices")
        .select("price, published_at, is_final")
        .eq("market_id", south)
        .eq("product", "RTM_HOURLY")
        .eq("delivery_timestamp", he(15))
        .order("published_at");
      expect(hourly!.map((r) => Number(r.price))).toEqual([26, 30]);
      expect(Date.parse(hourly![1].published_at as string)).toBe(Date.parse(POSTED));

      // Marks see the correction only once ERCOT has posted it.
      await d.clock(at(POSTED, -MINUTE));
      expect(await mark(d)).toBe(26);
      await d.clock(at(POSTED, MINUTE));
      expect(await mark(d)).toBe(30);

      // Ingestion promotes at the deadline; the latest vintage is the value.
      expect((await db.rpc("promote_rtm_finals")).error).toBeNull();
      await d.clock(at(FINAL, MINUTE));
      expect((await settle(d)).settled).toBe(1);
      expect(await cash(d)).toBe(100_000 + (30 - 20) * 10);
    }, 60_000);

    it("never lets a re-posted old hour pass for the current price (0047)", async () => {
      // A correction to an hour long past, posted a moment ago: the newest
      // publication there is, and the oldest hour.
      await publish(south, "RTM_HOURLY", he(16), 77, new Date(Date.now() - MINUTE).toISOString(), true);

      const { data: current } = await db
        .from("current_prices")
        .select("delivery_timestamp")
        .eq("market_id", south)
        .eq("product", "RTM_HOURLY")
        .single();
      const { data: newest } = await db
        .from("market_prices")
        .select("delivery_timestamp")
        .eq("market_id", south)
        .eq("product", "RTM_HOURLY")
        .lte("published_at", new Date().toISOString())
        .order("delivery_timestamp", { ascending: false })
        .limit(1)
        .single();
      expect(Date.parse(current!.delivery_timestamp as string)).toBe(
        Date.parse(newest!.delivery_timestamp as string)
      );
      expect(Date.parse(current!.delivery_timestamp as string)).toBeGreaterThan(Date.parse(he(16)));
    }, 60_000);
  });
});
