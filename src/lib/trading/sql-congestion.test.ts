import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";
import { INSTRUMENTS, PRODUCTS } from "@/lib/ercot/types";

/**
 * Congestion settlement, and the catalog itself, against the real database.
 *
 * Two things here can only be checked in Postgres:
 *
 *   1. `instrument_price` is the authoritative price reduction. The TypeScript
 *      mirror in `instruments.ts` is a convenience for the ticket, so asserting
 *      the mirror against itself proves nothing about what prices a real fill.
 *      These tests trade through the deployed function and check the rows.
 *
 *   2. The live catalog. Migration 0017 corrected a mislabelled product by
 *      aiming an UPDATE at `instruments` for a code that lived in `products`.
 *      It matched zero rows and reported success. Nothing caught it, because
 *      the TypeScript catalog and the deployed tables were never compared — so
 *      they are compared here. That is the test that would have caught it.
 *
 * Opt in with `RUN_DB_TESTS=1`: it creates real users in the configured project.
 */
describe.skipIf(!dbTestsEnabled())("congestion settlement (live database)", () => {
  const HOUR = 3600_000;

  let db: SupabaseClient;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: SupabaseClient;
  let legA: string;
  let legB: string;
  let interval: string;
  let intervalEnd: string;
  let rtA = 0;
  let rtB = 0;
  let daA = 0;
  let daB = 0;

  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

  interface Execution {
    execution_price: number;
    settlement_rule: string;
    product: string;
    counter_market_id: string | null;
    position_quantity: number;
    position_average_entry_price: number;
  }

  /**
   * A day-ahead PTP instrument is bought at the day-ahead congestion across the
   * path and settled at the real-time congestion across the same path, so it
   * carries the convergence of the two. Computed here from the published price
   * rows rather than taken from the engine, which is the whole point.
   */
  const convergence = (a: number, b: number, da_a: number, da_b: number) =>
    b - a - (da_b - da_a);

  const trade = (over: Record<string, unknown> = {}) => ({
    p_user_id: user.id,
    p_market_id: legA,
    p_counter_market_id: legB,
    p_instrument: "PTP_OBLIGATION",
    p_product: "DAM_HOURLY",
    p_side: "BUY",
    p_quantity_mwh: 1,
    p_delivery_start: interval,
    p_delivery_end: intervalEnd,
    p_client_order_id: crypto.randomUUID(),
    ...over,
  });

  const countRows = async () => {
    const [trades, positions, audit] = await Promise.all([
      db.from("trades").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      db.from("positions").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      db.from("audit_events").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    ]);
    return {
      trades: trades.count ?? 0,
      positions: positions.count ?? 0,
      audit: audit.count ?? 0,
    };
  };

  beforeAll(async () => {
    db = admin();
    user = await createTestUser("sql-congestion");
    client = await userClient(user);

    // A path needs one hour priced on both legs, in both markets. The pair is
    // discovered rather than hard-coded, so a thinner feed narrows the test
    // instead of breaking it.
    const { data: hubs } = await db
      .from("markets")
      .select("id")
      .in("settlement_point", [
        "HB_NORTH",
        "HB_SOUTH",
        "HB_HOUSTON",
        "HB_WEST",
        "HB_PAN",
      ])
      .eq("active", true);
    const hubIds = (hubs ?? []).map((h) => h.id as string);

    const { data: rows } = await db
      .from("market_prices")
      .select("market_id, product, delivery_timestamp, price")
      .in("market_id", hubIds)
      .in("product", ["DAM_HOURLY", "RTM_HOURLY"])
      .gt("delivery_timestamp", new Date().toISOString())
      .order("delivery_timestamp", { ascending: true })
      .limit(4000);

    type Legs = { DAM_HOURLY?: number; RTM_HOURLY?: number };
    const byInterval = new Map<string, Map<string, Legs>>();
    for (const r of rows ?? []) {
      const ts = r.delivery_timestamp as string;
      const perMarket = byInterval.get(ts) ?? new Map<string, Legs>();
      const leg = perMarket.get(r.market_id as string) ?? {};
      leg[r.product as "DAM_HOURLY" | "RTM_HOURLY"] = Number(r.price);
      perMarket.set(r.market_id as string, leg);
      byInterval.set(ts, perMarket);
    }

    let found: { ts: string; a: string; b: string } | null = null;
    for (const [ts, perMarket] of byInterval) {
      const complete = [...perMarket.entries()].filter(
        ([, l]) => l.DAM_HOURLY !== undefined && l.RTM_HOURLY !== undefined
      );
      if (complete.length >= 2) {
        found = { ts, a: complete[0][0], b: complete[1][0] };
        break;
      }
    }
    expect(found, "no future hour is priced in both markets on two hubs").not.toBeNull();

    interval = found!.ts;
    intervalEnd = new Date(new Date(interval).getTime() + HOUR).toISOString();
    legA = found!.a;
    legB = found!.b;
    const perMarket = byInterval.get(interval)!;
    rtA = perMarket.get(legA)!.RTM_HOURLY!;
    rtB = perMarket.get(legB)!.RTM_HOURLY!;
    daA = perMarket.get(legA)!.DAM_HOURLY!;
    daB = perMarket.get(legB)!.DAM_HOURLY!;
  }, 120_000);

  it("fills a day-ahead PTP obligation at the convergence of congestion", async () => {
    const { data, error } = await client.rpc("execute_trade", trade());
    expect(error).toBeNull();
    const result = data as Execution;

    expect(result.settlement_rule).toBe("CONGESTION_CONVERGENCE");
    near(result.execution_price, convergence(rtA, rtB, daA, daB));
    // Leg B is part of the position identity, so this is a path position.
    expect(result.counter_market_id).toBe(legB);

    const { data: pos } = await db
      .from("positions")
      .select("quantity_mwh, average_entry_price, product, counter_market_id")
      .eq("user_id", user.id)
      .eq("market_id", legA)
      .eq("counter_market_id", legB)
      .eq("instrument", "PTP_OBLIGATION")
      .eq("delivery_start", interval)
      .single();
    expect(pos!.counter_market_id).toBe(legB);
    // The instrument has no price series of its own — it settles off the market
    // it clears in — so its product is derived rather than caller-chosen. That
    // is what keeps two fills on one path from landing in two positions.
    expect(pos!.product).toBe("DAM_HOURLY");
    near(Number(pos!.average_entry_price), convergence(rtA, rtB, daA, daB));
  }, 60_000);

  it("fills an auctioned CRR on the same path at the day-ahead spread instead", async () => {
    const { data, error } = await client.rpc(
      "execute_trade",
      trade({ p_instrument: "CRR_OBLIGATION" })
    );
    expect(error).toBeNull();
    const result = data as Execution;

    // Two different ERCOT congestion products: the CRR settles on day-ahead
    // congestion alone (Nodal Protocols 7.9.1.1) and needs no real-time price,
    // while the day-ahead PTP instrument settles on the real-time spread. The
    // engine used to compute both as the day-ahead spread, which made the
    // day-ahead market product unrepresentable.
    expect(result.settlement_rule).toBe("DIFFERENCE");
    near(result.execution_price, daB - daA);
  }, 60_000);

  it("refuses a path instrument asked to settle without a second point", async () => {
    const before = await countRows();
    const { error } = await client.rpc(
      "execute_trade",
      trade({ p_counter_market_id: null })
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("COUNTER_POINT_REQUIRED");
    // A rejected order leaves no trace beyond the attempt.
    expect(await countRows()).toEqual(before);
  }, 60_000);

  it("refuses a second point on an instrument that settles one", async () => {
    const { error } = await client.rpc(
      "execute_trade",
      trade({ p_instrument: "ENERGY_SPOT", p_product: "RTM_HOURLY" })
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("COUNTER_POINT_INVALID");
  }, 60_000);

  it("floors a losing day-ahead PTP option at zero but not the obligation", async () => {
    // Reverse the path if needed so the convergence is negative either way, then
    // the obligation is two-way and the option can only pay out.
    const forward = convergence(rtA, rtB, daA, daB);
    const src = forward > 0 ? legB : legA;
    const sink = forward > 0 ? legA : legB;

    const obligation = await client.rpc(
      "execute_trade",
      trade({
        p_market_id: src,
        p_counter_market_id: sink,
        p_instrument: "PTP_OBLIGATION",
      })
    );
    expect(obligation.error).toBeNull();
    expect((obligation.data as Execution).execution_price).toBeLessThan(0);

    const option = await client.rpc(
      "execute_trade",
      trade({
        p_market_id: src,
        p_counter_market_id: sink,
        p_instrument: "PTP_OPTION",
      })
    );
    expect(option.error).toBeNull();
    expect((option.data as Execution).execution_price).toBe(0);
  }, 60_000);
});

/**
 * The deployed catalog is what the engine reads. A migration can be recorded as
 * applied and still not have done what it says — 0017's product rename did
 * exactly that — so the tables are compared to the catalog the application
 * uses, key by key.
 */
describe.skipIf(!dbTestsEnabled())("catalog (live database)", () => {
  let db: SupabaseClient;

  const byCode = <T extends { code: string }>(rows: T[]) =>
    [...rows].sort((a, b) => a.code.localeCompare(b.code));

  beforeAll(() => {
    db = admin();
  });

  it("matches the deployed product table to the TypeScript catalog", async () => {
    const { data, error } = await db
      .from("products")
      .select("code, kind, venue, interval_minutes, priced_per, tradable")
      .order("code");
    expect(error).toBeNull();

    const live = byCode(
      (data ?? []).map((p) => ({
        code: p.code as string,
        kind: p.kind as string,
        venue: p.venue as string,
        intervalMinutes: Number(p.interval_minutes),
        pricedPer: p.priced_per as string,
        tradable: Boolean(p.tradable),
      }))
    );
    const expected = byCode(
      PRODUCTS.map((p) => ({
        code: p.code,
        kind: p.kind,
        venue: p.venue,
        intervalMinutes: p.intervalMinutes,
        pricedPer: p.pricedPer,
        tradable: p.tradable,
      }))
    );

    expect(live).toEqual(expected);
  }, 60_000);

  it("matches the deployed instrument table to the TypeScript catalog", async () => {
    const { data, error } = await db
      .from("instruments")
      .select(
        "code, kind, venue, legs, settlement_rule, option_type, product_from_trade, tradable"
      )
      .order("code");
    expect(error).toBeNull();

    const live = byCode(
      (data ?? []).map((i) => ({
        code: i.code as string,
        kind: i.kind as string,
        venue: i.venue as string,
        legs: Number(i.legs),
        settlementRule: i.settlement_rule as string,
        optionType: i.option_type as string,
        productFromTrade: Boolean(i.product_from_trade),
        tradable: Boolean(i.tradable),
      }))
    );
    const expected = byCode(
      INSTRUMENTS.map((i) => ({
        code: i.code,
        kind: i.kind,
        venue: i.venue,
        legs: i.legs,
        settlementRule: i.settlementRule,
        optionType: i.optionType,
        productFromTrade: i.productFromTrade,
        tradable: i.tradable,
      }))
    );

    expect(live).toEqual(expected);
  }, 60_000);

  it("refuses a rule the pricing engine cannot settle", async () => {
    // Belt and braces on the constraint 0017 widened. An unknown rule must not
    // be insertable: `instrument_price` would fall through to null and every
    // order in that instrument would fail as PRICE_UNAVAILABLE, which is a much
    // harder failure to diagnose than a constraint violation at write time.
    const { error } = await db.from("instruments").insert({
      code: "_RULE_PROBE",
      label: "probe",
      kind: "ENERGY",
      venue: "DAM",
      legs: 1,
      settlement_rule: "MADE_UP",
      option_type: "NONE",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/instrument_rule_valid/);
  }, 60_000);
});
