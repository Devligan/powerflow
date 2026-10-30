import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runMarketDataIngestion } from "../src/lib/ingestion";

/**
 * Runs the database-backed suites: `npm run test:db`.
 *
 * Those suites are gated on `RUN_DB_TESTS`, which has no portable spelling.
 * `RUN_DB_TESTS=1 vitest run` is bash; PowerShell wants
 * `$env:RUN_DB_TESTS=1; npm test`, and npm runs scripts through cmd.exe on
 * Windows, where the prefix form is not valid at all. Setting the variable here
 * instead means the opt-in works the same from any shell.
 *
 * Extra arguments are forwarded, so a single suite can be run in isolation:
 *
 *   npm run test:db -- src/lib/security.rls.test.ts
 *   npm run test:db -- -t "race"
 *
 * Preflight: the trading suites price fills and marks at "the latest interval
 * the desk could see", which under the publication model is the newest
 * observation whose ERCOT publication instant has passed. Before running
 * them, one real ingestion through the production adapter brings the archive
 * to ERCOT's present — so the suites exercise the engine against actual
 * ERCOT data at its true head, exactly as production would.
 */

// Lightweight .env loader (this script runs outside Next). Does not
// overwrite values already in the environment.
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // .env missing — rely on ambient environment.
}

async function preflight(): Promise<void> {
  if (process.env.SKIP_INGEST_PREFLIGHT) return;
  try {
    const result = await runMarketDataIngestion();
    console.log(
      `[test-db] ercot preflight: source=${result.source} received=${result.recordsReceived} ` +
        `inserted=${result.recordsInserted} skipped=${result.recordsSkipped}` +
        (result.failed ? ` FAILED: ${result.error}` : "")
    );
    // A failed preflight is not fatal — the archive may simply be between
    // publications — but it must be visible.
  } catch (e) {
    console.warn(
      `[test-db] ercot preflight failed (continuing):`,
      e instanceof Error ? e.message : e
    );
  }
}

function run(): void {
  const forwarded = process.argv.slice(2);

// Node runs vitest's own entry point rather than the `node_modules/.bin` shim.
// The shim is a `.cmd` on Windows, which means going through cmd.exe — and that
// re-splits the command on the space in a path like "ERCOT paper trading".
// Spawning node with an argument array has no shell and no quoting to get wrong.
const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

// Suites share the database's market tables even though accounts are per-suite:
// two workers republishing prices on nearby intervals can interleave and make
// each other's "latest price" expectations wrong. File-serial execution is the
// safe default; the cost is seconds, not minutes.
const child = spawn(process.execPath, [vitest, "run", "--no-file-parallelism", ...forwarded], {
  stdio: "inherit",
  env: { ...process.env, RUN_DB_TESTS: "1" },
});

child.on("error", (error) => {
  console.error(`could not start vitest: ${error.message}`);
  process.exit(1);
});

  child.on("exit", (code, signal) => {
    // Forward vitest's exit code so CI and `npm test && …` chains see failures.
    process.exit(signal ? 1 : (code ?? 1));
  });
}

// Preflight first (real ERCOT ingestion), then the suites.
void preflight().then(run, run);
