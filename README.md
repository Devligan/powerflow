# PowerFlow — ERCOT Paper Trading

A secure, multi-user paper-trading platform for ERCOT electricity (Next.js +
Supabase + Vercel). Trade actual ERCOT hub and load-zone prices — day-ahead
clearing, 15-minute real-time settlement, and the hourly settlement series —
with virtual cash, a full risk engine, immutable audit trail, and analytics.

**Live:** https://powerflow-two.vercel.app — sign up with email or Google.

### At a glance

- **Real market data, continuously.** ERCOT's public MIS reports are ingested
  every 15 minutes by a Postgres `pg_cron` job, with continuous history from
  2026-09-20 (gaps filled from ERCOT's own annual archives, which match the
  live reports to the cent). Day-ahead, real-time, and ancillary-service prices
  for all 7 trading hubs and 8 load zones.
- **The engine lives in the database.** Fills, marks, margin and settlement are
  `SECURITY DEFINER` Postgres functions, run in one transaction with a per-account
  row lock; a TypeScript mirror is pinned to them by tests. Prices are read
  *as of* each account's own simulation clock, so replaying history has no
  look-ahead.
- **Instruments, not just prices.** Energy spot, virtuals, DART and basis
  spreads, point-to-point obligations/options, CRRs, block forwards and swaps,
  each reduced to a single price by its settlement rule.
- **Correct by construction.** Exact fixed-point money (`bigint`, never floats),
  idempotent orders, append-only trades and audit log, row-level security,
  automatic settlement and margin with forced liquidation and deficits.

> **Where the prices come from**: ERCOT provides the market, PowerFlow provides
> the trading. Every price row is ingested from ERCOT's own MIS reports
> (`ERCOT_MIS`, the default) and carries its true publication stamp; the
> simulator controls only the clock, the orders, and the accounts. Historical
> replay runs over actual ERCOT archives via the same adapter. There is no
> synthetic price feed; `GENERATED` remains only as a labeled development
> fallback and is never presented as ERCOT data.

## Features

- Secure auth via Supabase: email/password and Google; any provider enabled
  in the Supabase project appears automatically.
- $100,000 starting virtual cash; $500,000 gross-exposure limit per account.
- Buy/sell of hourly delivery windows per **product** on 7 hubs + 8 load
  zones, with server-authoritative execution prices taken from the persisted
  price *for the interval and market actually traded* — never from the client
  and never from an unrelated series.
- **Day-ahead bids, as ERCOT runs them** (migrations 0037–0038): a position
  for an operating day is a bid or offer placed before **10:00 Central the
  day before**, at the clearing price or with a limit. It fills when ERCOT
  publishes the day-ahead clearing (~13:30), at the actual clearing price —
  a limit only if the price crosses it (buy at/below, sell at/above, ties
  fill). Nobody can buy a day-ahead interval at its already-published price,
  and nothing trades once its delivery has started. A bid can be withdrawn
  until the deadline and not after, as in ERCOT; one the market clears through
  ends at the clearing, and one that never prices ends when delivery starts.
  As in ERCOT's submission rules (NP4-450, 0045), an operating day takes bids
  from 00:00 Central fourteen days before it, in steps of 0.1 MW; the ticket
  also holds each hour's bid to ERCOT's 1 MW minimum. Every fill, cancel and
  placement is audited.
- Day-ahead **ancillary-service clearing prices** (REGUP, REGDN, RRS, NSPIN,
  ECRS) ingested from ERCOT's NP4-188-CD report — system-wide MCPC series,
  final on arrival. AS capacity remains a resource obligation (no assets on
  a paper desk), so the series are reference data, not orderable.
- Settlement on ERCOT's calendar (0044): real-time prices are final at 16:00
  Central on the second Business Day after the Operating Day (day-ahead at
  10:00), and ERCOT corrects them until then. A delivered position is marked
  meanwhile and settles at that instant — on a replay account's own clock too —
  at the corrected price where ERCOT corrected it. The Business Day calendar
  (weekends and ERCOT's observed holidays) is `ercot_is_holiday`, mirrored in
  `src/lib/ercot/settlement-calendar.ts`. A correction ERCOT posts after a
  position settled (a Board-directed one, months later) updates prices and
  marks but does not resettle it.
- Weighted-average, signed-quantity position accounting with realized P&L on
  closes; exact `bigint` money math on the client matching the database engine.
- Immutable `trades` and `audit_events` (trigger-enforced, no UPDATE/DELETE),
  full RLS on private tables, per-user `FOR UPDATE` serialization on trades so
  no two requests can overspend the same account.
- Dedicated analytics, leaderboard (opt-in, aggregate-only), market charting,
  and an observable ingestion pipeline (`ingestion_runs`).
- Accounts: new traders choose a display name, username and picture on
  `/welcome`; `/settings` edits them and handles privacy (a private account is
  off the standings), email and password changes (confirmed by email), signing
  out other devices, a CSV export, and permanent deletion.
- Every time the site shows is in the viewer's own time zone (detected from the
  browser and kept in the `pf_tz` cookie so server-rendered pages agree, or
  chosen in Settings); see `src/lib/time.ts`. ERCOT's operating days and
  hour-ending numbers stay on Central time, since that is how the market
  defines them. Instants are stored and computed in UTC.
