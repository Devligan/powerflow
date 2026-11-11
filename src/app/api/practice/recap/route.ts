import { getSessionUser } from "@/lib/auth";
import { fail, ok, serverError } from "@/lib/api";
import { getActiveDesk } from "@/lib/desk";
import { getHourlyHistory, listMarketOptions } from "@/lib/markets";
import { practiceSchedule } from "@/lib/practice";
import { summarizeRecap } from "@/lib/practice-recap";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSimClock } from "@/lib/sim-clock";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * What the market did on the practice day at one point, as of the practice
 * desk's clock: before delivery, real time is not yet published and is not
 * shown — practice must not hand out the outcome before the bet.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.reads, user.id)) return tooManyRequests(LIMITS.reads);
  try {
    const desk = await getActiveDesk(user.id);
    if (desk.kind !== "PRACTICE" || !desk.id) return fail("Switch to the practice desk first.", 409);
    const { data: row, error } = await supabaseAdmin().from("desks").select("practice_day").eq("id", desk.id).single();
    if (error) throw new Error(error.message);
    const schedule = row?.practice_day ? practiceSchedule(row.practice_day as string) : null;
    if (!schedule) return fail("Pick a practice day first.", 409);

    const points = await listMarketOptions();
    const wanted = new URL(req.url).searchParams.get("point") ?? "HB_NORTH";
    const market = points.find((p) => p.settlementPoint === wanted) ?? points.find((p) => p.settlementPoint === "HB_NORTH");
    if (!market) return fail("Unknown settlement point.", 404);

    const clock = await getSimClock(desk.accountUserId);
    const asOf = clock ? new Date(clock.now) : new Date();
    const [da, rt] = await Promise.all([
      getHourlyHistory(market.id, "DAM_HOURLY", schedule.deliveryStart, schedule.deliveryEnd, asOf),
      getHourlyHistory(market.id, "RTM_HOURLY", schedule.deliveryStart, schedule.deliveryEnd, asOf),
    ]);
    return ok({
      day: schedule.day,
      point: market.settlementPoint,
      points: points.map((p) => p.settlementPoint),
      asOf: asOf.toISOString(),
      ...summarizeRecap(da, rt),
    });
  } catch (e) {
    return serverError("practice recap", e, "The market recap could not be loaded.");
  }
}
