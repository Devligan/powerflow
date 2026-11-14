import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Lamp } from "@/components/ui/lamp";
import { Stat } from "@/components/ui/stat";
import { loadSystemStatus } from "@/lib/system-status";
import { timeAgo } from "@/lib/format";
import { SOURCE_REPO, sourceUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "How it's built — PowerFlow",
  description:
    "What a power-trading desk can't get wrong, and how PowerFlow gets it right: no look-ahead, ERCOT's own bidding and settlement rules, exact money, and books that reconcile themselves every hour.",
};

/**
 * The engineering case study, public so it can be read without an account.
 *
 * Written as the problems a real desk has rather than as a list of tools: each
 * one says what goes wrong, what PowerFlow does about it, and where in the
 * source (and its tests) a reader can check. The live figures at the top come
 * from the same status the /status page and the Production workflow read, so
 * the page's claims about itself are checked, not asserted.
 */

type Proof = { label: string; path: string };

const PROBLEMS: Array<{ title: string; risk: string; answer: string; proof: Proof[] }> = [
  {
    title: "No peeking at tomorrow",
    risk:
      "A replay that can see a price before ERCOT published it is a backtest that lies. It is the easiest bug to ship and the hardest to notice.",
    answer:
      "Every price is stored with the moment ERCOT posted it, revisions included, and every fill, mark and margin check reads prices as of the account's own clock. A practice desk rewinds its clock; the database, not the screen, hides what had not happened yet.",
    proof: [
      { label: "As-of price engine", path: "supabase/migrations/0021_asof_price_engine.sql" },
      { label: "Replay tests", path: "src/lib/trading/sql-replay.test.ts" },
    ],
  },
  {
    title: "The day-ahead market's own rules",
    risk:
      "Paper trading that lets you buy at a price you can already see teaches the wrong game. In ERCOT you bid blind, before the auction closes.",
    answer:
      "Every position starts as a bid placed before 10:00 Central the day before delivery, on ERCOT's 0.1 MW grid, up to fourteen days out. It fills only at the actual clearing price, a limit only if the price crosses it, and it cannot be withdrawn once the gate has closed.",
    proof: [
      { label: "Bid deadline", path: "supabase/migrations/0038_dam_bid_deadline.sql" },
      { label: "Order tests", path: "src/lib/trading/sql-orders.test.ts" },
    ],
  },
  {
    title: "Settlement on ERCOT's calendar",
    risk:
      "Real-time prices are not final when they are first posted. ERCOT corrects them for two business days, and holidays, weekends and the 23- and 25-hour days of daylight saving all move the deadline.",
    answer:
      "A delivered position is marked on the prices as they arrive and settles at 16:00 Central on the second business day, at the corrected price where ERCOT corrected it. An hour with no published price is never filled or settled at a guess: it waits, and the screen says so.",
    proof: [
      { label: "Settlement calendar", path: "supabase/migrations/0044_settlement_calendar.sql" },
      { label: "Calendar tests", path: "src/lib/ercot/settlement-calendar.test.ts" },
      { label: "Price corrections", path: "src/lib/ercot/price-corrections.test.ts" },
    ],
  },
  {
    title: "Every cent accounted for",
    risk:
      "Floating-point money drifts, and a balance that can be edited in place can be wrong without anyone knowing.",
    answer:
      "Money is exact decimal in the database and fixed-point integers in the browser, to a millionth of a dollar. Fills and the audit log are append-only. Every hour the database proves every account's books against its fills, and the result is public.",
    proof: [
      { label: "Ledger reconciliation", path: "supabase/migrations/0054_ledger_reconciliation.sql" },
      { label: "Money math", path: "src/lib/money.ts" },
      { label: "Ledger tests", path: "src/lib/trading/sql-ledger.test.ts" },
    ],
  },
  {
    title: "The database is the engine",
    risk:
      "When the web server computes fills, two clicks, two tabs or one forged request can spend the same cash twice.",
    answer:
      "Fills, marks, margin and settlement run as Postgres functions in one transaction under a per-account lock. Orders are idempotent by client id, so a double submit fills once. A browser session may call only the handful of functions it needs and read only its own rows.",
    proof: [
      { label: "Concurrency tests", path: "src/lib/trading/sql-concurrency.test.ts" },
      { label: "Exploit tests", path: "src/lib/security.exploits.test.ts" },
      { label: "Least privilege", path: "supabase/migrations/0046_least_privilege.sql" },
    ],
  },
  {
    title: "Shipped like production",
    risk: "A trading system that is only correct on the day it was written is not correct.",
    answer:
      "Every change is a pull request. CI lints, type-checks, runs the unit suites, builds, audits dependencies, scans for secrets, and applies every migration to a fresh Postgres to run the engine suites against live ERCOT data. Schema changes are rehearsed in a rolled-back transaction against production first. After every deploy, and every six hours, a smoke check verifies the site, data freshness and the ledger.",
    proof: [
      { label: "CI pipeline", path: ".github/workflows/ci.yml" },
      { label: "Production check", path: ".github/workflows/production.yml" },
      { label: "Repository guards", path: "scripts/ci-guards.mjs" },
    ],
  },
];