- Automatic cash settlement of delivered positions at their own instrument
  price, equity-neutral and idempotent, with unpriced intervals deferred and
  surfaced rather than settled at a guess.
- Margin on settlement (migration 0014): a short whose settlement outflow
  exceeds its cash is funded by realising the account's longs, largest exposure
  first; an outflow that no amount of collateral can cover is booked as an
  explicit account **deficit** rather than being refused, so a losing position
  always settles and never stays open with its loss unrealised.
- Supabase `pg_cron` (migration 0029) calling `GET /api/cron/ingest` on
  ERCOT's 15-minute posting rhythm and `GET /api/cron/settle` hourly, guarded
  by a secret; `vercel.json` keeps a once-a-day fallback, which is all the
  Hobby plan allows. ERCOT MIS adapter via `ERCOT_SOURCE=ERCOT_MIS`.

## Stack

- **App**: Next.js 16 (App Router, `src/`, TypeScript strict, Tailwind 4)
- **Data**: Supabase Postgres (RLS, triggers, SECURITY DEFINER functions),
  `@supabase/ssr` for sessions, `@supabase/supabase-js` service role for
  ingestion/analytics
- **Testing**: Vitest (exact accounting engine + deterministic feed + CSV parser),
  plus a dependency-free Chrome check of the sign-in screens
- **Deploy**: Vercel (cron, `proxy.ts` route protection)

## Getting started

```bash
npm install                  # install dependencies
cp .env.example .env         # then fill in your Supabase values
```

