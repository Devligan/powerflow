---

name: powerflow-ercot-paper-trading
description: Build and maintain PowerFlow, a secure full-stack ERCOT electricity paper-trading platform using Next.js, TypeScript, Supabase, and Vercel. Implements ERCOT market-data ingestion, multi-user authentication, paper trading, positions, cash, P&L, analytics, leaderboard, auditability, and production-grade security.
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# PowerFlow — ERCOT Paper Trading Platform

## Role

You are an expert full-stack software engineer building **PowerFlow**, a production-quality, multi-user ERCOT electricity paper-trading platform.

The application is a portfolio project designed to demonstrate:

* Full-stack software engineering
* Secure multi-user application design
* Database design
* Authentication and authorization
* Financial/trading-system concepts
* ETRM concepts
* Market-data ingestion
* Data reliability engineering
* Transactional data integrity
* Analytics
* Clean UI/UX

The application is **paper trading only**. No real money or real orders may ever be involved.

The primary market is **ERCOT electricity prices**.

---

# 1. Product Definition

PowerFlow allows users to simulate trading ERCOT electricity prices using virtual capital.

A user should be able to:

1. Create an account.
2. Sign in with email/password.
3. Sign in with Google.
4. Sign in with Apple.
5. Receive a virtual starting balance.
6. Browse ERCOT prices.
7. Select a supported ERCOT settlement point/hub.
8. Select a delivery date/interval.
9. Place a simulated buy or sell trade.
10. Receive confirmation containing the exact simulated execution price and timestamp.
11. View open positions.
12. View realized and unrealized P&L.
13. View portfolio value.
14. Close/reverse positions.
15. View complete trade history.
16. View account analytics.
17. Compare performance against other users.
18. View a global leaderboard.

The application should feel like a simplified trading terminal/ETRM system rather than a generic CRUD application.

---

# 2. Technology Stack

Use:

* Next.js
* React
* TypeScript
* Tailwind CSS
* Supabase

  * PostgreSQL
  * Supabase Auth
  * Row Level Security
  * Database migrations
  * Database functions
  * Triggers where appropriate
* Vercel

Prefer the Next.js App Router.

Do not introduce unnecessary infrastructure.

Do not create a separate backend service unless there is a concrete requirement that cannot reasonably be solved with Next.js and Supabase.

---

# 3. Core Architecture

## ERCOT must never be in the synchronous trading path.

Never implement:

```text
Browser
    ↓
Next.js
    ↓
ERCOT API
    ↓
wait
    ↓
execute trade
```

Instead:

```text
                   ERCOT
                     │
                     ▼
             Background Ingestion
                     │
                     ▼
             Validation / Dedupe
                     │
                     ▼
                  Supabase
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
     Market Prices          Data Status
          │
          ▼
     Trading Engine
          │
          ▼
        User UI
```

The application trades against the **latest valid persisted ERCOT price**.

ERCOT is an external market-data source, not an application dependency.

If ERCOT is unavailable:

* Existing market data remains available.
* Existing positions remain available.
* Historical charts remain available.
* Portfolio pages remain available.
* Market-data freshness is displayed.
* New trades are accepted only when a valid persisted price exists.
* The UI never waits synchronously for ERCOT.

---

# 4. Market Data

The initial product focuses primarily on ERCOT LMP/price data.

Support major ERCOT:

* Hubs
* Load zones
* Settlement points where useful

The application must not be hard-coded around a single hub.

A market should contain:

```text
market
- id
- settlement_point
- settlement_point_type
- description
- active
```

Examples:

```text
HB_HOUSTON
HB_NORTH
HB_SOUTH
HB_WEST
LZ_HOUSTON
LZ_NORTH
LZ_SOUTH
LZ_WEST
```

Only include settlement points actually supported by the ingested dataset.

---

# 5. Historical Data

Historical ERCOT prices must be persisted in Supabase.

Historical data supports:

