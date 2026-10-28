import { readFileSync } from "node:fs";
import { Client } from "pg";

for (const line of readFileSync(".env", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ||= m[2];
}

async function run(sql: string, label: string): Promise<void> {
  const ref =
    process.env.SUPABASE_PROJECT_REF ||
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  const client = new Client({
    host: "aws-0-us-west-2.pooler.supabase.com",
    port: 5432,
    user: `postgres.${ref}`,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const res = await client.query(sql);
    console.log(`\n=== ${label} ===`);
    console.table(res.rows ?? []);
  } finally {
    await client.end();
  }
}

async function main() {
  const queries = [
    [
      "last_published_any",
      `select m.settlement_point,
             max(mp.published_at) as latest_pub_at,
             count(*) filter (where mp.product = 'DAM_HOURLY')  as dam_rows,
             count(*) filter (where mp.product = 'RTM_HOURLY') as rtm_hourly_rows,
             count(*) filter (where mp.product = 'RTM_15MIN')   as rtm15_rows
        from market_prices mp
        join markets m on m.id = mp.market_id
       where m.active
         and mp.product in ('DAM_HOURLY','RTM_HOURLY','RTM_15MIN')
       group by m.settlement_point
       order by latest_pub_at asc nulls last, m.settlement_point`,
    ],
    [
      "dam_head",
      `select m.settlement_point,
             mp.delivery_timestamp,
             mp.price,
             mp.source,
             mp.published_at,
             mp.is_final
        from market_prices mp
        join markets m on m.id = mp.market_id
       where mp.product = 'DAM_HOURLY'
       order by mp.published_at desc nulls last, m.settlement_point
       limit 20`,
    ],
    [
      "rtm_hourly_head",
      `select m.settlement_point,
             mp.delivery_timestamp,
             mp.price,
             mp.source,
             mp.published_at,
             mp.is_final
        from market_prices mp
        join markets m on m.id = mp.market_id
       where mp.product = 'RTM_HOURLY'
       order by mp.published_at desc nulls last, m.settlement_point
       limit 20`,
    ],
    [
      "rtm_15min_head",
      `select m.settlement_point,
             mp.delivery_timestamp,
             mp.price,
             mp.source,
             mp.published_at,
             mp.is_final
        from market_prices mp
        join markets m on m.id = mp.market_id
       where mp.product = 'RTM_15MIN'
       order by mp.published_at desc nulls last, m.settlement_point
       limit 10`,
    ],
    [
      "ingestion_summary",
      `select source,
             status,
             records_inserted,
             started_at,
             finished_at,
             detail::text
        from ingestion_runs
       order by finished_at desc nulls last, started_at desc
       limit 8`,
    ],
    [
      "open_txns",
      `select pid,
             state,
             backend_start::text,
             xact_start::text,
             query::text
        from pg_stat_activity
       where pid <> pg_backend_pid()
         and state is distinct from 'idle'
       order by xact_start nulls first
       limit 20`,
    ],
    [
      "idle_in_xact_aged",
      `select pid,
             state,
             backend_start::text,
             xact_start::text,
             age(now(), xact_start) as xact_age,
             query::text
        from pg_stat_activity
       where pid <> pg_backend_pid()
         and state = 'idle in transaction'
         and xact_start < now() - interval '5 minutes'
       order by xact_start`,
    ],
  ];

  for (const [label, sqlText] of queries) {
    try {
      await run(sqlText, label);
    } catch (e: any) {
      console.error(`\n!!! ${label} failed:`, e?.message ?? e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
