import { z } from "zod";
import { parseDec } from "@/lib/money";
import {
  BID_PRICE_CAP,
  BID_PRICE_FLOOR,
  DEFAULT_INSTRUMENT,
  DEFAULT_MARKET_PRODUCT,
} from "@/lib/ercot/types";

/**
 * The body of `POST /api/orders`.
 *
 * Each number arrives as a decimal string and is checked twice: its grammar,
 * then its bounds. Zod 4 runs every check even after one fails, so the
 * grammar check aborts: the bounds parse the string with `parseDec`, which
 * throws on "1e2" or "NaN", and a throw inside validation is a 500 rather
 * than the 422 a malformed number deserves.
 */
/** paper_orders.client_order_id's bound (0057), as execute_trade's (0010). */
const MAX_KEY_LENGTH = 128;

export const OrderRequest = z.object({
  marketId: z.string().uuid(),
  instrument: z.string().min(1).default(DEFAULT_INSTRUMENT),
  product: z.string().min(1).default(DEFAULT_MARKET_PRODUCT),
  counterMarketId: z.string().uuid().nullish(),
  side: z.enum(["BUY", "SELL"]),
  quantityMwh: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, { message: "Quantity must be a positive decimal number", abort: true })
    .refine((v) => parseDec(v) > 0n && parseDec(v) <= parseDec("1000"), {
      message: "Quantity must be > 0 and <= 1000 MWh",
    }),
  // Omitted or null: a MARKET order, filled at whatever the day-ahead market
  // clears at. Otherwise a LIMIT (0038).
  limitPrice: z
    .string()
    .regex(/^-?\d+(\.\d{1,6})?$/, { message: "Limit price must be a number", abort: true })
    // ERCOT's bid/offer bounds: negative prices are ordinary in the west.
    .refine((v) => parseDec(v) >= parseDec(String(BID_PRICE_FLOOR)) && parseDec(v) <= parseDec(String(BID_PRICE_CAP)), {
      message: `Limit price must be between -$${-BID_PRICE_FLOOR} and $${BID_PRICE_CAP.toLocaleString("en-US")}/MWh`,
    })
    .nullish(),
  deliveryStart: z.string().datetime(),
  deliveryEnd: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  clientOrderId: z.string().trim().min(1).max(MAX_KEY_LENGTH).optional(),
});

export type OrderRequestBody = z.infer<typeof OrderRequest>;

/**
 * The order's idempotency key (0057), from the `Idempotency-Key` header or the
 * body's `clientOrderId`. Either will do; both must agree, because a request
 * naming two keys has no single order it could be a retry of.
 */
export function idempotencyKey(
  header: string | null,
  body: string | undefined
): { ok: true; key: string | null } | { ok: false; message: string } {
  const fromHeader = header?.trim() || null;
  if (fromHeader && fromHeader.length > MAX_KEY_LENGTH) {
    return { ok: false, message: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.` };
  }
  if (fromHeader && body && fromHeader !== body) {
    return { ok: false, message: "Idempotency-Key and clientOrderId disagree." };
  }
  return { ok: true, key: fromHeader ?? body ?? null };
}