* Price charts
* Market exploration
* Portfolio valuation
* Analytics
* Demonstrations
* Historical analysis

The application must contain seeded historical data.

The demo must remain usable if ERCOT is completely unavailable.

---

# 6. Live Data Ingestion

Implement asynchronous ERCOT ingestion.

The ingestion process must:

1. Determine the latest stored market timestamp.
2. Request missing/new data.
3. Handle ERCOT delays.
4. Retry transient failures.
5. Respect rate limits.
6. Validate returned data.
7. Normalize source records.
8. Deduplicate records.
9. Persist valid records.
10. Record ingestion status.
11. Record failures safely.

The ingestion system must be **idempotent**.

Running the same ingestion operation multiple times must not create duplicate price records.

Use database uniqueness constraints as the final duplicate-protection mechanism.

---

# 7. ERCOT Reliability

ERCOT ingestion must tolerate:

* Slow responses
* HTTP errors
* Timeouts
* Rate limits
* Missing records
* Duplicate records
* Partial responses
* Authentication failures
* Unexpected response formats
* API downtime

Use:

* Request timeouts
* Exponential backoff
* Bounded retries
* Rate limiting
* Structured error logging
* Idempotent inserts
* Validation
* Last-known-good data
* Ingestion health status

Never retry indefinitely.

---

# 8. Market Data Freshness

Track:

* Last successful ingestion
* Latest market timestamp
* Data age
* Ingestion status

Example:

```text
ERCOT Market Data

Status: Healthy

Latest market timestamp:
10:55:00 AM

Last ingestion:
10:55:32 AM

Data age:
32 seconds
```

If stale:

```text
Status: Delayed

Latest valid price:
10:55:00 AM

Updated:
2 minutes ago
```

Never silently present stale data as live.

---

# 9. Paper Trading

Every user receives a configurable virtual starting balance.

Default:

```text
$100,000
```

There must be:

* No real money
* No deposits
* No withdrawals
* No payment processing
* No brokerage integration
* No real order execution

---

# 10. Trade Model

A paper trade contains:

```text
side
market
delivery_start
delivery_end
quantity_mwh
execution_price
price_timestamp
status
created_at
```

Supported sides:

```text
BUY
SELL
```

Trades execute against the latest valid persisted ERCOT market price.

Do not implement a simulated order book for the MVP.

Do not pretend trades are real exchange executions.

Clearly label execution as:

```text
Simulated Execution Price
```

---

# 11. Trade Execution

Example:

```text
Market:
HB_HOUSTON

Side:
BUY

Quantity:
500 MWh

Delivery:
September 15, 2026
14:00–15:00
```

Suppose the persisted ERCOT price is:

```text
$67.42/MWh
```

Then:

```text
Notional =
500 × 67.42
=
$33,710
```

The server determines the authoritative execution price.

The client must never be able to submit:

```text
execution_price = 1
```

and override the market price.

Store:

```text
execution_price
execution_timestamp
price_source_timestamp
market_price_id
```

---

# 12. Position Model

A position represents net exposure for:

```text
user
+
market
+
delivery interval
```

Use signed quantity:

```text
+500 MWh = long 500
-500 MWh = short 500
  0 MWh = flat
```

BUY:

```text
position.quantity += quantity
```

SELL:

```text
position.quantity -= quantity
```

Example:

```text
BUY 500
→ +500

SELL 200
→ +300

SELL 300
→ 0

SELL 200
→ -200
```

---

# 13. Average Entry Price

Use weighted-average cost for the MVP.

Example:

```text
BUY 500 @ $60
BUY 300 @ $70
```

Then:

```text
Quantity:
800 MWh

Average entry:
(500 × 60 + 300 × 70) / 800

= $63.75/MWh
```

The accounting method must be documented and consistently applied.

---

# 14. Closing Positions

Example:

```text
Position:
+800 MWh @ $63.75
```

User executes:

```text
SELL 300 @ $70
```

Realized P&L:

