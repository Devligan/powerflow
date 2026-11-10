import { practiceDays, practiceSchedule } from "@/lib/practice";

/**
 * A challenge's timeline (0049). Browser-safe.
 *
 * An entrant's clock starts at 08:00 Central the day before the first day and
 * only moves forward. Each day has two moves — open its bidding, then run its
 * clearing — and they interleave in time: day N+1's bidding (08:00 on day N)
 * comes after day N's clearing (14:00 on day N-1). The finish is the instant
 * the last day's real-time prices were final, when every position can settle.
 */

export const CHALLENGE_MAX_DAYS = 5;

export type ChallengeMove =
  | { kind: "bid" | "clearing"; day: string; at: number }
  | { kind: "finish"; day: null; at: number };

/** "Thu, Nov 5" for an operating day (YYYY-MM-DD), whatever the viewer's zone. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The consecutive operating days of a challenge. */
export function challengeDays(firstDay: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(firstDay, i));
}

export interface ChallengeWindow {
  days: string[];
  startsAt: number;
  finishesAt: number;
  moves: ChallengeMove[];
}

/**
 * The window for `count` days from `firstDay`, or null when they cannot be a
 * new challenge at `nowMs`: every day must be recent and already settled.
 */
export function challengeWindow(firstDay: string, count: number, nowMs: number): ChallengeWindow | null {
  if (!Number.isInteger(count) || count < 1 || count > CHALLENGE_MAX_DAYS) return null;
  const allowed = new Set(practiceDays(nowMs, 120));
  if (!challengeDays(firstDay, count).every((d) => allowed.has(d))) return null;
  return buildWindow(firstDay, count);
}

/** The moves of an existing challenge, however long ago it was made. */
export function buildWindow(firstDay: string, count: number): ChallengeWindow | null {
  if (!Number.isInteger(count) || count < 1 || count > CHALLENGE_MAX_DAYS) return null;
  const days = challengeDays(firstDay, count);
  const schedules = days.map((d) => practiceSchedule(d));
  if (schedules.some((s) => s == null)) return null;
  return movesOf(days, schedules as NonNullable<(typeof schedules)[number]>[]);
}

function movesOf(days: string[], schedules: NonNullable<ReturnType<typeof practiceSchedule>>[]): ChallengeWindow {
  const moves: ChallengeMove[] = [];
  for (const s of schedules) {
    moves.push({ kind: "bid", day: s.day, at: s.at.bid });
    moves.push({ kind: "clearing", day: s.day, at: s.at.clearing });
  }
  const finishesAt = schedules[schedules.length - 1].at.settle;
  moves.push({ kind: "finish", day: null, at: finishesAt });
  moves.sort((a, b) => a.at - b.at);
  return { days, startsAt: schedules[0].at.bid, finishesAt, moves };
}

/** The first move still ahead of the clock, or null once it is at the finish. */
export function nextMove(window: ChallengeWindow, clockMs: number): ChallengeMove | null {
  // A second of slack, as the engine allows: the clock runs while a request is in flight.
  return window.moves.find((m) => m.at > clockMs + 1000) ?? null;
}
