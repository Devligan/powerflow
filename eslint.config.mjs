import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".vercel/**",
    "scripts/typecheck-app.ts",
    // Local one-off probes: never committed.
    "test-*.cjs",
    "fetch-*.js",
    "probe-*",
    "scripts/_*",
    "scripts/test-*.cjs",
    "scripts/*.cjs",
    "scripts/*.js",
  ]),
]);

export default eslintConfig;
