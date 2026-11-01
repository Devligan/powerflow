import { supabaseAdmin } from "@/lib/supabase/admin";
import { format, parseDbDec } from "@/lib/money";
import { settlementState, type SettlementState } from "@/lib/settlement";
import {
  portfolioMetrics,
  positionKey,
  replayTrades,
  unrealizedPnl,
  type PositionState,
} from "@/lib/trading/accounting";
import type { MarginTier } from "@/lib/trading/margin";

/**
 * Read-side queries over trusted persisted data (service role, server-only).
 * Financial values are recomputed from the database — never accepted from
 * the client.
 */

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

async function loadContexts(userId: string) {
  const admin = supabaseAdmin();
  const [positionsRes, marketsRes] = await Promise.all([
    admin
      .from("positions")
      .select(
        "id, instrument, market_id, counter_market_id, product, delivery_start, delivery_end, quantity_mwh, average_entry_price, realized_pnl, settled_at, settlement_trade_id"
      )
      .eq("user_id", userId),
    admin.from("markets").select("id, settlement_point"),
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
  const rows = (positionsRes.data ?? []) as unknown as DbBookkeeping[];
  return { rows, markById, settlementByMarket };
}

function toPositionView(
  row: DbBookkeeping,
  markById: Map<string, MarkEntry>,
  settlementByMarket: Map<string, string>
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
    }),
  };
}

export async function getPortfolioSnapshot(
  userId: string
): Promise<PortfolioSnapshot> {
  const admin = supabaseAdmin();
  const { rows, markById, settlementByMarket } = await loadContexts(userId);

  const [accountRes, marginRes] = await Promise.all([
    admin.from("paper_accounts").select("*").eq("user_id", userId).maybeSingle(),
    admin.rpc("account_margin", { p_user_id: userId }),
  ]);

  const positions = rows.map((row) =>
    toPositionView(row, markById, settlementByMarket)
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
  const { rows, markById, settlementByMarket } = await loadContexts(userId);
  return rows.map((row) =>
    toPositionView(row, markById, settlementByMarket)
  );
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
  // how their P&L was computed. Bounded to protect shared limits.
  const { data, error } = await admin
    .from("trades")
    .select("id, instrument, market_id, counter_market_id, product, venue, side, quantity_mwh, execution_price, delivery_start, delivery_end, price_timestamp, status, created_at, executed_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const all = (data ?? []) as Array<Record<string, unknown>>;
  const realizedById = new Map<string, string>();
  if (all.length > 0) {
    // Replay in chronological order (newest-first fetch must be reversed).
    const replay = replayTrades(
      [...all]
        .reverse()
        .map((t) => ({
          id: String(t.id),
          instrument: String(t.instrument),
          marketId: String(t.market_id),
          counterMarketId: t.counter_market_id ? String(t.counter_market_id) : null,
          product: String(t.product),
          side: t.side as "BUY" | "SELL",
          quantityMwh: parseDbDec(String(t.quantity_mwh)),
          executionPrice: parseDbDec(String(t.execution_price)),
          deliveryStart: String(t.delivery_start),
          deliveryEnd: String(t.delivery_end),
        }))
    );
    for (const t of replay.trades) {
      // A decimal string, like every other DB-shaped field here: the bigint is
      // already at the 1e6 scale, so String() would read back a million times too large.
      realizedById.set(t.id, format(t.realizedPnL, 6));
    }
  }

  // Local-time-safe: compare instants rather than PostgREST timestamp strings.
  const dateFromMs = filters.dateFrom ? new Date(filters.dateFrom).getTime() : null;
  const dateToMs = filters.dateTo ? new Date(filters.dateTo).getTime() : null;
  const filtered = all.filter((t) => {
    if (filters.marketId && String(t.market_id) !== filters.marketId) return false;
    if (filters.side && String(t.side) !== filters.side) return false;
    if (dateFromMs != null || dateToMs != null) {
      const created = new Date(String(t.created_at)).getTime();
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
    id: String(r.id),
    market_id: String(r.market_id),
    settlement_point: pointById.get(String(r.market_id)) ?? String(r.market_id),
    instrument: String(r.instrument),
    counter_market_id: r.counter_market_id ? String(r.counter_market_id) : null,
    counter_settlement_point: r.counter_market_id
      ? pointById.get(String(r.counter_market_id)) ?? String(r.counter_market_id)
      : null,
    product: String(r.product),
    venue: String(r.venue),
    side: r.side as "BUY" | "SELL",
    quantity_mwh: String(r.quantity_mwh),
    execution_price: String(r.execution_price),
    delivery_start: String(r.delivery_start),
    delivery_end: String(r.delivery_end),
    price_timestamp: String(r.price_timestamp),
    status: String(r.status),
    created_at: String(r.created_at),
    executed_at: String(r.executed_at),
    realized_pnl: realizedById.get(String(r.id)) ?? "0",
  }));

  return { rows, total: filtered.length };
}