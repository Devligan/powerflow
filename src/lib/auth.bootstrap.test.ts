import { describe, expect, it } from "vitest";
import { admin, createTestUser, dbTestsEnabled, markLedgerStaged } from "@/lib/testing/db";
import { ensureUserRecords } from "@/lib/auth";

/**
 * Account bootstrap, against the real database.
 *
 * The bug this pins: `ensureUserRecords` called the RPC with `_user_id` and
 * `_email` while the SQL function is declared `(p_user_id, p_email)`. PostgREST
 * resolves an RPC by argument name, so the call failed with "function not
 * found" on every sign-in — and both call sites swallowed it with
 * `.catch(() => {})`, so nothing anywhere said so.
 *
 * A unit test with a mocked client would have passed against the typo. This
 * calls the real function.
 */
describe.skipIf(!dbTestsEnabled())("account bootstrap (live database)", () => {
  it("creates the profile and paper account for a user that has none", async () => {
    const user = await createTestUser("bootstrap");
    const db = admin();

    // The signup trigger creates them; remove them so this user looks like one
    // that predates the trigger (or whose trigger run failed).
    await db.from("paper_accounts").delete().eq("user_id", user.id);
    await db.from("profiles").delete().eq("id", user.id);
    const { data: gone } = await db.from("paper_accounts").select("id").eq("user_id", user.id);
    expect(gone).toEqual([]);

    // The real path, exactly as sign-in calls it.
    await ensureUserRecords({ id: user.id, email: user.email } as never);

    const { data: account } = await db
      .from("paper_accounts")
      .select("starting_cash, cash_balance, max_gross_notional")
      .eq("user_id", user.id)
      .single();
    expect(account).toBeTruthy();
    expect(Number(account!.starting_cash)).toBe(100000);
    expect(Number(account!.cash_balance)).toBe(100000);

    const { data: profile } = await db
      .from("profiles")
      .select("id, username")
      .eq("id", user.id)
      .single();
    expect(profile?.id).toBe(user.id);
    expect(profile?.username).toBeTruthy();
  });

  it("is idempotent and never resets a funded account", async () => {
    const user = await createTestUser("bootstrap-idem");
    const db = admin();

    // Spend some cash, then bootstrap again: the account must not be reset.
    markLedgerStaged(user.id);
    await db.from("paper_accounts").update({ cash_balance: 12345.67 }).eq("user_id", user.id);
    await ensureUserRecords({ id: user.id, email: user.email } as never);
    await ensureUserRecords({ id: user.id, email: user.email } as never);

    const { data: accounts } = await db
      .from("paper_accounts")
      .select("cash_balance")
      .eq("user_id", user.id);
    expect(accounts).toHaveLength(1);
    expect(Number(accounts![0].cash_balance)).toBe(12345.67);
  });
});
