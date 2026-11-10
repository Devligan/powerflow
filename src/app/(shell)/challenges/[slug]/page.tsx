import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDesk } from "@/lib/desk";
import { getChallenge } from "@/lib/challenges";
import { PageHeader } from "@/components/ui/page-header";
import { ChallengeView } from "@/components/challenge-view";

export const dynamic = "force-dynamic";

export default async function ChallengePage({ params }: { params: Promise<{ slug: string }> }) {
  const { desk } = await requireDesk();
  const { slug } = await params;
  const challenge = await getChallenge(slug).catch(() => null);
  if (!challenge) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Challenge"
        title={challenge.title}
        aside={
          <Link href="/challenges" className="btn btn-sm">
            All challenges
          </Link>
        }
      >
        Share this page&apos;s address with your friends: anyone signed in can enter. Each entrant trades the same
        days on a fresh $100,000 desk; open each day&apos;s bidding, bid from Markets, run the clearing, then finish to
        settle at ERCOT&apos;s final prices.
      </PageHeader>
      <ChallengeView slug={challenge.slug} activeDeskId={desk.id} />
    </div>
  );
}
