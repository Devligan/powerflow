import "dotenv/config";
import { getAdminClient } from "../src/lib/supabase/admin";

type Row = Record<string, unknown>;

async function go() {
  const s = getAdminClient();
  const stmts = [
    `select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'market_prices'
    order by ordinal_position;`,
    `select setlement_point, delivery_timestamp, product, price, source, published_at, is_final
    from public.market_prices
    limit 3;`,
  ];
  for (const sql of stmts) {
    const { error, data } = await s.rpc("__sql", { sql }) as { error: { message: string } | null; data: Row[] | null };
    console.log("\n----SQL----");
    console.log(sql.trim());
    if (error) {
      console.error("error:", error.message);
    } else {
      console.log(data ? data.length + " rows" : "no rows");
      if (data) {
        for (const r of data.slice(0, 3)) {
          console.log("  ", r);
        }
      }
    }
  }
}

go().catch((e) => { console.error(e); process.exit(1); });
