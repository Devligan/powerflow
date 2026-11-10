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
npx tsx scripts/run-migration.ts --status                          # which migrations production has (ops.applied_migrations)
npx tsx scripts/run-migration.ts --dry-run supabase/migrations/00NN_x.sql   # apply in a transaction, report, roll back
npx tsx scripts/run-migration.ts supabase/migrations/00NN_x.sql   # apply (forward only) and record it in the ledger
node scripts/smoke-production.mjs                                  # check the live site and data freshness
npx tsx scripts/backfill-ercot.ts --from 2026-09-20 [--dry-run]   # fill price gaps from ERCOT rolling reports + annual archives
npx tsx scripts/setup-scheduler.ts                                 # apply 0029 + store Vault URL/CRON_SECRET
```

- The shell is Windows PowerShell and the repo path contains a space. `RUN_DB_TESTS=1 npm test` does not work here — use `npm run test:db` (it sets the flag in Node and spawns vitest directly to avoid cmd.exe re-splitting the path).
- DB suites run against whatever project `.env` points at and create real users; teardown is centralised in `src/lib/testing/setup.ts`. Each DB suite claims a market no other suite writes to (repricing and the settlement sweep would otherwise break each other's assertions) — keep that when adding one.
- `npm run db:types` regenerates `src/lib/supabase/database.types.ts` after a schema change.

## Delivery

Master deploys to production through Vercel, so changes reach it by pull request: branch, push, let CI (`.github/workflows/ci.yml`) go green, merge. CI runs `scripts/ci-guards.mjs` (append-only migrations, definer-function hygiene, mojibake), lint, types, the offline suites, the build, a production-dependency audit, a secret scan, and every migration plus the DB suites on a disposable Supabase stack.

Run DB suites the same way locally rather than against production: `npx supabase start -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,postgres-meta,supavisor`, then set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from `npx supabase status` (ambient values win over `.env`), plus `ERCOT_SOURCE=ERCOT_MIS`, `INGEST_MAX_RECORDS=40000` and `INGEST_MAX_LOOKBACK_HOURS=96` so the preflight ingests up to ERCOT's present.

A migration a change depends on is applied to production before its PR merges (`scripts/run-migration.ts`), after `--dry-run` (a rolled-back transaction), so each one must stay compatible with the code already live. The runner records every file it applies in `ops.applied_migrations` (a schema PostgREST does not expose) and refuses a file already recorded or one with an earlier file still pending, so `--status` is the answer to "what does production have?" — not probing for marker objects. Stacked PRs merge bottom-up with merge commits: retarget each to `master` once the one below it lands.

`.github/workflows/production.yml` runs `scripts/smoke-production.mjs` after every production deploy (Vercel's commit status on master) and every three hours; a failed run means the site, auth gating or ingestion is broken.

## Architecture

**The database is the engine; TypeScript mirrors it.** All money-moving logic lives in `SECURITY DEFINER` SQL functions in `supabase/migrations/` (`execute_trade`, `instrument_price`, `position_marks`, `account_margin`, `settle_delivered_positions`, `place_limit_order`, `cancel_order`, `fill_crossing_limit_orders`, `promote_rtm_finals`, `set_sim_clock`). Route handlers in `src/app/api/**` validate input (zod) and call these RPCs; they never compute fill prices or mutate `trades`/`positions`/`paper_accounts`/`audit_events` directly (RLS + immutability triggers forbid it). `src/lib/trading/{accounting,instruments,margin}.ts` re-implement the same rules for previews, analytics and the read side, and are pinned to the SQL by the `sql-*.test.ts` DB suites. A change to engine semantics normally needs: a new migration, the matching TS mirror change, and both test layers.

**Migrations are append-only and evolve functions by redefinition.** The current definition of an SQL function is in the *latest* migration that touches it, not the one that introduced it — grep all migrations before editing. Some later migrations (e.g. 0028) patch the deployed function body in-database via a `DO` block rather than restating it. Migrations are written to be idempotent (`create or replace`, `if not exists`), but **never re-run a superseded migration on its own**: when a later migration changed a function's signature, re-running the old one re-creates the old overload beside the new one (0033 had to drop a stale `execute_trade` and `settle_delivered_positions` that broke settlement and re-opened stale-price fills). Apply forward only. New `SECURITY DEFINER` functions must pin `search_path` and revoke EXECUTE from `public` **and** `anon` (Supabase grants `anon` by default — see 0012/0019); system sweeps are `service_role`-only. Since 0046 the public API is least-privilege: a session (`authenticated`) may call only the eight caller-checked definer functions the app uses (`account_margin`, `cancel_order`, `clear_sim_clock`, `place_limit_order`, `position_marks`, `set_leaderboard_opt_in`, `set_sim_clock`, `update_profile`) and read its own rows plus `markets`/`products`/`instruments`; `anon` gets nothing, and neither reads `market_prices` (the app reads it through the service role). Default privileges no longer grant new functions or tables to `anon`/`authenticated`, so a function a session must call needs an explicit `grant execute ... to authenticated`. New audit event types must be added to the `audit_event_type_valid` constraint (0027).

**Prices are (settlement point, product, delivery interval) observations with a publication time** (0020/0021). `market_prices` holds multiple revisions per interval; every lookup is as-of a clock (`published_at <= clock`). Fills and marks use the latest observation visible at the account's clock; settlement uses only *final* observations (`price_final`). There is no fallback price: an unpriced interval is refused (`PRICE_UNAVAILABLE`), marked as unpriced (never zero), or deferred from settlement. Since 0044 a price is final on ERCOT's calendar — real time at 16:00 Central on the second Business Day after the Operating Day, day ahead at 10:00 (`ercot_price_final_at`, mirrored in `src/lib/ercot/settlement-calendar.ts`) — so `promote_rtm_finals` promotes then, a position settles then (on its account's clock; an explicit `p_as_of` bypasses the wait), and ERCOT's NP4-197 corrections posted before it are what settle. MIS `PublishDate` offsets are the listing's, not the posting's: read postings through `misPostedAt`.

**Desks** (0048, `src/lib/desk.ts`): a trader's live account is their own user id; a practice desk is a second engine account — an Auth user that never signs in, registered in `public.desks` — with its own $100,000 and clock. The `pf_desk` cookie picks the desk; every trading page and route resolves `getActiveDesk(user.id).accountUserId` instead of `user.id` (rate limits, profile and account settings stay on the real user). Writes still go through the caller's session: the caller-checked engine functions accept `acts_for(p_user_id)` — the account itself or its desk owner — so ownership is enforced in the database. Desk reads use the service role scoped to that verified account, since RLS shows a session only its own rows. Deleting a desk row deletes its user and book; deleting the owner deletes their desks. The practice day (`src/lib/practice.ts`, `/api/practice`) walks the desk clock through one past operating day (bid → clearing → delivery → settle); after any clock move `catchUpAccount` sweeps and settles that one account. Challenges (0049, `src/lib/challenges.ts`, `challenge-schedule.ts`) give each entrant a CHALLENGE desk; guard functions patched in right after the caller check (`challenge_check_clock` in `set_sim_clock`/`clear_sim_clock`, `challenge_check_order` in `place_limit_order`) hold its clock forward-only inside the challenge and its bids to the challenge's days, and close a finished entry. Finishing is server-orchestrated because the sweeps are service-role jobs: `challenge_advance_to_finish` → `catchUpAccount` → `challenge_record_result`.

**Each account has its own simulation clock** (`paper_accounts.sim_clock_offset`, `src/lib/sim-clock.ts`, `/api/clock`). Offset 0 = live; negative = replaying history. Fills, marks, margin and settlement-due checks all use the owner's clock, so look-ahead is prevented in the engine, not the UI.

**Products vs instruments.** Products are price series (catalog in `src/lib/ercot/types.ts`, authoritative copy in the `products` table — `tradable` in the DB is what the engine checks). Instruments (`ENERGY_SPOT`, `VIRTUAL`, `DART_SPREAD`, `BASIS_SPREAD`, `PTP_*`, `CRR_*`, `BLOCK_FORWARD`, …) are what positions are held in; each reduces its legs to one scalar price via a rule (`POINT`, `DIFFERENCE`, `CONVERGENCE`, `CONGESTION_CONVERGENCE`, `AVERAGE`). Position identity is `(user, instrument, market, second leg, product, delivery window)`. Real-time products are reference-only since 0025; forward trading is day-ahead, with RT reached via convergence instruments. Since 0038 every position opens as a day-ahead **bid** (`place_limit_order`, MARKET or LIMIT) placed before `dam_gate` (10:00 Central the day before the operating day); only the service-role sweep fills them, and a user's direct `execute_trade` on a day-ahead interval is refused. Nothing trades once delivery has started (0037). Since 0045 a day's bids open at 00:00 Central fourteen days before it (`dam_bid_window_opens`) and quantities sit on ERCOT's 0.1 MW grid. Since 0043 a bid cannot be cancelled after the gate, and the sweep judges it at the last instant it stood in the market, so `execute_trade` takes a service-role-only `p_as_of`. DB suites therefore fill through the service-role client.

**Money is exact.** DB columns are `numeric`; client math uses `bigint` at a fixed 1e6 scale (`src/lib/money.ts`). Never introduce floats into accounting paths.

**Market data is always actual ERCOT data.** `src/lib/ercot/index.ts#getErcotSource` resolves `ERCOT_SOURCE`: `ERCOT_MIS` (default — public MIS reports, no credentials: NP6-905 rolling RT, NP4-190 DAM, NP4-188 AS) or `ERCOT_REPLAY` (same adapter in archive mode, driven by `scripts/ingest-history.ts`). There is no synthetic feed in production. `src/lib/ingestion.ts` resumes each (market, product) series from its own cursor, clamped to `INGEST_MAX_LOOKBACK_HOURS`, writes under a per-product fair `INGEST_MAX_RECORDS` budget, then runs `promote_rtm_finals` and the `fill_crossing_limit_orders` sweep, and records the run in `ingestion_runs`. RT load zones are printed twice (`LZ` and energy-weighted `LZEW`, which can differ) — always keep the canonical `LZ` print, as `parseRtmSppCsv` does. ERCOT delivery hours are US/Central with DST skip/repeat handled by `deliveryCentralToUtc` — never use a single per-day offset. Recorded fixtures live in `fixtures/ercot/` (`npm run load:history`).

**Scheduling.** Vercel Hobby allows only a daily cron (`vercel.json` is a fallback). The real scheduler is Supabase `pg_cron` (migration 0029): it calls `/api/cron/ingest` at :03/:18/:33/:48 and `/api/cron/settle` at :25 via `pg_net`, reading the site URL and `CRON_SECRET` from Vault. Check `GET /api/market-data/status` (per-series newest delivery) and `net._http_response` when data looks stale.

**History warning.** Commit `2ccefe8` once overwrote 34 files with their September versions, silently removing the live pipeline; it was restored from `216ef26`. When a commit touches `src/lib/ercot/` or `src/lib/ingestion.ts`, diff it — a stale working copy can look like a small change.

**Supabase clients** (`src/lib/supabase/`): `server.ts` (SSR, user session, RLS applies), `client.ts` (browser), `admin.ts` (service role — server-only, used for ingestion, settlement, leaderboard, bootstrap). Route protection is in `src/proxy.ts` (Next 16's replacement for `middleware.ts`). Post-login redirects must go through `safeNextPath` (`src/lib/redirect.ts`).

## Repo hygiene

The repo root and `scripts/` contain many untracked one-off probe/debug scripts (`test-*.cjs`, `fetch-*.js`, `probe-*`, `_*.json`). They are not part of the app or test suite; don't build on them or treat them as the source of truth.
