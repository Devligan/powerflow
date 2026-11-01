import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseDbDec } from "@/lib/money";
import { getSessionUser } from "@/lib/auth";
import { usd, bpsToPercent } from "@/lib/format";
import { localDate } from "@/lib/time";
import { getViewerTimeZone } from "@/lib/time-zone-server";
import { getPublicStandings, type StandingsRow } from "@/lib/standings";
import { PageHeader } from "@/components/ui/page-header";
import { LeaderboardOptIn } from "@/components/leaderboard-opt-in";
import { Avatar } from "@/components/ui/avatar";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ top?: string }>;
}) {
  const { top } = await searchParams;
  const n = Math.min(Math.max(Number(top ?? "100"), 1), 100);

  // Rows carry no user ids or usernames: this page's payload is public, and
  // React keys and props are serialised into it (src/lib/standings.ts).
  const user = await getSessionUser().catch(() => null);
  const { tz } = await getViewerTimeZone();
  let rows: StandingsRow[] = [];
  let error: string | null = null;
  try {
    rows = await getPublicStandings(n, user?.id ?? null);
  } catch {
    error = "Leaderboard unavailable";
  }
  // The viewer's own setting, for the join/leave control.
  const optedIn = user
    ? Boolean(
        (
          await supabaseAdmin()
            .from("profiles")
            .select("leaderboard_opt_in")
            .eq("id", user.id)
            .maybeSingle()
        ).data?.leaderboard_opt_in
      )
    : null;

  return (
    <div className="space-y-5">
      <PageHeader
        kicker="Standings"
        title="Rank"
        aside={<span className="badge badge-neutral">Opt-in</span>}
      >
        Ranked by marked equity. Aggregate figures only, no positions or trades
        of anyone else are exposed.
      </PageHeader>

      {optedIn != null && <LeaderboardOptIn optedIn={optedIn} />}

      {error ? (
        <div className="card text-[13px] t-dim">
          Standings are unavailable right now.
        </div>
      ) : (
        <section className="card p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-14">Rank</th>
                  <th>Trader</th>
                  <th className="text-right">Equity</th>
                  <th className="text-right">Return</th>
                  <th className="text-right">Realized</th>
                  <th className="text-right">Marked</th>
                  <th className="text-right">Positions</th>
                  <th className="text-right">Trades</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-[13px] t-mute">
                      Nobody has joined the standings yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const equity = parseDbDec(row.equity);
                    const realized = parseDbDec(row.realizedPnl);
                    return (
                      <tr key={row.rank}>
                        <td className="mono">
                          <span className={row.rank <= 3 ? "t-accent" : "t-mute"}>
                            {String(row.rank).padStart(2, "0")}
                          </span>
                        </td>
                        <td className="font-medium">
                          <span className="flex items-center gap-2">
                            <Avatar url={row.avatarUrl} name={row.displayName} size={22} />
                            {row.displayName}
                            {row.isViewer && (
                              <span className="badge badge-amber">You</span>
                            )}
                          </span>
                        </td>
                        <td className="mono text-right">{usd(equity)}</td>
                        <td
                          className={`mono text-right ${parseFloat(row.returnBps) >= 0 ? "pos" : "neg"}`}
                        >
                          {bpsToPercent(row.returnBps)}
                        </td>
                        <td
                          className={`mono text-right ${realized >= 0n ? "pos" : "neg"}`}
                        >
                          {usd(realized)}
                        </td>
                        <td className="mono text-right">
                          {usd(parseDbDec(row.markedValue))}
                        </td>
                        <td className="mono text-right">
                          {row.positionsCount}
                        </td>
                        <td className="mono text-right">{row.tradesCount}</td>
                        <td className="mono t-mute">
                          {localDate(row.joinedAt, tz)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="caption">
        New accounts start unlisted; your entry appears only while you have
        joined. Equity = virtual cash + mark-to-market value of open positions.
      </p>
    </div>
  );
}