```text
($70 - $63.75) × 300
=
+$1,875
```

Remaining:

```text
+500 MWh @ $63.75
```

Do not modify the historical BUY trade.

The SELL is a new immutable trade.

---

# 15. Unrealized P&L

For a long:

```text
(current_price - average_entry_price)
× quantity
```

For a short:

```text
(current_price - average_entry_price)
× signed_quantity
```

Because quantity is signed, the unified formula is:

```text
unrealized_pnl =
(current_mark - average_entry_price)
× signed_quantity
```

Example:

```text
+500 @ $63.75
Current = $70

($70 - $63.75) × 500
=
+$3,125
```

---

# 16. Cash Model

Each user has one paper account.

```text
paper_accounts
────────────────────────
id
user_id
starting_cash
cash_balance
created_at
updated_at
```

`cash_balance` represents virtual cash available after executed trades.

BUY:

```text
cash_balance -= buy_notional
```

SELL:

```text
cash_balance += sell_notional
```

Example:

```text
Starting cash:
$100,000

BUY 500 @ $60

Notional:
$30,000

Cash:
$70,000
```

Cash must be updated transactionally with the trade.

The client must never directly modify cash.

---

# 17. Equity Model

Do not independently trust a client-provided portfolio value.

Portfolio equity is:

```text
equity =
cash_balance
+
marked_value_of_positions
```

Total P&L is:

```text
total_pnl =
equity - starting_cash
```

And must reconcile with:

```text
total_pnl =
realized_pnl + unrealized_pnl
```

Example:

```text
Starting cash:       $100,000
Cash:                 $70,000
Position:             +500 MWh
Current mark:         $70

Position value:
500 × $70 = $35,000

Equity:
$70,000 + $35,000
= $105,000

Total P&L:
+$5,000
```

---

# 18. Financial Invariants

These must always reconcile.

```text
equity =
cash + marked_position_value
```

```text
total_pnl =
equity - starting_cash
```

```text
total_pnl =
realized_pnl + unrealized_pnl
```

```text
position_quantity =
Σ BUY quantity - Σ SELL quantity
```

These should have automated tests.

---

# 19. Trade vs Position

Keep these concepts separate.

## Trade

An immutable historical event.

```text
BUY
500 MWh
HB_HOUSTON
$60/MWh
14:00–15:00
```

## Position

Current aggregate exposure.

```text
+500 MWh
Average entry: $60
```

Never overwrite historical trades to update positions.

The conceptual flow is:

```text
Executed Trades
      ↓
Position Accounting
      ↓
Current Position
      ↓
Mark to Market
      ↓
P&L
```

---

# 20. Short Selling

Support long and short positions.

Use a configurable virtual exposure/margin limit.

For example:

```text
max_gross_notional
```

Before execution:

```text
new gross exposure <= configured limit
```

The limit must be enforced server-side.

Do not implement complex real-world clearing/margin systems.

---

# 21. Atomic Trade Transaction

Trade execution must be transactional.

One operation must:

1. Authenticate the user.
2. Validate the market.
3. Validate delivery interval.
4. Retrieve the authoritative persisted market price.
5. Validate quantity.
6. Validate virtual capital/exposure.
7. Create the trade.
8. Update the position.
9. Update cash where applicable.
10. Create the audit event.

If any step fails:

```text
ROLLBACK
```

Never allow:

```text
trade exists
but
position does not
```

or:

```text
cash changed
but
trade does not exist
```

---

# 22. Concurrency

Account for concurrent trade requests.

Example:

```text
Request A:
BUY 80,000 MWh

Request B:
BUY 80,000 MWh
```

Both requests must not independently observe the same balance and overspend it.

Use database transactions, row locking, and/or appropriate PostgreSQL concurrency controls.

Frontend validation is not sufficient.

---

# 23. Authentication

Use Supabase Auth.

Support:

* Email/password
* Google
* Apple

Never store passwords in application tables.

