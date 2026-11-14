import { hourEndingStartUtc, operatingDayHours } from "@/lib/ercot/hour-ending";
import { priceFinalAt } from "@/lib/ercot/settlement-calendar";

/**
 * A practice day: one past operating day, walked through on the practice
 * desk's clock in the order ERCOT runs it. Browser-safe (no server imports).
 *
 *   bid       08:00 Central the day before — two hours before the day-ahead
 *             deadline (10:00), so bids are still accepted.
 *   clearing  14:00 Central the day before — after ERCOT has published the
 *             day-ahead clearing (normally early afternoon); the sweep that
 *             follows a clock jump fills every bid it crossed.
 *   delivery  five minutes after the operating day ends: every hour has been
 *             delivered and marked to real time.
 *   settle    one minute after the day's real-time prices are final on
 *             ERCOT's calendar (16:00 Central, second Business Day after), so
 *             the settlement that follows a clock jump cashes the day out.
 */

/** Continuous ERCOT history starts here (docs/design.md "Market data"). */
export const PRACTICE_HISTORY_START = "2026-09-20";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type PracticeStep = "bid" | "clearing" | "delivery" | "settle";

export const PRACTICE_STEPS: PracticeStep[] = ["bid", "clearing", "delivery", "settle"];

export interface PracticeSchedule {
  day: string;
  /** The operating day's first and last instants (UTC ms, end exclusive). */
  deliveryStart: number;
  deliveryEnd: number;
  /** Where each step puts the clock (UTC ms). */
  at: Record<PracticeStep, number>;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function practiceSchedule(day: string): PracticeSchedule | null {
  const hours = operatingDayHours(day);
  if (hours.length === 0) return null;
  const before = addDays(day, -1);
  // The start of HE9 is 08:00 and HE15 is 14:00; neither is ever skipped.
  const bid = hourEndingStartUtc(before, 9);
  const clearing = hourEndingStartUtc(before, 15);
  if (bid == null || clearing == null) return null;
  const deliveryStart = hours[0].startMs;
  const deliveryEnd = hours[hours.length - 1].startMs + HOUR_MS;
  return {
    day,
    deliveryStart,
    deliveryEnd,
    at: {
      bid,
      clearing,
      delivery: deliveryEnd + 5 * MINUTE_MS,
      settle: priceFinalAt("RTM_HOURLY", deliveryEnd - 1) + MINUTE_MS,
    },
  };
}

/**
 * The operating days that can be practised at `nowMs`, newest first: every
 * step must already be in the past (replay cannot run ahead of the wall
 * clock), and the day must lie inside the price history.
 */
export function practiceDays(nowMs: number, count = 21): string[] {
  const out: string[] = [];
  let day = new Date(nowMs).toISOString().slice(0, 10);
  while (out.length < count && day >= PRACTICE_HISTORY_START) {
    const s = practiceSchedule(day);
    if (s && s.at.settle <= nowMs) out.push(day);
    day = addDays(day, -1);
  }
  return out;
}

/** practiceDays as of the wall clock now, for server rendering. */
export function practiceDaysNow(count = 21): string[] {
  return practiceDays(Date.now(), count);
}

/**
 * The step the desk's clock has reached for this day: null before the bid
 * window opens (or on a clock nowhere near it), else the last step whose
 * instant has passed.
 */
export function reachedStep(schedule: PracticeSchedule, clockMs: number): PracticeStep | null {
  let reached: PracticeStep | null = null;
  for (const step of PRACTICE_STEPS) {
    if (clockMs >= schedule.at[step]) reached = step;
  }
  return reached;
}
