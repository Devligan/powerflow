# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

PowerFlow: a multi-user ERCOT electricity paper-trading app (Next.js 16 App Router + Supabase Postgres + Vercel). `README.md` is the long-form design reference (pricing, settlement, margin, instruments, security model) — read the relevant section before changing engine behaviour. The as-of engine, simulation clock and limit orders (0020–0028) are documented mainly in those migration headers.

## Commands

```bash
npm run dev            # http://localhost:3000
npm run typecheck      # tsc --noEmit
npm run lint
npm run build
npm test               # vitest, offline suites only (src/**/*.test.ts)
npx vitest run src/lib/trading/accounting.test.ts   # one offline file
npx vitest run -t "name"                            # one test by name
npm run test:db                                     # DB-backed suites (opt-in)
npm run test:db -- src/lib/security.rls.test.ts     # one DB suite
npm run test:db -- -t "race"
npm run market:probe   # one live ingestion run against ERCOT MIS + the DB
npx tsx scripts/run-migration.ts supabase/migrations/00NN_x.sql   # apply one migration without the Supabase CLI
```

- The shell is Windows PowerShell and the repo path contains a space. `RUN_DB_TESTS=1 npm test` does not work here — use `npm run test:db` (it sets the flag in Node and spawns vitest directly to avoid cmd.exe re-splitting the path).
- DB suites run against whatever project `.env` points at and create real users; teardown is centralised in `src/lib/testing/setup.ts`. Each DB suite claims a market no other suite writes to (repricing and the settlement sweep would otherwise break each other's assertions) — keep that when adding one.
- `npm run db:types` regenerates `src/lib/supabase/database.types.ts` after a schema change.

## Architecture

**The database is the engine; TypeScript mirrors it.** All money-moving logic lives in `SECURITY DEFINER` SQL functions in `supabase/migrations/` (`execute_trade`, `instrument_price`, `position_marks`, `account_margin`, `settle_delivered_positions`, `place_limit_order`, `cancel_order`, `fill_crossing_limit_orders`, `promote_rtm_finals`, `set_sim_clock`). Route handlers in `src/app/api/**` validate input (zod) and call these RPCs; they never compute fill prices or mutate `trades`/`positions`/`paper_accounts`/`audit_events` directly (RLS + immutability triggers forbid it). `src/lib/trading/{accounting,instruments,margin}.ts` re-implement the same rules for previews, analytics and the read side, and are pinned to the SQL by the `sql-*.test.ts` DB suites. A change to engine semantics normally needs: a new migration, the matching TS mirror change, and both test layers.

**Migrations are append-only and evolve functions by redefinition.** The current definition of an SQL function is in the *latest* migration that touches it, not the one that introduced it — grep all migrations before editing. Some later migrations (e.g. 0028) patch the deployed function body in-database via a `DO` block rather than restating it. Migrations are written to be idempotent (`create or replace`, `if not exists`). New `SECURITY DEFINER` functions must pin `search_path` and revoke EXECUTE from `public` **and** `anon` (Supabase grants `anon` by default — see 0012/0019); system sweeps are `service_role`-only. New audit event types must be added to the `audit_event_type_valid` constraint (0027).

**Prices are (settlement point, product, delivery interval) observations with a publication time** (0020/0021). `market_prices` holds multiple revisions per interval; every lookup is as-of a clock (`published_at <= clock`). Fills and marks use the latest observation visible at the account's clock; settlement uses only *final* observations (`price_final`). There is no fallback price: an unpriced interval is refused (`PRICE_UNAVAILABLE`), marked as unpriced (never zero), or deferred from settlement.

**Each account has its own simulation clock** (`paper_accounts.sim_clock_offset`, `src/lib/sim-clock.ts`, `/api/clock`). Offset 0 = live; negative = replaying history. Fills, marks, margin and settlement-due checks all use the owner's clock, so look-ahead is prevented in the engine, not the UI.

**Products vs instruments.** Products are price series (catalog in `src/lib/ercot/types.ts`, authoritative copy in the `products` table — `tradable` in the DB is what the engine checks). Instruments (`ENERGY_SPOT`, `VIRTUAL`, `DART_SPREAD`, `BASIS_SPREAD`, `PTP_*`, `CRR_*`, `BLOCK_FORWARD`, …) are what positions are held in; each reduces its legs to one scalar price via a rule (`POINT`, `DIFFERENCE`, `CONVERGENCE`, `CONGESTION_CONVERGENCE`, `AVERAGE`). Position identity is `(user, instrument, market, second leg, product, delivery window)`. Real-time products are reference-only since 0025; forward trading is day-ahead, with RT reached via convergence instruments.

**Money is exact.** DB columns are `numeric`; client math uses `bigint` at a fixed 1e6 scale (`src/lib/money.ts`). Never introduce floats into accounting paths.

**Market data is always actual ERCOT data.** `src/lib/ercot/index.ts#getErcotSource` resolves `ERCOT_SOURCE`: `ERCOT_MIS` (default — public MIS reports, no credentials: NP6-905 rolling RT, NP4-190 DAM, NP4-188 AS) or `ERCOT_REPLAY` (same adapter in archive mode, driven by `scripts/ingest-history.ts`). There is no synthetic feed in production. `src/lib/ingestion.ts` resumes each (market, product) series from its own cursor, clamped to `INGEST_MAX_LOOKBACK_HOURS`, writes under a per-product fair `INGEST_MAX_RECORDS` budget, then runs `promote_rtm_finals` and the `fill_crossing_limit_orders` sweep, and records the run in `ingestion_runs`. ERCOT delivery hours are US/Central with DST skip/repeat handled by `deliveryCentralToUtc` — never use a single per-day offset. Recorded fixtures live in `fixtures/ercot/` (`npm run load:history`).

**Scheduling.** Vercel Hobby allows only a daily cron (`vercel.json` is a fallback). The real scheduler is Supabase `pg_cron` (migration 0029): it calls `/api/cron/ingest` at :03/:18/:33/:48 and `/api/cron/settle` at :25 via `pg_net`, reading the site URL and `CRON_SECRET` from Vault. Check `GET /api/market-data/status` (per-series newest delivery) and `net._http_response` when data looks stale.

**History warning.** Commit `2ccefe8` once overwrote 34 files with their September versions, silently removing the live pipeline; it was restored from `216ef26`. When a commit touches `src/lib/ercot/` or `src/lib/ingestion.ts`, diff it — a stale working copy can look like a small change.

**Supabase clients** (`src/lib/supabase/`): `server.ts` (SSR, user session, RLS applies), `client.ts` (browser), `admin.ts` (service role — server-only, used for ingestion, settlement, leaderboard, bootstrap). Route protection is in `src/proxy.ts` (Next 16's replacement for `middleware.ts`). Post-login redirects must go through `safeNextPath` (`src/lib/redirect.ts`).

## Repo hygiene

The repo root and `scripts/` contain many untracked one-off probe/debug scripts (`test-*.cjs`, `fetch-*.js`, `probe-*`, `_*.json`). They are not part of the app or test suite; don't build on them or treat them as the source of truth.
