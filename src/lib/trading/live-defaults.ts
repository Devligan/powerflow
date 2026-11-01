import { getProduct } from "@/lib/ercot/types";
import {
  firstOpenOperatingDay,
  hourEndingStartUtc,
  isDayAheadProduct,
} from "@/lib/ercot/hour-ending";

/**
 * Default delivery for the order ticket.
 *
 * Day-ahead positions are bids made before the market clears (0038): an
 * operating day takes bids until 10:00 Central the day before. So the ticket
 * opens on the first operating day still open for bids — tomorrow before
 * 10:00, the day after from then on — at HE18, a liquid on-peak hour. A
 * delivery the desk would refuse is never the default.
 *
 * Reference series (real-time) are not orderable at all; the ticket says why
 * and points at the instruments that reach the same exposure.
 */
export interface LiveDeliveryDefault {
  date: string;
  hour: number;
  /** One line of honest guidance when the default product cannot trade. */
  note: string | null;
}

const DEFAULT_HE = 18;

export function liveDeliveryDefault(
  productCode: string,
  nowMs: number = Date.now()
): LiveDeliveryDefault {
  const product = getProduct(productCode);
  let start: number;
  if (isDayAheadProduct(productCode) || !product?.tradable) {
    const day = firstOpenOperatingDay(nowMs);
    start = hourEndingStartUtc(day, DEFAULT_HE) ?? nowMs + 3600_000;
  } else {
    start = Math.ceil(nowMs / 3600_000) * 3600_000;
  }
  const d = new Date(start);
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    note:
      product && !product.tradable
        ? `${product.label} is a reference series — real-time prices are published only after delivery, so it is not orderable. Reach real-time exposure with a DART spread or virtual.`
        : null,
  };
}
