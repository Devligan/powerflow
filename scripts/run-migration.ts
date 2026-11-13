import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Client } from "pg";

/**
 * Migration runner for environments without the Supabase CLI, with a ledger.
 *
 * Opens a direct Postgres connection to the project (session pooler) using
 * SUPABASE_DB_PASSWORD and executes each SQL file as ONE batch, so $$-quoted
 * function bodies with embedded semicolons survive intact. Each file runs in a
 * transaction together with its row in ops.applied_migrations, so the ledger
 * says exactly what took effect, and "what does production have?" is a query.
 *
 * Forward only. A file already in the ledger is refused: re-running a
 * superseded migration re-creates the overloads a later one replaced (0033
 * had to drop a stale execute_trade that way). So is a file while an earlier
 * one is still pending.
 *
 * Run:
 *   npx tsx scripts/run-migration.ts supabase/migrations/0048_x.sql [more.sql ...]
 *   npx tsx scripts/run-migration.ts --dry-run <files...>  apply in one transaction, report, roll back
 *   npx tsx scripts/run-migration.ts --status [--check]    applied / pending / changed (--check: exit 1 unless all applied)
 *   npx tsx scripts/run-migration.ts --baseline 0047       record 0001..0047 as already applied; runs nothing
 */

const MIGRATIONS = "supabase/migrations";

(function loadEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = match[2];
      }
      // Also overwrite when the ambient value is EMPTY (common with a
      // placeholder line in .env) — an empty token must not shadow the real one.
      if (match && match[1] in process.env && process.env[match[1]] === "") {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // rely on ambient environment
  }
})();

type Migration = { version: string; name: string; path: string; sql: string; checksum: string };
type LedgerRow = { version: string; checksum: string; applied_at: Date };

function readMigration(path: string): Migration {
  const name = basename(path);
  const version = name.match(/^(\d{4})_/)?.[1];
  if (!version) {
    throw new Error(`${path}: not a migration (expected NNNN_name.sql)`);
  }
  const sql = readFileSync(path, "utf8");
  if (!sql.trim()) {
    throw new Error(`${path} is empty`);
  }
  // A Windows checkout has CRLF and maybe a BOM; the ledger must agree with CI's.
  const normalized = sql.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  return { version, name, path, sql, checksum: createHash("sha256").update(normalized).digest("hex") };
}

function allMigrations(): Migration[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readMigration(join(MIGRATIONS, name)));
}

const LEDGER_DDL = `
  create schema if not exists ops;
  revoke all on schema ops from public, anon, authenticated;
  create table if not exists ops.applied_migrations (
    version    text primary key,
    name       text not null,
    checksum   text not null,
    applied_at timestamptz not null default now(),
    applied_by text not null default current_user
  );
  revoke all on ops.applied_migrations from public, anon, authenticated;
`;

async function readLedger(client: Client): Promise<Map<string, LedgerRow>> {
  const { rows } = await client.query<{ exists: boolean }>(
    "select to_regclass('ops.applied_migrations') is not null as exists",
  );
  if (!rows[0].exists) {
    return new Map();
  }
  const ledger = await client.query<LedgerRow>("select version, checksum, applied_at from ops.applied_migrations");
  return new Map(ledger.rows.map((r) => [r.version, r]));
}

async function record(client: Client, m: Migration) {
  await client.query("insert into ops.applied_migrations (version, name, checksum) values ($1, $2, $3)", [
    m.version,
    m.name,
    m.checksum,
  ]);
}

async function status(client: Client, check: boolean) {
  const ledger = await readLedger(client);
  if (ledger.size === 0) {
    console.log("[migration] no ledger yet: run --baseline <last applied version> once");
  }
  let outstanding = 0;
  for (const m of allMigrations()) {
    const row = ledger.get(m.version);
    if (!row) {
      outstanding++;
      console.log(`PENDING  ${m.name}`);
    } else if (row.checksum !== m.checksum) {
      outstanding++;
      console.log(`CHANGED  ${m.name} (file differs from what was applied ${row.applied_at.toISOString()})`);
    } else {
      console.log(`applied  ${m.name}  ${row.applied_at.toISOString()}`);
    }
  }
  if (check && outstanding > 0) {
    process.exitCode = 1;
  }
}

