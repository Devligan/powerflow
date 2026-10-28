import { readFileSync } from "node:fs";
import { supabaseAdmin } from "../src/lib/supabase/admin";
import { runMarketDataIngestion } from "../src/lib/ingestion";

// Lightweight .env reader for scripts that run outside Next.
(function () {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    // .env missing — rely on ambient environment.
  }
})();

async function main() {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      "SUPABASE credentials required: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env"
    );
  }

  // Force the live ERCOT path for this run so dev envs are not allowed to
  // guess a different source when pointed at production.
  process.env.ERCOT_SOURCE = "ERCOT_MIS";

  // Same scope the deployable cron uses; the probe verifies the real path,
  // not a thinner local variant. If this is too heavy for the target host,
  // lower INGEST_MAX_RECORDS in .env once and keep the script untouched.
  const start = new Date();
  console.log(`[probe] start ${start.toISOString()}`);
  const result = await runMarketDataIngestion({ dryRun: false });
  const end = new Date();
  console.log(`[probe] end ${end.toISOString()} (${Math.round((end.getTime() - start.getTime()) / 1000)}s)`);

  console.log(JSON.stringify(result, null, 2));
  if (result.failed) {
    console.error("[probe] live ERCOT path failed;", result.error ?? "no error");
    process.exit(1);
  }
  if (result.newestIntervalAgeSeconds == null) {
    console.warn("[probe] no RTM_15MIN coverage yet; feed still warming up.");
  } else if (result.newestIntervalAgeSeconds > 35 * 60) {
    console.warn("[probe] feed still stale by the cron's own threshold;",
      "the next bounded run is what usually fixes this.");
  }
}

main().catch((e) => {
  console.error("[probe] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
