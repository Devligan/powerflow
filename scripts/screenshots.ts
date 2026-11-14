/**
 * The README's screenshots, taken from the live site rather than mocked up:
 *
 *   npx tsx scripts/screenshots.ts [https://powerflow-two.vercel.app] [--only landing,desk]
 *
 * A throwaway @powerflow.test trader (scripts/e2e/db.ts) switches to its
 * practice desk and trades one recent operating day through the app's own
 * API: a handful of day-ahead virtual bids, the clearing, delivery, and the
 * settlement. Chrome, driven over the DevTools Protocol with that session's
 * cookies, photographs each stage at a desktop viewport in Central time, then
 * the account is deleted. Images land in docs/screenshots/.
 *
 * Needs SUPABASE_DB_PASSWORD and the project URL/anon key from .env, and
 * Chrome (or CHROME_PATH).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachPage, freePort, killTree, launchChrome, removeProfile, resolveChrome, type Page } from "./lib/chrome";
import { createTestUser, db, deleteTestUser, type Loose } from "./e2e/db";
import { he18, signIn, type Call } from "./e2e/session";

const args = process.argv.slice(2);
const SITE = (args.find((a) => a.startsWith("http")) ?? "https://powerflow-two.vercel.app").replace(/\/+$/, "");
const onlyArg = args[args.indexOf("--only") + 1];
/** e.g. `--only desk,positions`: retake some shots, keep the rest. */
const ONLY = args.includes("--only") && onlyArg ? new Set(onlyArg.split(",")) : null;
const OUT = join("docs", "screenshots");
const VIEWPORT = { width: 1440, height: 900 };

/** The book the screenshots show: a few views on one operating day. */
const BIDS: Array<{ point: string; side: "BUY" | "SELL"; hourEnding: number; mw: string; limit?: string }> = [
  { point: "HB_NORTH", side: "BUY", hourEnding: 18, mw: "5" },
  { point: "HB_NORTH", side: "BUY", hourEnding: 19, mw: "5" },
  { point: "HB_HOUSTON", side: "BUY", hourEnding: 17, mw: "3" },
  { point: "HB_WEST", side: "SELL", hourEnding: 8, mw: "4" },
  { point: "HB_WEST", side: "SELL", hourEnding: 9, mw: "4" },
  { point: "LZ_SOUTH", side: "SELL", hourEnding: 14, mw: "2.5" },
  { point: "HB_PAN", side: "BUY", hourEnding: 20, mw: "2" },
  // Rests below the clearing, so the order book shows one that did not fill.
  { point: "HB_NORTH", side: "BUY", hourEnding: 12, mw: "5", limit: "1.00" },
];

/** Set when the trader has signed in: the browser takes the session's cookies
 *  (the token, and the desk the API switched to) before every shot. */
let session: Call | null = null;

async function shoot(page: Page, name: string, path: string, settleMs = 3000): Promise<void> {
  if (ONLY && !ONLY.has(name)) return;
  if (session) {
    const { hostname: domain, protocol } = new URL(SITE);
    for (const c of session.cookies()) {
      await page.send("Network.setCookie", { name: c.name, value: c.value, domain, path: "/", secure: protocol === "https:" });
    }
  }
  await page.load(SITE + path, { settleMs });
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(String(shot.data), "base64"));
  console.log(`  saved ${file}  (${path})`);
}

function expectOk(what: string, res: { status: number; text: string }, ok = [200, 201]): void {
  if (!ok.includes(res.status)) throw new Error(`${what}: ${res.status} ${res.text.slice(0, 200)}`);
}

async function placeBook(call: Call, day: string): Promise<void> {
  const markets: Loose[] = (await call("GET", "/api/markets")).json?.markets ?? [];
  const idOf = (point: string) => markets.find((m) => (m.settlementPoint ?? m.settlement_point) === point)?.id;
  for (const bid of BIDS) {
    const start = he18(day) + (bid.hourEnding - 18) * 3_600_000;
    const res = await call("POST", "/api/orders", {
      marketId: idOf(bid.point),
      instrument: "VIRTUAL",
      product: "DAM_HOURLY",
      side: bid.side,
      quantityMwh: bid.mw,
      ...(bid.limit ? { limitPrice: bid.limit } : {}),
      deliveryStart: new Date(start).toISOString(),
      deliveryEnd: new Date(start + 3_600_000).toISOString(),
    });
    expectOk(`bid ${bid.side} ${bid.point} HE${bid.hourEnding}`, res);
  }
}

async function main(): Promise<void> {
  const chromePath = resolveChrome(undefined);
  if (!chromePath) throw new Error("no Chrome found; set CHROME_PATH");
  mkdirSync(OUT, { recursive: true });

  const pg = await db();
  const user = await createTestUser(pg, "screenshots");
  await pg.query("update public.profiles set display_name = 'Demo Trader' where id = $1", [user.id]);

  const debugPort = await freePort();
  const { child, profile } = await launchChrome(chromePath, debugPort, false);
  const { page, socket } = await attachPage(debugPort);
  try {
    await page.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    // ERCOT runs on Central time; so do the screenshots, wherever they are taken.
    await page.send("Emulation.setTimezoneOverride", { timezoneId: "America/Chicago" });
    const host = new URL(SITE).hostname;
    const secure = SITE.startsWith("https");
    // The server renders times in the zone this cookie names (src/lib/time.ts).
    await page.send("Network.setCookie", { name: "pf_tz", value: "America/Chicago", domain: host, path: "/", secure });

    console.log("a practice day on a throwaway desk");
    const call = await signIn(SITE, user.email, user.password);
    session = call;
    // The first-trade card is for a new trader's first visit, not a screenshot;
    // its dismissal lives in the site's localStorage, so open the site first.
    await page.load(SITE + "/learn", { settleMs: 500 });
    await page.evaluate(`localStorage.setItem("pf_first_trade_dismissed", "1")`);

    expectOk("switch to practice", await call("PUT", "/api/desk", { desk: "PRACTICE" }));
    const day: string | undefined = (await call("GET", "/api/practice")).json?.days?.[0];
    if (!day) throw new Error("no practice day offered");
    console.log(`  operating day ${day}`);

    expectOk("open bidding", await call("POST", "/api/practice", { day, step: "bid" }));
    await placeBook(call, day);
    await shoot(page, "markets", "/markets/HB_NORTH");

    expectOk("clearing", await call("POST", "/api/practice", { day, step: "clearing" }));
    await shoot(page, "orders", "/orders");

    expectOk("delivery", await call("POST", "/api/practice", { day, step: "delivery" }));
    await shoot(page, "desk", "/dashboard", 4000);
    await shoot(page, "positions", "/positions");

    expectOk("settle", await call("POST", "/api/practice", { day, step: "settle" }));
    await shoot(page, "analytics", "/analytics", 4000);
  } finally {
    socket.close();
    killTree(child);
    await removeProfile(profile);
    const { desksLeft } = await deleteTestUser(pg, user.id);
    console.log(desksLeft === 0 ? "throwaway account deleted" : `WARNING: ${desksLeft} desk account(s) left`);
    await pg.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
