import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createReplayTestUser, dbTestsEnabled } from "@/lib/testing/db";
import { loadFixturePoint } from "@/lib/testing/ercot-fixture";
import { PRODUCTS, INSTRUMENTS } from "@/lib/ercot/types";

/**
 * Congestion: day-ahead PTP and CRR, against ACTUAL ERCOT data.
 *
 * A path instrument has two legs, so it needs a pair of points whose series
 * both exist for the delivery interval. Under real ERCOT publication the
 * real-time series only exists for hours that have already been printed —
 * a future hour never carries an RTM price — so the legs and intervals come
 * from the actual-ERCOT corpus (`fixtures/ercot/replay-2026-09-20.json`,
 * built by `scripts/build-history-fixture.ts` from ERCOT MIS reports),
 * ingested through the production observation key. Every price a case
 * asserts on is read from the fixture; nothing is injected.
 *
 * §12 and §16 of the product audit are the reason this suite exists:
 * a day-ahead PTP obligation is ENTERED at the day-ahead spread (what the
 * DAM clears it at) and SETTLED at the real-time spread; an auctioned CRR
 * is entered AND settled on day-ahead congestion alone. Two different
 * ERCOT products that share one path.
 *
 * Opt in with `RUN_DB_TESTS=1`, since it creates real users in the configured
 * Supabase project.
 */
describe.skipIf(!dbTestsEnabled())("congestion settlement (live database)", () => {
  const HOUR = 3600_000;

  const shift = (ts: string, hours: number) =>
    new Date(new Date(ts).getTime() + hours * HOUR).toISOString();

  let db: SupabaseClient;
  let user: Awaited<ReturnType<typeof createReplayTestUser>>;
  let legA: string;
  let legB: string;
  let interval: string;
  let intervalEnd: string;
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

  /** The day-ahead congestion spread across the path: what a PTP clears at in
   *  the DAM, and therefore what a PTP position is ENTERED at. The engine's
   *  DIFFERENCE composition is sink minus source — counter leg first. */
  const daSpread = (da_a: number, da_b: number) => da_b - da_a;
  // What a PTP then settles at (the real-time spread, DA→RT convergence) is
  // pinned in sql-audit's "path obligations".

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
    user = await createReplayTestUser("sql-congestion");

    // The path and its prices come from the corpus, not from a discovery
    // heuristic over the live feed: every hub in the fixture carries a
    // complete day of day-ahead clearings and real-time finals.
    const a = await loadFixturePoint(db, "HB_NORTH");
    const b = await loadFixturePoint(db, "HB_WEST");
    legA = a.marketId;
    legB = b.marketId;

    const daHours = [...a.dam.keys()].filter((h) => a.dam.has(h) && b.dam.has(h)).sort();
    const rtHours = [...a.rtHour.keys()].filter((h) => a.rtHour.has(h) && b.rtHour.has(h)).sort();
    expect(daHours.length, "fixture carries a full day of day-ahead clearings").toBe(24);
    expect(rtHours.length, "fixture carries a full day of real-time finals").toBe(24);

    // Interval 0 drives the entry-economics cases: the day-ahead spread is
    // tradable at that instant, the real-time outcome is not visible.
    interval = daHours[0];
    intervalEnd = new Date(new Date(interval).getTime() + HOUR).toISOString();
    daA = Number(a.dam.get(interval)!.price);
    daB = Number(b.dam.get(interval)!.price);

    // The desk sits just before the delivery hour: the day-ahead clearings
    // that price the path are visible (ERCOT posted them the day before),
    // the real-time outcome is not. Without the clock these fixture intervals
    // are historical and every fill would be refused as past delivery.
    const { error: clockErr } = await db.rpc("set_sim_clock", {
      p_user_id: user.id,
      p_iso: shift(interval, -1),
    });
    expect(clockErr).toBeNull();
  }, 240_000);

  it("enters a day-ahead PTP obligation at the day-ahead spread, not a known outcome", async () => {
    const { data, error } = await db.rpc("execute_trade", trade());
    expect(error).toBeNull();
    const result = data as Execution;

    expect(result.settlement_rule).toBe("CONGESTION_CONVERGENCE");
    // Entry economics (§12): a PTP is bought at the day-ahead spread in the
    // DAM. The real-time spread it settles against does not exist yet, so a
    // fill computed from it would be trading a known outcome.
    near(result.execution_price, daSpread(daA, daB));
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
    near(Number(pos!.average_entry_price), daSpread(daA, daB));
  }, 60_000);

  it("fills an auctioned CRR on the same path at the day-ahead spread instead", async () => {
    const { data, error } = await db.rpc(
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
    const { error } = await db.rpc(
      "execute_trade",
      trade({ p_counter_market_id: null })
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("COUNTER_POINT_REQUIRED");
    // A rejected order leaves no trace beyond the attempt.
    expect(await countRows()).toEqual(before);
  }, 60_000);

  it("refuses a second point on an instrument that settles one", async () => {
    const { error } = await db.rpc(
      "execute_trade",
      trade({ p_instrument: "ENERGY_SPOT", p_product: "DAM_HOURLY" })
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("COUNTER_POINT_INVALID");
  }, 60_000);

  it("floors a losing day-ahead PTP option at zero but not the obligation", async () => {
    // Reverse the path if needed so the day-ahead spread is negative either
    // way; then the obligation is two-way and the option can only pay out.
    const forward = daSpread(daA, daB);
    const src = forward > 0 ? legB : legA;
    const sink = forward > 0 ? legA : legB;

    const obligation = await db.rpc(
      "execute_trade",
      trade({
        p_market_id: src,
        p_counter_market_id: sink,
        p_instrument: "PTP_OBLIGATION",
      })
    );
    expect(obligation.error).toBeNull();
    expect((obligation.data as Execution).execution_price).toBeLessThan(0);

    const option = await db.rpc(
      "execute_trade",
      trade({
        p_market_id: src,
        p_counter_market_id: sink,
        p_instrument: "PTP_OPTION",
      })
    );
    // Retired (0039): in ERCOT's day-ahead market PTP options are held only by
    // NOIEs, and an entry at max(DA spread, 0) = $0 bought real-time
    // congestion optionality for nothing.
    expect(String(option.error?.message)).toContain("INSTRUMENT_NOT_TRADABLE");
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
