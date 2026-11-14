#!/usr/bin/env node
/**
 * Repository rules CI enforces, each one a mistake this repo has already paid
 * for or could not otherwise catch:
 *
 *   - migrations are append-only and numbered without gaps;
 *   - a new SECURITY DEFINER function pins search_path and revokes EXECUTE;
 *   - no mojibake in source (typecheck and tests pass straight through it);
 *   - a client component never imports the service-role client.
 *
 * Needs no dependencies, so it runs before anything is installed if it has to.
 * CI_BASE_SHA is what the migration history is compared against; without it
 * (a local run) only the checks that need no history apply.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = "supabase/migrations";
const failures = [];
const fail = (message) => failures.push(message);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/* --- Migration numbering -------------------------------------------- */
const files = readdirSync(MIGRATIONS).sort();
files.forEach((name, i) => {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) {
    fail(`${MIGRATIONS}/${name}: must be NNNN_lower_snake_case.sql`);
    return;
  }
  const expected = String(i + 1).padStart(4, "0");
  if (!name.startsWith(expected)) {
    fail(`${MIGRATIONS}/${name}: expected number ${expected} (no gaps or duplicates)`);
  }
});

/* --- Migration history is append-only ------------------------------- */
const base = process.env.CI_BASE_SHA;
const usableBase = base && !/^0+$/.test(base);
if (usableBase) {
  const changes = git("diff", "--name-status", "--no-renames", `${base}...HEAD`, "--", MIGRATIONS);
  for (const line of changes.split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t");
    if (status !== "A") {
      fail(`${path}: applied migrations are immutable; add a new one instead (status ${status})`);
      continue;
    }
    checkDefinerFunctions(path);
  }
}

/**
 * Every SECURITY DEFINER function a new migration creates. Supabase grants
 * anon EXECUTE by default, and an unpinned search_path lets a caller shadow
 * what the function resolves — 0012 and 0019 exist to undo exactly that.
 */
function checkDefinerFunctions(path) {
  const sql = readFileSync(path, "utf8");
  const pattern = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)[\s\S]*?\$\$/gi;
  for (const [header, name] of sql.matchAll(pattern)) {
    if (!/security\s+definer/i.test(header)) continue;
    if (!/set\s+search_path/i.test(header)) {
      fail(`${path}: SECURITY DEFINER function ${name} must pin search_path`);
    }
    const revoke = new RegExp(`revoke[^;]*on\\s+function\\s+(?:public\\.)?${name}\\b[^;]*anon`, "i");
    if (!revoke.test(sql)) {
      fail(`${path}: SECURITY DEFINER function ${name} must revoke EXECUTE from public and anon`);
    }
  }
}

/* --- Source files --------------------------------------------------- */
const MOJIBAKE = /â€|Â·|Â |â€™|Ã©/;
for (const path of walk("src")) {
  if (!/\.(ts|tsx|css)$/.test(path)) continue;
  const text = readFileSync(path, "utf8");
  if (MOJIBAKE.test(text)) {
    fail(`${path}: mojibake (a UTF-8 file was read as cp1252 and rewritten)`);
  }
  if (/^\s*["']use client["']/m.test(text) && /supabase\/admin/.test(text)) {
    fail(`${path}: a client component must not import the service-role client`);
  }
}

// An invisible U+FEFF inside a file (not as its byte-order mark) is a
// character an editor can strip without anyone seeing: the BOM-stripping
// regexes in the CSV and .env readers were written that way. Only tracked
// files count: untracked scratch scripts are not CI's business.
for (const path of git("ls-files", "src", "scripts").split("\n")) {
  if (!/\.(ts|tsx|mjs|js)$/.test(path)) continue;
  if (readFileSync(path, "utf8").indexOf("\uFEFF", 1) >= 0) {
    fail(`${path}: a literal U+FEFF inside the file; write it as \\uFEFF`);
  }
}

if (failures.length > 0) {
  console.error(`ci-guards: ${failures.length} problem(s)\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`ci-guards: ok (${files.length} migrations${usableBase ? ", history checked" : ""})`);
