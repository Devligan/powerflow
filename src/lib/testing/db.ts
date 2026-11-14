import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Support for the database-backed test suites.
 *
 * Those suites exercise the *real* path — the live Postgres functions, not the
 * TypeScript mirror of them — because the money moves in SQL. They are opt-in,
 * because they create real users and rows in whatever project `.env` points at:
 *
 *   npm run test:db
 *
 * That is `RUN_DB_TESTS=1 npm test` with the flag set in Node, so it works from
 * PowerShell and cmd as well as bash (see `scripts/test-db.ts`). Without the
 * flag they skip, so the default `npm test` stays offline and safe.
 */

let envLoaded = false;

/**
 * Vitest does not run Next's env loader, so the server keys are absent from
 * `process.env` unless read from the file. Same minimal loader the seed script
 * uses; never overwrites a value already present.
 */
export function loadTestEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = match[2].replace(/\r$/, "");
      }
    }
  } catch {
    // No .env — rely on the ambient environment.
  }
}

/** Whether the database-backed suites should run at all. */
export function dbTestsEnabled(): boolean {
  loadTestEnv();
  return (
    process.env.RUN_DB_TESTS === "1" &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

/**
 * Users created in this test file, so they can be removed again.
 *
 * Every row a suite writes hangs off one of these: `profiles`,
 * `paper_accounts`, `trades`, `positions` and `audit_events` all reference
 * `auth.users` with ON DELETE CASCADE, so removing the user removes the whole
 * footprint. One module instance per test file, and the teardown hook in
 * `./setup.ts` drains it, which is why nothing has to remember to clean up.
 */
const createdUsers: TestUser[] = [];

/** The users this test file has created so far. */
export function createdTestUsers(): readonly TestUser[] {
  return createdUsers;
}

/**
 * Create a confirmed user through the GoTrue admin API — the same entry point
 * as signup, so the `on_auth_user_created` trigger runs and a fresh account is
 * bootstrapped exactly as a real user's would be.
 *
 * Addresses are namespaced under powerflow.test, and the user is registered for
 * teardown by `cleanupTestUsers()`. An earlier version left them behind on
 * purpose; the cost was that every run of `npm run test:db` permanently added
 * accounts, positions and trades to the project the tests point at, with
 * nothing in the suite ever removing them.
 */
export async function createTestUser(prefix: string): Promise<TestUser> {
  loadTestEnv();
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  // A real password, however short-lived the account: from the CSPRNG.
  const email = `${prefix}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}@powerflow.test`;
  const password = `Audit-${crypto.randomUUID()}!1`;

  const res = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = (await res.json()) as { id?: string; msg?: string };
  if (!res.ok || !body.id) {
    throw new Error(`could not create test user: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  const user: TestUser = { id: body.id, email, password };
  createdUsers.push(user);
  return user;
}

/**
 * A test account that may replay: registered as the practice desk (0048) of
 * a throwaway owner. Since 0053 only a desk's clock may leave live, and the
 * engine suites replay history on purpose. The account's own session still
 * acts for it, so nothing else about the suite changes; deleting either user
 * removes both (the desk row cascades to its user).
 */
export async function createReplayTestUser(prefix: string): Promise<TestUser> {
  const user = await createTestUser(prefix);
  const owner = await createTestUser(`${prefix}-owner`);
  const { error } = await admin()
    .from("desks")
    .insert({ owner_id: owner.id, desk_user_id: user.id, kind: "PRACTICE" });
  if (error) throw new Error(`could not make ${prefix} a practice desk: ${error.message}`);
  return user;
}

export function admin() {
  loadTestEnv();
  return supabaseAdmin();
}

/**
 * Accounts whose books a suite wrote by hand — a cash balance set as a fixture,
 * a position or fill inserted directly — so they no longer follow from the
 * engine's own movements and are left out of the teardown reconciliation.
 */
const stagedLedgers = new Set<string>();

/**
 * Exempt an account from the teardown reconciliation. Call it where a fixture
 * writes money state outside the engine (the platform has no deposit path, so
 * "the member's cash is X" can only be staged); everything the engine does to
 * every other account is still reconciled.
 */
export function markLedgerStaged(userId: string): void {
  stagedLedgers.add(userId);
}

/**
 * The 0054 reconciliation, over the accounts this file created and did not
 * stage: whatever a suite drove the engine through, cash must still follow from
 * the fills, positions from their trades, and bids from their fills. Read
 * before teardown, raised after it, so a failure never leaks users.
 */
async function reconcileTestLedgers(userIds: string[]): Promise<string | null> {
  const ids = userIds.filter((id) => !stagedLedgers.has(id));
  if (ids.length === 0) return null;
  const { data, error } = await supabaseAdmin().rpc("ledger_violations", { p_user_ids: ids });
  if (error) return `ledger reconciliation could not run: ${error.message}`;
  const rows = (data ?? []) as Array<{ check_name: string; user_id: string; detail: unknown }>;
  if (rows.length === 0) return null;
  return (
    `the ledger does not reconcile for ${rows.length} row(s) this suite left behind:\n  ` +
    rows.map((r) => `${r.check_name} ${r.user_id} ${JSON.stringify(r.detail)}`).join("\n  ")
  );
}

/**
 * Delete every test user this file created, so the database is left as found.
 * The cascade takes their account, positions, fills and audit history with it.
 * First, every unstaged account is reconciled (see `reconcileTestLedgers`).
 *
 * Deletion is retried on the auth service's rate limit for the same reason
 * sign-in is: many files tear down at once. Anything still undeleted is named
 * in the error rather than left as a silent leak — residue is precisely the
 * failure this exists to prevent, and a warning nobody reads would not.
 */
export async function cleanupTestUsers(): Promise<void> {
  const pending = createdUsers.splice(0);
  if (pending.length === 0) return;

  loadTestEnv();
  const db = supabaseAdmin();
  const unreconciled = await reconcileTestLedgers(pending.map((u) => u.id));
  const failures: string[] = [];

  for (const user of pending) {
    let lastError = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(300 * 2 ** attempt); // 600ms, 1.2s, 2.4s
      const { error } = await db.auth.admin.deleteUser(user.id);
      if (!error) {
        lastError = "";
        break;
      }
      // Already absent is the outcome we wanted. A suite may have deleted the
      // user itself (the immutability suite tears an account down on purpose),
      // and a retry can see a user an earlier attempt removed.
      if (error.status === 404 || /not found/i.test(error.message)) {
        lastError = "";
        break;
      }
      lastError = error.message;
      if (!RATE_LIMITED.test(error.message)) break;
    }
    if (lastError) failures.push(`${user.email} (${user.id}): ${lastError}`);
  }

  if (failures.length > 0) {
    throw new Error(
      `could not delete ${failures.length} test user(s); they are still in the database ` +
        `and must be removed by hand:\n  ${failures.join("\n  ")}`
    );
  }
  if (unreconciled) throw new Error(unreconciled);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Supabase rate-limits its auth endpoint. Every database suite signs in its own
 * users and vitest runs the files in parallel, so a full run bursts past that
 * limit and fails with "Request rate limit reached" — a constraint of the auth
 * service, not a defect in what is under test. Only that error is retried, with
 * backoff; any other sign-in failure is raised on the first attempt so a real
 * broken credential is not hidden behind retries.
 */
const RATE_LIMITED = /rate limit/i;

/**
 * A client authenticated as the user, using the anon key — the same
 * (authenticated role) credentials the app's server client uses. This is what
 * makes the tests exercise `auth.uid()` inside the SECURITY DEFINER RPC rather
 * than the service role's bypass.
 */
export async function userClient(user: TestUser): Promise<SupabaseClient> {
  loadTestEnv();
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt); // 1s, 2s, 4s, 8s
    const { error } = await client.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    });
    if (!error) return client;
    lastError = error.message;
    if (!RATE_LIMITED.test(error.message)) break;
  }
  throw new Error(`could not sign in test user: ${lastError}`);
}
