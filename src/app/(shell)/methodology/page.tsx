import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { loadSystemStatus } from "@/lib/system-status";
import { timeAgo } from "@/lib/format";
import { sourceUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Methodology — PowerFlow",
  description:
    "How PowerFlow follows ERCOT: the day-ahead bid gate, fills at the clearing price, marks against real time, and settlement when ERCOT calls prices final.",
};

/**
 * The rules a trader's P&L follows, in the order a bid meets them, public so
 * they can be read before signing up. Each links to where the rule is
 * enforced; the design reference has the full detail. The live figures come
 * from the same status /status reads.
 */

const RULES: Array<{ title: string; line: string; source: string }> = [
  {
    title: "Bids close at the day-ahead gate",
    line: "An operating day takes bids from midnight Central fourteen days before it until 10:00 Central the day before. A bid can be cancelled until the gate and not after. Quantities are in steps of 0.1 MW.",
    source: "supabase/migrations/0045_dam_bid_window.sql",
  },
  {
    title: "Fills at the clearing price",
    line: "A bid fills when ERCOT publishes the day-ahead clearing that afternoon, at the clearing price. A limit bid fills only if the price crosses it: a buy at or below the limit, a sell at or above.",
    source: "supabase/migrations/0043_engine_audit.sql",
  },
  {
    title: "Marked to real time",
    line: "As each hour is delivered, open positions are marked to ERCOT's real-time price for it. A mark only uses prices ERCOT had published by then, never a later revision.",
    source: "supabase/migrations/0021_asof_price_engine.sql",
  },
  {
    title: "Settled when ERCOT calls prices final",
    line: "Real-time prices are final at 16:00 Central on the second business day after the operating day, with ERCOT's holidays counted. Positions settle then, at the final price, including any correction ERCOT posted.",
    source: "supabase/migrations/0044_settlement_calendar.sql",
  },
  {
    title: "No price, no fill",
    line: "An hour without a published price is never filled, marked or settled at an older price or at zero. It waits, and the desk says why.",
    source: "supabase/migrations/0011_strict_pricing.sql",
  },
  {
    title: "Exact accounting",
    line: "Cash and P&L are exact to a millionth of a dollar. Fills are permanent, and every account is checked against its own fill history each hour.",
    source: "supabase/migrations/0054_ledger_reconciliation.sql",
  },
];

const FLOW: Array<{ stage: string; detail: string }> = [
  { stage: "ERCOT", detail: "Public market reports" },
  { stage: "Prices", detail: "Every 15 minutes, each price kept with its posting time" },
  { stage: "Bids", detail: "Filled at the day-ahead clearing" },
  { stage: "Marks", detail: "Each book marked to real time as hours deliver" },
  { stage: "Settlement", detail: "At ERCOT's final prices" },
];

export default async function MethodologyPage() {
  const status = await loadSystemStatus().catch(() => null);
  const ledger = status?.ledger ?? null;
  const run = status?.latestRuns[0] ?? null;

  return (
    <div className="space-y-10">
      <PageHeader kicker="Methodology" title="How PowerFlow follows ERCOT">
        Every price is ERCOT&apos;s, and every bid, mark and settlement follows ERCOT&apos;s rules and calendar.
        These are the rules your P&amp;L follows.
      </PageHeader>

      <section aria-label="From a price to a P&L">
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

      <section aria-label="The rules">
        <ol className="grid gap-x-10 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
          {RULES.map((rule) => (
            <li key={rule.title} className="border-t border-white/10 pt-4">
              <h2 className="font-display text-lg font-semibold tracking-tight">{rule.title}</h2>
              <p className="mt-2 text-[14px] leading-relaxed t-dim">{rule.line}</p>
              <p className="mt-3 text-[12px]">
                <a href={sourceUrl(rule.source)} className="t-accent hover:underline">
                  Source ↗
                </a>
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Right now" className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Last ERCOT update"
          value={run ? timeAgo(run.started_at) : "—"}
          note={run ? `${run.status.toLowerCase()} · every 15 minutes` : undefined}
        />
        <Stat
          label="Accounts last checked"
          value={ledger ? timeAgo(ledger.checkedAt) : "—"}
          note={
            ledger
              ? `${ledger.trades.toLocaleString("en-US")} fills · ${ledger.checks.reduce((n, c) => n + (c.violations ?? 0), 0)} discrepancies`
              : undefined
          }
          delay={60}
        />
        <Stat
          label="Price feed"
          value={status?.mode === "ERCOT_LIVE" ? "Live ERCOT" : (status?.mode ?? "—")}
          note="Actual market reports"
          delay={120}
        />
      </section>

      <p className="border-t border-white/10 pt-6 text-[14px] t-dim">
        New to the market? Start with{" "}
        <Link href="/learn" className="t-fg underline">
          how it works
        </Link>
        . The full rules are in the{" "}
        <a href={sourceUrl("docs/design.md")} className="t-fg underline">
          design reference
        </a>
        , and live system checks are on{" "}
        <Link href="/status" className="t-fg underline">
          the status page
        </Link>
        .
      </p>
    </div>
  );
}
