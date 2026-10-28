import { getProduct } from "@/lib/ercot/types";

/**
 * Live-mode default delivery for the order ticket.
 *
 * The old default — "next wall-clock hour" — silently broke the moment the
 * catalog let the ticket offer a real-time series: RT prints exist only
 * AFTER delivery, so the pre-filled delivery could only be refused with
 * PRICE_UNAVAILABLE. Under the corrected catalog (0025: RT series are
 * reference-only), the next-hour default is sound for every orderable
 * product — for DAM, the next full hour's Central delivery day is always
 * already posted (D-1 ~12:35 Central covers all 24 of its hours, and the
 * next full hour always lands in today's or yesterday's Central day).
 *
 * What remains is honesty about the products that are no longer orderable:
 * the ticket states why, and points at the instruments that reach the same
 * exposure. The engine remains the authority — it refuses a past delivery
 * or an unpublished price regardless of what the UI pre-fills.
 */
export interface LiveDeliveryDefault {
  date: string;
  hour: number;
  /** One line of honest guidance when the default product cannot trade. */
  note: string | null;
}

/**
 * The ticket's default delivery: the next full hour, plus a note when the
 * page's series is reference-only rather than orderable.
 */
export function liveDeliveryDefault(
  productCode: string,
  nowMs: number = Date.now()
): LiveDeliveryDefault {
  const d = new Date(nowMs + 3600_000);
  const product = getProduct(productCode);
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    note:
      product && !product.tradable
        ? `${product.label} is a reference series — real-time prices are published only after delivery, so it is not orderable. Reach real-time exposure with a DART spread or virtual.`
        : null,
  };
}
