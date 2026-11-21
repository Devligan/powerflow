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
});

export type OrderRequestBody = z.infer<typeof OrderRequest>;
