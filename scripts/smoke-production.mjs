#!/usr/bin/env node
/**
 * Checks the live site the way a visitor and the scheduler see it: public pages
 * answer, protected routes stay protected, and ERCOT prices are still arriving.
 * Exits 1 on any failure, so a workflow run that fails is the alert.
 *
 * Needs no dependencies and no credentials.
 *   node scripts/smoke-production.mjs [https://powerflow-two.vercel.app]
 */

const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? "https://powerflow-two.vercel.app").replace(/\/$/, "");
// pg_cron ingests at :03/:18/:33/:48; two missed runs is an outage.
const MAX_RUN_AGE_MIN = 45;
// ERCOT posts a 15-minute RT interval roughly 15-20 minutes after it ends.
const MAX_RT_PUBLISH_AGE_MIN = 90;
const MAX_STORAGE_PERCENT = 80;

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });

async function get(path, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(BASE + path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      // A cold start or a deploy cut-over can drop one request.
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
}

const minutesSince = (iso) => (Date.now() - Date.parse(iso)) / 60_000;

async function main() {
  for (const path of ["/", "/login", "/signup", "/leaderboard"]) {
    const res = await get(path);
    check(`GET ${path}`, res.status === 200, `${res.status}`);
  }

  const dashboard = await get("/dashboard");
  const location = dashboard.headers.get("location") ?? "";
  check("signed-out /dashboard redirects to /login", dashboard.status >= 300 && dashboard.status < 400 && location.includes("/login"), `${dashboard.status} ${location}`);

  const clock = await get("/api/clock");
  check("signed-out /api/clock is refused", clock.status === 401, `${clock.status}`);

  const statusRes = await get("/api/market-data/status");
  check("GET /api/market-data/status", statusRes.status === 200, `${statusRes.status}`);
  if (statusRes.status === 200) {
    const status = await statusRes.json();
    check("market data mode is live ERCOT", status.mode === "ERCOT_LIVE", status.mode);

    const run = status.latestRuns?.[0];
    check(
      "latest ingestion run succeeded recently",
      run && run.status === "SUCCESS" && minutesSince(run.started_at) <= MAX_RUN_AGE_MIN,
      run ? `${run.status} ${Math.round(minutesSince(run.started_at))} min ago` : "no runs",
    );

    const rt = status.newestByProduct?.RTM_15MIN;
    check(
      "real-time prices are fresh",
      rt && minutesSince(rt.publishedAt) <= MAX_RT_PUBLISH_AGE_MIN,
      rt ? `interval ${rt.deliveryTimestamp}, posted ${Math.round(minutesSince(rt.publishedAt))} min ago` : "none",
    );

    // The free plan's database stops taking writes when full: warn at 80%,
    // months ahead at the current ~1 MB a day (0050).
    const pct = status.storage?.percentOfFreeTier;
    check(
      "database below 80% of the free tier",
      typeof pct === "number" && pct < MAX_STORAGE_PERCENT,
      typeof pct === "number" ? `${pct}% used` : "not reported",
    );
  }

  for (const r of results) {
    console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} check(s) failed against ${BASE}` : `\nall ${results.length} checks passed against ${BASE}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(`smoke test could not run against ${BASE}:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