---

# 24. Profiles

Create:

```text
profiles
- id
- username
- display_name
- avatar_url
- leaderboard_opt_in
- created_at
- updated_at
```

`id` corresponds to the authenticated Supabase user.

Usernames must be unique.

Only intentionally public profile fields should appear on the leaderboard.

---

# 25. Security

Treat the application as a real multi-user financial application even though it uses virtual funds.

Mandatory:

* Supabase Auth
* RLS
* Server-side authorization
* Input validation
* Database constraints
* Transactional operations
* Immutable trade history
* Immutable audit records
* Server-authoritative balances
* Server-authoritative execution prices

Never expose the Supabase service-role key to the browser.

Never trust:

```text
client_balance
client_pnl
client_execution_price
client_position
client_rank
```

---

# 26. Row Level Security

RLS is mandatory on private tables.

A user may access:

```text
their account
their trades
their positions
their analytics
their audit events
```

A user must not access:

```text
another user's account
another user's trades
another user's positions
another user's audit events
```

Users must not be able to directly update financial state.

Never disable RLS merely to simplify development.

---

# 27. Audit Events

Maintain immutable audit records.

Examples:

```text
USER_CREATED
TRADE_CREATED
TRADE_VALIDATED
TRADE_EXECUTED
TRADE_REJECTED
POSITION_UPDATED
ACCOUNT_UPDATED
PROFILE_UPDATED
```

Store:

```text
id
user_id
event_type
entity_type
entity_id
metadata
created_at
```

Users cannot modify or delete audit events.

---

# 28. Database Schema

At minimum implement:

## profiles

```text
id UUID PRIMARY KEY
username TEXT UNIQUE NOT NULL
display_name TEXT
avatar_url TEXT
leaderboard_opt_in BOOLEAN NOT NULL DEFAULT true
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

## paper_accounts

```text
id UUID PRIMARY KEY
user_id UUID UNIQUE NOT NULL
starting_cash NUMERIC NOT NULL
cash_balance NUMERIC NOT NULL
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

## markets

```text
id UUID PRIMARY KEY
settlement_point TEXT UNIQUE NOT NULL
settlement_point_type TEXT
description TEXT
active BOOLEAN NOT NULL
```

## market_prices

```text
id UUID PRIMARY KEY
market_id UUID NOT NULL
delivery_timestamp TIMESTAMPTZ NOT NULL
price NUMERIC NOT NULL
source TEXT NOT NULL
source_timestamp TIMESTAMPTZ
ingested_at TIMESTAMPTZ NOT NULL
```

Create an appropriate unique constraint for:

```text
market
+
delivery interval
+
market product
```

## trades

```text
id UUID PRIMARY KEY
user_id UUID NOT NULL
market_id UUID NOT NULL
side TEXT NOT NULL
quantity_mwh NUMERIC NOT NULL
delivery_start TIMESTAMPTZ NOT NULL
delivery_end TIMESTAMPTZ NOT NULL
execution_price NUMERIC NOT NULL
price_timestamp TIMESTAMPTZ NOT NULL
market_price_id UUID NOT NULL
status TEXT NOT NULL
created_at TIMESTAMPTZ NOT NULL
executed_at TIMESTAMPTZ
```

## positions

