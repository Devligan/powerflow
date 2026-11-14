import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Term } from "@/components/term";
import { GLOSSARY } from "@/lib/glossary";
import { getSessionUser } from "@/lib/auth";

export const metadata = {
  title: "How it works — PowerFlow",
  description: "The Texas power market in five minutes: day-ahead bids, real-time prices, and how a virtual bid makes or loses money.",
};

const STEPS: Array<{ title: string; body: React.ReactNode }> = [
  {
    title: "Two prices for every hour",
    body: (
      <>
        <Term k="ercot" /> runs two markets for the same electricity. The <Term k="dam">day-ahead market</Term> sets a
        price for each hour of tomorrow in an auction today. The <Term k="rt">real-time market</Term> prices it again
        as it is delivered. They rarely agree — a heat wave, a plant trip or a windy night pulls real time away from
        what the auction expected.
      </>
    ),
  },
  {
    title: "Bet on the gap",
    body: (
      <>
        A <Term k="virtual">virtual bid</Term> is a bet on that gap, the <Term k="dart">DART spread</Term>. Buy (a DEC)
        if you think real time will come in above day-ahead; sell (an INC) if you think it will come in below. No
        power moves; only the difference is paid.
      </>
    ),
  },
  {
    title: "Bid before 10:00 Central the day before",
    body: (
      <>
        Pick a <Term k="settlementPoint">settlement point</Term>, an <Term k="operatingDay">operating day</Term> and
        the <Term k="hourEnding">hours</Term>, and bid before the deadline. ERCOT publishes the{" "}
        <Term k="clearing">clearing price</Term> in the early afternoon and your bid fills at it — or, as a{" "}
        <Term k="limit">limit bid</Term>, only if the price crosses your limit.
      </>
    ),
  },
  {
    title: "Watch real time, then settle",
    body: (
      <>
        On the day, the position is <Term k="mark">marked</Term> on real-time prices as they arrive.{" "}
        <Term k="settlement">Settlement</Term> pays it out when ERCOT calls the prices final, two business days later.
        Your $100,000 sets how much you can bet: open bids and positions hold <Term k="collateral">collateral</Term>.
      </>
    ),
  },
];

export default async function LearnPage() {
  const user = await getSessionUser().catch(() => null);
  return (
    <div className="space-y-6">
      <PageHeader kicker="How it works" title="The Texas power market in five minutes">
        Everything on this desk is real ERCOT data. Only the money is pretend. Hover, focus or tap an underlined word
        for what it means.
      </PageHeader>

      <ol className="grid gap-3 md:grid-cols-2">
        {STEPS.map((s, i) => (
          <li key={s.title} className="card p-4">
            <div className="caption t-mute">Step {i + 1}</div>
            <h2 className="mt-1 font-medium">{s.title}</h2>
            <p className="mt-2 text-[13px] leading-relaxed t-dim">{s.body}</p>
          </li>
        ))}
      </ol>

      <section className="card p-4">
        <h2 className="card-title">A worked example</h2>
        <p className="text-[13px] leading-relaxed t-dim">
          Tomorrow looks hot. You think the day-ahead auction is too calm about the evening peak, so you buy a 5 MW
          DEC at HB_NORTH for hour ending 18. The hour clears day-ahead at <span className="mono">$40</span>. On the
          day, real time settles at <span className="mono">$65</span>: you earn{" "}
          <span className="mono">($65 − $40) × 5 MW = $125</span>. Had real time come in at{" "}
          <span className="mono">$30</span>, you would have lost <span className="mono">$50</span>.
        </p>
      </section>

      <section className="card p-4">
        <h2 className="card-title">Glossary</h2>
        <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2">
          {Object.entries(GLOSSARY).map(([key, g]) => (
            <div key={key}>
              <dt className="font-medium">{g.term}</dt>
              <dd className="caption mt-0.5 normal-case tracking-normal t-dim">
                {g.short}
                {"detail" in g && g.detail ? ` ${g.detail}` : ""}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="flex flex-wrap gap-3">
        {user ? (
          <Link href="/markets" className="btn btn-primary">
            Place a bid
          </Link>
        ) : (
          <Link href="/signup" className="btn btn-primary">
            Start with $100,000 virtual
          </Link>
        )}
      </div>
    </div>
  );
}
