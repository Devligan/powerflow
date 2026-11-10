import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { fail, m, ok, serverError } from "@/lib/api";
import { getActiveDesk, type Desk } from "@/lib/desk";
import { PRACTICE_STEPS, practiceDays, practiceSchedule, reachedStep } from "@/lib/practice";
import { getPositionsView } from "@/lib/queries";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { catchUpAccount, getSimClock, setSimClock } from "@/lib/sim-clock";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * The practice day (src/lib/practice.ts): which past operating day the
 * practice desk is walking through, how far its clock has got, and what that
 * day's positions made. Only the practice desk has one — the live account's
 * clock is the trader's own business, and a live result must stay live.
 */

async function practiceDesk(userId: string): Promise<Desk | null> {
  const desk = await getActiveDesk(userId);
  return desk.kind === "PRACTICE" ? desk : null;
}

async function state(desk: Desk) {
  const [clock, { data: row, error }] = await Promise.all([
    getSimClock(desk.accountUserId),
    supabaseAdmin().from("desks").select("practice_day").eq("id", desk.id as string).single(),
  ]);
  if (error) throw new Error(error.message);
  const days = practiceDays(Date.now());
  const day = (row?.practice_day as string | null) ?? null;
  const schedule = day ? practiceSchedule(day) : null;

  let results = null;
  if (schedule) {
    const positions = (await getPositionsView(desk.accountUserId)).filter((p) => {
      const t = Date.parse(p.deliveryStart);
      return t >= schedule.deliveryStart && t < schedule.deliveryEnd;
    });
    let realized = 0n;
    let unrealized = 0n;
    for (const p of positions) {
      realized += p.realizedPnl;
      unrealized += p.unrealizedPnl;
    }
    results = {
      positions: positions.length,
      settled: positions.filter((p) => p.settledAt != null).length,
      realizedPnl: m(realized),
      unrealizedPnl: m(unrealized),
    };
  }

  return {
    days,
    day,
    clock,
    reached: schedule && clock ? reachedStep(schedule, Date.parse(clock.now)) : null,
    schedule: schedule
      ? Object.fromEntries(PRACTICE_STEPS.map((s) => [s, new Date(schedule.at[s]).toISOString()]))
      : null,
    results,
  };
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  try {
    const desk = await practiceDesk(user.id);
    if (!desk) return fail("Switch to the practice desk first.", 409);
    return ok(await state(desk));
  } catch (e) {
    return serverError("practice read", e, "The practice day could not be loaded.");
  }
}

const Move = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  step: z.enum(["bid", "clearing", "delivery", "settle"]),
});

/** Put the practice desk's clock at a step of a practice day. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.clock, user.id)) return tooManyRequests(LIMITS.clock);
  const parsed = Move.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Choose a day and a step.", 422);
  const { day, step } = parsed.data;

  try {
    const desk = await practiceDesk(user.id);
    if (!desk) return fail("Switch to the practice desk first.", 409);
    // Only days whose every step is already history: replay cannot run ahead
    // of the wall clock, and a day without final prices cannot settle.
    if (!practiceDays(Date.now()).includes(day)) {
      return fail("That day cannot be practised: pick one from the list.", 422);
    }
    const schedule = practiceSchedule(day)!;

    const moved = await setSimClock(desk.accountUserId, new Date(schedule.at[step]).toISOString());
    if (!moved.ok) return fail(moved.message, 422);
    const { error } = await supabaseAdmin()
      .from("desks")
      .update({ practice_day: day })
      .eq("id", desk.id as string);
    if (error) throw new Error(error.message);
    await catchUpAccount(desk.accountUserId);
    return ok(await state(desk));
  } catch (e) {
    return serverError("practice step", e, "The practice clock could not be moved.");
  }
}
