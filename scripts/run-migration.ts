import { readFileSync } from "node:fs";
import { Client } from "pg";

/**
 * Minimal migration runner for environments without the Supabase CLI.
 *
 * Opens a direct Postgres connection to the project (session pooler) using
 * SUPABASE_DB_PASSWORD and executes the whole SQL file as ONE batch, so
 * $$-quoted function bodies with embedded semicolons survive intact.
 * Migrations are idempotent by construction (drop/create or replace, add
 * column if not exists), so a re-run is safe.
 *
 * Run:  npx tsx scripts/run-migration.ts supabase/migrations/0020_simulation_clock_and_price_revisions.sql
 */

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

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx scripts/run-migration.ts <path/to/migration.sql>");
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
  const sql = readFileSync(file, "utf8");
  if (!sql.trim()) {
    throw new Error(`${file} is empty`);
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
  await client.connect();
  try {
    await client.query(sql);
    // PostgREST (Supabase's REST layer) caches the schema; DDL that creates
    // or replaces functions is invisible to the API until it reloads.
    await client.query("notify pgrst, 'reload schema'");
    // The reload is asynchronous; give it a beat before the runner exits,
    // so a test run straight after does not race the cache refresh.
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`[migration] OK: ${file}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[migration] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
