import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { fail, ok, serverError } from "@/lib/api";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const CancelRequest = z.object({ orderId: z.string().uuid() });

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.cancels, user.id)) return tooManyRequests(LIMITS.cancels);

  const { id } = await ctx.params;
  const parsed = CancelRequest.safeParse({ orderId: id });
  if (!parsed.success) return fail("Invalid order id", 422);

  const db = await createClient();
  const { data, error } = await db.rpc("cancel_order", {
    p_user_id: user.id,
    p_order_id: parsed.data.orderId,
  });

  if (error) {
    const raw = error.message;
    if (raw.includes("ORDER_NOT_FOUND")) return fail("Order not found.", 404);
    if (raw.includes("ORDER_NOT_OPEN"))
      return fail("Only an open order can be cancelled.", 409);
    if (raw.includes("DAM_CLOSED"))
      return fail("Bids for that operating day closed at 10:00 AM Central the day before, so it can no longer be withdrawn.", 409);
    if (raw.includes("FORBIDDEN"))
      return fail("You are not allowed to cancel this order.", 403);
    return serverError("order cancel", raw, "The order could not be cancelled. Please try again.");
  }

  return ok({ cancelled: data === true });
}
