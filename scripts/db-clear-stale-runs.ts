import { readFileSync } from "node:fs";
import { supabaseAdmin } from "../src/lib/supabase/admin";

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

const STALE_HOURS = Number(process.env.CLEAN_STALE_RUNS_HOURS ?? "2");
const DRY_RUN = process.env.CLEAN_STALE_RUNS_DRY_RUN === "true";

async function main() {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      "SUPABASE credentials required: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env"
    );
  }

  const admin = supabaseAdmin();

  const { data: stale, error: staleErr } = await admin
    .from("ingestion_runs")
    .select("id, source, status, records_received, records_inserted, started_at")
    .eq("status", "RUNNING")
    .is("finished_at", null)
    .lt("started_at", new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString())
    .order("started_at", { ascending: false });

  if (staleErr) throw new Error(`could not read stale runs: ${staleErr.message}`);
  const staleRows = (stale ?? []);

  if (staleRows.length === 0) {
    console.log(`[stale] no ingestion runs older than ${STALE_HOURS}h that are still open.`);
    return;
  }

  console.log(`[stale] found ${staleRows.length} open run(s) older than ${STALE_HOURS}h:`);
  for (const r of staleRows) {
    console.log(
      `  ${r.id}  ${r.source}  ${r.status}  started=${r.started_at}  received=${r.records_received}  inserted=${r.records_inserted}`
    );
  }

  if (DRY_RUN) {
    console.log("[stale] dry run — set CLEAN_STALE_RUNS_DRY_RUN=false to close the above.");
    return;
  }

  // The incremental path cannot start cleanly while an old open run occupies
  // the table, so stale open runs are closed automatically. The only exception
  // is an explicit allow-list: use CLEAN_STALE_RUNS_ALLOW_IDS to target a
  // single run that should not be bulk-closed with the rest.
  const allowList = (process.env.CLEAN_STALE_RUNS_ALLOW_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // If the caller passed an allow-list, only close those rows. Otherwise close
  // everything the query returned (all of it was already past the stale cutoff).
  const rowsToClose = allowList.length
    ? staleRows.filter((r) => allowList.includes(r.id))
    : staleRows;

  if (rowsToClose.length === 0) {
    console.log("[stale] none of the stale runs are in CLEAN_STALE_RUNS_ALLOW_IDS; nothing closed.");
    return;
  }

  // Warn loudly on a stale ERCOT_MIS run that the live path should not be
  // ignoring. This is the one run that most often means "the cron lost the
  // plot" rather than "a harmless draft".
  const misStuck = rowsToClose.find(
    (r) => r.source === "ERCOT_MIS" && r.source !== "ERCOT_MIS_HISTORY"
  );
  if (misStuck) {
    console.warn(
      `[stale] closing a stale open ERCOT_MIS run: ${misStuck.id} ` +
        `(started ${misStuck.started_at}); the next real ingest run can now start fresh.`
    );
  }

  const { error: closeErr } = await admin
    .from("ingestion_runs")
    .update({
      status: "FAILED",
      finished_at: new Date().toISOString(),
      detail: {
        skipped_reason:
          `cleaned by scripts/db-clear-stale-runs.ts; the incremental path cannot advance an open run that old, so stale open runs are marked FAILED so the next run can start fresh. The real cause of the open draft is recorded here rather than left in the table.`,
        cleaned_by_stale_hours: STALE_HOURS,
      },
    })
    .in("id", rowsToClose.map((r) => r.id));

  if (closeErr) throw new Error(`could not close stale runs: ${closeErr.message}`);
  console.log(`[stale] closed ${rowsToClose.length} run(s): ${rowsToClose.map((r) => r.id).join(", ")}`);
}

main().catch((e) => {
  console.error("[stale] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
