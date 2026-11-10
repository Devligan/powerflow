import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getActiveDesk } from "@/lib/desk";
import { getChallenge, getStandings, type Challenge } from "@/lib/challenges";
import { dayLabel } from "@/lib/challenge-schedule";
import { PageHeader } from "@/components/ui/page-header";
import { ChallengeView } from "@/components/challenge-view";
import { Avatar } from "@/components/ui/avatar";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

function daysOf(c: Challenge): string {
  return c.firstDay === c.lastDay ? dayLabel(c.firstDay) : `${dayLabel(c.firstDay)} – ${dayLabel(c.lastDay)}`;
}

/** A shared link shows what the challenge is before anyone signs in. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const challenge = await getChallenge((await params).slug).catch(() => null);
  if (!challenge) return { title: "Challenge — PowerFlow" };
  const title = `${challenge.title} — a PowerFlow challenge`;
  const description = `Trade ERCOT's real power prices for ${daysOf(challenge)} on a fresh $100,000 paper desk. Best P&L wins.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

function money(v: string | null): string {
  if (v == null) return "—";
  const n = Number(v);
  const s = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

export default async function ChallengePage({ params }: Props) {
  const { slug } = await params;
  const challenge = await getChallenge(slug).catch(() => null);
  if (!challenge) notFound();
  const user = await getSessionUser().catch(() => null);

  const header = (
    <PageHeader
      kicker="Challenge"
      title={challenge.title}
      aside={
        user ? (
          <Link href="/challenges" className="btn btn-sm">
            All challenges
          </Link>
        ) : undefined
      }
    >
      {daysOf(challenge)} as ERCOT actually ran them. Everyone who enters trades those days on a fresh $100,000
      desk: open each day&apos;s bidding, bid, run the clearing, then finish to settle at ERCOT&apos;s final prices.
      Best P&amp;L wins.
    </PageHeader>
  );

  if (user) {
    const desk = await getActiveDesk(user.id);
    return (
      <div className="space-y-6">
        {header}
        <ChallengeView slug={challenge.slug} activeDeskId={desk.id} />
      </div>
    );
  }

  // Signed out: what the challenge is and who is winning, and the way in.
  const standings = await getStandings(challenge, "").catch(() => []);
  const next = encodeURIComponent(`/challenges/${challenge.slug}`);
  return (
    <div className="space-y-6">
      {header}
      <section className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/signup?next=${next}`} className="btn btn-primary">
            Sign up to enter
          </Link>
          <Link href={`/login?next=${next}`} className="btn">
            Sign in
          </Link>
          <Link href="/learn" className="caption t-accent hover:underline">
            New to power markets? How it works →
          </Link>
        </div>
        <p className="caption t-mute mt-2">Paper trading only: no card, no deposit, no real money.</p>
      </section>
      <section className="card p-4">
        <h2 className="card-title">Standings</h2>
        {standings.length === 0 ? (
          <p className="caption t-mute">Nobody has entered yet — be the first.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Trader</th>
                  <th className="text-right">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.rank ?? "—"}</td>
                    <td>
                      <span className="flex items-center gap-2">
                        <Avatar url={r.avatarUrl} name={r.displayName} size={22} />
                        {r.displayName}
                      </span>
                    </td>
                    <td className={`mono text-right ${r.pnl == null ? "t-mute" : Number(r.pnl) >= 0 ? "pos" : "neg"}`}>
                      {r.status === "FINISHED" ? money(r.pnl) : "playing"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
