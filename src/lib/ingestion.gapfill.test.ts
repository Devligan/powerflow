import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, dbTestsEnabled } from "@/lib/testing/db";
import { runMarketDataIngestion } from "@/lib/ingestion";

/**
 * Market-data gap fill, against the real database.
 *
 * Ingestion used to resume from a *single* `from` per product — the maximum
 * last-known delivery timestamp across every market. So as soon as one market
 * was current, every lagging market was dragged up to that same point and its
 * own gap was never fetched. The gap persisted silently, because the run also
 * reported zero rows inserted (it summed `count`, which PostgREST always
 * returns as null, instead of the rows actually written) and counted every
 * remaining row as skipped.
 *
 * The series used here is deliberately one no other test trades, since this
 * deletes real price rows. The source is deterministic per interval, so
 * re-ingestion restores exactly the rows removed.
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

  it("backfills the lagging series rather than moving it to the leader's position", async () => {
    const db = admin();
    const behindId = await marketId(BEHIND);
    const leaderId = await marketId(LEADER);

    const leaderBefore = await latestFor(leaderId);
    const behindBefore = await latestFor(behindId);
    expect(leaderBefore).toBeTruthy();
    expect(behindBefore).toBeTruthy();
    expect(leaderBefore).toBe(behindBefore); // both current to the same horizon

    // Roll the lagging series back a day, as a feed that missed it.
    const rollBackTo = new Date(new Date(behindBefore!).getTime() - 24 * 3600_000).toISOString();
    const { count: removed, error: delErr } = await db
      .from("market_prices")
      .delete({ count: "exact" })
      .eq("market_id", behindId)
      .eq("product", PRODUCT)
      .gt("delivery_timestamp", rollBackTo);
    expect(delErr).toBeNull();
    expect(removed).toBeGreaterThan(0);

    const behindStranded = await latestFor(behindId);
    expect(new Date(behindStranded!).getTime()).toBeLessThan(new Date(leaderBefore!).getTime());

    // Ingest. A single global resume point would fetch nothing here, because it
    // would start after the leader's last interval.
    const result = await runMarketDataIngestion();
    expect(result.failed).toBe(false);
    expect(result.error).toBeUndefined();

    // The counters must describe what happened. Summing `count` reported 0
    // inserted for every run while writing thousands of rows.
    expect(result.recordsInserted).toBeGreaterThanOrEqual(removed!);
    expect(result.recordsDeferred).toBe(0);
    expect(result.truncated).toBe(false);

    // And the gap is gone: the lagging series is back to the horizon every
    // other market is at. Compare against the leader *after* the run, not
    // before it: the simulated feed's horizon rolls forward with wall-clock
    // time, so an absolute timestamp here is a clock-dependent flake. The
    // invariant the fix is responsible for is "this series ends where the
    // others end", which is exactly what `leaderAfter` measures.
    const behindAfter = await latestFor(behindId);
    const leaderAfter = await latestFor(leaderId);
    expect(new Date(behindAfter!).getTime()).toBeGreaterThan(
      new Date(behindStranded!).getTime()
    );
    expect(behindAfter).toBe(leaderAfter);
  }, 120_000);
});
