import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { fail, ok, serverError } from "@/lib/api";
import { CHALLENGE_MAX_DAYS } from "@/lib/challenge-schedule";
import { createChallenge, listChallenges } from "@/lib/challenges";
import { practiceDays } from "@/lib/practice";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Every challenge, newest first, with whether the caller is in it; and the days a new one can use. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.reads, user.id)) return tooManyRequests(LIMITS.reads);
  try {
    return ok({ challenges: await listChallenges(user.id), days: practiceDays(Date.now(), 60), maxDays: CHALLENGE_MAX_DAYS });
  } catch (e) {
    return serverError("challenges list", e, "Challenges could not be loaded.");
  }
}

const Create = z.object({
  title: z.string().trim().min(3, "Give it a name of at least 3 characters.").max(60, "Keep the name under 60 characters."),
  firstDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.number().int().min(1).max(CHALLENGE_MAX_DAYS),
});

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.desk, user.id)) return tooManyRequests(LIMITS.desk);
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid challenge", 422);
  try {
    const result = await createChallenge(user.id, parsed.data.title, parsed.data.firstDay, parsed.data.days);
    if (!result.ok) return fail(result.message, 422);
    return ok({ challenge: result.challenge }, 201);
  } catch (e) {
    return serverError("challenge create", e, "The challenge could not be created.");
  }
}
