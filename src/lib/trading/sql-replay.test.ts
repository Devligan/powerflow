import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";

/**
 * Historical replay, against the real database, on ACTUAL ERCOT data.
 *
 * This is the test the whole architecture exists for: an operating day of
 * real ERCOT MIS observations (fixture built by scripts/build-history-fixture.ts
 * from reports 12331/12301 — each row carries ERCOT's own publication
 * instant) is ingested through the same observation key production uses,
 * a paper desk is moved onto the historical clock, and the full lifecycle
 * runs: entry on the day-ahead leg → look-ahead refusals → marks that move
 * only when ERCOT actually published → settlement at the final value →
 * a revision that revises without destroying.
 *
 * Every expected price is read from the fixture, never hand-written: the
 * test asserts the engine against ERCOT's numbers, not against a copy of
 * itself. Opt in with `RUN_DB_TESTS=1`.
 */

interface FixtureObs {
  settlementPoint: string;
  product: string;
  deliveryTimestamp: string;
  deliveryEnd?: string;
  price: string;
  publishedAt: string;
  isFinal?: boolean;
}

const FIXTURE = "fixtures/ercot/replay-2026-09-20.json";
const POINT = "HB_NORTH";
/** Production observation key: re-ingesting the corpus is a no-op. */
const OBS_KEY = "market_id,product,delivery_timestamp,published_at";

