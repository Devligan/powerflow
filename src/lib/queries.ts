import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { format, parseDbDec } from "@/lib/money";
import { settlementState, type SettlementState } from "@/lib/settlement";
import { getSimClock } from "@/lib/sim-clock";
import {
  inExecutionOrder,
  portfolioMetrics,
  positionKey,
  replayTrades,
  unrealizedPnl,
  type PositionState,
  type ReplayTradeInput,
} from "@/lib/trading/accounting";
import type { MarginTier } from "@/lib/trading/margin";

/**
 * Read-side queries over trusted persisted data (service role, server-only).
 * Financial values are recomputed from the database — never accepted from
 * the client.
 */

/** PostgREST caps a response at this many rows, whatever `.limit()` says, and
 *  says nothing when it does. Anything that has to see all of an account's rows
 *  pages through them. */
const PAGE = 1000;
/** Bounds one read of an account's history to protect shared limits. */
const MAX_HISTORY_ROWS = 100_000;

async function allRows<T>(
  page: (from: number, to: number) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>
): Promise<T[]> {
  const rows: T[] = [];
  while (rows.length < MAX_HISTORY_ROWS) {
    const { data, error } = await page(rows.length, rows.length + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

interface DbBookkeeping {
  id: string;
  instrument: string;
  market_id: string;
  counter_market_id: string | null;
  product: string;
  delivery_start: string;
  delivery_end: string;
  quantity_mwh: string;
  average_entry_price: string;
  realized_pnl: string;
  settled_at: string | null;
  settlement_trade_id: string | null;
}

interface MarkEntry {
  price: bigint | null;
  ts: string | null;
}

export interface PositionView extends PositionState {
  id: string;
  instrument: string;
  marketId: string;
  counterMarketId: string | null;
  product: string;
  settlementPoint: string;
  counterSettlementPoint: string | null;
  deliveryStart: string;
  deliveryEnd: string;
  markPrice: bigint | null;
  markTimestamp: string | null;
  unrealizedPnl: bigint;
  isOpen: boolean;
  /** When the position was cashed out at delivery, or null. */
  settledAt: string | null;
  /** The SETTLED trade that cashed it out, or null. */
  settlementTradeId: string | null;
  /** Where the position stands with respect to delivery and settlement. */
  settlement: SettlementState;
}

/** Margin state, computed by `account_margin` in Postgres rather than here:
 *  equity and the requirements are the same numbers the settlement leg acts
 *  on, so the UI must not carry a second implementation of them. */
export interface MarginView {
  cashBalance: bigint;
  markedValue: bigint;
  /** Settlement cash the account could not pay. A liability. */
  deficit: bigint;
  equity: bigint;
  usedMargin: bigint;
  maintenanceMargin: bigint;
  availableMargin: bigint;
  marginRatio: number | null;
  /** Positions whose instrument price is unresolvable, so the requirements
   *  above understate the account by an unknown amount. */
  unpricedPositions: number;
  tier: MarginTier;
}

export interface PortfolioSnapshot {
  account: {
    id: string | undefined;
    startingCash: string;
    cashBalance: string;
    maxGrossNotional: string;
    deficit: string;
  };
  positions: PositionView[];
  metrics: ReturnType<typeof portfolioMetrics>;
  /** Null only when the margin state could not be read at all. */
  margin: MarginView | null;
  dataStatus: unknown;
}

interface AccountMarginRow {
  cash_balance: string;
  marked_value: string;
  deficit: string;
  equity: string;
  used_margin: string;
  maintenance_margin: string;
  available_margin: string;
  margin_ratio: string | number | null;
  unpriced_positions: number | string;
  tier: MarginTier;
}

interface PositionMarkRow {
  position_id: string;
  mark_price: string | null;
  mark_timestamp: string | null;
}

/** Every position the account has held: realized P&L sums over all of them,
 *  and settled ones outnumber open ones within weeks of hourly bids. */
export function allPositions(userId: string): Promise<DbBookkeeping[]> {
  return allRows<DbBookkeeping>((from, to) =>
    supabaseAdmin()
      .from("positions")
      .select(
        "id, instrument, market_id, counter_market_id, product, delivery_start, delivery_end, quantity_mwh, average_entry_price, realized_pnl, settled_at, settlement_trade_id"
      )
      .eq("user_id", userId)
      .order("id")
      .range(from, to)
  );
}

async function loadContexts(userId: string) {
  const admin = supabaseAdmin();
  const [rows, marketsRes, clock] = await Promise.all([
    allPositions(userId),
    admin.from("markets").select("id, settlement_point"),
    getSimClock(userId),
  ]);

  // Marks are resolved by the engine itself (`position_marks`, migration 0008)
  // because an instrument price is a reduction over legs — a spread has no
  // single price series and a window instrument has no single interval, so the
  // read side cannot recompute a mark from a point price. A missing mark is
  // reported as null (unpriced), never defaulted to zero.
  const marksRes = await admin.rpc("position_marks", { p_user_id: userId });
  if (marksRes.error) throw new Error(marksRes.error.message);

  const markById = new Map<string, MarkEntry>();
  for (const row of (marksRes.data ?? []) as unknown as PositionMarkRow[]) {
    markById.set(row.position_id, {
      price: row.mark_price == null ? null : parseDbDec(row.mark_price),
      ts: row.mark_timestamp,
    });
  }

  const settlementByMarket = new Map(
    (marketsRes.data ?? []).map((m: { id: string; settlement_point: string }) => [
      m.id,
      m.settlement_point,
    ])
  );
  // "Delivered" is on the account's clock, as it is for the sweep.
  const nowMs = clock ? Date.parse(clock.now) : Date.now();
  return { rows, markById, settlementByMarket, nowMs };
}

function toPositionView(
  row: DbBookkeeping,
  markById: Map<string, MarkEntry>,
  settlementByMarket: Map<string, string>,
  nowMs: number
): PositionView {
  const quantityMwh = parseDbDec(row.quantity_mwh);
  const averageEntryPrice = parseDbDec(row.average_entry_price);
  const realizedPnl = parseDbDec(row.realized_pnl);
  const mark = markById.get(row.id);
  const markPrice = mark?.price ?? null;
  const unrealised =
    markPrice == null
      ? 0n
      : unrealizedPnl({ quantityMwh, averageEntryPrice }, markPrice);

  return {
    id: row.id,
    instrument: row.instrument,
    marketId: row.market_id,
    counterMarketId: row.counter_market_id,
    product: row.product,
    settlementPoint: settlementByMarket.get(row.market_id) ?? row.market_id,
    counterSettlementPoint: row.counter_market_id
      ? settlementByMarket.get(row.counter_market_id) ?? row.counter_market_id
      : null,
    deliveryStart: row.delivery_start,
    deliveryEnd: row.delivery_end,
    quantityMwh,
    averageEntryPrice,
    realizedPnl,
    markPrice,
    markTimestamp: mark?.ts ?? null,
    unrealizedPnl: unrealised,
    isOpen: quantityMwh !== 0n,
    settledAt: row.settled_at,
    settlementTradeId: row.settlement_trade_id,
    settlement: settlementState({
      quantityMwh,
      settledAt: row.settled_at,
      deliveryEnd: row.delivery_end,
      // An unpriced window is precisely what the sweep defers on, so the same
      // null that means "cannot be marked" also means "cannot be settled yet".
      markPrice,
      now: nowMs,
    }),
  };
}

export async function getPortfolioSnapshot(
  userId: string
): Promise<PortfolioSnapshot> {
  const admin = supabaseAdmin();
  const { rows, markById, settlementByMarket, nowMs } = await loadContexts(userId);

  const [accountRes, marginRes] = await Promise.all([
    admin.from("paper_accounts").select("*").eq("user_id", userId).maybeSingle(),
    admin.rpc("account_margin", { p_user_id: userId }),
  ]);

  const positions = rows.map((row) =>
    toPositionView(row, markById, settlementByMarket, nowMs)
  );

  // Metrics are marked per instrument, so the mark map is keyed by the same
  // identity the positions carry.
  const marks = new Map<string, bigint>();
  for (const p of positions) {
    if (p.markPrice != null) marks.set(positionKey(p), p.markPrice);
  }

  const metrics = portfolioMetrics({
    cashBalance: parseDbDec(accountRes.data?.cash_balance ?? "0"),
    startingCash: parseDbDec(accountRes.data?.starting_cash ?? "0"),
    deficit: parseDbDec(accountRes.data?.deficit ?? "0"),
    marks,
    positions: positions.map((p) => ({
      instrument: p.instrument,
      marketId: p.marketId,
      counterMarketId: p.counterMarketId,
      product: p.product,
      deliveryStart: p.deliveryStart,
      deliveryEnd: p.deliveryEnd,
      quantityMwh: p.quantityMwh,
      averageEntryPrice: p.averageEntryPrice,
      realizedPnl: p.realizedPnl,
    })),
  });

  const marginRow = (marginRes.data as AccountMarginRow[] | null)?.[0];

  return {
    account: {
      id: accountRes.data?.id,
      startingCash: accountRes.data?.starting_cash ?? "0",
      cashBalance: accountRes.data?.cash_balance ?? "0",
      maxGrossNotional: accountRes.data?.max_gross_notional ?? "0",
      deficit: accountRes.data?.deficit ?? "0",
    },
    positions,
    metrics,
    margin: marginRow ? toMarginView(marginRow) : null,
    dataStatus: null,
  };
}

function toMarginView(row: AccountMarginRow): MarginView {
  return {
    cashBalance: parseDbDec(row.cash_balance),
    markedValue: parseDbDec(row.marked_value),
    deficit: parseDbDec(row.deficit),
    equity: parseDbDec(row.equity),
    usedMargin: parseDbDec(row.used_margin),
    maintenanceMargin: parseDbDec(row.maintenance_margin),
    availableMargin: parseDbDec(row.available_margin),
    // PostgREST renders `numeric` as a string, and a null ratio stays null:
    // an account with no open exposure has no ratio, not a ratio of zero.
    marginRatio: row.margin_ratio == null ? null : Number(row.margin_ratio),
    unpricedPositions: Number(row.unpriced_positions),
    tier: row.tier,
  };
}

export async function getPositionsView(userId: string): Promise<PositionView[]> {
  const { rows, markById, settlementByMarket, nowMs } = await loadContexts(userId);
  return rows.map((row) =>
    toPositionView(row, markById, settlementByMarket, nowMs)
  );
}

/** A `trades` row, as the read side uses it. */
export interface HistoryTrade {
  id: string;
  instrument: string;
  market_id: string;
  counter_market_id: string | null;
  product: string;
  venue: string;
  side: "BUY" | "SELL";
  quantity_mwh: string;
  execution_price: string;
  delivery_start: string;
  delivery_end: string;
  price_timestamp: string;
  status: string;
  created_at: string;
  executed_at: string;
}

export function replayInput(t: HistoryTrade): ReplayTradeInput {
  return {
    id: t.id,
    instrument: t.instrument,
    marketId: t.market_id,
    counterMarketId: t.counter_market_id,
    product: t.product,
    side: t.side,
    quantityMwh: parseDbDec(t.quantity_mwh),
    executionPrice: parseDbDec(t.execution_price),
    deliveryStart: t.delivery_start,
    deliveryEnd: t.delivery_end,
  };
}

/**
 * An account's whole trade history, in the order the engine applied it.
 *
 * Replaying part of a history is worse than not replaying it: a close whose
 * open was cut off reads as a new position, and every P&L figure after it is
 * wrong. So this reads every row rather than the newest page.
 */
export async function tradeHistory(userId: string): Promise<HistoryTrade[]> {
  const rows = await allRows<HistoryTrade>((from, to) =>
    supabaseAdmin()
      .from("trades")
      .select(
        "id, instrument, market_id, counter_market_id, product, venue, side, quantity_mwh, execution_price, delivery_start, delivery_end, price_timestamp, status, created_at, executed_at"
      )
      .eq("user_id", userId)
      .order("created_at")
      .order("id")
      .range(from, to)
  );
  return inExecutionOrder(rows, (t) => ({
    key: positionKey(replayInput(t)),
    status: t.status,
    at: t.created_at,
  }));
}

export interface TradeRow {
  id: string;
  market_id: string;
  settlement_point: string;
  instrument: string;
  counter_market_id: string | null;
  counter_settlement_point: string | null;
  product: string;
  venue: string;
  side: "BUY" | "SELL";
  quantity_mwh: string;
  execution_price: string;
  delivery_start: string;
  delivery_end: string;
  price_timestamp: string;
  status: string;
  created_at: string;
  executed_at: string;
  realized_pnl: string;
}

export interface TradeFilters {
  marketId?: string;
  side?: "BUY" | "SELL";
  dateFrom?: string;
  dateTo?: string;
  offset?: number;
  limit?: number;
  /** Every matching trade in one page (export); the replay is the same. */
  all?: boolean;
}

const isoInstant = z.string().refine((v) => !Number.isNaN(Date.parse(v)));
const TradeQuery = z.object({
  marketId: z.string().uuid().optional(),
  side: z.enum(["BUY", "SELL"]).optional(),
  dateFrom: isoInstant.optional(),
  dateTo: isoInstant.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** The blotter's query string, or null when any part of it is malformed. */
export function parseTradeFilters(params: URLSearchParams): TradeFilters | null {
  const parsed = TradeQuery.safeParse(Object.fromEntries(params));
  return parsed.success ? parsed.data : null;
}

export async function getTrades(
  userId: string,
  filters: TradeFilters = {}
): Promise<{ rows: TradeRow[]; total: number }> {
  const admin = supabaseAdmin();
  const limit = filters.all ? Number.MAX_SAFE_INTEGER : Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  // Realized P&L per trade is attributed by replaying history through the
  // same engine as execute_trade, which requires the *unfiltered* running
  // position: replaying only the filtered subset would re-open positions that
  // were already closed and report wrong P&L. So the full history is fetched
  // and replayed first; filters then select which trades are listed, never
  // how their P&L was computed.
  const history = await tradeHistory(userId);
  const realizedById = new Map<string, string>();
  for (const t of replayTrades(history.map(replayInput)).trades) {
    // A decimal string, like every other DB-shaped field here: the bigint is
    // already at the 1e6 scale, so String() would read back a million times too large.
    realizedById.set(t.id, format(t.realizedPnL, 6));
  }
  // The blotter reads newest first.
  const all = [...history].reverse();

  // Local-time-safe: compare instants rather than PostgREST timestamp strings.
  const dateFromMs = filters.dateFrom ? new Date(filters.dateFrom).getTime() : null;
  const dateToMs = filters.dateTo ? new Date(filters.dateTo).getTime() : null;
  const filtered = all.filter((t) => {
    if (filters.marketId && t.market_id !== filters.marketId) return false;
    if (filters.side && t.side !== filters.side) return false;
    if (dateFromMs != null || dateToMs != null) {
      const created = new Date(t.created_at).getTime();
      if (dateFromMs != null && created < dateFromMs) return false;
      if (dateToMs != null && created > dateToMs) return false;
    }
    return true;
  });

  const marketsRes = await admin.from("markets").select("id, settlement_point");
  const pointById = new Map(
    (marketsRes.data ?? []).map((m: { id: string; settlement_point: string }) => [
      m.id,
      m.settlement_point,
    ])
  );

  const page = filtered.slice(offset, offset + limit);
  const rows = page.map((r) => ({
    ...r,
    settlement_point: pointById.get(r.market_id) ?? r.market_id,
    counter_settlement_point: r.counter_market_id
      ? pointById.get(r.counter_market_id) ?? r.counter_market_id
      : null,
    quantity_mwh: String(r.quantity_mwh),
    execution_price: String(r.execution_price),
    realized_pnl: realizedById.get(r.id) ?? "0",
  }));

  return { rows, total: filtered.length };
}