import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { fail, ok, m } from "@/lib/api";
import { parseDbDec, parseDec } from "@/lib/money";
import {
  BID_PRICE_CAP,
  BID_PRICE_FLOOR,
  DEFAULT_INSTRUMENT,
  DEFAULT_MARKET_PRODUCT,
  DESK_INSTRUMENT_CODES,
  getInstrument,
} from "@/lib/ercot/types";
import {
  needsCounterPoint,
  resolveTradedProduct,
} from "@/lib/trading/instruments";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------- GET (book)

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status && status !== "OPEN" && status !== "FILLED" && status !== "CANCELLED" && status !== "EXPIRED") {
    return fail("Invalid status", 422);
  }

  const db = await createClient();
  let query = db
    .from("paper_orders")
    .select(
      "id, market_id, product, instrument, counter_market_id, side, quantity_mwh, limit_price, order_type, status, delivery_start, delivery_end, filled_trade_id, expires_at, created_at, updated_at"
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return fail(error.message, 500);

  return ok({
    orders: (data ?? []).map((o) => ({
      id: o.id,
      marketId: o.market_id,
      product: o.product,
      instrument: o.instrument,
      counterMarketId: o.counter_market_id,
      side: o.side,
      quantityMwh: m(parseDbDec(o.quantity_mwh)),
      // MARKET orders have no limit: they fill at the clearing price.
      limitPrice: o.limit_price == null ? null : m(parseDbDec(o.limit_price)),
      orderType: o.order_type,
      status: o.status,
      deliveryStart: o.delivery_start,
      deliveryEnd: o.delivery_end,
      filledTradeId: o.filled_trade_id,
      expiresAt: o.expires_at,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    })),
  });
}

// ---------------------------------------------------------------- POST (place)

const OrderRequest = z.object({
  marketId: z.string().uuid(),
  instrument: z.string().min(1).default(DEFAULT_INSTRUMENT),
  product: z.string().min(1).default(DEFAULT_MARKET_PRODUCT),
  counterMarketId: z.string().uuid().nullish(),
  side: z.enum(["BUY", "SELL"]),
  quantityMwh: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Quantity must be a positive decimal number")
    .refine((v) => parseDec(v) > 0n && parseDec(v) <= parseDec("1000"), {
      message: "Quantity must be > 0 and <= 1000 MWh",
    }),
  // Omitted or null: a MARKET order, filled at whatever the day-ahead market
  // clears at. Otherwise a LIMIT (0038).
  limitPrice: z
    .string()
    .regex(/^-?\d+(\.\d{1,6})?$/, "Limit price must be a number")
    // ERCOT's bid/offer bounds: negative prices are ordinary in the west.
    .refine((v) => parseDec(v) >= parseDec(String(BID_PRICE_FLOOR)) && parseDec(v) <= parseDec(String(BID_PRICE_CAP)), {
      message: `Limit price must be between -$${-BID_PRICE_FLOOR} and $${BID_PRICE_CAP.toLocaleString("en-US")}/MWh`,
    })
    .nullish(),
  deliveryStart: z.string().datetime(),
  deliveryEnd: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});

const FRIENDLY: Record<string, string> = {
  FORBIDDEN: "You are not allowed to place orders on this account.",
  ACCOUNT_NOT_FOUND: "Paper account not found.",
  MARKET_INVALID: "That market is not available for trading.",
  INSTRUMENT_INVALID: "That is not an instrument this desk trades.",
  INSTRUMENT_NOT_TRADABLE: "That instrument is not open for trading yet.",
  COUNTER_POINT_REQUIRED:
    "That instrument is a spread — it needs a second settlement point.",
  COUNTER_POINT_INVALID:
    "The second settlement point is not valid for that instrument.",
  PRODUCT_INVALID: "That product is not one this desk trades.",
  PRODUCT_NOT_TRADABLE: "That product is not open for trading yet.",
  SIDE_INVALID: "Side must be BUY or SELL.",
  QUANTITY_INVALID: "Quantity must be a positive number.",
  LIMIT_PRICE_INVALID: "Limit price must be between -$250 and $5,000/MWh.",
  DELIVERY_INVALID: "The delivery window is invalid.",
  DELIVERY_IN_PAST: "That delivery period has already started, so it can no longer be traded.",
  DELIVERY_TOO_FAR_OUT: "That delivery is too far in the future (max 35 days).",
  EXPIRY_INVALID: "Expiry must be in the future.",
  CREDIT_LIMIT_EXCEEDED:
    "Not enough credit: your open bids' collateral plus this one would exceed your cash. Each bid holds MW x the 95th-percentile day-ahead/real-time gap at its point (at least $10/MW).",
  DAM_CLOSED: "Day-ahead bids for that operating day closed at 10:00 AM Central the day before.",
};

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }

  const parsed = OrderRequest.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid order", 422);
  }
  const o = parsed.data;

  const instrument = getInstrument(o.instrument);
  if (!instrument) return fail("That is not an instrument this desk trades.", 422);
  if (!DESK_INSTRUMENT_CODES.includes(instrument.code)) {
    return fail(
      "The desk offers virtual INC/DEC bids and day-ahead PTP obligations. Other instruments enter and settle on the same day-ahead price, so they cannot make or lose money.",
      422
    );
  }

  // The trade's product follows the same derivation as execution: the caller
  // names a series for single-leg instruments; derived instruments clear in
  // the day-ahead market regardless of the page they were placed from.
  const product = resolveTradedProduct(instrument, o.product);

  const db = await createClient();
  const { data, error } = await db.rpc("place_limit_order", {
    p_user_id: user.id,
    p_market_id: o.marketId,
    p_instrument: instrument.code,
    p_product: product,
    p_counter_market_id: needsCounterPoint(instrument.settlementRule)
      ? (o.counterMarketId ?? null)
      : null,
    p_side: o.side,
    p_quantity_mwh: o.quantityMwh,
    p_limit_price: o.limitPrice ?? null,
    p_delivery_start: o.deliveryStart,
    p_delivery_end: o.deliveryEnd,
    p_expires_at: o.expiresAt ?? null,
  });

  if (error) {
    const raw = error.message;
    const code = Object.keys(FRIENDLY).find((k) => raw.includes(k));
    return fail(code ? FRIENDLY[code] : raw, 422);
  }

  return ok({ orderId: data }, 201);
}
