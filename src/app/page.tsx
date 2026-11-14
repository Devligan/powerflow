import Link from "next/link";
import { Brand } from "@/components/brand";
import { BuiltBy } from "@/components/built-by";
import { MarketsStrip } from "@/components/markets-strip";
import { StoryChart } from "@/components/story-chart";
import { LocalClock } from "@/components/ui/clock";
import { getSessionUser } from "@/lib/auth";
import { loadMarketStory, type MarketStory } from "@/lib/market-story";
import { loadSystemStatus } from "@/lib/system-status";
import { timeAgo } from "@/lib/format";

/**
 * The landing page.
 *
 * It leads with one true thing rather than a list of features: the hour of
 * yesterday's Texas market where day-ahead and real time were furthest apart,
 * drawn from the same ERCOT data the desk trades on. The story explains the
 * product (that gap is the trade), the chart proves the data is real, and
 * everything after it is short: three moves, three facts, two links. The
 * detail lives on /learn and /engineering for whoever wants it.
 */

const CENTRAL = "America/Chicago";
const hourLabel = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, hour: "numeric" }).format(ms);
const weekday = (day: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(
    Date.parse(`${day}T12:00:00Z`)
  );
const price = (v: number) =>
  `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** The size of the bet the payoff line prices, in MW. */
const STORY_MW = 10;

const MOVES: Array<{ title: string; body: string }> = [
  {
    title: "Bid blind",
    body: "Day-ahead bids close at 10 AM the day before, as they do at ERCOT. Nobody knows the clearing price when they bid, and neither do you.",
  },
  {
    title: "Watch it deliver",
    body: "As each hour of the day happens, your position is marked against ERCOT's real-time price.",
  },
  {
    title: "Settle for real",
    body: "It pays out when ERCOT calls the price final, two business days later. Or replay a past day on the practice desk in about two minutes.",
  },
];

function StoryHero({ story }: { story: MarketStory }) {
  const { peak } = story;
  const up = peak.dart > 0;
  return (
    <>
      <p className="caption">Yesterday on the Texas grid · {weekday(story.day)}</p>
      <h1 className="mt-4 max-w-4xl font-display text-4xl leading-[1.05] font-bold tracking-tight sm:text-6xl">
        At {hourLabel(peak.startMs)}, power in {story.place} went from{" "}
        <span className="mono t-steel">{price(peak.da)}</span> to{" "}
        <span className={`mono ${up ? "pos" : "neg"}`}>{price(peak.rt)}</span>.
      </h1>
      <p className="mt-6 max-w-2xl text-[16px] leading-relaxed t-dim">
        The first is the day-ahead price, set in an auction the afternoon before. The second is what the same
        megawatt-hour cost as the hour happened. The gap is a trade, and PowerFlow lets you make it on real ERCOT
        prices with $100,000 of pretend money.
      </p>
    </>
  );
}

export default async function Home() {
  const [user, story, status] = await Promise.all([
    getSessionUser().catch(() => null),
    loadMarketStory().catch(() => null),
    loadSystemStatus().catch(() => null),
  ]);
  const ledger = status?.ledger ?? null;
  const run = status?.latestRuns[0] ?? null;

  const FACTS: Array<{ figure: string; label: string; note: string | null }> = [
    {
      // The audit's own count, whatever it is: this line must never claim a
      // clean book the reconciliation did not report.
      figure: ledger ? String(ledger.checks.reduce((n, c) => n + (c.violations ?? 0), 0)) : "—",
      label: "discrepancies in the books",
      note: ledger
        ? `Every account reconciled against its ${ledger.trades.toLocaleString("en-US")} fills, ${timeAgo(ledger.checkedAt)}. It runs every hour.`
        : null,
    },
    {
      figure: "15 min",
      label: "from ERCOT's report to the desk",
      note: run ? `Last pulled ${timeAgo(run.started_at)}. Real data only, never a simulated feed.` : null,
    },
    {
      figure: "0",
      label: "floating-point numbers in the money",
      note: "Every balance is exact to a millionth of a dollar, from the database to the screen.",
    },
  ];

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[var(--ink-panel)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Brand tag="paper trading" />
          <div className="ml-auto flex items-center gap-3">
            <Link href="/engineering" className="nav-link hidden sm:inline-flex">
              How it&apos;s built
            </Link>
            <span className="hidden border-l border-white/10 pl-3 md:block">
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
                  Start trading
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4">
        {/* ---- The story ---------------------------------------------------- */}
        <section className="reveal pt-12 pb-10 lg:pt-20">
          {story ? (
            <StoryHero story={story} />
          ) : (
            <>
              <p className="caption">ERCOT · day-ahead and real-time</p>
              <h1 className="mt-4 max-w-3xl font-display text-4xl leading-[1.05] font-bold tracking-tight sm:text-6xl">
                Trade the Texas power grid on real ERCOT prices.
              </h1>
            </>
          )}

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
                <Link href="/learn" className="btn">
                  How the market works
                </Link>
              </>
            )}
          </div>
        </section>

        <section className="reveal pb-16" style={{ animationDelay: "80ms" }}>
          <div className="card card-bracket p-4 sm:p-6">
            {story ? (
              <>
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="card-title mb-0">
                    {story.point} · {weekday(story.day)}
                  </h2>
                  <span className="caption">Actual ERCOT prices · $/MWh · Central time</span>
                </div>
                <StoryChart story={story} />
                <p className="mt-5 border-t border-white/10 pt-4 text-[14px] leading-relaxed">
                  A {STORY_MW} MW {story.peak.dart > 0 ? "DEC" : "INC"} on that hour, a bet that real time would land{" "}
                  {story.peak.dart > 0 ? "above" : "below"} day-ahead, would have made{" "}
                  <span className="mono pos">
                    ${(Math.abs(story.peak.dart) * STORY_MW).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </span>
                  . <span className="t-dim">Placing it the day before is the hard part.</span>
                </p>
              </>
            ) : (
              <MarketsStrip />
            )}
          </div>
        </section>

        {/* ---- Three moves --------------------------------------------------- */}
        <section className="pb-16">
          <ol className="grid gap-8 sm:grid-cols-3">
            {MOVES.map((move, i) => (
              <li key={move.title}>
                <span className="mono text-[12px] t-accent">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="mt-2 font-display text-xl font-semibold tracking-tight">{move.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed t-dim">{move.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ---- Built like a desk ----------------------------------------------- */}
        <section className="border-t border-white/10 py-16">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <div>
              <h2 className="font-display text-2xl font-bold tracking-tight">Built like a real trading desk.</h2>
              <p className="mt-3 text-[14px] leading-relaxed t-dim">
                The engine runs inside the database and is held to ERCOT&apos;s own rules. A replayed day can&apos;t see
                its own future. The books check themselves every hour, in public.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link href="/engineering" className="btn">
                  How it&apos;s built
                </Link>
                <Link href="/status" className="btn">
                  Live status
                </Link>
              </div>
            </div>
            <dl className="grid gap-6 sm:grid-cols-3">
              {FACTS.map((fact) => (
                <div key={fact.label} className="border-t border-white/10 pt-4">
                  <dt className="sr-only">{fact.label}</dt>
                  <dd>
                    <div className="mono text-4xl font-medium t-fg">{fact.figure}</div>
                    <div className="mt-1 text-[13px] font-medium">{fact.label}</div>
                    {fact.note && <p className="mt-2 text-[12.5px] leading-relaxed t-dim">{fact.note}</p>}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[var(--ink-panel)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-7 sm:flex-row sm:items-center sm:justify-between">
          <BuiltBy />
          <p className="caption">
            Actual ERCOT data, simulated money · not investment advice ·{" "}
            <Link href="/status" className="hover:underline">Status</Link> ·{" "}
            <Link href="/privacy" className="hover:underline">Privacy</Link> ·{" "}
            <Link href="/terms" className="hover:underline">Terms</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
