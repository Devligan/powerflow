import { cookies } from "next/headers";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { fail, ok, serverError } from "@/lib/api";
import {
  enterChallenge,
  finishChallenge,
  getChallenge,
  getMyEntry,
  getStandings,
  makeMove,
  windowOf,
} from "@/lib/challenges";
import { DESK_COOKIE, DESK_COOKIE_OPTIONS } from "@/lib/desk";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

const FRIENDLY: Record<string, string> = {
  CHALLENGE_ALREADY_ENTERED: "You are already in this challenge.",
  CHALLENGE_ENTRY_NOT_ACTIVE: "Your entry in this challenge is already finished.",
  CHALLENGE_CLOCK_FORWARD_ONLY: "A challenge clock only moves forward.",
  CHALLENGE_CLOCK_PAST_END: "That is past the end of the challenge.",
  CHALLENGE_FINISHED: "Your entry in this challenge is already finished.",
};

function friendly(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  const code = Object.keys(FRIENDLY).find((k) => msg.includes(k));
  return code ? FRIENDLY[code] : null;
}

async function view(slug: string, userId: string) {
  const challenge = await getChallenge(slug);
  if (!challenge) return null;
  const w = windowOf(challenge);
  const [standings, entry] = await Promise.all([getStandings(challenge, userId), getMyEntry(userId, challenge)]);
  return {
    challenge,
    days: w?.days ?? [],
    moves: (w?.moves ?? []).map((m) => ({ kind: m.kind, day: m.day, at: new Date(m.at).toISOString() })),
    standings,
    entry: entry && {
      status: entry.status,
      pnl: entry.pnl,
      deskId: entry.desk?.id ?? null,
      clock: entry.clock?.now ?? null,
      next: entry.next ? { kind: entry.next.kind, day: entry.next.day, at: new Date(entry.next.at).toISOString() } : null,
    },
  };
}

export async function GET(_req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.reads, user.id)) return tooManyRequests(LIMITS.reads);
  try {
    const v = await view((await ctx.params).slug, user.id);
    return v ? ok(v) : fail("Challenge not found.", 404);
  } catch (e) {
    return serverError("challenge read", e, "The challenge could not be loaded.");
  }
}

const Action = z.object({ action: z.enum(["enter", "trade", "move", "finish"]) });

/**
 * enter  — a fresh desk in this challenge, which becomes the desk being traded
 * trade  — switch to this challenge's desk
 * move   — the entry's next move (open a day's bidding, run its clearing)
 * finish — settle at the last day's final prices and record the result
 */
export async function POST(req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  const parsed = Action.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Unknown action.", 422);
  const { action } = parsed.data;
  const limit = action === "enter" ? LIMITS.desk : LIMITS.clock;
  if (await overLimit(limit, user.id)) return tooManyRequests(limit);

  const slug = (await ctx.params).slug;
  try {
    const challenge = await getChallenge(slug);
    if (!challenge) return fail("Challenge not found.", 404);
    const store = await cookies();

    if (action === "enter") {
      const deskId = await enterChallenge(user.id, challenge);
      store.set(DESK_COOKIE, deskId, DESK_COOKIE_OPTIONS);
    } else if (action === "trade") {
      const entry = await getMyEntry(user.id, challenge);
      if (!entry?.desk?.id) return fail("You are not in this challenge.", 404);
      store.set(DESK_COOKIE, entry.desk.id, DESK_COOKIE_OPTIONS);
    } else if (action === "move") {
      const moved = await makeMove(user.id, challenge);
      if (!moved.ok) return fail(moved.message, 409);
    } else {
      await finishChallenge(user.id, challenge);
    }
    return ok(await view(slug, user.id));
  } catch (e) {
    const message = friendly(e);
    if (message) return fail(message, 409);
    return serverError(`challenge ${action}`, e, "That did not work. Please try again.");
  }
}