```text
id UUID PRIMARY KEY
user_id UUID NOT NULL
market_id UUID NOT NULL
delivery_start TIMESTAMPTZ NOT NULL
delivery_end TIMESTAMPTZ NOT NULL
quantity_mwh NUMERIC NOT NULL
average_entry_price NUMERIC NOT NULL
realized_pnl NUMERIC NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

Create a uniqueness constraint on the position identity.

## audit_events

Immutable audit records.

## ingestion_runs

```text
id
source
started_at
finished_at
status
records_received
records_inserted
records_skipped
error_message
```

---

# 29. Database Rules

Use:

* UUIDs
* Foreign keys
* NOT NULL constraints
* CHECK constraints
* UNIQUE constraints
* PostgreSQL `numeric`
* `timestamptz`
* Appropriate indexes

Never use JavaScript floating-point arithmetic as the authoritative accounting system.

Important indexes:

```text
market_prices(market_id, delivery_timestamp)
trades(user_id, created_at)
trades(user_id, market_id)
positions(user_id, market_id)
audit_events(user_id, created_at)
```

---

# 30. Account Initialization

When a user first signs in:

1. Create profile if missing.
2. Create paper account if missing.
3. Assign starting cash.
4. Ensure the operation is idempotent.

Repeated logins must never reset the account.

Enforce this with database constraints.

---

# 31. UI

Keep the UI simple and professional.

Primary navigation:

```text
Dashboard
Markets
Trade
Positions
Trades
Analytics
Leaderboard
Profile
```

Prioritize usability over visual effects.

Avoid:

* excessive animation
* flashy gradients
* unnecessary 3D
* overcomplicated navigation

The application should resemble a serious internal trading application.

---

# 32. Dashboard

Show:

```text
Portfolio Equity
Today's P&L
Total Return
Available Cash
Open Positions
Total Volume
```

Also show:

* Recent trades
* Current positions
* Market-data status
* Compact price chart

---

# 33. Markets

Allow users to:

* Browse ERCOT markets
* View current prices
* View historical prices
* Select delivery intervals
* Navigate to trading

Example:

```text
HB_HOUSTON

$67.42/MWh

+8.4%

Last update:
10:55 AM
```

---

# 34. Trading Screen

Example:

```text
HB_HOUSTON

Current ERCOT Price
$67.42/MWh

Side
[ BUY ] [ SELL ]

Quantity
[ 500 ]

Delivery
[ September 15, 2026 ]

Interval
[ 14:00–15:00 ]

Estimated Notional
$33,710

Available Cash
$72,450

[ PLACE PAPER TRADE ]
```

Before confirmation:

```text
This is a paper trade using virtual funds.
```

After execution:

```text
Paper Trade Executed

BUY 500 MWh
HB_HOUSTON
$67.42/MWh

Execution:
10:56:03 AM
```

---

# 35. Positions

Display:

```text
Market
Delivery
Quantity
Average Entry
Current Mark
Unrealized P&L
```

Allow users to initiate closing/reversing trades.

---

# 36. Trade History

Display:

```text
Time
Market
Side
Quantity
Execution Price
Status
P&L
```

Support filtering by:

* Market
* Side
* Date
* Status

Executed trades are immutable.

---

# 37. Analytics

Provide:

* Total return
* Realized P&L
* Unrealized P&L
* Number of trades
* Win rate
* Average trade P&L
* Best trade
* Worst trade
* Total MWh traded
* Long volume
* Short volume
* P&L over time
* P&L by market
* P&L by day
* Maximum drawdown

Do not overcomplicate the analytics.

---

# 38. Leaderboard

Create a global leaderboard.

Primary ranking metric:

```text
Return %
```

Show:

```text
Rank
Username
Return %
P&L
Trades
Win Rate
```

Only users who opt into the leaderboard should appear.

Do not expose:

* Email
* Private trades
* Account internals
* Private audit records

Leaderboard values must be calculated from trusted persisted data.

---

# 39. API

Use typed server-side interfaces.

Possible endpoints:

```text
GET  /api/markets
GET  /api/markets/:id
GET  /api/markets/:id/prices
GET  /api/portfolio
GET  /api/positions
GET  /api/trades
POST /api/trades
GET  /api/analytics
GET  /api/leaderboard
GET  /api/market-data/status
```

Route Handlers or Server Actions are both acceptable.

Do not create endpoints that simply proxy ERCOT requests to the browser.

---

# 40. Input Validation

Validate all user-controlled input.

Examples:

```text
quantity > 0
market exists
side is BUY or SELL
delivery interval is valid
user is authenticated
```

Use Zod or equivalent typed validation.

Database constraints must provide a second layer of protection.

---

# 41. Error Handling

Never expose internal implementation details to users.

Do not expose:

* SQL errors
* stack traces
* service keys
* database credentials
* infrastructure details

Display useful messages.

Example:

```text
Unable to complete the paper trade.