const FLOW: Array<{ stage: string; detail: string }> = [
  { stage: "ERCOT", detail: "Public MIS reports: day-ahead clearing, 15-minute real time, ancillary services" },
  { stage: "Ingest", detail: "Scheduled in Postgres every 15 minutes; each price kept with its posting time" },
  { stage: "Engine", detail: "Bids, fills, marks, margin and settlement as audited database functions" },
  { stage: "Desk", detail: "The trading screens, reading the book as of each account's clock" },
  { stage: "Audit", detail: "Hourly reconciliation of every book, published on /status and alarmed in CI" },
];

export default async function EngineeringPage() {
  const status = await loadSystemStatus().catch(() => null);
  const ledger = status?.ledger ?? null;
  const run = status?.latestRuns[0] ?? null;
  const balanced = ledger != null && ledger.ok && !ledger.stale;

  return (
    <div className="space-y-8">
      <PageHeader
        kicker="How it's built"
        title="What a trading desk can't get wrong"
        aside={
          ledger && (
            <span className={`badge ${balanced ? "badge-green" : "badge-red"}`}>
              <Lamp pulse={balanced} />
              {balanced ? "Books balanced" : "Books need attention"}
            </span>
          )
        }
      >
        PowerFlow is a paper desk, but its books are kept to the standard of a real one. These are the six problems
        that decide whether a power-trading simulator is worth practising on, what PowerFlow does about each, and where
        to check it in the source.
      </PageHeader>

      <section aria-label="Live evidence" className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Books last reconciled"
          value={ledger ? timeAgo(ledger.checkedAt) : "—"}
          note={
            ledger
              ? `${ledger.trades.toLocaleString("en-US")} fills · ${ledger.accounts.toLocaleString("en-US")} accounts · ${ledger.checks.reduce((n, c) => n + (c.violations ?? 0), 0)} discrepancies`
              : undefined
          }
        />
        <Stat
          label="Last ERCOT ingestion"
          value={run ? timeAgo(run.started_at) : "—"}
          note={run ? `${run.status.toLowerCase()} · runs every 15 minutes` : undefined}
          delay={60}
        />
        <Stat
          label="Price feed"
          value={status?.mode === "ERCOT_LIVE" ? "Live ERCOT" : (status?.mode ?? "—")}
          note="Actual MIS publications, never synthetic"
          delay={120}
        />
      </section>

      <section aria-labelledby="flow-heading">
        <div className="mb-4 flex items-baseline gap-4">
          <h2 id="flow-heading" className="caption t-dim">
            How a price becomes a P&amp;L
          </h2>
          <div className="h-px flex-1 bg-white/10" />
        </div>
        <ol className="grid gap-px overflow-hidden border border-white/10 bg-white/10 sm:grid-cols-5">
          {FLOW.map((step, i) => (
            <li key={step.stage} className="bg-[var(--ink-panel)] p-3">
              <div className="flex items-center gap-2">
                <span className="mono text-[11px] t-accent">{String(i + 1).padStart(2, "0")}</span>
                <span className="font-display text-sm font-semibold">{step.stage}</span>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed t-dim">{step.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="problems-heading">
        <div className="mb-4 flex items-baseline gap-4">
          <h2 id="problems-heading" className="caption t-dim">
            Six problems, six answers
          </h2>
          <div className="h-px flex-1 bg-white/10" />
        </div>
        <ol className="grid gap-3 md:grid-cols-2">
          {PROBLEMS.map((p, i) => (
            <li key={p.title} className="card reveal p-4" style={{ animationDelay: `${i * 50}ms` }}>
              <div className="caption t-mute">{String(i + 1).padStart(2, "0")}</div>
              <h3 className="mt-1 font-display text-[15px] font-semibold">{p.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed t-dim">
                <span className="t-fg">The risk. </span>
                {p.risk}
              </p>
              <p className="mt-2 text-[13px] leading-relaxed t-dim">
                <span className="t-fg">What PowerFlow does. </span>
                {p.answer}
              </p>
              <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                {p.proof.map((link) => (
                  <a key={link.path} href={sourceUrl(link.path)} className="t-accent hover:underline">
                    {link.label} ↗
                  </a>
                ))}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section className="card p-4">
        <h2 className="card-title">Go deeper</h2>
        <ul className="space-y-1.5 text-[13px] leading-relaxed t-dim">
          <li>
            <Link href="/status" className="t-fg underline">
              System status
            </Link>{" "}
            — every reconciliation check and the ingestion runs, live.
          </li>
          <li>
            <Link href="/learn" className="t-fg underline">
              How the market works
            </Link>{" "}
            — the trader&apos;s view: day-ahead, real time and the spread between them.
          </li>
          <li>
            <a href={sourceUrl("docs/design.md")} className="t-fg underline">
              Design reference
            </a>{" "}
            — pricing, execution, settlement, margin, instruments and the security model in full.
          </li>
          <li>
            <a href={SOURCE_REPO} className="t-fg underline">
              The source
            </a>{" "}
            — every forward-only migration, the engine&apos;s test suites, and the pull requests behind them.
          </li>
        </ul>
      </section>
    </div>
  );
}
