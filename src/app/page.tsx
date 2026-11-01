import Link from "next/link";
import { Brand } from "@/components/brand";
import { MarketsStrip } from "@/components/markets-strip";
import { Lamp } from "@/components/ui/lamp";
import { LocalClock, ZoneCaption } from "@/components/ui/clock";
import { getSessionUser } from "@/lib/auth";

/**
 * The landing page.
 *
 * Deliberately not a centred hero above a row of equal feature cards. The
 * product is a screen full of live numbers, so the page shows one: the same
 * settlement-point monitor the desk uses, running on the real feed, beside a
 * left-aligned statement. Everything below it is written as a specification
 * rather than as a set of promises, because a trading desk is bought on what
 * it does with a number, not on adjectives.
 */

const SPEC: Array<{ term: string; detail: string }> = [
  {
    term: "Market",
    detail:
      "All seven ERCOT trading hubs and eight load zones, with the day-ahead curve through the next operating day.",
  },
  {
    term: "Series",
    detail:
      "Day-ahead hourly clearing, real-time hourly and 15-minute settlement prices, and the five day-ahead ancillary-service prices — continuous since September 20, refreshed every 15 minutes.",
  },
  {
    term: "Instruments",
    detail:
      "Point energy, basis spread, convergence, block forward and virtual trade, each with its own settlement rule.",
  },
  {
    term: "Starting capital",
    detail:
      "$100,000 virtual cash and a $500,000 gross exposure cap, per account.",
  },
  {
    term: "Execution",
    detail:
      "Server-authoritative price for the exact delivery interval an order references. An order with no price for its own interval is refused rather than filled at an older one.",
  },
  {
    term: "Accounting",
    detail:
      "Weighted-average cost basis, realized P&L booked on every close, and positions cashed out automatically at delivery.",
  },
  {
    term: "Order integrity",
    detail:
      "Idempotent by client order id, so a repeated or concurrent submission fills exactly once. The blotter is append-only and immutable.",
  },
  {
    term: "Privacy",
    detail:
      "Row-level security isolates every account. Leaderboard participation is opt-in.",
  },
  {
    term: "Data source",
    detail:
      "Actual ERCOT MIS publications — the same reports a real desk reads, never a synthetic feed. Only the clock, orders and accounts are simulated.",
  },
];

const SEQUENCE: Array<{ title: string; body: string }> = [
  {
    title: "Fund the desk",
    body: "Sign up with email or Google. The account bootstraps itself with virtual cash and an exposure limit.",
  },
  {
    title: "Pick a point and an interval",
    body: "Choose a settlement point, a series and an upcoming delivery window. The ticket states what the priced horizon can actually cover.",
  },
  {
    title: "Send the order",
    body: "The server prices the exact interval, checks cash cover and gross exposure, then fills or refuses. Nothing fills at a stale price.",
  },
  {
    title: "Read the book",
    body: "Positions, realized and unrealized P&L, margin state and drawdown, recomputed from the executed blotter rather than from a running total.",
  },
];

export default async function Home() {
  const user = await getSessionUser().catch(() => null);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[var(--ink-panel)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Brand tag="paper trading" />
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden border-l border-white/10 pl-3 sm:block">
              <LocalClock />
            </span>
            {user ? (
              <Link href="/dashboard" className="btn btn-primary btn-sm">
                Open the desk
              </Link>
            ) : (
              <>
                <Link href="/login" className="btn btn-sm">
                  Sign in
                </Link>
                <Link href="/signup" className="btn btn-primary btn-sm">
                  Create account
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4">
        {/* ---- Statement + the actual product ---------------------------- */}
        {/* The base column is pinned to minmax(0,1fr): an implicit column sizes
            to its content, and the market strip's row of tiles made the hero
            ~2,600px wide on a phone. */}
        <section className="grid grid-cols-[minmax(0,1fr)] gap-10 py-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:gap-14 lg:py-20">
          <div className="reveal min-w-0">
            <p className="caption">ERCOT · day-ahead and real-time</p>
            <h1 className="mt-4 max-w-2xl font-display text-4xl leading-[1.05] font-bold tracking-tight sm:text-5xl">
              Trade the Texas power curve, hour by hour.
            </h1>
            <p className="mt-6 max-w-xl text-[15px] leading-relaxed t-dim">
              PowerFlow is a paper-trading desk for the ERCOT market. Hourly
              day-ahead and real-time series, 15-minute intervals, point and
              basis positions, block forwards and virtual trades. Every fill is
              priced off the interval it names, and every position is settled by
              the same engine that opened it.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              {user ? (
                <Link href="/dashboard" className="btn btn-primary">
                  Go to the desk
                </Link>
              ) : (
                <>
                  <Link href="/signup" className="btn btn-primary">
                    Start with $100,000 virtual
                  </Link>
                  <Link href="/markets" className="btn">
                    Browse markets
                  </Link>
                </>
              )}
            </div>

            <p className="mt-5 caption">
              No card, no deposit, no real money. Simulation only.
            </p>
          </div>

          <div className="reveal min-w-0" style={{ animationDelay: "80ms" }}>
            <section className="card card-bracket p-0">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <h2 className="card-title mb-0">Settlement point monitor</h2>
                <span className="badge badge-amber">
                  <Lamp pulse />
                  Live
                </span>
              </div>
              <div className="p-4">
                <MarketsStrip />
              </div>
            </section>
            <p className="mt-3 caption">
              Running on the live feed right now, not a screenshot.
            </p>
          </div>
        </section>

        {/* ---- Specification --------------------------------------------- */}
        <section className="pb-14">
          <div className="mb-5 flex items-baseline gap-4">
            <h2 className="caption t-dim">System specification</h2>
            <div className="h-px flex-1 bg-white/10" />
          </div>
          <dl className="border-t border-white/10">
            {SPEC.map((row) => (
              <div
                key={row.term}
                className="grid gap-1 border-b border-white/[0.07] py-3 sm:grid-cols-[13rem_1fr] sm:gap-6"
              >
                <dt className="caption pt-0.5">{row.term}</dt>
                <dd className="text-[12.5px] leading-relaxed t-dim">
                  {row.detail}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ---- Operating sequence ---------------------------------------- */}
        <section className="pb-20">
          <div className="mb-6 flex items-baseline gap-4">
            <h2 className="caption t-dim">Operating sequence</h2>
            <div className="h-px flex-1 bg-white/10" />
          </div>
          <ol className="grid gap-7 sm:grid-cols-2 lg:grid-cols-4">
            {SEQUENCE.map((step, i) => (
              <li
                key={step.title}
                className="reveal"
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <div className="flex items-center gap-3">
                  <span className="mono text-[11px] t-accent">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="h-px flex-1 bg-white/10" />
                </div>
                <h3 className="mt-3 font-display text-sm font-semibold">
                  {step.title}
                </h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed t-dim">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[var(--ink-panel)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-7 sm:flex-row sm:items-center sm:justify-between">
          <p className="caption">
            PowerFlow · for education only · not investment advice ·{" "}
            <Link href="/privacy" className="hover:underline">Privacy</Link> ·{" "}
            <Link href="/terms" className="hover:underline">Terms</Link>
          </p>
          <p className="caption">
            Times in <ZoneCaption /> · actual ERCOT market data, simulated trading
          </p>
        </div>
      </footer>
    </div>
  );
}
