/**
 * A challenge end to end on a deployed site, through its own HTTP API:
 * create a one-day challenge, check its page and preview as a signed-out
 * friend sees them, enter, bid, be refused outside the challenge and on a
 * backward clock, run the clearing, finish and rank — live account untouched.
 * A throwaway @powerflow.test user is created and deleted, with its desk and
 * the challenge.
 *
 *   npx tsx scripts/e2e/challenge.ts [https://powerflow-two.vercel.app]
 *
 * Needs SUPABASE_DB_PASSWORD and the project URL/anon key from .env.
 */
import { createTestUser, db, deleteTestUser, type Loose } from "./db";
import { checklist, he18, signIn } from "./session";

const SITE = process.argv[2] ?? "https://powerflow-two.vercel.app";
const { check, report } = checklist();

async function main() {
  const pg = await db();
  const { id: userId, email, password } = await createTestUser(pg, "challenge-e2e");
  let slug: string | undefined;
  try {
    const call = await signIn(SITE, email, password);

    const list = await call("GET", "/api/challenges");
    const day: string | undefined = list.json?.days?.[0];
    check("challenges list and days", list.status === 200 && !!day, `${list.status} newest=${day}`);
    if (!day) return;

    const made = await call("POST", "/api/challenges", { title: "E2E check", firstDay: day, days: 1 });
    slug = made.json?.challenge?.slug;
    check("create a one-day challenge", made.status === 201 && !!slug, `${made.status} ${made.text.slice(0, 120)}`);
    if (!slug) return;

    // The shared link, as a friend without an account (or a link preview) sees it.
    const pub = await fetch(`${SITE}/challenges/${slug}`, { redirect: "manual" });
    const pubHtml = await pub.text();
    check(
      "signed out: the challenge page and its preview",
      pub.status === 200 && pubHtml.includes("Sign up to enter") && pubHtml.includes("Share invite") && pubHtml.includes("E2E check — a PowerFlow challenge"),
      `${pub.status} ${pub.headers.get("location") ?? ""}`,
    );
    const listOut = await fetch(`${SITE}/challenges`, { redirect: "manual" });
    check("signed out: the list of challenges still needs an account", listOut.status >= 300 && listOut.status < 400, `${listOut.status}`);

    const entered = await call("POST", `/api/challenges/${slug}`, { action: "enter" });
    check("enter: desk switched to the challenge", entered.status === 200 && entered.json?.entry?.status === "ACTIVE", `${entered.status} next=${entered.json?.entry?.next?.kind}`);

    const desk = await call("GET", "/api/desk");
    check("active desk is the challenge desk", desk.json?.active?.kind === "CHALLENGE", desk.json?.active?.label);

    const mk = await call("GET", "/api/markets");
    const north = (mk.json?.markets ?? []).find((m: Loose) => (m.settlementPoint ?? m.settlement_point) === "HB_NORTH");
    const t = he18(day);
    const order = await call("POST", "/api/orders", {
      marketId: north?.id, instrument: "VIRTUAL", product: "DAM_HOURLY", side: "SELL", quantityMwh: "3",
      deliveryStart: new Date(t).toISOString(), deliveryEnd: new Date(t + 3_600_000).toISOString(),
    });
    check("bid on the challenge day", order.status === 201, `${order.status} ${order.text.slice(0, 120)}`);

    const outside = await call("POST", "/api/orders", {
      marketId: north?.id, instrument: "VIRTUAL", product: "DAM_HOURLY", side: "SELL", quantityMwh: "3",
      deliveryStart: new Date(t + 86_400_000).toISOString(), deliveryEnd: new Date(t + 86_400_000 + 3_600_000).toISOString(),
    });
    check("a bid outside the challenge is refused", outside.status === 422 && /challenge's own operating days/.test(outside.text), `${outside.status}`);

    const back = await call("PUT", "/api/clock", { to: "2026-09-25T12:00:00.000Z" });
    check("the clock will not go back", back.status === 422 && /only moves forward/.test(back.text), `${back.status} ${back.text.slice(0, 80)}`);

    const moved = await call("POST", `/api/challenges/${slug}`, { action: "move" });
    check("move: run the clearing", moved.status === 200 && moved.json?.entry?.next?.kind === "finish", `${moved.status} next=${moved.json?.entry?.next?.kind}`);
    const orders = await call("GET", "/api/orders");
    check("the bid filled at the clearing", orders.json?.orders?.[0]?.status === "FILLED", orders.json?.orders?.[0]?.status);

    const done = await call("POST", `/api/challenges/${slug}`, { action: "finish" });
    const mine = done.json?.standings?.find((r: Loose) => r.isViewer);
    check("finish: settled and ranked", done.status === 200 && done.json?.entry?.status === "FINISHED" && mine?.rank === 1, `pnl=${done.json?.entry?.pnl} rank=${mine?.rank}`);

    await call("PUT", "/api/desk", { desk: "LIVE" });
    const { rows: [live] } = await pg.query("select cash_balance, sim_clock_offset, replay_tainted_at from public.paper_accounts where user_id = $1", [userId]);
    check("live account untouched", Number(live.cash_balance) === 100000 && Number(live.sim_clock_offset) === 0 && live.replay_tainted_at === null, `cash=${live.cash_balance}`);
  } finally {
    if (slug) await pg.query("delete from public.challenges where slug = $1", [slug]);
    const { desksLeft } = await deleteTestUser(pg, userId);
    check("cleanup: user, desk and challenge deleted", desksLeft === 0, `${desksLeft} desk account(s) left`);
    await pg.end();
  }
}

main()
  .catch((e) => check("ran", false, e instanceof Error ? e.message : String(e)))
  .finally(report);