Required env values (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server Supabase clients |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only; ingestion, bootstrapping, analytics |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF` | Supabase CLI (migrations/types) |
| `CRON_SECRET` | guard for `/api/cron/ingest` |
| `ERCOT_SOURCE` | `ERCOT_MIS` (default, direct MIS reports) or `ERCOT_REPLAY` (historical replay corpus); anything else is a configuration error — synthetic feeds are not available |

Social sign-in needs no variables: the buttons on `/login` and `/signup` are
read from the project's own configuration (`GET /auth/v1/settings`, public and
anon-key readable), so the list can never drift from what the project actually
supports. To turn a provider on, enable it in Supabase →
Authentication → Sign In / Providers, paste its client id and secret, and add
`https://<ref>.supabase.co/auth/v1/callback` to that provider's authorized
redirect URLs — its button appears on the next page load. Google, GitHub,
Microsoft, Apple, Discord, GitLab, LinkedIn, Slack, Facebook, Notion, Spotify,
Twitch, X, Bitbucket, Figma, Kakao, Keycloak and Zoom are all wired up; the
client id and secret stay in the Supabase dashboard and never reach the app.
The public landing page at `/` describes the platform; signed-in users land on
`/dashboard`.

### Database

Migrations live in `supabase/migrations/` and are applied with the Supabase CLI:

```bash
npx supabase link --project-ref $SUPABASE_PROJECT_REF
npx supabase db push
npx supabase gen types typescript --project-id $SUPABASE_PROJECT_REF > src/lib/supabase/database.types.ts
```

Seed ~45 days of deterministic historical prices:

```bash
npx tsx scripts/seed.ts
```

### Development

```bash
npm run dev          # http://localhost:3000
npm test             # exact accounting + feed tests (offline)
npm run test:db      # the database-backed suites (see below)
npm run test:browser # the auth pages in a real browser (needs a build first)
npm run typecheck
npm run lint
npm run build        # production build + type-check of pages
```

Some tests exercise the real database — the SQL that moves cash, order
idempotency under concurrency, account bootstrap, and ingestion gap-fill —
because a TypeScript mirror agreeing with itself proves nothing about the
deployed function. They create real users in whatever project `.env` points
at, so they are opt-in:

```bash
npm run test:db
```

Each suite deletes the accounts it created when it finishes. Removing the user
cascades to its profile, paper account, positions, fills and audit rows, so a
run leaves the database as it found it — and a suite that *fails* part-way still
cleans up, because the teardown is a hook in `src/lib/testing/setup.ts` rather
than something each suite has to remember. The one row with no account behind it
is the `ingestion_runs` entry the gap-fill suite causes, which that suite
removes itself.

`RUN_DB_TESTS=1 npm test` is the same thing, but that prefix is bash only:
PowerShell needs `$env:RUN_DB_TESTS=1; npm test`, and npm runs scripts through
`cmd.exe` on Windows, where the prefix form is invalid. `npm run test:db` sets
the flag in Node, so the opt-in is spelled the same from any shell, and it
forwards arguments, so a single suite can be run on its own:

```bash
npm run test:db -- src/lib/security.rls.test.ts
npm run test:db -- -t "race"
```

These suites share one database, so each claims a market no other one writes —
two of them reprice intervals and the settlement sweep settles delivered
positions, either of which will fail a suite that pins an assertion to a series
it does not own. Respect that when adding one.

### The browser check

Unit tests cannot tell you whether a page *renders*. `npm run test:browser`
drives a real Chrome — the one already on the machine — over the DevTools
Protocol and checks that `/login` and `/signup` render, that their fields are
labelled and autofillable, that a failed OAuth round trip is announced, and that
the provider buttons the Supabase project reports as enabled exist, are named by
the catalogue, and are grouped and announced properly:

```bash
npm run build && npm run test:browser
npm run test:browser -- --url http://localhost:3000   # against a running server
npm run test:browser -- --headed                       # watch it, for debugging
npm run test:browser -- --signed-in                    # adds the desk, positions and rank pages
```

The signed-in pages need an account, so `--signed-in` creates one throwaway
user (as the database suites do), signs in **through the form**, places one real
trade through the app's own HTTP API and deletes the account afterwards — the
cascade takes its position and fill. It is therefore opt-in for the same reason
the database suites are: it writes to whatever project `.env` points at. What it
checks on those pages: the nav marks the current section for assistive tech, the
desk's readouts are real money rather than placeholders, a fresh account's equity
equals its cash, an empty book is an empty state rather than a blank table, the
fill appears as a row with the quantity that was filled and moves cash, and the
standings render without exposing an email address or a raw `user_id`.

It is deliberately not Playwright: Chrome is already installed, and Node has
spoken the debugging protocol over a WebSocket since v22, so the check costs no
dependency, no install step and no lockfile entry. The one branch that cannot be
reached without real OAuth credentials — providers enabled — is exercised by
answering the settings request with a stubbed payload, injected through the
protocol for a single page load, so nothing is rebuilt and the project's own
Auth configuration is untouched. It needs Node 22+ and Chrome or Chromium; with
no browser present it reports that it skipped rather than failing.

## How trading works

Every orderable instrument prices off the day-ahead market (`DAM_HOURLY`), so
every position starts as a **bid**: `POST /api/orders` → `place_limit_order`,
accepted only before `dam_gate(delivery_start)` — 10:00 Central on the day
before the delivery's operating day — on the account's own clock. A bid with
no limit is a `MARKET` order (fill at whatever clears); otherwise `LIMIT`.
When ERCOT publishes the clearing prices, the service-role sweep
`fill_crossing_limit_orders` (run by every ingest, and right after a replay
clock jump) fills each bid that crosses, at the price the fill will actually be
made at. A bid is judged on what had cleared while it stood in the market, on
its own account's clock, not on when the sweep happens to run: a replay clock
jumping past delivery, or ingestion catching up after an outage, still fills a
bid ERCOT cleared the day before, and a clearing posted after delivery started
never does. A user calling `execute_trade`
directly for a day-ahead interval is refused (`DAM_ORDER_REQUIRED` before the
deadline, `DAM_CLOSED` after): knowing the clearing price, and watching real
time come in, before choosing a side was the edge this closes. And nothing is
accepted once its delivery has started (0037).

The fill itself is `execute_trade(...)` (SQL, security definer, one
transaction), called by the sweep:

1. authorization (`auth.uid()` must equal the account owner, or the
   service-role sweep acting for the order's owner)
2. market active, product catalogued + tradable, delivery window valid
   (exactly the product's settlement interval, interval-aligned, future,
   ≤ 35 days; a day-ahead bid is further held to ERCOT's fourteen-day
   window when it is placed)
3. idempotency: if the request carries a `clientOrderId` that has already
   executed, the **stored result of that execution** is returned and nothing is
   filled again
4. authoritative execution price = the persisted price for **that interval and
   that product**. There is no fallback: an interval the feed has not priced is
   `PRICE_UNAVAILABLE` and the order is refused (see *Strict pricing* below)
5. account row locked `FOR UPDATE` (serializes per-user trades)
6. capital (buys fully cash-covered) and gross-exposure checks, marking every
   open position at its own instrument price
7. position accounting (weighted avg cost, signed qty), keyed by
   `(user, instrument, leg pair, product, delivery window)`
8. cash update, immutable trade insert, position upsert, audit event

### Strict pricing: a fill always has a price for its own interval

A price is only ever used for the delivery interval it was published for. If
no such price exists, the order is **refused** rather than filled off an older
one — the feed publishes roughly 72 hours ahead and orders may be placed up to
35 days out, so the fallback that used to bridge that gap meant a trade could
be executed at a price days from the interval it was priced against, with
`price_timestamp` claiming otherwise. A window instrument (a block forward or
swap) is priced only when its whole window is covered; a partially-covered
window is not a price, and averaging the covered part would have been a wrong
number rather than a missing one.

The practical consequence, and the reason ingestion matters: **you can only
trade what the feed has published.** The market page shows the priced-through
interval and warns when the selected delivery is beyond it.

### Order idempotency

Every order carries a `clientOrderId` (the trade panel generates one per
intent, rotating it after a successful fill so that deliberately repeating an
identical order still executes). A retry — a timeout, a double-click, a
reconnect — replays the original execution instead of filling again, and the
response says `replayed: true`. The check sits inside `execute_trade`, around
the existing per-user row lock, so concurrent duplicates fill exactly once; a
unique index on `(user_id, client_order_id)` is the backstop.

The TypeScript engine in `src/lib/trading/accounting.ts` mirrors this logic
exactly for previews/analytics and is pinned by tests
(`src/lib/trading/accounting.test.ts`).

### Settlement: delivered positions are cashed out

When a position's delivery window passes it is **cash-settled automatically**
at its own instrument price (migration 0013). Settlement is not a second
accounting method — it is the same close a user would make, with the engine
choosing the side and the price: a `SELL` for a long, a `BUY` for a short. Both
movements reduce to one signed expression, with `q` the signed quantity and `p`
the settlement price:

- `cash += p × q`
- `realised += (p − average_entry_price) × q`

Because the settlement price is the price the position was already marked at,
settlement is **equity-neutral**: `cash + marked value` is unchanged and
unrealised P&L becomes realised. The `SETTLED` trade row it writes is what keeps
the trade-history replay in agreement with `positions` — the read side
reconstructs both by replaying `trades` — and each settlement is recorded as a
`POSITION_SETTLED` audit event.

A delivered interval with **no price** is left open and reported rather than
settled at a guess, since that would reintroduce the stale-price fill strict
pricing removed. The positions page shows it as *awaiting price*, and the sweep
reports it as `deferred` alongside `settlementDueRemaining`, so a stuck position
is visible instead of silently mispriced.

Run it via `POST /api/cron/settle` (hourly from `pg_cron`, migration 0029), guarded by
`CRON_SECRET`. It is a service-role job over every user's book — the RPC refuses
any caller that is not `service_role`, and `p_as_of` is never taken from the
request, because a caller able to set it could force-settle its own undelivered
positions. `SETTLEMENT_ENABLED=false` restores the pre-0013 behaviour of leaving
delivered positions open until the user closes them.

### Margin: a settlement obligation has to be paid for

Settlement as described above assumes the cash is there. It is not always: a
short's settlement is an *outflow* of `settlement_price × |qty|`, and ERCOT
prices are capped at $20,000/MWh against a $100,000 starting balance, so one
modest short can owe more than the whole account.

Without a rule for that, the sweep simply **fails forever**: the movement
violates `cash_balance_nonneg`, the subtransaction rolls back, and the position
stays open with its entire loss unrealised — re-attempted and re-failed on every
sweep, permanently occupying the exposure limit. That is not a state the
platform should be able to reach, so migration 0014 models what a desk actually
does with an unmet margin call:

1. **Realise collateral.** The account's longs are sold — largest exposure
   first — until the obligation is covered, and only as much as it needs.
2. **Book the remainder as a deficit.** If selling every long still is not
   enough, the gap is recorded on the account as `deficit` (a liability) and the
   position settles anyway. The move beat the equity posted against it; that is
   a real loss, not a reason to leave the position open.
3. **Receipts repay the deficit first.** A later settlement that pays *in* is
   applied to what the clearing house is owed before the member can spend again.

Equity is reported net of the deficit, so `cash + marked value − deficit` is the
figure that stays honest. The sweep records a `MARGIN_CALL` per account per run,
plus `POSITION_SETTLED` (carrying `funded_by_liquidation`, `liquidated_positions`
and `shortfall`), `ACCOUNT_DEFICIT` and `DEFICIT_REPAID` events, and
`account_margin()` exposes cash, marked value, deficit, equity, used and
maintenance margin, and the account's margin tier for the UI.

There is no deposit path and no liquidation freeze: liquidating the last long
leaves the account holding nothing, and freezing it there would be terminal. A
deficit is a standing liability the account works off from later receipts.

Bids post collateral (0040): MW × the 95th-percentile |RT − DA| at the point, at
least $10/MW, held on every open bid and every open margined position. Together
they must fit within the lesser of cash and equity, so an open loss or a deficit
reduces what a new bid can post, and an open gain does not add to it.

## Market data

- `ERCOT_MIS` (default): `src/lib/ercot/mis.ts` reads ERCOT's MIS archive
  **directly** — no gateway, no credentials. Report enumeration queries the
  JSON listing API first (measured to surface new RT postings 23–35s before
  the website's page, at ~30ms of JSON vs ~2s of 600KB HTML) and keeps the
  website listing page as a scrape fallback:
  - MIS 12331 (`NP4-190-CD`, DAM Settlement Point Prices) — the daily
    day-ahead clearing for every hub and load zone, posted once the day
    before delivery (~12:35 Central). Final on arrival.
  - MIS 12301 (`SPPHLZNP6905`) — the rolling 15-minute real-time
    settlement points, a new file every 15 minutes, published ~2 minutes
    after each interval ends; and the **hourly settlement series**
    aggregated per ERCOT's equal-time rule (the mean of the four 15-minute
    settlement intervals in the hour), emitted only when all four intervals
    exist. One report serves both: MIS publishes no separate hourly report.
  - MIS 13045 (`NP4-197`, RTM price corrections) — the corrected 15-minute
    prices ERCOT posts before (and, Board-directed, after) the finality
    deadline. Ingestion applies each SPP document once
    (`apply_rtm_price_corrections`): corrected intervals the store holds are
    published as new observations and each affected hour is re-averaged.
    Corrections list only the prints that changed, so an `LZEW` row alone means
    the canonical `LZ` print stood; it is never taken in its place.
  - Every record's `published_at` comes from ERCOT's own posting stamp, so
    look-ahead protection filters on real publication time, not delivery time.
    The listing API's `PublishDate` carries the posting's Central wall time but
    the offset in force when the listing is *read*, so the wall time is
    resolved on its own date (`misPostedAt`).
  - ERCOT prints every load zone and DC tie **twice** per interval — once
    under its own type code (`LZ`/`DC`) and once under an EHV variant
    (`LZEW`/`DCEW`), prices within a rounding hair. The parser dedupes to
    the canonical typed print: they are one settlement observation, and an
    undeduped print corrupts the hourly average (a two-interval hour looks
    complete) while hubs, which print once, stay clean.
- `ERCOT_REPLAY`: drive the same adapter over a historical MIS corpus for
  replay trading — `npm run load:history` and `scripts/build-history-fixture.ts`.
- `GENERATED`: labeled deterministic simulated prices, kept only for offline
  tests and UI development. Never shown as ERCOT data.

Ingestion fetches each product independently (its own interval length) and
resumes **each (market, product) series from its own last published
interval**, so a market that fell behind is backfilled rather than being
skipped to match whichever market is furthest ahead. `INGEST_PRODUCTS`
overrides the set, defaulting to everything the source publishes;
`INGEST_MAX_RECORDS` bounds a run, and rows left for the next run are reported
as `recordsDeferred`/`truncated` rather than as success. Because MIS keeps
every daily report downloadable, past windows can always be re-resolved from
ERCOT's own files: `scripts/ingest-history.ts --gateway --from <ISO> --to <ISO>`
backfills mid-series gaps (a bounded run's revision policy deliberately leaves
rows below a series' cursor to it).

#### US/Central DST

ERCOT reports the two transition days the way the wall clock behaved: the
spring day **skips** the 02:00 hour (23 delivery hours) and the fall day
**repeats** 01:00 (25), with `RepeatedHourFlag` identifying the repeated row.
`deliveryCentralToUtc` resolves each hour-ending against the offset actually
then in effect, so the skipped hour yields no instant and the repeated hour
yields two distinct ones. Handling this with a single offset per day loses one
settlement hour every November and double-books one every March.

Seen ingestion state: `GET /api/market-data/status` (recent runs plus the newest
delivery per series); manual run: `POST /api/cron/ingest` with
`Authorization: Bearer $CRON_SECRET`.

#### Scheduling and catch-up

Ingestion is triggered from the database: migration 0029 schedules
`/api/cron/ingest` at :03/:18/:33/:48 (each RT interval posts ~2 minutes after
it ends) and `/api/cron/settle` at :25, through `pg_net`, with the site URL and
`CRON_SECRET` read from Supabase Vault (`powerflow_app_url`,
`powerflow_cron_secret`). Responses land in `net._http_response`.

A run never reaches back further than `INGEST_MAX_LOOKBACK_HOURS` (default 48):
the RT series is one MIS file per 15-minute interval, so an unbounded catch-up
after downtime cannot finish in one invocation and the series would never
advance. Gaps older than that are filled with `scripts/backfill-ercot.ts`
(`npx tsx scripts/backfill-ercot.ts --from 2026-09-20`): it takes ERCOT's
rolling reports first (real posting stamps), then the annual archives
(NP6-785 RTM, NP4-180 DAM, NP4-181 AS) for anything older, writing only
intervals that have no observation yet. Archive rows are labelled
`ERCOT_MIS_HISTORY`; where the archive and the live reports overlap they agree
to the cent. `npx tsx scripts/setup-scheduler.ts` applies 0029 and stores the
two Vault values in one step.
`INGEST_MAX_RECORDS` is shared round-robin across products, oldest delivery
first, so one large backlog cannot starve the other series.

### Products: a price is never "the price"

ERCOT publishes different prices for the same delivery interval, so a price is
only meaningful as **(settlement point, product, interval)**. The `products`
catalog stores that explicitly, and every price row, trade and position carries
its product:

| Product | Series | Interval |
| --- | --- | --- |
| `DAM_HOURLY` | Day-ahead market clearing SPP | 60 min |
| `RTM_15MIN` | Real-time settlement interval | 15 min |
| `RTM_HOURLY` | Real-time hourly average (RTH) | 60 min |
| `REGUP` `REGDN` `RRS` `NSPIN` `ECRS` | Ancillary-service clearing prices | 60 min |
| `DRRS` | Dispatchable Reliability Reserve Service (in design) | 60 min |
| `CRR_OBLIGATION` / `CRR_OPTION` | Congestion revenue rights | 60 min |

`REGUP`, `REGDN`, `RRS`, `NSPIN` and `ECRS` are ERCOT's published
ancillary-service price series — ERCOT's own AS price report lists exactly
those five. RRS is deliberately **one** series: its Primary/Under/Fast
Frequency Response split is a requirement allocation *inside* RRS, not three
products, so modelling the tiers would invent prices ERCOT never publishes.
`DRRS` is a real service still being designed (NPRR1235, PUCT guidance, TAC
workshops through March 2026) with no series yet, catalogued so one has
somewhere to land.

A product's `tradable` flag is about the **series**, not about whether the desk
can open a position. Ancillary services stay non-tradable because supplying one
is a resource obligation that needs a qualified asset behind it; this desk
simulates a financial participant with none. Positions are held in
*instruments* (below), and a CRR or day-ahead PTP instrument is open to order
entry even though the congestion series it settles off is not. A day-ahead and
a real-time position for the same market and hour are **different instruments**
— the position identity is
`(user, instrument, market, second leg, product, delivery window)`.

Price bounds follow ERCOT's actual economics rather than one clamp:

- administrative floor **−$251/MWh** (day-ahead and real-time);
- real-time offer cap **$2,000/MWh**, day-ahead offer cap **$5,000/MWh**
  (RTC+B, live since Dec 5, 2025), with effective VOLL at $5,000;
- because offer caps are *not* price caps, storage bounds are wider
  (`-2000 < price < 20000`) so extreme congestion — which really can push LMP
  past the cap — is representable rather than silently truncated.

The simulated feed models the two energy markets separately, derives the
hourly real-time price as the average of its four 15-minute intervals, and
prices the load zones in the IMM's 2024–2025 ordering (West rich, Houston
cheap).

The location universe covers the five regional hubs (`HB_HOUSTON/NORTH/SOUTH/
WEST/PAN`), the published hub averages (`HB_HUBAVG`, `HB_BUSAVG`), the four
competitive load zones, the four non-opt-in entity zones (`LZ_AEN`, `LZ_CPS`,
`LZ_LCRA`, `LZ_RAYBN`) and resource nodes. Hub averages are *derived* (evaluated
per interval as the average of their member locations), matching how ERCOT
publishes them. Real node and DC-tie codes come from ERCOT's Settlement Points
List on ingestion; the simulated ones are synthesized and labelled as such.

### Instruments vs products

Products are price series. **Instruments are what a position is actually held
in**, and most of what trades in ERCOT is not a single price series:

| Instrument | Legs | Settles by |
| --- | --- | --- |
| `ENERGY_SPOT` | 1 point | that point's price for the interval |
| `VIRTUAL` (INC/DEC) | 0 — purely financial | day-ahead → real-time convergence |
| `DART_SPREAD` | 1 point, two markets | DA vs RT convergence |
| `BASIS_SPREAD` | 2 points | price difference |
| `PTP_OBLIGATION` / `PTP_OPTION` | source + sink | real-time spread less day-ahead spread |
| `AS_CAPACITY` | 1 point | capacity clearing price ($/MW-hr) — needs a resource |
| `CRR_OBLIGATION` / `CRR_OPTION` | source + sink | day-ahead congestion difference (auctioned) |
| `BLOCK_FORWARD` / `INDEX_SWAP` / `PRICE_OPTION` | 1 index | average over a window |

The two congestion pairs are **different ERCOT products**, not one with a flag.
A CRR bought in the auction settles on the day-ahead congestion between sink and
source alone (Nodal Protocols 7.9.1.1). A PTP obligation submitted into the
day-ahead market is bought at the day-ahead spread and settled at the real-time
spread, so what it carries is the *convergence* of congestion across the path —
a fifth settlement rule, `CONGESTION_CONVERGENCE` (migration 0017). Until that
landed, both pairs were priced as the day-ahead spread, which made the
day-ahead market product unrepresentable.

OTC instruments are a **venue** rather than a price source: they carry no
series of their own and settle against the ERCOT prices they reference.

Every one of these can be placed from the order ticket on a market page, where
the instrument choice drives the rest of the form — a spread asks for a second
settlement point, a block forward asks for a window length, and a legless or
path instrument settles in a market it does not get to choose, so it shows the
derived product instead of offering one. The ticket previews a price only where
it can derive one from what the page holds (a point, or a fully covered
window) and says *composed at execution* otherwise, rather than previewing a
spread from its first leg. The form logic is `src/lib/trading/order-form.ts`,
kept out of the component so the window arithmetic, the derived product and the
request body are unit-tested instead of click-tested.

#### How an instrument is priced and held

An instrument reduces its legs to a single price — its own — and that scalar is
what the position is held at. Because every shape collapses to one number, the
weighted-average accounting applies unchanged to a spot fill, a two-sided
spread, a convergence trade and a window average:

| Rule | Instrument price |
| --- | --- |
| `POINT` | leg A's price for the interval |
| `DIFFERENCE` | leg B − leg A (sink minus source), so a long profits on A→B congestion |
| `CONVERGENCE` | real-time − day-ahead, priced off the day-ahead series |
| `AVERAGE` | leg A's price averaged over the settlement window |

An **option** floors at zero (it can only pay out); an **obligation** pays both
ways. A legless instrument still names a settlement point and interval to
settle against — what it lacks is a *delivery* leg.

A price here can be a spread, and a spread has wider bounds than either point:
two points at their storage limits are $22,000 apart, which is what
`trades.execution_price` allows.

The table gives each rule's payoff. The two convergence rules reach it in two
steps: a position is held at its day-ahead entry and marked at what it would
settle at, so unrealized P&L is the mark less the entry. A virtual marks at the
hourly real-time price and a PTP at the real-time spread; before the hour has
posted they mark at its newest 15-minute prints, and before real time at the
day-ahead leg they cleared at, so an open position is never unpriced for want of
a real-time print.

Two consequences worth knowing:

- A path or legless instrument has no product of its own, so its product is
  **derived** (the day-ahead market it clears in) rather than taken from the
  caller. That keeps the identity canonical: two virtual trades on the same
  point and interval cannot land in different positions because the caller
  passed a different product.
- A window instrument's `delivery_start`/`delivery_end` are the settlement
  **window**, not an interval, so there is no second pair of columns to keep in
  sync — the same identity covers both.

#### Units

A product's `pricedPer` is the unit its position quantity is held in: energy
settles in `$/MWh` over **MWh**, and ancillary services clear as capacity rates
in `$/MW-hr` over **MW**. Those are different dimensions, so:

- **volume is reported per unit** (`{ unit, long, short, net }`) and never
  totalled across units — 100 MWh and 100 MW are not 200 of anything. An
  uncatalogued product is bucketed as `UNKNOWN` and labelled "unclassified"
  rather than being assumed to be energy.
- **every quantity column is labelled with its row's unit**, so a capacity
  position never reads as "MWh".
- **gross notional** stays dollars in both cases, because a capacity price is a
  rate over that product's own settlement interval (`$/MW-hr` over an hourly
  product is dollars for the hour). A sub-hourly capacity product would need
  the interval duration factored in; none is catalogued.

Volume and realized P&L are *mark-independent*, so both are reported even for a
position whose instrument price cannot be resolved. Only marked value,
exposure and unrealized P&L require a mark.

The engine is implemented twice on purpose: `public.execute_trade` (migration
0008, with its pricing in `public.instrument_price` as amended by 0017) is
authoritative, and `src/lib/trading/instruments.ts` mirrors its rules so the
read side, analytics and tests can price without a round trip. Tests pin the
two together — and `src/lib/trading/sql-congestion.test.ts` additionally
compares the **deployed catalog tables** to the TypeScript catalog, because a
migration can be recorded as applied and still not have done what it says.

Reads mark each open position through `public.position_marks`, which reduces
legs the same way; the read side never recomputes a mark from a point price,
because a spread has no single series and a window has no single interval. An
instrument that cannot be marked is reported as **unpriced, never zero**.

## Security model

- RLS enabled on every user-owned table; policies scoped to `auth.uid()`.
- No direct client INSERT/UPDATE/DELETE on `trades`, `positions`,
  `paper_accounts`, or `audit_events`. All state changes go through
  `execute_trade` (single transaction, row-locked).
- Function ACLs are revoked from `PUBLIC` **and `anon`**; `execute_trade` is
  `authenticated`-only, `ensure_user_records` and `get_leaderboard` are
  service-role-only. Supabase's default privileges grant EXECUTE to `anon` on
  every function created in `public`, so revoking `PUBLIC` alone is not enough
  — leaving `anon` in place made the `SECURITY DEFINER` bootstrap callable
  without a session (migration 0012). `ensure_user_records` additionally
  refuses a user session acting for another id. SECURITY DEFINER functions pin
  `search_path`.
- `trades` / `audit_events` are immutable (triggers raise on UPDATE/DELETE).
- Money is column-typed `numeric`, never floats; client math is `bigint` with a
  fixed 1e6 scale.
- The boundary is tested by attacking it, not by reading the policies:
  `src/lib/security.rls.test.ts` signs in a real second user (and a bare anon
  key) and tries to read and write the first user's money, and
  `src/lib/trading/sql-concurrency.test.ts` races the cash balance. Both are
  opt-in with `npm run test:db`.
- Auth cookies are `httpOnly` + `Secure` (production); email/password sign-in
  happens server-side; OAuth uses PKCE. Post-sign-in redirects only accept
  internal paths (`safeNextPath`).
- Leaderboard is computed by a `SECURITY DEFINER` function (returning raw
  `user_id`s) and is reached only from server code with the service role; the
  browser-facing RPC is not exposed. Its public faces (the Rank page and
  `GET /api/leaderboard`) go through `src/lib/standings.ts`, which drops user
  ids and usernames and lists only accounts that have chosen a display name.
  Default names are random, never derived from the email (migration 0036), and
  uploaded pictures are stored under random names, not user ids.
- Auth errors are answered without saying whether an address has an account
  (login, sign-up, email change, forgot password).
- Profiles are written only through definer functions (migration 0035): the
  own-row insert/update policies and table write grants are gone, so a session
  cannot point its avatar at an arbitrary URL or flip its standings flag
  without an audit row. `update_profile` validates names (mirrored in
  `src/lib/profile.ts`); `set_profile_avatar` is service-role-only and is
  called after `/api/account/avatar` has checked the upload's actual bytes.
  Pictures live in the public `avatars` bucket, which has no write policies.
- Account changes are confirmed by email. An email change is Supabase's own
  two-sided confirmation; a password is set only from a session opened by an
  emailed recovery link within the last 30 minutes (read from the verified
  token's `amr` claim, `src/lib/account.ts`), after which other sessions are
  signed out. Account deletion requires typing the username and cascades
  through every user table (0005), with stored pictures removed first.
- Service-role usage is isolated to trusted server code. Cron is secret-guarded.
  Sign-out is POST-only.
- Before launch: confirm Supabase Auth (email confirmations, rate limits),
  rotate the service-role key to Vercel, and set `NEXT_PUBLIC_SITE_URL`.

## Project layout

```
src/
  app/                 # pages, route handlers, proxy.ts
    (shell)/           # authed app (nav + footer layout)
    (auth)/            # login / signup
  components/          # nav, markets strip, trade panel, charts, …
  lib/
    money.ts           # exact fixed-point money (bigint)
    trading/           # accounting engine + replay (mirrors the RPC)
    ercot/             # types, simulated feed, MIS CSV adapter
    supabase/          # browser / SSR / admin clients + config
    auth.ts            # session helpers, account bootstrap
    queries.ts         # trusted read-side queries
    analytics.ts       # trade replay analytics
    markets.ts         # market views + status
  api/lib.ts           # response helpers
supabase/migrations/   # 0001 schema · 0002 execute_trade · 0003 leaderboard
                       # 0004 ACLs · 0005 cascade · 0006 products
                       # 0007 instruments · 0008 instrument engine
                       # 0009 settlement-point types · 0010 order idempotency
                       # 0011 strict pricing · 0012 security boundary
                       # 0013 automatic settlement · 0014 margin
                       # 0015 settlement price provenance
                       # 0016 immutability guards · 0017 ERCOT catalog + PTP settlement
                       # 0018 ancillary-service catalog
                       # 0019 anon EXECUTE grants revoked
scripts/seed.ts        # historical simulated prices + markets
scripts/browser-check.ts  # the sign-in screens, in a real browser
vercel.json            # cron schedule
```