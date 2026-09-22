import { spawn } from "node:child_process";
import { join } from "node:path";

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
 */

const forwarded = process.argv.slice(2);

// Node runs vitest's own entry point rather than the `node_modules/.bin` shim.
// The shim is a `.cmd` on Windows, which means going through cmd.exe — and that
// re-splits the command on the space in a path like "ERCOT paper trading".
// Spawning node with an argument array has no shell and no quoting to get wrong.
const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

const child = spawn(process.execPath, [vitest, "run", ...forwarded], {
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