The market data required for this trade is currently unavailable.
```

Log technical details server-side.

---

# 42. Performance

Use Supabase/PostgreSQL as the persisted source of market data.

Do not repeatedly call ERCOT for the same information.

Use pagination for:

* Trades
* Audit events
* Large historical price sets

Avoid loading thousands of records unnecessarily on the dashboard.

---

# 43. Testing

Testing is mandatory.

## Trading

Test:

* Buy
* Sell
* Position creation
* Position reduction
* Position reversal
* Long positions
* Short positions
* Realized P&L
* Unrealized P&L
* Cash updates
* Equity reconciliation
* Insufficient capital
* Invalid quantity
* Invalid market
* Missing price
* Stale price

## Security

Test:

* Unauthenticated users cannot trade.
* Users cannot read another user's trades.
* Users cannot read another user's positions.
* Users cannot modify another user's account.
* Users cannot directly modify cash.
* Users cannot delete audit records.

## Ingestion

Test:

* Valid ERCOT record
* Duplicate record
* Malformed record
* Timeout
* Retry
* Rate limit
* Partial response
* Idempotent re-run

## Account initialization

Test:

* New user receives starting cash.
* Repeated initialization does not reset cash.
* Concurrent initialization does not create duplicate accounts.

## Concurrency

Test simultaneous trades against the same account.

---

# 44. Deployment

Target:

```text
Vercel
    +
Supabase
```

Provide:

```text
.env.example
```

Never commit secrets.

Keep server-only credentials server-side.

Use Supabase migrations for schema changes.

Do not rely on local filesystem state.

Do not rely on a permanently running process.

---

# 45. Ingestion Scheduling

Use a serverless/scheduled architecture compatible with Vercel and Supabase.

Ingestion should execute in bounded chunks.

If a job is interrupted:

```text
next run
    ↓
read persisted latest timestamp
    ↓
resume safely
```

Never depend on process memory for ingestion state.

---

# 46. Data Normalization

Create an ERCOT-specific adapter.

Architecture:

```text
ERCOT API
    ↓
ERCOT parser
    ↓
Normalized market record
    ↓
Supabase
    ↓
