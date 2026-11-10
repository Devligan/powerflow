import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, dbTestsEnabled } from "@/lib/testing/db";
import { runMarketDataIngestion } from "@/lib/ingestion";

/**
 * Market-data gap fill, against the real database and the REAL ERCOT MIS
 * adapter.
 *
 * Ingestion used to resume from a *single* `from` per product — the maximum
 * last-known delivery timestamp across every market. So as soon as one market
 * was current, every lagging market was dragged up to that same point and its
 * own gap was never fetched. The gap persisted silently, because the run also
 * reported zero rows inserted (it summed `count`, which PostgREST always
 * returns as null, instead of the rows actually written) and counted every
 * remaining row as skipped.
 *
 * There is no synthetic data in this suite: PowerFlow runs on actual ERCOT
 * data. The test inflicts a controlled gap — it deletes one market's hourly
 * series for the last day, exactly what a feed outage looks like — and
 * requires the REAL adapter to restore it from ERCOT's own MIS reports,
 * byte for byte under the observation key. Restoration from ERCOT is the
 * assertion: nothing else can rebuild actual market data.
 */
describe.skipIf(!dbTestsEnabled())("market-data gap fill (live database)", () => {
  const PRODUCT = "RTM_HOURLY";
  const BEHIND = "LZ_WEST";
  const LEADER = "HB_NORTH";

  /**
   * `ingestion_runs` is the one row this suite creates that has no user behind
   * it, so the teardown in `@/lib/testing/setup.ts` cannot reach it — an
   * ingestion run belongs to the job, not to an account. It is removed here
   * instead, by everything the run started at or after this suite began.
   */
  let suiteStartedAt: string;

  beforeAll(() => {
    suiteStartedAt = new Date().toISOString();
  });

  afterAll(async () => {
    if (!suiteStartedAt) return;
    const { error } = await admin()
      .from("ingestion_runs")
      .delete()
      .gte("started_at", suiteStartedAt);
    // A failed cleanup must be visible: these rows accumulate on every run
    // otherwise, which is the whole reason for doing this.
    if (error) throw new Error(`could not delete this suite's ingestion_runs: ${error.message}`);
  }, 120_000);

  const marketId = async (point: string) => {
    const { data } = await admin()
      .from("markets")
      .select("id")
      .eq("settlement_point", point)
      .single();
    return data!.id as string;
  };
  const latestFor = async (id: string) => {
    const { data } = await admin()
      .from("market_prices")
      .select("delivery_timestamp")
      .eq("market_id", id)
      .eq("product", PRODUCT)
      .order("delivery_timestamp", { ascending: false })
      .limit(1);
    return (data?.[0]?.delivery_timestamp as string | undefined) ?? null;
  };

  it("backfills the lagging series from actual ERCOT MIS reports", async () => {
    const db = admin();
    const behindId = await marketId(BEHIND);
    const leaderId = await marketId(LEADER);

    // Converge first (bounded): both series must stand at the same horizon
    // before the test inflicts its controlled gap, so the assertion measures
    // gap fill rather than ordinary catch-up. Catch-up may take more than
    // one bounded run on a slow day.
    let leaderBefore = await latestFor(leaderId);
    let behindBefore = await latestFor(behindId);
    for (let i = 0; i < 6 && leaderBefore !== behindBefore; i++) {
      const result = await runMarketDataIngestion();
      expect(result.failed).toBe(false);
      expect(result.error).toBeUndefined();
      leaderBefore = await latestFor(leaderId);
      behindBefore = await latestFor(behindId);
    }
    expect(leaderBefore).toBeTruthy();
    expect(behindBefore).toBeTruthy();
    expect(leaderBefore).toBe(behindBefore); // both current to the same horizon

    // Roll the lagging series back a day, as a feed that missed it. These
    // are actual ERCOT rows being removed; the adapter must win them back.
    // Distinct INTERVALS are the unit of restoration, not rows: a window can
    // hold two vintages of one interval (an ERCOT correction), which deletes
    // N rows but needs only N−1 observations back — the store keeps the
    // latest publication per interval, by design.
    //
    // A fresh database holds under a day of this series, so the series' oldest
    // row always survives. Lagging means the series has a cursor to resume from;
    // with none at all, ingestion reaches back only a fixed overlap from now, and
    // an hour at its edge drops out if the clock crosses the hour mid-suite.
    const { data: oldest } = await db
      .from("market_prices")
      .select("delivery_timestamp")
      .eq("market_id", behindId)
      .eq("product", PRODUCT)
      .order("delivery_timestamp", { ascending: true })
      .limit(1);
    const rollBackTo = new Date(
      Math.max(
        new Date(behindBefore!).getTime() - 24 * 3600_000,
        new Date(oldest![0].delivery_timestamp as string).getTime()
      )
    ).toISOString();
    const { data: doomed, error: selErr } = await db
      .from("market_prices")
      .select("delivery_timestamp")
      .eq("market_id", behindId)
      .eq("product", PRODUCT)
      .gt("delivery_timestamp", rollBackTo);
    expect(selErr).toBeNull();
    const doomedIntervals = new Set(doomed!.map((r) => r.delivery_timestamp as string));
    expect(doomedIntervals.size).toBeGreaterThan(0);
    const { count: removed, error: delErr } = await db
      .from("market_prices")
      .delete({ count: "exact" })
      .eq("market_id", behindId)
      .eq("product", PRODUCT)
      .gt("delivery_timestamp", rollBackTo);
    expect(delErr).toBeNull();
    expect(removed).toBe(doomed!.length);

    const behindStranded = await latestFor(behindId);
    expect(new Date(behindStranded!).getTime()).toBeLessThan(new Date(leaderBefore!).getTime());

    // Ingest with the production configuration (the real ERCOT MIS adapter).
    // A single global resume point would fetch nothing here, because it
    // would start after the leader's last interval.
    const result = await runMarketDataIngestion();
    expect(result.failed).toBe(false);
    expect(result.error).toBeUndefined();

    // The counters must describe what happened. Summing `count` reported 0
    // inserted for every run while writing thousands of rows.
    expect(result.recordsInserted).toBeGreaterThanOrEqual(doomedIntervals.size);
    expect(result.recordsDeferred).toBe(0);
    expect(result.truncated).toBe(false);

    // And the gap is gone — restored from ERCOT itself. Every restored row
    // must carry the ERCOT source: nothing synthetic may creep into the
    // series, and the horizon converges with the untouched leader.
    const { data: restored } = await db
      .from("market_prices")
      .select("source")
      .eq("market_id", behindId)
      .eq("product", PRODUCT)
      .gt("delivery_timestamp", rollBackTo)
      .lte("delivery_timestamp", behindBefore!);
    expect(restored!.length).toBeGreaterThanOrEqual(doomedIntervals.size);
    expect(restored!.every((r) => r.source === "ERCOT_MIS")).toBe(true);

    const leaderAfter = await latestFor(leaderId);
    let caught = await latestFor(behindId);
    for (let i = 0; i < 5 && caught !== leaderAfter; i++) {
      const again = await runMarketDataIngestion();
      expect(again.failed).toBe(false);
      caught = await latestFor(behindId);
    }
    expect(caught).toBe(leaderAfter);
  }, 480_000);
});
