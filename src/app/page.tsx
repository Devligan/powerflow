import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { BuiltBy } from "@/components/built-by";
import { MarketsStrip } from "@/components/markets-strip";
import { PriceTape } from "@/components/price-tape";
import { StoryChart } from "@/components/story-chart";
import { LocalClock } from "@/components/ui/clock";
import { getSessionUser } from "@/lib/auth";
import { damDeadlineUtc, firstOpenOperatingDay, hourEndingStartUtc } from "@/lib/ercot/hour-ending";
import { requestTime } from "@/lib/time";
import { countdown } from "@/lib/format";
import { listMarkets } from "@/lib/markets";
import { loadMarketStory, type MarketStory } from "@/lib/market-story";
import marketsShot from "../../public/showcase/markets.png";
import positionsShot from "../../public/showcase/positions.png";
import analyticsShot from "../../public/showcase/analytics.png";

/**
 * The landing page.
 *
 * It sells the product, not the plumbing. The tape and the week's story say
 * the prices are real; the hero says what the trade is; then the desk itself,
 * three screens of it, in the words a trader would use. How fills, marks and
 * settlement follow ERCOT is one link away for whoever wants it (/methodology).
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

interface TourStop {
  kicker: string;
  title: string;
  body: string;
  shot: StaticImageData;
  path: string;
  alt: string;
}

const TOUR: TourStop[] = [
  {
    kicker: "The auction",
    title: "Bid tomorrow before anyone knows the price.",
    body: "Pick a hub, read the curve, and put in a DEC or an INC on any hour before ERCOT's 10 AM gate. It fills that afternoon at the real clearing price.",
    shot: marketsShot,
    path: "markets/HB_NORTH",
    alt: "The HB_NORTH market: the day-ahead curve against real time, and the bid ticket",
  },
  {
    kicker: "The book",
    title: "Watch your risk, hour by hour.",
    body: "Every megawatt you hold, laid out across the delivery day and marked to ERCOT's real-time price as each hour prints.",
    shot: positionsShot,
    path: "positions",
    alt: "Positions: a risk ladder of net megawatt-hours by delivery hour, each position marked to real time",
  },
  {
    kicker: "The scorecard",
    title: "Find out if you're any good.",
    body: "Positions settle when ERCOT calls the price final. Then the numbers that matter: return, win rate, your best and worst trade, drawdown.",
    shot: analyticsShot,
    path: "analytics",
    alt: "Analytics after a settled day: equity, return, realized P&L, win rate, best and worst trade, drawdown",
  },
];

function StoryHero({ story }: { story: MarketStory }) {
  const { peak } = story;
  const up = peak.dart > 0;
  return (
    <>
      <p className="caption">This past week on the Texas grid · {weekday(story.day)}</p>
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

/**
 * A screen of the desk, framed as a browser window. The screenshots are
 * cropped to the part worth reading, so they show near their real size.
 */
function Screen({ stop }: { stop: TourStop }) {
  const { shot, path, alt } = stop;
  return (
    <div className="screen">
      <div className="flex h-8 items-center gap-1.5 border-b border-white/10 bg-[var(--ink-plate)] px-3">
        <span className="h-2 w-2 rounded-full bg-white/15" aria-hidden="true" />
        <span className="h-2 w-2 rounded-full bg-white/15" aria-hidden="true" />
        <span className="h-2 w-2 rounded-full bg-white/15" aria-hidden="true" />
        <span className="mono mx-auto truncate pr-8 text-[10.5px] t-mute">powerflow / {path}</span>
      </div>
      <Image src={shot} alt={alt} placeholder="blur" sizes="(min-width: 1152px) 1120px, 100vw" className="block h-auto w-full" />
    </div>
  );
}

export default async function Home() {
  const [user, story, markets] = await Promise.all([
    getSessionUser().catch(() => null),
    loadMarketStory().catch(() => null),
    listMarkets().catch(() => []),
  ]);

  // The next auction a new trader can still get into, and how long is left.
  const nowMs = requestTime();
  const openDay = firstOpenOperatingDay(nowMs);
  const firstHour = hourEndingStartUtc(openDay, 1);
  const gate = firstHour == null ? null : damDeadlineUtc(firstHour);
  const minutesLeft = gate == null ? null : Math.max(0, Math.floor((gate - nowMs) / 60_000));

  const startButtons = user ? (
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
  );

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 bg-[var(--ink-panel)]">
        <div className="border-b border-white/10">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
            <Brand tag="paper trading" />
            <div className="ml-auto flex items-center gap-3">
              <Link href="/learn" className="nav-link hidden md:inline-flex">
                How it works
              </Link>
              <Link href="/leaderboard" className="nav-link hidden md:inline-flex">
                Leaderboard
              </Link>
              <span className="hidden border-l border-white/10 pl-3 lg:block">
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
        </div>
        <PriceTape markets={markets} />
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
          <div className="mt-8 flex flex-wrap gap-3">{startButtons}</div>
        </section>

        <section className="reveal pb-24" style={{ animationDelay: "80ms" }}>
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

        {/* ---- The desk ------------------------------------------------------ */}
        <section className="border-t border-white/10 pt-20 pb-8">
          <p className="caption">Inside the desk</p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
            Everything a power trader looks at, on the real ERCOT market.
          </h2>
        </section>

        {TOUR.map((stop, i) => (
          <section key={stop.kicker} className="py-12">
            <div className="mb-8 grid gap-4 lg:grid-cols-2 lg:items-end lg:gap-14">
              <div>
                <span className="mono text-[12px] t-accent">
                  {String(i + 1).padStart(2, "0")} · {stop.kicker}
                </span>
                <h3 className="mt-3 font-display text-2xl leading-snug font-bold tracking-tight sm:text-3xl">
                  {stop.title}
                </h3>
              </div>
              <p className="text-[15px] leading-relaxed t-dim">{stop.body}</p>
            </div>
            <Screen stop={stop} />
          </section>
        ))}

        {/* ---- The close ----------------------------------------------------- */}
        <section className="my-20 card card-bracket px-6 py-12 text-center sm:px-12 sm:py-16">
          <p className="caption">The next auction</p>
          <h2 className="mx-auto mt-3 max-w-2xl font-display text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
            Bids for {weekday(openDay)} close
            {minutesLeft != null && (
              <>
                {" "}in{" "}
                <span className="mono t-accent">{countdown(minutesLeft)}</span>
              </>
            )}
            .
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed t-dim">
            Pick a hub, take a side on any hour, and find out what Texas actually paid. Real ERCOT prices, $100,000 of
            pretend money.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {user ? (
              <Link href="/dashboard" className="btn btn-primary">
                Go to the desk
              </Link>
            ) : (
              <Link href="/signup" className="btn btn-primary">
                Start with $100,000 virtual
              </Link>
            )}
            <Link href="/leaderboard" className="btn">
              See the leaderboard
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[var(--ink-panel)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-7 sm:flex-row sm:items-center sm:justify-between">
          <BuiltBy />
          <p className="caption">
            Actual ERCOT data, simulated money · not investment advice ·{" "}
            <Link href="/methodology" className="hover:underline">Methodology</Link> ·{" "}
            <Link href="/status" className="hover:underline">Status</Link> ·{" "}
            <Link href="/privacy" className="hover:underline">Privacy</Link> ·{" "}
            <Link href="/terms" className="hover:underline">Terms</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
