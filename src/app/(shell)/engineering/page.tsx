import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Lamp } from "@/components/ui/lamp";
import { Stat } from "@/components/ui/stat";
import { loadSystemStatus } from "@/lib/system-status";
import { timeAgo } from "@/lib/format";
import { SOURCE_REPO, sourceUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Building it — PowerFlow",
  description:
    "What it took to make a paper desk trade like ERCOT: prices that get revised, an auction that closes blind, settlement on ERCOT's calendar, and money that has to add up.",
};

/**
 * The story of building the desk, public so it can be read without an account.
 *
 * Told as the problems the market threw up, in the order a trader meets them,
 * one sentence each with a link to the code for anyone who wants the detail
 * (the design reference has all of it). The live figures come from the same
 * status /status reads.
 */

type Proof = { label: string; path: string };

const PROBLEMS: Array<{ title: string; line: string; proof: Proof[] }> = [
  {
    title: "Prices change after they're published",
    line: "ERCOT posts a price, then sometimes corrects it. So every price is kept with the moment it was posted, and a fill or a mark only sees what had been posted by then. A later correction can't rewrite a trade made before it.",
    proof: [
      { label: "Price engine", path: "supabase/migrations/0021_asof_price_engine.sql" },
      { label: "Tests", path: "src/lib/trading/sql-replay.test.ts" },
    ],
  },
  {
    title: "The auction closes before you know anything",
    line: "Day-ahead bids close at 10 AM the day before and fill at the price ERCOT clears that afternoon, or not at all. Once the gate passes there's no taking a bid back.",
    proof: [
      { label: "Bid gate", path: "supabase/migrations/0038_dam_bid_deadline.sql" },
      { label: "Tests", path: "src/lib/trading/sql-orders.test.ts" },
    ],
  },
  {
    title: "Settlement runs on ERCOT's calendar",
    line: "Real-time prices become final at 4 PM two business days later. Holidays push that back, and the daylight-saving changes give some days 23 or 25 hours. Positions settle then, at the corrected price.",
    proof: [
      { label: "Calendar", path: "supabase/migrations/0044_settlement_calendar.sql" },
      { label: "Tests", path: "src/lib/ercot/settlement-calendar.test.ts" },
    ],
  },
  {
    title: "A missing price is not zero",
    line: "Sometimes an hour hasn't been priced yet. Filling it at an old price or at $0 would quietly make up P&L, so it waits, and the screen says why.",
    proof: [
      { label: "Strict pricing", path: "supabase/migrations/0011_strict_pricing.sql" },
      { label: "Tests", path: "src/lib/trading/sql-settlement.test.ts" },
    ],
  },
  {
    title: "The money has to add up",
    line: "Money is exact decimal, fills can only ever be added, and every hour each account is checked against its own fill history. The result is public on the status page.",
    proof: [
      { label: "Reconciliation", path: "supabase/migrations/0054_ledger_reconciliation.sql" },
      { label: "Tests", path: "src/lib/trading/sql-ledger.test.ts" },
    ],
  },
  {
    title: "Two clicks, one trade",
    line: "Trades happen inside the database, one account at a time, so a double-click or two open tabs can't spend the same cash twice.",
    proof: [
      { label: "Concurrency tests", path: "src/lib/trading/sql-concurrency.test.ts" },
      { label: "Exploit tests", path: "src/lib/security.exploits.test.ts" },
    ],
  },
];

const FLOW: Array<{ stage: string; detail: string }> = [
  { stage: "ERCOT", detail: "Public market reports" },
  { stage: "Ingest", detail: "Every 15 minutes, each price kept with its posting time" },
  { stage: "Engine", detail: "Bids, fills, margin and settlement in Postgres" },
  { stage: "Desk", detail: "Each trader's book, marked to the latest prices" },
  { stage: "Audit", detail: "Every book reconciled hourly, in public" },
];

export default async function EngineeringPage() {
  const status = await loadSystemStatus().catch(() => null);
  const ledger = status?.ledger ?? null;
  const run = status?.latestRuns[0] ?? null;
  const balanced = ledger != null && ledger.ok && !ledger.stale;

  return (
    <div className="space-y-10">
      <PageHeader
        kicker="Building it"
        title="Making a paper desk trade like ERCOT"
        aside={
          ledger && (
            <span className={`badge ${balanced ? "badge-green" : "badge-red"}`}>
              <Lamp pulse={balanced} />
              {balanced ? "Books balanced" : "Books need attention"}
            </span>
          )
        }
      >
        I built PowerFlow to learn how power traders work, and the market turned out to be in the details. These
        are the ones that took the most getting right, each with a link to the code.
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
          note={run ? `${run.status.toLowerCase()} · every 15 minutes` : undefined}
          delay={60}
        />
        <Stat
          label="Price feed"
          value={status?.mode === "ERCOT_LIVE" ? "Live ERCOT" : (status?.mode ?? "—")}
          note="Actual market reports, never synthetic"
          delay={120}
        />
      </section>

      <section aria-label="How a price becomes a P&L">
        <ol className="grid gap-px overflow-hidden border border-white/10 bg-white/10 sm:grid-cols-5">
          {FLOW.map((step, i) => (
            <li key={step.stage} className="bg-[var(--ink-panel)] p-4">
              <div className="flex items-center gap-2">
                <span className="mono text-[11px] t-accent">{String(i + 1).padStart(2, "0")}</span>
                <span className="font-display text-[15px] font-semibold">{step.stage}</span>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed t-dim">{step.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="The problems">
        <ol className="grid gap-x-10 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
          {PROBLEMS.map((problem) => (
            <li key={problem.title} className="border-t border-white/10 pt-4">
              <h2 className="font-display text-lg font-semibold tracking-tight">{problem.title}</h2>
              <p className="mt-2 text-[14px] leading-relaxed t-dim">{problem.line}</p>
              <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                {problem.proof.map((link) => (
                  <a key={link.path} href={sourceUrl(link.path)} className="t-accent hover:underline">
                    {link.label} ↗
                  </a>
                ))}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <p className="border-t border-white/10 pt-6 text-[14px] t-dim">
        All of it is in{" "}
        <a href={SOURCE_REPO} className="t-fg underline">
          the source
        </a>
        , in full in the{" "}
        <a href={sourceUrl("docs/design.md")} className="t-fg underline">
          design reference
        </a>
        , and checked live on{" "}
        <Link href="/status" className="t-fg underline">
          the status page
        </Link>
        .
      </p>
    </div>
  );
}
