import { centralHourEnding } from "@/lib/ercot/hour-ending";

/**
 * The risk ladder: open exposure laid out by delivery hour, one row per
 * instrument and legs. It answers what a desk asks first each morning —
 * where am I long or short, in which hours — which a flat position list
 * makes the reader assemble in their head.
 *
 * Quantities here are for display (MWh as numbers); balances and P&L stay
 * exact elsewhere. A window instrument (block, swap, price option) is spread
 * evenly across its hours, matching how the engine holds its quantity: one
 * total over the window, priced at the window average.
 */

const HOUR_MS = 3_600_000;
const SCALE = 1e6;

export interface LadderPosition {
  instrument: string;
  /** e.g. "HB_NORTH" or "HB_NORTH → LZ_WEST". */
  legs: string;
  instrumentLabel: string;
  deliveryStart: string;
  deliveryEnd: string;
  /** Signed, 1e6-scaled. */
  quantityMwh: bigint;
  /** 1e6-scaled. */
  unrealizedPnl: bigint;
  /** False when the engine could not mark it. */
  marked: boolean;
}

export interface LadderColumn {
  t: number;
  day: string;
  he: number;
  repeated: boolean;
}

export interface LadderRow {
  key: string;
  legs: string;
  instrumentLabel: string;
  /** Net MWh by column start (ms). */
  cells: Map<number, number>;
  netMwh: number;
  grossMwh: number;
  /** Dollars. */
  unrealized: number;
  unmarked: number;
}

export interface Ladder {
  columns: LadderColumn[];
  rows: LadderRow[];
}

export function buildLadder(positions: LadderPosition[]): Ladder {
  const rows = new Map<string, LadderRow>();
  const hours = new Set<number>();

  for (const p of positions) {
    if (p.quantityMwh === 0n) continue;
    const start = Date.parse(p.deliveryStart);
    const end = Date.parse(p.deliveryEnd);
    const n = Math.max(1, Math.round((end - start) / HOUR_MS));
    const qty = Number(p.quantityMwh) / SCALE;
    const perHour = qty / n;

    const key = `${p.instrument}|${p.legs}`;
    const row =
      rows.get(key) ??
      ({
        key,
        legs: p.legs,
        instrumentLabel: p.instrumentLabel,
        cells: new Map(),
        netMwh: 0,
        grossMwh: 0,
        unrealized: 0,
        unmarked: 0,
      } satisfies LadderRow);
    for (let i = 0; i < n; i++) {
      const t = start + i * HOUR_MS;
      hours.add(t);
      row.cells.set(t, (row.cells.get(t) ?? 0) + perHour);
    }
    row.netMwh += qty;
    row.grossMwh += Math.abs(qty);
    row.unrealized += Number(p.unrealizedPnl) / SCALE;
    if (!p.marked) row.unmarked += 1;
    rows.set(key, row);
  }

  const columns = [...hours]
    .sort((a, b) => a - b)
    .map((t) => ({ t, ...centralHourEnding(t) }));
  const sorted = [...rows.values()].sort(
    (a, b) => a.legs.localeCompare(b.legs) || a.instrumentLabel.localeCompare(b.instrumentLabel)
  );
  return { columns, rows: sorted };
}
