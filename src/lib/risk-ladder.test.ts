import { describe, expect, it } from "vitest";
import { buildLadder, type LadderPosition } from "@/lib/risk-ladder";

const mwh = (n: number) => BigInt(Math.round(n * 1e6));

const pos = (over: Partial<LadderPosition>): LadderPosition => ({
  instrument: "VIRTUAL",
  legs: "HB_NORTH",
  instrumentLabel: "Virtual INC/DEC",
  deliveryStart: "2026-11-02T19:00:00Z",
  deliveryEnd: "2026-11-02T20:00:00Z",
  quantityMwh: mwh(1),
  unrealizedPnl: 0n,
  marked: true,
  ...over,
});

describe("buildLadder", () => {
  it("nets same-instrument hours into one row and labels columns in hour ending", () => {
    const ladder = buildLadder([
      pos({ quantityMwh: mwh(5) }),
      pos({ deliveryStart: "2026-11-02T20:00:00Z", deliveryEnd: "2026-11-02T21:00:00Z", quantityMwh: mwh(-2) }),
    ]);
    expect(ladder.rows).toHaveLength(1);
    const [row] = ladder.rows;
    expect(row.netMwh).toBe(3);
    expect(row.grossMwh).toBe(7);
    expect(ladder.columns.map((c) => `${c.day} HE${c.he}`)).toEqual(["2026-11-02 HE14", "2026-11-02 HE15"]);
    expect(row.cells.get(Date.parse("2026-11-02T20:00:00Z"))).toBe(-2);
  });

  it("keeps different instruments and legs apart", () => {
    const ladder = buildLadder([
      pos({}),
      pos({ instrument: "ENERGY_SPOT", instrumentLabel: "Energy spot" }),
      pos({ instrument: "BASIS_SPREAD", legs: "HB_NORTH → LZ_WEST", instrumentLabel: "Basis spread" }),
    ]);
    expect(ladder.rows.map((r) => `${r.legs} · ${r.instrumentLabel}`)).toEqual([
      "HB_NORTH · Energy spot",
      "HB_NORTH · Virtual INC/DEC",
      "HB_NORTH → LZ_WEST · Basis spread",
    ]);
    expect(ladder.columns).toHaveLength(1);
  });

  it("spreads a window position evenly over its hours", () => {
    const ladder = buildLadder([
      pos({
        instrument: "BLOCK_FORWARD",
        instrumentLabel: "Block forward",
        deliveryStart: "2026-11-02T12:00:00Z",
        deliveryEnd: "2026-11-03T04:00:00Z",
        quantityMwh: mwh(16),
      }),
    ]);
    expect(ladder.columns).toHaveLength(16);
    expect([...ladder.rows[0].cells.values()].every((v) => v === 1)).toBe(true);
    expect(ladder.rows[0].netMwh).toBe(16);
  });

  it("skips flat positions and counts unmarked ones", () => {
    const ladder = buildLadder([pos({ quantityMwh: 0n }), pos({ marked: false, unrealizedPnl: mwh(-12.5) })]);
    expect(ladder.rows[0].unmarked).toBe(1);
    expect(ladder.rows[0].unrealized).toBe(-12.5);
    expect(buildLadder([pos({ quantityMwh: 0n })]).rows).toHaveLength(0);
  });
});
