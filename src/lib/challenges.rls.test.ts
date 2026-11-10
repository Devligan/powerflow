import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";
import { buildWindow } from "@/lib/challenge-schedule";

/**
 * Challenges (0049): the rules that make it a contest, attacked through the
 * entrant's own session — the credentials a browser holds. A challenge desk's
 * clock moves only forward and only inside the challenge; it bids only on the
 * challenge's days; a finished entry is closed; nobody else may act for it.
 *
 * The days are the fixture's (2026-09-20 onward). The one bid placed rests in
 * the book and is cancelled when the entry finishes, so no price is read or
 * written and the suite claims no market.
 */
describe.skipIf(!dbTestsEnabled())("challenges: the rules of the contest (live database)", () => {
  const FIRST_DAY = "2026-09-21";
  const LAST_DAY = "2026-09-22";
  const window = buildWindow(FIRST_DAY, 2)!;
  const iso = (ms: number) => new Date(ms).toISOString();

  let db: SupabaseClient;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let stranger: Awaited<ReturnType<typeof createTestUser>>;
  let ownerClient: SupabaseClient;
  let strangerClient: SupabaseClient;
  let challengeId: string;
  let deskUserId: string;
  let marketId: string;

  async function enter(userId: string): Promise<{ error: { message: string } | null; deskUserId?: string }> {
    const { data, error } = await db.auth.admin.createUser({
      email: `desk-${crypto.randomUUID()}@desks.powerflow.invalid`,
      email_confirm: true,
      app_metadata: { desk: true },
    });
    expect(error).toBeNull();
    const id = data.user!.id;
    const { error: enterError } = await db.rpc("enter_challenge", {
      p_owner_id: userId,
      p_challenge_id: challengeId,
      p_desk_user_id: id,
    });
    if (enterError) await db.auth.admin.deleteUser(id);
    return { error: enterError, deskUserId: enterError ? undefined : id };
  }

  const simNow = async () => {
    const { data } = await db.rpc("sim_now", { p_user_id: deskUserId });
    return Date.parse(data as string);
  };

  const bid = (client: SupabaseClient, deliveryStartMs: number) =>
    client.rpc("place_limit_order", {
      p_user_id: deskUserId,
      p_market_id: marketId,
      p_instrument: "VIRTUAL",
      p_product: "DAM_HOURLY",
      p_counter_market_id: null,
      p_side: "BUY",
      p_quantity_mwh: 1,
      p_limit_price: null,
      p_delivery_start: iso(deliveryStartMs),
      p_delivery_end: iso(deliveryStartMs + 3_600_000),
    });

  beforeAll(async () => {
    db = admin();
    owner = await createTestUser("challenge-owner");
    stranger = await createTestUser("challenge-stranger");
    [ownerClient, strangerClient] = await Promise.all([userClient(owner), userClient(stranger)]);

    const { data: market } = await db.from("markets").select("id").eq("active", true).limit(1).single();
    marketId = market!.id as string;

    const { data: challenge, error } = await db
      .from("challenges")
      .insert({
        slug: Math.random().toString(36).slice(2, 10).padEnd(8, "x").replace(/[^a-z0-9]/g, "x"),
        title: "Suite challenge",
        first_day: FIRST_DAY,
        last_day: LAST_DAY,
        starts_at: iso(window.startsAt),
        finishes_at: iso(window.finishesAt),
        created_by: owner.id,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    challengeId = challenge!.id as string;

    const entered = await enter(owner.id);
    expect(entered.error).toBeNull();
    deskUserId = entered.deskUserId!;
  }, 120_000);

  // The challenge outlives its users (created_by is set null), so it is removed
  // here; the entries and desks go with the users in the shared teardown.
  afterAll(async () => {
    if (challengeId) await db.from("challenges").delete().eq("id", challengeId);
  });

  it("starts the entrant's desk at the challenge's start, with a fresh $100,000", async () => {
    expect(Math.abs((await simNow()) - window.startsAt)).toBeLessThan(60_000);
    const { data } = await db.from("paper_accounts").select("cash_balance").eq("user_id", deskUserId).single();
    expect(Number(data!.cash_balance)).toBe(100000);
  });

  it("does not let anyone enter twice, or anyone else act for the desk", async () => {
    const again = await enter(owner.id);
    expect(again.error?.message).toContain("CHALLENGE_ALREADY_ENTERED");
    const { error } = await strangerClient.rpc("set_sim_clock", { p_user_id: deskUserId, p_iso: iso(window.moves[1].at) });
    expect(error?.message).toContain("FORBIDDEN");
    const { error: bidError } = await bid(strangerClient, Date.parse("2026-09-21T15:00:00Z"));
    expect(bidError?.message).toContain("FORBIDDEN");
  });

  it("bids only on the challenge's own operating days", async () => {
    const { error: outside } = await bid(ownerClient, Date.parse("2026-09-25T15:00:00Z"));
    expect(outside?.message).toContain("CHALLENGE_DAY_OUTSIDE");
    // 2026-09-21 HE10 (09:00 Central): inside the challenge, before its deadline.
    const { error: inside } = await bid(ownerClient, Date.parse("2026-09-21T14:00:00Z"));
    expect(inside).toBeNull();
  });

  it("moves the clock forward only, never past the finish, never back to live", async () => {
    const { error: forward } = await ownerClient.rpc("set_sim_clock", { p_user_id: deskUserId, p_iso: iso(window.moves[1].at) });
    expect(forward).toBeNull();
    const { error: back } = await ownerClient.rpc("set_sim_clock", { p_user_id: deskUserId, p_iso: iso(window.startsAt) });
    expect(back?.message).toContain("CHALLENGE_CLOCK_FORWARD_ONLY");
    const { error: past } = await ownerClient.rpc("set_sim_clock", { p_user_id: deskUserId, p_iso: iso(window.finishesAt + 3_600_000) });
    expect(past?.message).toContain("CHALLENGE_CLOCK_PAST_END");
    const { error: live } = await ownerClient.rpc("clear_sim_clock", { p_user_id: deskUserId });
    expect(live?.message).toContain("CHALLENGE_DESK_REPLAY_ONLY");
  });

  it("finishes at the last day's final prices, records the result and closes the entry", async () => {
    const { data: advanced, error } = await db.rpc("challenge_advance_to_finish", { p_owner_id: owner.id, p_challenge_id: challengeId });
    expect(error).toBeNull();
    expect(advanced).toBe(deskUserId);
    expect(Math.abs((await simNow()) - window.finishesAt)).toBeLessThan(60_000);

    const { data: result, error: recordError } = await db.rpc("challenge_record_result", { p_owner_id: owner.id, p_challenge_id: challengeId });
    expect(recordError).toBeNull();
    expect(Number((result as { equity: number }).equity)).toBeGreaterThan(0);

    const { data: entry } = await db
      .from("challenge_entries")
      .select("status, final_equity, pnl, finished_at")
      .eq("challenge_id", challengeId)
      .eq("user_id", owner.id)
      .single();
    expect(entry!.status).toBe("FINISHED");
    expect(entry!.finished_at).not.toBeNull();
    expect(Number(entry!.pnl)).toBe(Number(entry!.final_equity) - 100000);

    // The resting bid could no longer change the result, so it was withdrawn.
    const { data: open } = await db.from("paper_orders").select("id").eq("user_id", deskUserId).eq("status", "OPEN");
    expect(open ?? []).toHaveLength(0);

    const { error: clockAfter } = await ownerClient.rpc("set_sim_clock", { p_user_id: deskUserId, p_iso: iso(window.finishesAt) });
    expect(clockAfter?.message).toContain("CHALLENGE_FINISHED");
    const { error: bidAfter } = await bid(ownerClient, Date.parse("2026-09-22T14:00:00Z"));
    expect(bidAfter?.message).toContain("CHALLENGE_FINISHED");
    const { error: twice } = await db.rpc("challenge_record_result", { p_owner_id: owner.id, p_challenge_id: challengeId });
    expect(twice?.message).toContain("CHALLENGE_ENTRY_NOT_ACTIVE");
  });

  it("keeps challenges and entries away from sessions", async () => {
    const { data } = await strangerClient.from("challenge_entries").select("user_id");
    expect(data ?? []).toHaveLength(0);
    const { error } = await strangerClient.rpc("enter_challenge", {
      p_owner_id: stranger.id,
      p_challenge_id: challengeId,
      p_desk_user_id: stranger.id,
    });
    expect(error).not.toBeNull();
  });
});
