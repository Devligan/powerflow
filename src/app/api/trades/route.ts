import crypto from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { fail, ok, m } from "@/lib/api";
import { parseDbDec, parseDec } from "@/lib/money";
import {
  DEFAULT_INSTRUMENT,
  DEFAULT_MARKET_PRODUCT,
  getInstrument,
  getProduct,
} from "@/lib/ercot/types";
import { getTrades } from "@/lib/queries";
import {
  needsCounterPoint,
  resolveTradedProduct,
} from "@/lib/trading/instruments";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------- GET (list)

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  const url = new URL(req.url);
  const side = url.searchParams.get("side") as "BUY" | "SELL" | null;
  if (side && side !== "BUY" && side !== "SELL") return fail("Invalid side", 422);

  const limit = Number(url.searchParams.get("limit") ?? "50");
  const offset = Number(url.searchParams.get("offset") ?? "0");

  try {
    const { rows, total } = await getTrades(user.id, {
      marketId: url.searchParams.get("marketId") ?? undefined,
      side: side ?? undefined,
      dateFrom: url.searchParams.get("dateFrom") ?? undefined,
      dateTo: url.searchParams.get("dateTo") ?? undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });

    return ok({
      total,
      trades: rows.map((r) => ({
        id: r.id,
        marketId: r.market_id,
        settlementPoint: r.settlement_point,
        instrument: r.instrument,
        counterMarketId: r.counter_market_id,
        counterSettlementPoint: r.counter_settlement_point,
        product: r.product,
        venue: r.venue,
        side: r.side,
        quantityMwh: m(parseDbDec(r.quantity_mwh)),
        executionPrice: m(parseDbDec(r.execution_price)),
        deliveryStart: r.delivery_start,
        deliveryEnd: r.delivery_end,
        priceTimestamp: r.price_timestamp,
        status: r.status,
        createdAt: r.created_at,
        realizedPnl: m(parseDbDec(r.realized_pnl)),
      })),
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Failed to load trades", 500);
  }
}

// ---------------------------------------------------------------- POST (execute)

const TradeRequest = z.object({
  marketId: z.string().uuid(),
  // What is being traded is an *instrument* (energy spot, a virtual INC/DEC, a
  // point-to-point spread, a block forward…), and a price only exists per
  // (settlement point, product, interval) — so a trade must name both.
  instrument: z.string().min(1).default(DEFAULT_INSTRUMENT),
  product: z.string().min(1).default(DEFAULT_MARKET_PRODUCT),
  // Leg B (sink) for path instruments; rejected when the instrument is not one.
  counterMarketId: z.string().uuid().nullish(),
  side: z.enum(["BUY", "SELL"]),
  quantityMwh: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Quantity must be a positive decimal number")
    .refine((v) => parseDec(v) > 0n && parseDec(v) <= parseDec("1000"), {
      message: "Quantity must be > 0 and <= 1000 MWh",
    }),
  deliveryStart: z.string().datetime(),
  deliveryEnd: z.string().datetime(),
  // Idempotency key for this *intent*. A retry (timeout, double submit,
  // reconnect) carrying the same id replays the original execution instead of
  // filling a second time. Generated here when absent, in which case the
  // request is not deduplicated — only a client-chosen id can be replayed.
  clientOrderId: z
    .string()
    .trim()
    .min(8, "Client order id must be at least 8 characters")
    .max(128, "Client order id must be at most 128 characters")
    .optional(),
});

const FRIENDLY = {
  FORBIDDEN: "You are not allowed to trade this account.",
  MARKET_INVALID: "That market is not available for trading.",
  INSTRUMENT_INVALID: "That is not an instrument this desk trades.",
  INSTRUMENT_NOT_TRADABLE: "That instrument is not open for trading yet.",
  COUNTER_POINT_REQUIRED:
    "That instrument is a spread — it needs a second settlement point.",
  COUNTER_POINT_INVALID:
    "The second settlement point is not valid for that instrument.",
  CLIENT_ORDER_ID_INVALID: "That order id is not usable.",
  PRODUCT_INVALID: "That product is not one this desk trades.",
  PRODUCT_NOT_TRADABLE: "That product is not open for trading yet.",
  SIDE_INVALID: "Side must be BUY or SELL.",
  QUANTITY_INVALID: "Quantity must be a positive number.",
  DELIVERY_INVALID: "The delivery window is invalid.",
  DELIVERY_INTERVAL_INVALID:
    "The delivery window must match the product's settlement interval.",
  DELIVERY_WINDOW_INVALID:
    "A settlement window must be a whole number of settlement intervals.",
  DELIVERY_MUST_BE_ALIGNED:
    "Delivery must start on a settlement-interval boundary.",
  DELIVERY_IN_PAST: "That delivery period has already started, so it can no longer be traded.",
  DELIVERY_TOO_FAR_OUT: "That delivery is too far in the future (max 35 days).",
  DAM_CLOSED: "Day-ahead bids for that operating day closed at 10:00 AM Central the day before.",
  DAM_ORDER_REQUIRED:
    "Day-ahead positions are bids: place an order before 10:00 AM Central the day before, and it fills when the market clears.",
  PRICE_UNAVAILABLE: "No market price is available to execute against.",
  ACCOUNT_NOT_FOUND: "Paper account not found.",
  INSUFFICIENT_CAPITAL: "Not enough virtual cash to cover this buy.",
  EXPOSURE_LIMIT_EXCEEDED: "This trade would exceed your gross exposure limit.",
} as const;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await req.json().catch(() => null);
  if (body == null) return fail("Invalid JSON body", 400);

  const parsed = TradeRequest.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid trade request";
    return fail(msg, 422);
  }
  const t = parsed.data;

  const instrument = getInstrument(t.instrument);
  if (!instrument) return fail(FRIENDLY.INSTRUMENT_INVALID, 422);
  if (!instrument.tradable) return fail(FRIENDLY.INSTRUMENT_NOT_TRADABLE, 422);

  // Path and legless instruments price off the market they clear in, not off a
  // series the caller names, so the product is only the caller's to choose for
  // single-leg instruments.
  const tradedProduct = resolveTradedProduct(instrument, t.product);
  const def = getProduct(tradedProduct);
  if (!def) return fail(FRIENDLY.PRODUCT_INVALID, 422);
  if (instrument.productFromTrade && !def.tradable) {
    return fail(FRIENDLY.PRODUCT_NOT_TRADABLE, 422);
  }
  // Both path rules need a second point — a CRR and a day-ahead PTP
  // instrument are each a source/sink pair. Kept in step with
  // `execute_trade` step 4, which rejects the same two cases server-side.
  if (needsCounterPoint(instrument.settlementRule) && !t.counterMarketId) {
    return fail(FRIENDLY.COUNTER_POINT_REQUIRED, 422);
  }
  if (!needsCounterPoint(instrument.settlementRule) && t.counterMarketId) {
    return fail(FRIENDLY.COUNTER_POINT_INVALID, 422);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("execute_trade", {
    p_user_id: user.id,
    p_market_id: t.marketId,
    p_counter_market_id: t.counterMarketId ?? null,
    p_instrument: t.instrument,
    p_product: tradedProduct,
    p_side: t.side,
    p_quantity_mwh: t.quantityMwh,
    p_delivery_start: t.deliveryStart,
    p_delivery_end: t.deliveryEnd,
    p_client_order_id: t.clientOrderId ?? crypto.randomUUID(),
  });

  if (error) {
    const code = String(error.message ?? "").trim();
    const friendly = (FRIENDLY as Record<string, string>)[code];
    return fail(friendly ?? (error.message ?? "Trade failed"), 422);
  }

  const d = data as {
    trade_id: string;
    instrument: string;
    settlement_rule: string;
    option_type: string;
    product: string;
    venue: string;
    side: "BUY" | "SELL";
    quantity_mwh: string;
    execution_price: string;
    price_timestamp: string;
    price_stale: boolean;
    market_price_id: string | null;
    counter_market_id: string | null;
    notional: string;
    realized_delta: string;
    cash_balance: string;
    position_quantity: string;
    position_average_entry_price: string;
    executed_at: string;
    /** true when this response is the replayed result of the original fill. */
    replayed?: boolean;
  };

  return ok({
    trade: {
      id: d.trade_id,
      instrument: d.instrument,
      settlementRule: d.settlement_rule,
      optionType: d.option_type,
      product: d.product,
      venue: d.venue,
      side: d.side,
      counterMarketId: d.counter_market_id,
      quantityMwh: m(parseDbDec(d.quantity_mwh)),
      executionPrice: m(parseDbDec(d.execution_price)),
      priceTimestamp: d.price_timestamp,
      priceStale: Boolean(d.price_stale),
      notional: m(parseDbDec(d.notional)),
      realizedDelta: m(parseDbDec(d.realized_delta)),
      cashBalance: m(parseDbDec(d.cash_balance)),
      positionQuantity: m(parseDbDec(d.position_quantity)),
      positionAverageEntryPrice: m(parseDbDec(d.position_average_entry_price)),
      executedAt: d.executed_at,
      replayed: Boolean(d.replayed),
    },
  });
}