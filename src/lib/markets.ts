import { supabaseAdmin } from "@/lib/supabase/admin";
import { DEFAULT_MARKET_PRODUCT } from "@/lib/ercot/types";

export interface MarketView {
  id: string;
  settlementPoint: string;
  type: string;
  description: string | null;
  price: string | null;
  deliveryTimestamp: string | null;
  source: string | null;
  product: string;
}

export async function listMarkets(): Promise<MarketView[]> {
  const admin = supabaseAdmin();
  const [marketsRes, pricesRes] = await Promise.all([
    admin.from("markets").select("id, settlement_point, settlement_point_type, description, active"),
    admin
      .from("current_prices")
      .select("settlement_point, price, delivery_timestamp, source, product")
      .eq("product", DEFAULT_MARKET_PRODUCT),
  ]);
  if (marketsRes.error) throw new Error(marketsRes.error.message);
  if (pricesRes.error) throw new Error(pricesRes.error.message);

  const priceBySettlement = new Map<
    string,
    { price: string; ts: string | null; source: string | null }
  >();
  for (const p of (pricesRes.data ?? []) as Array<{
    settlement_point: string;
    price: string | null;
    delivery_timestamp: string | null;
    source: string | null;
  }>) {
    if (p.price == null) continue;
    priceBySettlement.set(p.settlement_point, {
      price: p.price,
      ts: p.delivery_timestamp,
      source: p.source,
    });
  }

  return (marketsRes.data ?? [])
    .filter((m: { active: boolean }) => m.active)
    .sort((a: { settlement_point: string }, b: { settlement_point: string }) =>
      a.settlement_point.localeCompare(b.settlement_point)
    )
    .map((m) => {
      const p = priceBySettlement.get((m as { settlement_point: string }).settlement_point);
      return {
        id: m.id,
        settlementPoint: m.settlement_point,
        type: m.settlement_point_type,
        description: m.description as string | null,
        price: p?.price ?? null,
        deliveryTimestamp: p?.ts ?? null,
        source: p?.source ?? null,
        product: DEFAULT_MARKET_PRODUCT,
      };
    });
}

export interface MarketOption {
  id: string;
  settlementPoint: string;
  type: string;
}

/** Just enough of the market list to offer a second settlement point on a
 *  spread ticket, without dragging every market's price along with it. */
export async function listMarketOptions(): Promise<MarketOption[]> {
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("markets")
    .select("id, settlement_point, settlement_point_type")
    .eq("active", true)
    .order("settlement_point");
  if (error) throw new Error(error.message);
  return (data ?? []).map((m) => ({
    id: m.id,
    settlementPoint: m.settlement_point,
    type: m.settlement_point_type,
  }));
}

export interface PricePoint {
  deliveryTimestamp: string;
  deliveryEnd: string | null;
  price: string;
  source: string | null;
  product: string;
}

export async function getMarketPrices(
  settlementPoint: string,
  product: string = DEFAULT_MARKET_PRODUCT
): Promise<{
  market: MarketView;
  latest: PricePoint | null;
  series: PricePoint[];
}> {
  const admin = supabaseAdmin();
  const marketRes = await admin
    .from("markets")
    .select("id, settlement_point, settlement_point_type, description, active")
    .eq("settlement_point", settlementPoint.toUpperCase())
    .maybeSingle();
  if (marketRes.error) throw new Error(marketRes.error.message);
  if (!marketRes.data) throw new Error("Market not found");

  const horizonFrom = new Date();
  horizonFrom.setUTCHours(horizonFrom.getUTCHours() - 48);

  const pricesRes = await admin
    .from("market_prices")
    .select("delivery_timestamp, delivery_end, price, source, product")
    .eq("market_id", marketRes.data.id)
    .eq("product", product)
    .gte("delivery_timestamp", horizonFrom.toISOString())
    .order("delivery_timestamp", { ascending: true })
    .limit(120);

  if (pricesRes.error) throw new Error(pricesRes.error.message);

  const series: PricePoint[] = (pricesRes.data ?? []).map((r) => ({
    deliveryTimestamp: r.delivery_timestamp,
    deliveryEnd: r.delivery_end,
    price: r.price,
    source: r.source,
    product: r.product,
  }));

  return {
    market: {
      id: marketRes.data.id,
      settlementPoint: marketRes.data.settlement_point,
      type: marketRes.data.settlement_point_type,
      description: marketRes.data.description as string | null,
      price: series.length ? series[series.length - 1].price : null,
      deliveryTimestamp: series.length ? series[series.length - 1].deliveryTimestamp : null,
      source: series.length ? series[series.length - 1].source : null,
      product,
    },
    latest: series.length ? series[series.length - 1] : null,
    series,
  };
}

export interface MarketStatus {
  latestRuns: Array<Record<string, unknown>>;
  latestPriceAt: string | null;
  latestPriceSource: string | null;
  mode: string;
  generated: boolean;
}

export async function getMarketStatus(): Promise<MarketStatus> {
  const admin = supabaseAdmin();
  const [runsRes, pricesRes] = await Promise.all([
    admin
      .from("ingestion_runs")
      .select("id, source, status, records_received, records_inserted, records_skipped, detail, started_at, finished_at")
      .order("finished_at", { ascending: false })
      .limit(5),
    admin
      .from("market_prices")
      .select("source, delivery_timestamp, product")
      .eq("product", DEFAULT_MARKET_PRODUCT)
      .order("delivery_timestamp", { ascending: false })
      .limit(1),
  ]);
  if (runsRes.error) throw new Error(runsRes.error.message);

  const latestRow = pricesRes.error ? null : pricesRes.data?.[0] ?? null;
  return {
    latestRuns: (runsRes.data ?? []) as Array<Record<string, unknown>>,
    latestPriceAt: latestRow?.delivery_timestamp ?? null,
    latestPriceSource: latestRow?.source ?? null,
    mode: process.env.ERCOT_SOURCE ?? "GENERATED",
    generated: (process.env.ERCOT_SOURCE ?? "GENERATED") === "GENERATED",
  };
}