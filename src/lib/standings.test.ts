import { describe, expect, it } from "vitest";
import { publicStandingsJson, standingsSize, type StandingsRow } from "@/lib/standings";

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
  it("gives the return in plain basis points, as /api/portfolio does", () => {
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
