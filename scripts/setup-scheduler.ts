import "dotenv/config";
import { readFileSync } from "node:fs";
import { Client } from "pg";

/**
 * One-time scheduler setup: `npx tsx scripts/setup-scheduler.ts [site-url]`.
 *
 * Applies migration 0029 (pg_cron + pg_net jobs that call the cron routes),
 * then stores the two values those jobs read from Supabase Vault:
 *   powerflow_app_url      the deployed site (argument, else NEXT_PUBLIC_APP_URL)
 *   powerflow_cron_secret  CRON_SECRET from .env — must equal the one in Vercel
 * Re-running is safe: the migration is idempotent and existing secrets are
 * updated in place. Neither value is printed.
 */
async function main() {
  const url = process.argv[2] ?? process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.CRON_SECRET;
  const ref =
    process.env.SUPABASE_PROJECT_REF ||
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!url || !secret || !ref || !process.env.SUPABASE_DB_PASSWORD) {
    throw new Error("needs a site URL, CRON_SECRET, SUPABASE_DB_PASSWORD and the project ref in .env");
  }

  const db = new Client({
    host: "aws-0-us-west-2.pooler.supabase.com",
    port: 5432,
    user: `postgres.${ref}`,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  try {
    await db.query(readFileSync("supabase/migrations/0029_pg_cron_schedule.sql", "utf8"));
    console.log("[scheduler] migration 0029 applied");

    for (const [name, value] of [
      ["powerflow_app_url", url.replace(/\/$/, "")],
      ["powerflow_cron_secret", secret],
    ]) {
      const existing = await db.query("select id from vault.secrets where name = $1", [name]);
      if (existing.rows[0]) {
        await db.query("select vault.update_secret($1, $2)", [existing.rows[0].id, value]);
      } else {
        await db.query("select vault.create_secret($1, $2)", [value, name]);
      }
      console.log(`[scheduler] vault secret ${name} ${existing.rows[0] ? "updated" : "created"}`);
    }

    const jobs = await db.query("select jobname, schedule, active from cron.job where jobname like 'powerflow-%' order by 1");
    console.table(jobs.rows);
    console.log("[scheduler] first ingest fires at the next :03/:18/:33/:48; responses land in net._http_response");
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("[scheduler] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
