import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ optIn: z.boolean() });

/**
 * Join or leave the public standings. Runs as the signed-in user, so
 * set_leaderboard_opt_in can only ever change the caller's own profile, and
 * the change is audited there (0032).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Expected { optIn: boolean }", 422);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_leaderboard_opt_in", {
    p_opt_in: parsed.data.optIn,
  });
  if (error) return fail(error.message, 422);
  return ok({ optIn: Boolean(data) });
}
