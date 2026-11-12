/**
 * The practice desk end to end on a deployed site, through its own HTTP API:
 * switch to practice, run a past operating day (bid, clearing, delivery,
 * settle), check the recap never shows real time before delivery, and that
 * the live account is untouched. A throwaway @powerflow.test user is created
 * and deleted (its desk and books go with it).
 *
 *   npx tsx scripts/e2e/practice.ts [https://powerflow-two.vercel.app]
 *
 * Needs SUPABASE_DB_PASSWORD and the project URL/anon key from .env.
 */
import { createTestUser, db, deleteTestUser, type Loose } from "./db";
import { checklist, he18, signIn } from "./session";

const SITE = process.argv[2] ?? "https://powerflow-two.vercel.app";
const { check, report } = checklist();

async function main() {
  const pg = await db();
  const { id: userId, email, password } = await createTestUser(pg, "desk-e2e");
  try {
    const call = await signIn(SITE, email, password);

    const before = await call("GET", "/api/portfolio");
    check("live portfolio reads", before.status === 200, `${before.status}`);

    const sw = await call("PUT", "/api/desk", { desk: "PRACTICE" });
    check("switch to practice desk", sw.status === 200 && sw.json?.active?.kind === "PRACTICE", `${sw.status} ${sw.text.slice(0, 120)}`);

    const p0 = await call("GET", "/api/practice");
    const day: string | undefined = p0.json?.days?.[0];
    check("practice days offered", p0.status === 200 && !!day, `${p0.status} first=${day}`);
    if (!day) return;

    const s1 = await call("POST", "/api/practice", { day, step: "bid" });
    check("step 1: open bidding", s1.status === 200 && s1.json?.reached === "bid", `${s1.status} clock=${s1.json?.clock?.now}`);

    const mk = await call("GET", "/api/markets");
    const north = (mk.json?.markets ?? []).find((m: Loose) => (m.settlementPoint ?? m.settlement_point) === "HB_NORTH");
    const t = he18(day);
    const order = await call("POST", "/api/orders", {
      marketId: north?.id, instrument: "VIRTUAL", product: "DAM_HOURLY", side: "BUY", quantityMwh: "2",
      deliveryStart: new Date(t).toISOString(), deliveryEnd: new Date(t + 3_600_000).toISOString(),
    });
    check("bid accepted on the practice desk", order.status === 201, `${order.status} ${order.text.slice(0, 160)}`);

    const s2 = await call("POST", "/api/practice", { day, step: "clearing" });
    const orders = await call("GET", "/api/orders");
    check("step 2: bid filled at the clearing", s2.status === 200 && orders.json?.orders?.[0]?.status === "FILLED", `${orders.json?.orders?.[0]?.status}`);

    const r2 = await call("GET", "/api/practice/recap?point=HB_NORTH");
    check(
      "recap after the clearing: day-ahead, and no real time yet",
      r2.status === 200 && r2.json?.hours?.length >= 23 && r2.json?.hours.every((h: Loose) => h.da != null && h.rt == null) && r2.json?.bestDec == null,
      `${r2.status} hours=${r2.json?.hours?.length} priced=${r2.json?.priced}`,
    );

    const s3 = await call("POST", "/api/practice", { day, step: "delivery" });
    const r3 = await call("GET", "/api/practice/recap?point=HB_NORTH");
    check(
      "recap after delivery: real time in, best hours named",
      r3.status === 200 && r3.json?.priced >= 23 && (r3.json?.bestDec != null || r3.json?.bestInc != null),
      `priced=${r3.json?.priced} bestDec=${JSON.stringify(r3.json?.bestDec)} bestInc=${JSON.stringify(r3.json?.bestInc)}`,
    );
    check("step 3: delivered and marked", s3.status === 200 && s3.json?.reached === "delivery", `open=${s3.json?.results?.unrealizedPnl}`);

    const s4 = await call("POST", "/api/practice", { day, step: "settle" });
    check("step 4: settled", s4.status === 200 && s4.json?.results?.settled === 1, `realized=${s4.json?.results?.realizedPnl} settled=${s4.json?.results?.settled}`);

    await call("PUT", "/api/desk", { desk: "LIVE" });
    const after = await call("GET", "/api/portfolio");
    const { rows: [liveAccount] } = await pg.query("select cash_balance, sim_clock_offset, replay_tainted_at from public.paper_accounts where user_id = $1", [userId]);
    check(
      "live account untouched",
      after.status === 200 && Number(liveAccount.cash_balance) === 100000 && Number(liveAccount.sim_clock_offset) === 0 && liveAccount.replay_tainted_at === null,
      `cash=${liveAccount.cash_balance} offset=${liveAccount.sim_clock_offset} tainted=${liveAccount.replay_tainted_at}`,
    );
  } finally {
    const { desksLeft } = await deleteTestUser(pg, userId);
    check("cleanup: user and desks deleted", desksLeft === 0, `${desksLeft} desk account(s) left`);
    await pg.end();
  }
}

main()
  .catch((e) => check("ran", false, e instanceof Error ? e.message : String(e)))
  .finally(report);
