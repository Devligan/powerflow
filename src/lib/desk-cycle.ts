import { damDeadlineUtc, firstOpenOperatingDay, hourEndingStartUtc } from "@/lib/ercot/hour-ending";

/**
 * Where a trader's book stands in ERCOT's day-ahead cycle, for the desk:
 *
 *   bid      → working bids, before 10:00 Central the day before delivery
 *   clear    → bids past the gate, waiting for ERCOT's clearing that afternoon
 *   deliver  → filled hours not yet over, marked to real time as they print
 *   settle   → delivered hours waiting for ERCOT to call the price final
 *
 * Pure: the page passes in the clock, the open bids and the open positions,
 * so the sorting is tested on its own. Nothing here moves money.
 */

export interface CycleOrder {
  deliveryStart: string;
}

export interface CyclePosition {
  deliveryStart: string;
  deliveryEnd: string;
  unrealizedPnl: bigint;
  /** When ERCOT's price for it is final and it settles (ISO). */
  finalAt: string;
}

export interface DeskCycle {
  /** The first operating day still open for bids, YYYY-MM-DD. */
  openDay: string;
  /** Minutes until that day's 10:00 Central gate. */
  minutesToGate: number;
  /** Bids that can still be changed or withdrawn. */
  working: number;
  /** Bids past their gate, waiting for the clearing. */
  awaitingClearing: number;
  /** Filled positions whose delivery has not ended. */
  delivering: { count: number; unrealized: bigint };
  /** Delivered positions waiting for final prices. */
  settling: { count: number; unrealized: bigint; nextFinalAt: string | null };
}

export function deskCycle(nowMs: number, orders: CycleOrder[], positions: CyclePosition[]): DeskCycle {
  const openDay = firstOpenOperatingDay(nowMs);
  const firstHour = hourEndingStartUtc(openDay, 1);
  const gate = firstHour == null ? nowMs : (damDeadlineUtc(firstHour) ?? nowMs);

  let working = 0;
  let awaitingClearing = 0;
  for (const o of orders) {
    const deadline = damDeadlineUtc(Date.parse(o.deliveryStart));
    if (deadline != null && nowMs < deadline) working++;
    else awaitingClearing++;
  }

  const delivering = { count: 0, unrealized: 0n };
  const settling = { count: 0, unrealized: 0n, nextFinalAt: null as string | null };
  for (const p of positions) {
    if (Date.parse(p.deliveryEnd) > nowMs) {
      delivering.count++;
      delivering.unrealized += p.unrealizedPnl;
    } else {
      settling.count++;
      settling.unrealized += p.unrealizedPnl;
      if (settling.nextFinalAt == null || Date.parse(p.finalAt) < Date.parse(settling.nextFinalAt)) {
        settling.nextFinalAt = p.finalAt;
      }
    }
  }

  return {
    openDay,
    minutesToGate: Math.max(0, Math.floor((gate - nowMs) / 60_000)),
    working,
    awaitingClearing,
    delivering,
    settling,
  };
}
