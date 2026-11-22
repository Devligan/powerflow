import { describe, expect, it } from "vitest";
import {
  listedStandings,
  publicStandingsJson,
  standingsSize,
  type ListedProfile,
  type RawRow,
  type StandingsRow,
} from "@/lib/standings";

const row: StandingsRow = {
  rank: 1,
  displayName: "Ada",
  avatarUrl: null,
  isViewer: true,
  startingCash: "100000",
  cashBalance: "101234.5",
  realizedPnl: "1234.5",
  markedValue: "-12.3456789",
  equity: "101222.1543211",
  // get_leaderboard's division is unrounded numeric.
  returnBps: "122.2154321100000000",
  openNotionalMwh: "40",
  openNotionalMw: "0",
  positionsCount: 2,
  tradesCount: 5,
  joinedAt: "2026-10-01T00:00:00Z",
};

describe("publicStandingsJson", () => {
  it("gives the return in plain basis points, as the portfolio snapshot does", () => {
    expect(publicStandingsJson(row).returnBps).toBeCloseTo(122.21543211, 8);
    expect(publicStandingsJson({ ...row, returnBps: "-50" }).returnBps).toBe(-50);
  });

  it("gives money as exact decimal strings on the 6-place grid", () => {
    const json = publicStandingsJson(row);
    expect(json.equity).toBe("101222.154321");
    expect(json.markedValue).toBe("-12.345679");
    expect(json.realizedPnl).toBe("1234.5");
  });

  it("carries nothing that identifies the account beyond the chosen name", () => {
    expect(Object.keys(publicStandingsJson(row)).sort()).toEqual(
      [
        "avatarUrl", "displayName", "equity", "joinedAt", "markedValue", "openNotionalMw",
        "openNotionalMwh", "positionsCount", "rank", "realizedPnl", "returnBps", "tradesCount",
      ].sort()
    );
  });
});

describe("standingsSize", () => {
  it("clamps to 1..100 and defaults to 100", () => {
    expect(standingsSize(null)).toBe(100);
    expect(standingsSize("0")).toBe(1);
    expect(standingsSize("250")).toBe(100);
    expect(standingsSize("2.5")).toBe(100);
    expect(standingsSize("10")).toBe(10);
  });
});

describe("listedStandings (#70)", () => {
  const raw = (id: string, equity: string): RawRow => ({
    user_id: id,
    username: `user-${id}`,
    display_name: `Cached ${id}`,
    starting_cash: "100000",
    cash_balance: equity,
    realized_pnl: "0",
    marked_value: "0",
    equity,
    return_bps: "0",
    open_notional_mwh: "0",
    open_notional_mw: "0",
    positions_count: 0,
    trades_count: 0,
    joined_at: "2026-10-01T00:00:00Z",
  });
  const profile = (id: string, over: Partial<ListedProfile> = {}): ListedProfile => ({
    id,
    display_name: `Now ${id}`,
    avatar_url: null,
    onboarded_at: "2026-10-01T00:00:00Z",
    leaderboard_opt_in: true,
    ...over,
  });
  const ranked = [raw("a", "103000"), raw("b", "102000"), raw("c", "101000")];

  it("drops a trader who left after the ranking was cached, and ranks the rest again", () => {
    const rows = listedStandings(
      ranked,
      [profile("a"), profile("b", { leaderboard_opt_in: false }), profile("c")],
      null
    );
    expect(rows.map((r) => [r.rank, r.displayName])).toEqual([
      [1, "Now a"],
      [2, "Now c"],
    ]);
  });

  it("shows the current name and picture, not the cached ones", () => {
    const [row] = listedStandings([raw("a", "1")], [profile("a", { avatar_url: "https://x/p.png" })], null);
    expect(row.displayName).toBe("Now a");
    expect(row.avatarUrl).toBe("https://x/p.png");
  });

  it("leaves out a trader with no profile, no name yet, or not onboarded", () => {
    const rows = listedStandings(
      ranked,
      [profile("b", { display_name: null }), profile("c", { onboarded_at: null })],
      null
    );
    expect(rows).toEqual([]);
  });

  it("marks only the viewer's own row", () => {
    const rows = listedStandings(ranked, ranked.map((r) => profile(r.user_id)), "b");
    expect(rows.map((r) => r.isViewer)).toEqual([false, true, false]);
  });
});
