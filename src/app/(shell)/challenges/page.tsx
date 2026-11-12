import Link from "next/link";
import { requireDesk } from "@/lib/desk";
import { listChallenges } from "@/lib/challenges";
import { CHALLENGE_MAX_DAYS, dayLabel } from "@/lib/challenge-schedule";
import { practiceDaysNow } from "@/lib/practice";
import { PageHeader } from "@/components/ui/page-header";
import { ChallengeCreate } from "@/components/challenge-create";

export const dynamic = "force-dynamic";

export default async function ChallengesPage() {
  const { user } = await requireDesk();
  const challenges = await listChallenges(user.id).catch(() => []);
  const days = practiceDaysNow(60);

  return (
    <div className="space-y-6">
      <PageHeader kicker="Compete" title="Challenges">
        The same past operating days, traded by everyone who enters on a fresh $100,000 desk, ranked by P&amp;L. The
        days have already happened, so a challenge plays out in one sitting — and nothing in it touches your live
        account.
      </PageHeader>

      <ChallengeCreate days={days} maxDays={CHALLENGE_MAX_DAYS} />

      <section className="card p-4">
        <h2 className="card-title">All challenges</h2>
        {challenges.length === 0 ? (
          <p className="hint t-mute">None yet. Start the first one above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Challenge</th>
                  <th>Days</th>
                  <th className="text-right">Entrants</th>
                  <th>You</th>
                </tr>
              </thead>
              <tbody>
                {challenges.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/challenges/${c.slug}`} className="t-accent hover:underline">
                        {c.title}
                      </Link>
                    </td>
                    <td className="mono">
                      {dayLabel(c.firstDay)}
                      {c.lastDay !== c.firstDay ? ` – ${dayLabel(c.lastDay)}` : ""}
                    </td>
                    <td className="mono text-right">{c.entrants}</td>
                    <td>
                      {c.myStatus === "FINISHED" ? (
                        <span className="badge badge-neutral">finished</span>
                      ) : c.myStatus === "ACTIVE" ? (
                        <span className="badge badge-amber">playing</span>
                      ) : (
                        <span className="caption t-mute">—</span>
                      )}
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