describe.skipIf(!dbTestsEnabled())("historical replay on actual ERCOT data (live database)", () => {
  let db: SupabaseClient;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: SupabaseClient;
  let marketId: string;
  let startingCash: number;

  // The fixture, indexed the way the engine sees it.
  let dam: Map<string, FixtureObs>; // delivery hour start -> day-ahead observation
  let rtHour: Map<string, FixtureObs>; // delivery hour start -> hourly final
  let rt15: Map<string, FixtureObs>; // interval start -> 15-minute print
  let hour: string; // the hour under test (chosen where print ≠ final)
  let hourEnd: string;
  /** The clock instants of the replay, all derived from ERCOT's publications. */
  let tOpen: string; // after the DAM posts, before delivery day
  let tMid: string; // mid-hour, only the first 15-minute print exists
  let tFinal: string; // just after ERCOT posts the hourly final
  let tSettle: string; // after delivery, position due

  /** Revision rows this suite published (§18), removed at teardown. */
  const revisionIds: string[] = [];
  /** This run's start instant: the teardown sweep horizon. */
  let suiteStartedAt = new Date().toISOString();

  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

  const num = (v: unknown) => Number(v);

  const cash = async (): Promise<number> => {
    const { data } = await db.from("paper_accounts").select("cash_balance").eq("user_id", user.id).single();
    return num(data!.cash_balance);
  };
  const starting = async (): Promise<number> => {
    const { data } = await db.from("paper_accounts").select("starting_cash").eq("user_id", user.id).single();
    return num(data!.starting_cash);
  };
  const position = async (start: string) => {
    const { data } = await db
      .from("positions")
      .select("id, quantity_mwh, average_entry_price, realized_pnl, settled_at")
      .eq("user_id", user.id)
      .eq("market_id", marketId)
      .eq("delivery_start", start)
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.id as string,
      qty: num(data.quantity_mwh),
      avg: num(data.average_entry_price),
      realized: num(data.realized_pnl),
      settledAt: data.settled_at as string | null,
    };
  };
  /** The desk's mark for a position, through the authenticated client. */
  const markFor = async (positionId: string): Promise<{ price: number; asOf: string } | null> => {
    const { data, error } = await client.rpc("position_marks", { p_user_id: user.id });
    expect(error).toBeNull();
    const row = (data as Array<{ position_id: string; mark_price: string | number; mark_timestamp: string }>).find(
      (m) => m.position_id === positionId
    );
    return row ? { price: num(row.mark_price), asOf: row.mark_timestamp } : null;
  };
  const setClock = async (iso: string) => {
    const { error } = await client.rpc("set_sim_clock", { p_user_id: user.id, p_iso: iso });
    expect(error).toBeNull();
  };
  const trade = (over: Record<string, unknown> = {}) => ({
    p_user_id: user.id,
    p_market_id: marketId,
    p_counter_market_id: null,
    p_instrument: "VIRTUAL",
    p_product: "DAM_HOURLY",
    p_side: "BUY",
    p_quantity_mwh: 10,
    // Delivery defaults: PostgREST matches the function overload on the
    // parameter SET it receives, so omitting these entirely fails overload
    // resolution even though SQL-level defaults exist.
    p_delivery_start: hour,
    p_delivery_end: hourEnd,
    p_client_order_id: crypto.randomUUID(),
    ...over,
  });

  beforeAll(async () => {
    suiteStartedAt = new Date().toISOString();
    db = admin();
    user = await createTestUser("sql-replay");
    client = await userClient(user);

    const corpus = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      meta?: { source?: string };
      markets?: Array<{ settlementPoint: string; settlementPointType: string; description?: string }>;
      observations: FixtureObs[];
    };
    const source = corpus.meta?.source ?? "ERCOT_MIS_HISTORY";

    // The settlement point: an existing catalog row keeps its identity
    // (lookup-before-write, exactly as the history loader does).
    const { data: existingMarket } = await db
      .from("markets")
      .select("id")
      .eq("settlement_point", POINT)
      .maybeSingle();
    if (existingMarket) {
      marketId = existingMarket.id as string;
    } else {
      const m = corpus.markets!.find((m) => m.settlementPoint === POINT)!;
      const { data, error } = await db
        .from("markets")
        .upsert(
          {
            settlement_point: m.settlementPoint,
            settlement_point_type: m.settlementPointType,
            description: m.description ?? null,
            active: true,
          },
          { onConflict: "settlement_point" }
        )
        .select("id")
        .single();
      expect(error).toBeNull();
      marketId = data!.id as string;
    }

    // Ingest this point's observations through the production path's key.
    const venueOf: Record<string, string> = { DAM_HOURLY: "DAM", RTM_HOURLY: "RTM", RTM_15MIN: "RTM" };
    const rows = corpus.observations.filter((o) => o.settlementPoint === POINT);
    expect(rows.length).toBeGreaterThan(100);
    const { error: ingestError } = await db.from("market_prices").upsert(
      rows.map((o) => ({
        market_id: marketId,
        product: o.product,
        delivery_timestamp: o.deliveryTimestamp,
        delivery_end: o.deliveryEnd ?? null,
        price: o.price,
        venue: venueOf[o.product],
        source,
        source_timestamp: o.publishedAt,
        published_at: o.publishedAt,
        is_final: o.isFinal ?? false,
      })),
      { onConflict: OBS_KEY, ignoreDuplicates: true }
    );
    expect(ingestError).toBeNull();

    dam = new Map();
    rtHour = new Map();
    rt15 = new Map();
    for (const o of rows) {
      if (o.product === "DAM_HOURLY") dam.set(o.deliveryTimestamp, o);
      else if (o.product === "RTM_HOURLY") rtHour.set(o.deliveryTimestamp, o);
      else if (o.product === "RTM_15MIN") rt15.set(o.deliveryTimestamp, o);
    }
    expect(dam.size).toBe(24);
    expect(rtHour.size).toBe(24);
    expect(rt15.size).toBe(96);

    // The hour under test: the first hour whose 15-minute print disagrees
    // with the hourly final by a visible margin, so "the mark is the print,
    // not the final" cannot pass by coincidence. The NEXT hour must also be
    // fully covered (DAM + final + print): the revision test trades and
    // settles hour+1, and the fixture ends at the day's last interval.
    hour = "";
    for (const [start, fin] of rtHour) {
      const next = new Date(new Date(start).getTime() + 3_600_000).toISOString();
      const print = rt15.get(start);
      if (
        print &&
        Math.abs(num(print.price) - num(fin.price)) > 0.5 &&
        dam.has(next) &&
        rtHour.has(next) &&
        rt15.has(next)
      ) {
        hour = start;
        break;
      }
    }
    expect(hour).not.toBe("");
    hourEnd = new Date(new Date(hour).getTime() + 3_600_000).toISOString();

    const dayAhead = dam.get(hour)!;
    const fin = rtHour.get(hour)!;
    const print = rt15.get(hour)!;
    // ERCOT's own timeline drives the clock:
    //   day-ahead posts D-1 ~17:35Z  → open the desk 15 minutes later
    //   15-minute print ~17 min into the interval → look at the book 1 min after
    //   hourly final ~62 min after the hour starts → mark after +3 min
    tOpen = new Date(new Date(dayAhead.publishedAt).getTime() + 15 * 60_000).toISOString();
    tMid = new Date(new Date(print.publishedAt).getTime() + 60_000).toISOString();
    tFinal = new Date(new Date(fin.publishedAt).getTime() + 3 * 60_000).toISOString();
    tSettle = new Date(new Date(fin.publishedAt).getTime() + 5 * 60_000).toISOString();

    await setClock(tOpen);
    startingCash = await starting();
  }, 180_000);

  // Remove this suite's revisions; the original observations were never
  // edited, so the series is restored exactly as it was found. This suite's
  // rows are actual-ERCOT-source, so the sweep keys on this run's start
  // instant alone.
  afterAll(async () => {
    await db
      .from("market_prices")
      .delete()
      .eq("market_id", marketId)
      .eq("product", "RTM_HOURLY")
      .gte("published_at", suiteStartedAt);
    for (const id of revisionIds) {
      await db.from("market_prices").delete().eq("id", id);
    }
  }, 60_000);

  it("fills a virtual position at the actual day-ahead price ERCOT published", async () => {
    const dayAhead = num(dam.get(hour)!.price);
    const { data, error } = await db.rpc("execute_trade", trade());
    expect(error).toBeNull();
    expect((data as { trade_id: string }).trade_id).toBeTruthy();

    const pos = (await position(hour))!;
    expect(pos.qty).toBe(10);
    near(pos.avg, dayAhead); // entry = the DA leg, from the fixture
    near(await cash(), startingCash); // margined (0041): opening moves no cash
    expect(pos.realized).toBe(0);
    expect(pos.settledAt).toBeNull();
  }, 60_000);

  it("refuses a fill whose observation exists but is not yet published", async () => {
    // The property that guards against look-ahead: a row PRESENT in the
    // store does not fill a position unless its publication instant has
    // passed the clock. The RT hourly final for `hour` IS in the database
    // (delivered with the fixture) but ERCOT publishes it only after the
    // hour completes — the RT series is reference-only now (0025), so the
    // engine-level property is exercised on the ORDERABLE series: an hour
    // with no observation at all except one whose publication stamp lies
    // in the future must be refused rather than filled from it.
    await setClock(tMid);
    expect(new Date(tMid) < new Date(rtHour.get(hour)!.publishedAt)).toBe(true);

    const { error: rtError } = await db.rpc(
      "execute_trade",
      trade({
        p_instrument: "ENERGY_SPOT",
        p_product: "RTM_HOURLY",
        p_delivery_start: hour,
        p_delivery_end: hourEnd,
      })
    );
    expect(rtError).toBeTruthy();
    expect(rtError!.message).toContain("PRODUCT_NOT_TRADABLE");

    // A delivery hour beyond every published DAM day (fixture day + 3),
    // carrying exactly one observation — publication one hour AFTER the
    // clock. Delivery is legitimately in the future, so the only thing
    // between the trader and this fill is the publication gate.
    const futureHour = new Date(new Date(tMid).getTime() + 72 * 3600_000);
    futureHour.setUTCMinutes(0, 0, 0);
    const futureHourEnd = new Date(futureHour.getTime() + 3600_000).toISOString();
    const futurePub = new Date(new Date(tMid).getTime() + 3600_000).toISOString();
    const { data: rev, error: revErr } = await db
      .from("market_prices")
      .insert({
        market_id: marketId,
        product: "DAM_HOURLY",
        delivery_timestamp: futureHour.toISOString(),
        delivery_end: futureHourEnd,
        price: "99.99",
        venue: "DAM",
        source: "ERCOT_MIS_HISTORY",
        source_timestamp: futurePub,
        published_at: futurePub,
        is_final: true,
      })
      .select("id")
      .single();
    expect(revErr).toBeNull();
    revisionIds.push(rev!.id as string);

    const { error } = await db.rpc(
      "execute_trade",
      trade({
        p_instrument: "ENERGY_SPOT",
        p_product: "DAM_HOURLY",
        p_delivery_start: futureHour.toISOString(),
        p_delivery_end: futureHourEnd,
      })
    );
    expect(error).toBeTruthy();
    expect(error!.message).toContain("PRICE_UNAVAILABLE");
  }, 60_000);

  it("marks mid-hour at the newest 15-minute print, never the unpublished final", async () => {
    const pos = (await position(hour))!;
    const print = num(rt15.get(hour)!.price);
    const fin = num(rtHour.get(hour)!.price);
    expect(Math.abs(print - fin)).toBeGreaterThan(0.5); // the discrimination is real

    const mark = await markFor(pos.id);
    expect(mark).not.toBeNull();
    near(mark!.price, print); // actual ERCOT print of THIS hour
    expect(Math.abs(mark!.price - fin)).toBeGreaterThan(0.5); // ...not the future final
    expect(new Date(mark!.asOf) <= new Date(tMid)).toBe(true); // provenance predates the clock
  }, 60_000);

  it("moves the mark only when ERCOT actually publishes the hourly final", async () => {
    await setClock(tFinal);
    const pos = (await position(hour))!;
    const fin = num(rtHour.get(hour)!.price);
    const dayAhead = num(dam.get(hour)!.price);

    const mark = await markFor(pos.id);
    near(mark!.price, fin); // the same position, repriced by a real publication

    // Full decomposition on real data: equity − starting cash = realized +
    // unrealized. A margined position is worth its P&L (0041), so cash is
    // still the starting balance and the whole result is the mark's move.
    near(await cash(), startingCash);
    near(10 * (mark!.price - dayAhead), 10 * (fin - dayAhead));
  }, 60_000);

  it("settles at the actual final price with exact realized P&L", async () => {
    const { error } = await db.rpc("settle_delivered_positions", {
      p_as_of: tSettle,
      p_user_id: user.id,
    });
    expect(error).toBeNull();

    const dayAhead = num(dam.get(hour)!.price);
    const fin = num(rtHour.get(hour)!.price);

    const pos = (await position(hour))!;
    expect(pos.qty).toBe(0);
    near(pos.realized, 10 * (fin - dayAhead)); // the DA→RT convergence, realized once
    expect(pos.settledAt).not.toBeNull();
    near(await cash(), startingCash + 10 * (fin - dayAhead)); // settlement pays the P&L only (0041)

    // The settlement trade cites the final value as its execution price.
    const { data: settled } = await db
      .from("trades")
      .select("id, status, execution_price, side")
      .eq("user_id", user.id)
      .eq("status", "SETTLED")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    expect(settled).not.toBeNull();
    near(num(settled!.execution_price), fin);
    expect(settled!.side).toBe("SELL"); // closing a long
  }, 60_000);

  it("applies an ERCOT price revision without destroying the original observation", async () => {
    // A second hour, traded before ERCOT's final posts: entry is the DA leg.
    const hour2 = new Date(new Date(hour).getTime() + 3_600_000).toISOString();
    const hour2End = new Date(new Date(hour2).getTime() + 3_600_000).toISOString();
    const dayAhead2 = num(dam.get(hour2)!.price);
    const fin2 = rtHour.get(hour2)!;
    const revised = num(fin2.price) + 4.25;

    // Open before the hour starts: nothing trades once delivery has (0037).
    const tOpen2 = new Date(new Date(hour2).getTime() - 20 * 60_000).toISOString();
    await setClock(tOpen2);
    const { error: openError } = await db.rpc(
      "execute_trade",
      trade({ p_quantity_mwh: 5, p_delivery_start: hour2, p_delivery_end: hour2End })
    );
    expect(openError).toBeNull();
    const pos = (await position(hour2))!;
    near(pos.avg, dayAhead2);

    // Publish the original final, then ERCOT "corrects" it: a NEW observation
    // at a later publication instant — the original row is never touched.
    await setClock(new Date(new Date(fin2.publishedAt).getTime() + 60_000).toISOString());
    const { data: rev, error: revError } = await db
      .from("market_prices")
      .insert({
        market_id: marketId,
        product: "RTM_HOURLY",
        delivery_timestamp: hour2,
        delivery_end: hour2End,
        price: String(revised),
        venue: "RTM",
        source: "ERCOT_MIS_HISTORY",
        source_timestamp: new Date(new Date(fin2.publishedAt).getTime() + 30 * 60_000).toISOString(),
        published_at: new Date(new Date(fin2.publishedAt).getTime() + 30 * 60_000).toISOString(),
        is_final: true,
      })
      .select("id")
      .single();
    expect(revError).toBeNull();
    revisionIds.push(rev!.id as string);

    // Mark resolves the revision once it is published.
    await setClock(new Date(new Date(fin2.publishedAt).getTime() + 31 * 60_000).toISOString());
    const mark = await markFor(pos.id);
    near(mark!.price, revised);

    // Two final observations of the same interval coexist: original + correction.
    // Scoped to the fixture's source: the live gateway also publishes this
    // interval's archive vintages under ERCOT_MIS, and those are real rows
    // too — the store is an append-only observation log, not per-source.
    const { count } = await db
      .from("market_prices")
      .select("id", { count: "exact", head: true })
      .eq("market_id", marketId)
      .eq("product", "RTM_HOURLY")
      .eq("delivery_timestamp", hour2)
      .eq("is_final", true)
      .eq("source", "ERCOT_MIS_HISTORY");
    expect(count).toBe(2);

    // Settlement uses the revised value — the latest publication.
    const { error: settleError } = await db.rpc("settle_delivered_positions", {
      p_as_of: new Date(new Date(fin2.publishedAt).getTime() + 32 * 60_000).toISOString(),
      p_user_id: user.id,
    });
    expect(settleError).toBeNull();
    const settled = (await position(hour2))!;
    expect(settled.qty).toBe(0);
    near(settled.realized, 5 * (revised - dayAhead2));
  }, 60_000);

  it("keeps a live-mode account sealed off from the replayed market", async () => {
    // A second desk, clock untouched (live mode), cannot trade the replayed
    // day: the intervals are in ITS past and no publication is "current" for
    // it. Same database, same rows, different clock, different market.
    const other = await createTestUser("sql-replay-live");
    const otherClient = await userClient(other);

    const { error } = await otherClient.rpc("execute_trade", {
      p_user_id: other.id,
      p_market_id: marketId,
      p_counter_market_id: null,
      p_instrument: "VIRTUAL",
      p_product: "DAM_HOURLY",
      p_side: "BUY",
      p_quantity_mwh: 1,
      p_delivery_start: hour,
      p_delivery_end: hourEnd,
      p_client_order_id: crypto.randomUUID(),
    });
    expect(error).toBeTruthy();

    // And its clock is the wall clock, not the replay desk's.
    const { data: now2 } = await otherClient.rpc("sim_now", { p_user_id: other.id });
    const { data: now1 } = await client.rpc("sim_now", { p_user_id: user.id });
    expect(Math.abs(new Date(now2 as string).getTime() - Date.now())).toBeLessThan(30_000);
    expect(new Date(now1 as string).getTime()).toBeLessThan(
      new Date(now2 as string).getTime() - 20 * 3_600_000
    );
  }, 60_000);
});
