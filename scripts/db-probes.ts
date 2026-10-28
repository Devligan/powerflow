import { readFileSync } from "node:fs";
import { Client } from "pg";

// Tiny .env-aware SQL query CLI for the live database (diagnostics).
for (const line of readFileSync(".env", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ||= m[2];
}

const ref =
  process.env.SUPABASE_PROJECT_REF ||
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!ref) throw new Error("SUPABASE project ref unknown; set SUPABASE_PROJECT_REF or NEXT_PUBLIC_SUPABASE_URL");
const user = `postgres.${ref}`;
const client = new Client({
  host: "aws-0-us-west-2.pooler.supabase.com",
  port: 5432,
  user,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: "postgres",
  ssl: { rejectUnauthorized: false },
});

async function go() {
  await client.connect();
  try {
    for (const sql of [
      // Most recent final observation per (market, product), by publication.
      `select mp.market_id,
              m.settlement_point,
              mp.product,
              mp.delivery_timestamp,
              mp.published_at,
              mp.is_final,
              mp.source
       from public.market_prices mp
       join public.markets m on m.id = mp.market_id
       where mp.is_final
       order by mp.published_at desc
       limit 12;`,
      // Oldest (by delivery) gap per product, relative to now UTC.
      `select mp.product,
              min(mp.delivery_timestamp)::timestamptz as oldest_delivery_utc,
              now()::timestamptz as now_utc,
              extract(epoch from (now() - min(mp.delivery_timestamp)))::int as seconds_behind
       from public.market_prices mp
       where mp.product in ('DAM_HOURLY', 'RTM_HOURLY', 'RTM_15MIN')
       group by mp.product
       order by mp.product;`,
      // Newest RTM_15MIN interval (the feed's freshness signal the cron uses).
      `select mp.product,
              mp.delivery_timestamp,
              mp.published_at,
              mp.source,
              extract(epoch from (now() - mp.delivery_timestamp))::int as seconds_since_start
       from public.market_prices mp
       where mp.product = 'RTM_15MIN'
       order by mp.delivery_timestamp desc
       limit 1;`,
      // Open (unfinished) ingestion runs older than 4 hours, if any.
      `select id, source, status, records_received, records_inserted, records_skipped,
              started_at, finished_at
       from public.ingestion_runs
       where finished_at is null
         and started_at < (now() - interval '4 hours')::timestamptz
       order by started_at desc;`,
    ]) {
      const res = await client.query(sql);
      console.log("\n----SQL----");
      console.log(sql.trim());
      console.table(res.rows ?? []);
    }
  } finally {
    await client.end();
  }
}

go().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  }
);