Application
```

The trading engine must not depend directly on ERCOT response formats.

If the ERCOT API changes, ideally only the adapter/parser needs modification.

---

# 47. Observability

Track:

* Ingestion status
* Last successful ingestion
* Latest market timestamp
* Records received
* Records inserted
* Records skipped
* Error messages
* Ingestion duration
* Data freshness

Expose basic market-data health information in the UI.

---

# 48. Seed Data

The deployed application should contain:

* Several ERCOT markets
* Historical prices
* Example portfolio/trading data where appropriate
* Leaderboard data if needed for the demo

Never fabricate something and label it as live ERCOT data.

Clearly distinguish:

```text
Historical / Seeded
```

from:

```text
Live Ingested
```

---

# 49. Development Order

Implement vertically.

## Phase 1

* Next.js
* TypeScript
* Tailwind
* Supabase
* Authentication
* Database migrations
* RLS
* Profiles
* Paper accounts

## Phase 2

* ERCOT adapter
* Historical ingestion
* Market tables
* Price tables
* Seed data
* Freshness status

## Phase 3

* Trade engine
* Cash accounting
* Positions
* P&L
* Trade history

## Phase 4

* Dashboard
* Markets
* Trading UI
* Positions
* Analytics
* Leaderboard

## Phase 5

* Reliability
* Retries
* Idempotency
* Monitoring
* Error handling
* Stale-data behavior

## Phase 6

* Tests
* Security review
* README
* Deployment
* UI polish

---

# 50. Engineering Rules

Always:

* Inspect the existing repository before changing it.
* Preserve working functionality.
* Prefer incremental changes.
* Use migrations for schema changes.
* Use server-side financial logic.
* Use database constraints.
* Write tests for accounting logic.
* Run type checking.
* Run linting.
* Run tests before declaring completion.
* Keep the README current.

Never:

* Put secrets in client code.
* Trust client balances.
* Trust client execution prices.
* Call ERCOT directly from the trading UI.
* Mutate executed trades.
* Disable RLS to make development easier.
* Use floating-point arithmetic as authoritative financial accounting.
* Introduce unnecessary infrastructure.

---

# 51. Acceptance Criteria

The application is complete when:

## Authentication

* [ ] Email/password registration works.
* [ ] Email/password login works.
* [ ] Google login works.
* [ ] Apple login works.
* [ ] Logout works.
* [ ] Protected routes require authentication.

## Accounts

* [ ] Each user has exactly one paper account.
* [ ] Starting cash is granted exactly once.
* [ ] Users cannot directly modify cash.

## Market Data

* [ ] Historical ERCOT prices are available.
* [ ] New ERCOT data can be ingested.
* [ ] ERCOT is not called synchronously by the UI.
* [ ] Duplicate data is prevented.
* [ ] Ingestion failures are handled.
* [ ] Data freshness is visible.
* [ ] Last-known-good data remains available.

## Trading

* [ ] User can select a market.
* [ ] User can select delivery interval.
* [ ] User can BUY.
* [ ] User can SELL.
* [ ] Execution price comes from persisted market data.
* [ ] Trade execution is transactional.
* [ ] Cash updates correctly.
* [ ] Positions update correctly.
* [ ] Realized P&L updates correctly.
* [ ] Unrealized P&L updates correctly.
* [ ] Equity reconciles.
* [ ] Invalid trades are rejected.
* [ ] Concurrent trades cannot corrupt account state.

## Analytics

* [ ] Portfolio equity works.
* [ ] Total P&L works.
* [ ] Realized P&L works.
* [ ] Unrealized P&L works.
* [ ] Return percentage works.
* [ ] Trade statistics work.
* [ ] P&L history is displayed.

## Leaderboard

* [ ] Ranking works.
* [ ] Ranking uses trusted data.
* [ ] Opted-out users are excluded.
* [ ] Private data is not exposed.

## Security

* [ ] RLS is enabled.
* [ ] Private data is isolated by user.
* [ ] Service-role credentials never reach the browser.
* [ ] Financial state cannot be modified directly by clients.
* [ ] Audit events are immutable.
* [ ] Server-side authorization exists.
* [ ] Inputs are validated.

## Deployment

* [ ] Application deploys to Vercel.
* [ ] Supabase production environment works.
* [ ] Environment variables are documented.
* [ ] Historical/demo data is available.
* [ ] Application remains usable during ERCOT outages.

---

# 52. Final Goal

The finished application should communicate this architecture immediately:

```text
                ERCOT
                  │
                  ▼
          Reliable Ingestion
                  │
                  ▼
          Normalized Market Data
                  │
                  ▼
             Supabase
                  │
                  ▼
        Transactional Trade Engine
                  │
          ┌───────┴───────┐
          ▼               ▼
      Positions          Cash
          │               │
          └───────┬───────┘
                  ▼
                 P&L
                  │
          ┌───────┴───────┐
          ▼               ▼
      Analytics       Leaderboard
                  │
                  ▼
              Next.js UI
```

The project should demonstrate that the developer understands:

* External market-data dependencies
* Data ingestion
* Reliability
* Authentication
* Authorization
* RLS
* Transaction processing
* Financial accounting
* Position management
* Mark-to-market valuation
* P&L
* Auditability
* Multi-user security
* Production deployment

It is a **paper trading application**, but the engineering should resemble the standards expected of a serious energy trading/ETRM system.
