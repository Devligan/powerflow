import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseDbDec } from "@/lib/money";
import { getSessionUser } from "@/lib/auth";
import { usd, bpsToPercent, centralDate } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { LeaderboardOptIn } from "@/components/leaderboard-opt-in";
import { Avatar } from "@/components/ui/avatar";

export const dynamic = "force-dynamic";

interface LeaderboardRow {
  user_id: string;
  username: string;
  display_name: string | null;
  starting_cash: string;
  cash_balance: string;
  realized_pnl: string;
  marked_value: string;
  equity: string;
  return_bps: string;
  open_notional_mwh: string;
  open_notional_mw: string;
  positions_count: number;
  trades_count: number;
  joined_at: string;
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ top?: string }>;
}) {
  const { top } = await searchParams;
  const n = Math.min(Math.max(Number(top ?? "100"), 1), 100);

  const [user, result] = await Promise.all([
    getSessionUser().catch(() => null),
    (async () => {
      try {
        const { data, error } = await supabaseAdmin().rpc("get_leaderboard", {
          p_top: n,
        });
        if (error) throw new Error(error.message);
        return {
          rows: (data ?? []) as unknown as Array<Record<string, unknown>>,
          error: null as string | null,
        };
      } catch (e) {
        return {
          rows: [] as Array<Record<string, unknown>>,
          error: e instanceof Error ? e.message : "Leaderboard unavailable",
        };
      }
    })(),
  ]);

  const { rows, error } = result;

  // Pictures for the listed traders only (get_leaderboard predates avatars).
  const listedIds = rows.map((r) => String(r.user_id));
  const avatars = new Map<string, string>();
  if (listedIds.length > 0) {
    const { data } = await supabaseAdmin()
      .from("profiles")
      .select("id, avatar_url")
      .in("id", listedIds)
      .not("avatar_url", "is", null);
    for (const p of data ?? []) avatars.set(p.id as string, p.avatar_url as string);
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
          Standings are unavailable right now.{" "}
          <span className="t-mute">({error})</span>
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
                  rows.map((r, i) => {
                    const row = r as unknown as LeaderboardRow;
                    const equity = parseDbDec(row.equity);
                    const realized = parseDbDec(row.realized_pnl);
                    const isMe = user != null && row.user_id === user.id;
                    return (
                      <tr key={row.user_id}>
                        <td className="mono">
                          <span className={i < 3 ? "t-accent" : "t-mute"}>
                            {String(i + 1).padStart(2, "0")}
                          </span>
                        </td>
                        <td className="font-medium">
                          <span className="flex items-center gap-2">
                            <Avatar
                              url={avatars.get(row.user_id)}
                              name={row.display_name || row.username}
                              size={22}
                            />
                            {row.display_name || row.username || "trader"}
                            {isMe && (
                              <span className="badge badge-amber">You</span>
                            )}
                          </span>
                        </td>
                        <td className="mono text-right">{usd(equity)}</td>
                        <td
                          className={`mono text-right ${parseFloat(row.return_bps) >= 0 ? "pos" : "neg"}`}
                        >
                          {bpsToPercent(row.return_bps)}
                        </td>
                        <td
                          className={`mono text-right ${realized >= 0n ? "pos" : "neg"}`}
                        >
                          {usd(realized)}
                        </td>
                        <td className="mono text-right">
                          {usd(parseDbDec(row.marked_value))}
                        </td>
                        <td className="mono text-right">
                          {row.positions_count}
                        </td>
                        <td className="mono text-right">{row.trades_count}</td>
                        <td className="mono t-mute">
                          {centralDate(row.joined_at)}
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