async function baseline(client: Client, through: string) {
  const all = allMigrations();
  if (!all.some((m) => m.version === through)) {
    throw new Error(`--baseline ${through}: no such migration`);
  }
  await client.query("begin");
  try {
    await client.query(LEDGER_DDL);
    const ledger = await readLedger(client);
    for (const m of all.filter((m) => m.version <= through && !ledger.has(m.version))) {
      await record(client, m);
      console.log(`[migration] recorded as applied: ${m.name}`);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

async function apply(client: Client, paths: string[], dryRun: boolean) {
  const requested = paths.map(readMigration).sort((a, b) => a.version.localeCompare(b.version));
  const ledger = await readLedger(client);
  const wanted = new Set(requested.map((m) => m.version));

  for (const m of requested) {
    if (ledger.has(m.version)) {
      throw new Error(`${m.name} is already applied (${ledger.get(m.version)!.applied_at.toISOString()}); migrations run forward only`);
    }
    const earlier = allMigrations().filter((e) => e.version < m.version && !ledger.has(e.version) && !wanted.has(e.version));
    if (earlier.length > 0) {
      throw new Error(
        `${m.name}: earlier migrations are pending (${earlier.map((e) => e.name).join(", ")})` +
          (ledger.size === 0 ? "; if production already has them, run --baseline first" : ""),
      );
    }
  }

  if (dryRun) {
    // One transaction for all of them, so each sees the ones before it.
    await client.query("begin");
    try {
      await client.query(LEDGER_DDL);
      for (const m of requested) {
        const t = Date.now();
        await client.query(m.sql);
        await record(client, m);
        console.log(`[migration] applied (uncommitted): ${m.name} in ${Date.now() - t} ms`);
      }
      // Since 0046 a session may call exactly eight functions, and anon none.
      const { rows } = await client.query(`
        select count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')) as authenticated_functions,
               count(*) filter (where has_function_privilege('anon', p.oid, 'execute')) as anon_functions
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`);
      console.log("[migration] after:", rows[0]);
    } finally {
      await client.query("rollback");
      console.log("[migration] DRY RUN: rolled back, nothing committed");
    }
    return;
  }

  for (const m of requested) {
    await client.query("begin");
    try {
      await client.query(LEDGER_DDL);
      await client.query(m.sql);
      await record(client, m);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw new Error(`${m.name}: ${e instanceof Error ? e.message : e} (rolled back)`);
    }
    console.log(`[migration] OK: ${m.path}`);
  }
  // PostgREST (Supabase's REST layer) caches the schema; DDL that creates
  // or replaces functions is invisible to the API until it reloads.
  await client.query("notify pgrst, 'reload schema'");
  // The reload is asynchronous; give it a beat before the runner exits,
  // so a test run straight after does not race the cache refresh.
  await new Promise((r) => setTimeout(r, 1500));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const dryRun = flag("--dry-run");
  const showStatus = flag("--status");
  const check = flag("--check");
  const baselineAt = args.indexOf("--baseline");
  const through = baselineAt >= 0 ? args.splice(baselineAt, 2)[1] : undefined;
  if (!showStatus && !through && args.length === 0) {
    console.error("usage: tsx scripts/run-migration.ts [--dry-run] <migration.sql ...> | --status [--check] | --baseline NNNN");
    process.exit(2);
  }

  const password = process.env.SUPABASE_DB_PASSWORD;
  // The project ref usually ships in the public URL (https://<ref>.supabase.co);
  // accept either source.
  const ref =
    process.env.SUPABASE_PROJECT_REF ||
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!password || !ref) {
    throw new Error("SUPABASE_DB_PASSWORD plus SUPABASE_PROJECT_REF (or NEXT_PUBLIC_SUPABASE_URL) must be set");
  }

  const client = new Client({
    host: "aws-0-us-west-2.pooler.supabase.com",
    port: 5432,
    user: `postgres.${ref}`,
    password,
    database: "postgres",
    // Managed Postgres terminates idle connections; a short-lived migration
    // client does not need keepalives, only explicit statement timeout.
    statement_timeout: 120_000,
    ssl: { rejectUnauthorized: false },
  });
  // A migration reports what it found (a backfill's count, a first audit's
  // result) with RAISE NOTICE, so a dry run shows it before anything is kept.
  client.on("notice", (n) => console.log(`[migration] notice: ${n.message}`));
  await client.connect();
  try {
    if (showStatus) {
      await status(client, check);
    } else if (through) {
      await baseline(client, through);
    } else {
      await apply(client, args, dryRun);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[migration] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
