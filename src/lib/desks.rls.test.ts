import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser, dbTestsEnabled, userClient } from "@/lib/testing/db";

/**
 * Desks (0048), attacked rather than read.
 *
 * A desk is an engine account its owner's session may act for. The boundary
 * that matters is that nobody else's may: a second trader, holding the same
 * credentials a browser holds, tries every caller-checked function against the
 * first trader's practice desk. The owner's own calls are the control.
 *
 * Nothing here prices or fills an order, so the suite claims no market.
 */
describe.skipIf(!dbTestsEnabled())("desks: who may act for an account (live database)", () => {
  let db: SupabaseClient;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let stranger: Awaited<ReturnType<typeof createTestUser>>;
  let ownerClient: SupabaseClient;
  let strangerClient: SupabaseClient;
  let deskId: string;
  let deskUserId: string;

  /** What src/lib/desk.ts does: an Auth user, registered to its owner. */
  async function makeDesk(ownerId: string): Promise<{ id: string; userId: string }> {
    const { data, error } = await db.auth.admin.createUser({
      email: `desk-${crypto.randomUUID()}@desks.powerflow.invalid`,
      email_confirm: true,
      app_metadata: { desk: true },
    });
    expect(error).toBeNull();
    const userId = data.user!.id;
    const { data: id, error: regError } = await db.rpc("register_desk", {
      p_owner_id: ownerId,
      p_desk_user_id: userId,
      p_kind: "PRACTICE",
    });
    expect(regError).toBeNull();
    return { id: id as string, userId };
  }

  beforeAll(async () => {
    db = admin();
    owner = await createTestUser("desk-owner");
    stranger = await createTestUser("desk-stranger");
    [ownerClient, strangerClient] = await Promise.all([userClient(owner), userClient(stranger)]);
    const desk = await makeDesk(owner.id);
    deskId = desk.id;
    deskUserId = desk.userId;
  }, 120_000);

  it("bootstraps a desk as a real account that stays off the standings", async () => {
    const [{ data: account }, { data: profile }] = await Promise.all([
      db.from("paper_accounts").select("cash_balance").eq("user_id", deskUserId).single(),
      db.from("profiles").select("leaderboard_opt_in, onboarded_at").eq("id", deskUserId).single(),
    ]);
    expect(Number(account!.cash_balance)).toBe(100000);
    expect(profile!.leaderboard_opt_in).toBe(false);
    expect(profile!.onboarded_at).toBeNull();
  });

  it("lets the owner's session act for the desk, but not move its clock (0055)", async () => {
    const { error: marginError } = await ownerClient.rpc("account_margin", { p_user_id: deskUserId });
    expect(marginError).toBeNull();
    const { error: marksError } = await ownerClient.rpc("position_marks", { p_user_id: deskUserId });
    expect(marksError).toBeNull();
    // Clocks are moved by the service role only, for anyone's account.
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    for (const [fn, args] of [
      ["set_sim_clock", { p_user_id: deskUserId, p_iso: past }],
      ["clear_sim_clock", { p_user_id: deskUserId }],
    ] as const) {
      const { error } = await ownerClient.rpc(fn, args);
      expect(error?.message, fn).toMatch(/permission denied/i);
    }
  });

  it("refuses every caller-checked function to anyone else's session", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["account_margin", { p_user_id: deskUserId }],
      ["position_marks", { p_user_id: deskUserId }],
      ["cancel_order", { p_user_id: deskUserId, p_order_id: crypto.randomUUID() }],
      [
        "place_limit_order",
        {
          p_user_id: deskUserId,
          p_market_id: crypto.randomUUID(),
          p_instrument: "VIRTUAL",
          p_product: "DAM_HOURLY",
          p_counter_market_id: null,
          p_side: "BUY",
          p_quantity_mwh: 1,
          p_limit_price: null,
          p_delivery_start: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          p_delivery_end: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString(),
        },
      ],
    ];
    for (const [fn, args] of calls) {
      const { error } = await strangerClient.rpc(fn, args);
      expect(error?.message, fn).toContain("FORBIDDEN");
    }
    // The control: the desk's clock is where the owner left it.
    const { data } = await db.from("paper_accounts").select("sim_clock_offset").eq("user_id", deskUserId).single();
    expect(Number(data!.sim_clock_offset)).toBe(0);
  });

  it("keeps the desks table and registration away from sessions", async () => {
    const { data: rows } = await strangerClient.from("desks").select("id");
    expect(rows ?? []).toHaveLength(0);
    const { data: ownRows } = await ownerClient.from("desks").select("id");
    expect(ownRows ?? []).toHaveLength(0);
    const { error } = await strangerClient.rpc("register_desk", {
      p_owner_id: stranger.id,
      p_desk_user_id: deskUserId,
      p_kind: "PRACTICE",
    });
    expect(error).not.toBeNull();
  });

  it("does not let a desk own desks, or a trader have two practice desks", async () => {
    const { error: nested } = await db.from("desks").insert({
      owner_id: deskUserId,
      desk_user_id: stranger.id,
      kind: "PRACTICE",
    });
    expect(nested?.message).toMatch(/DESK_CANNOT_OWN_DESKS|DESK_USER_INVALID/);

    const { data, error } = await db.auth.admin.createUser({
      email: `desk-${crypto.randomUUID()}@desks.powerflow.invalid`,
      email_confirm: true,
    });
    expect(error).toBeNull();
    const { error: second } = await db.rpc("register_desk", {
      p_owner_id: owner.id,
      p_desk_user_id: data.user!.id,
      p_kind: "PRACTICE",
    });
    expect(second).not.toBeNull();
    await db.auth.admin.deleteUser(data.user!.id);
  });

  it("deletes the desk's account with its row, and every desk with its owner", async () => {
    // A second owner's desk, deleted by removing the owner.
    const leaver = await createTestUser("desk-leaver");
    const leaverDesk = await makeDesk(leaver.id);
    const { error: deleteOwner } = await db.auth.admin.deleteUser(leaver.id);
    expect(deleteOwner).toBeNull();
    const { data: leaverAccount } = await db
      .from("paper_accounts")
      .select("id")
      .eq("user_id", leaverDesk.userId)
      .maybeSingle();
    expect(leaverAccount).toBeNull();

    // The owner's own desk, reset by deleting its row.
    const { error: deleteRow } = await db.from("desks").delete().eq("id", deskId);
    expect(deleteRow).toBeNull();
    const { data: deskAccount } = await db
      .from("paper_accounts")
      .select("id")
      .eq("user_id", deskUserId)
      .maybeSingle();
    expect(deskAccount).toBeNull();
    const { data: ownerAccount } = await db.from("paper_accounts").select("id").eq("user_id", owner.id).single();
    expect(ownerAccount).not.toBeNull();
  });
});
