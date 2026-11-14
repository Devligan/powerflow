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
    "How PowerFlow holds a paper desk to a real one: no look-ahead, ERCOT's own bidding and settlement rules, exact money, and books that reconcile themselves every hour.",
};

/**
 * The engineering case study, public so it can be read without an account.
 *
 * Short on purpose: one sentence per idea, and a link to the code that proves
 * it for anyone who wants the detail (the design reference has all of it).
 * The live figures come from the same status /status and the Production
 * workflow read, so the page's claims about itself are checked, not asserted.
 */

type Proof = { label: string; path: string };

const IDEAS: Array<{ title: string; line: string; proof: Proof[] }> = [
  {
    title: "No peeking at tomorrow",
    line: "Every price carries the moment ERCOT posted it, and every fill reads prices as of the account's own clock, so a replayed day can't see its own future.",
    proof: [
      { label: "As-of engine", path: "supabase/migrations/0021_asof_price_engine.sql" },
      { label: "Tests", path: "src/lib/trading/sql-replay.test.ts" },
    ],
  },
  {
    title: "ERCOT's rules, enforced",
    line: "Bids close at 10 AM the day before and fill only at the real clearing price. The engine refuses anything ERCOT would.",
    proof: [
      { label: "Bid deadline", path: "supabase/migrations/0038_dam_bid_deadline.sql" },
      { label: "Tests", path: "src/lib/trading/sql-orders.test.ts" },
    ],
  },
  {
    title: "Settled on ERCOT's calendar",
    line: "Positions pay out when ERCOT calls prices final, two business days later with holidays and daylight-saving days counted, at any corrected price.",
    proof: [
      { label: "Calendar", path: "supabase/migrations/0044_settlement_calendar.sql" },
      { label: "Tests", path: "src/lib/ercot/settlement-calendar.test.ts" },
    ],
  },
  {
    title: "Every cent accounted for",
    line: "Money is exact decimal with no floats, fills can only be appended, and every book is reconciled against its fills each hour, in public.",
    proof: [
      { label: "Reconciliation", path: "supabase/migrations/0054_ledger_reconciliation.sql" },
      { label: "Tests", path: "src/lib/trading/sql-ledger.test.ts" },
    ],
  },
  {
    title: "The database is the engine",
    line: "Trades run as locked, idempotent Postgres functions, so a double-click or a forged request can't spend the same cash twice.",
    proof: [
      { label: "Concurrency tests", path: "src/lib/trading/sql-concurrency.test.ts" },
      { label: "Exploit tests", path: "src/lib/security.exploits.test.ts" },
    ],
  },
  {
    title: "Shipped like production",
    line: "Every change runs the engine against live ERCOT data on a fresh database before it ships, and the live site is checked after every deploy.",
    proof: [
      { label: "CI", path: ".github/workflows/ci.yml" },
      { label: "Production check", path: ".github/workflows/production.yml" },
    ],
  },
];

const FLOW: Array<{ stage: string; detail: string }> = [
  { stage: "ERCOT", detail: "Public market reports" },
  { stage: "Ingest", detail: "Every 15 minutes, each price kept with its posting time" },
  { stage: "Engine", detail: "Bids, fills, margin and settlement in Postgres" },
  { stage: "Desk", detail: "The book, as of each account's clock" },
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
        kicker="How it's built"
        title="A paper desk, held to the standard of a real one"
        aside={
          ledger && (
            <span className={`badge ${balanced ? "badge-green" : "badge-red"}`}>
              <Lamp pulse={balanced} />
              {balanced ? "Books balanced" : "Books need attention"}
            </span>
          )
        }
      >
        A trading simulator is easy to build and easy to get subtly wrong. Here is what PowerFlow refuses to get
        wrong, with a link to the code that proves each one.
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

      <section aria-label="What PowerFlow refuses to get wrong">
        <ol className="grid gap-x-10 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
          {IDEAS.map((idea) => (
            <li key={idea.title} className="border-t border-white/10 pt-4">
              <h2 className="font-display text-lg font-semibold tracking-tight">{idea.title}</h2>
              <p className="mt-2 text-[14px] leading-relaxed t-dim">{idea.line}</p>
              <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                {idea.proof.map((link) => (
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
