import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, fail, m } from "@/lib/api";
import { parseDec } from "@/lib/money";
import { DEFAULT_MARKET_PRODUCT } from "@/lib/ercot/types";

export const dynamic = "force-dynamic";

interface MarketRow {
  id: string;
  settlement_point: string;
  settlement_point_type: string;
  description: string | null;
  active: boolean;
}

interface CurrentPriceRow {
  settlement_point: string;
  price: string | null;
  delivery_timestamp: string | null;
  source: string | null;
  product: string | null;
}

export async function GET() {
  const admin = supabaseAdmin();
  const [marketsRes, pricesRes] = await Promise.all([
    admin.from("markets").select("id, settlement_point, settlement_point_type, description, active"),
    admin
      .from("current_prices")
      .select("settlement_point, price, delivery_timestamp, source, product")
      .eq("product", DEFAULT_MARKET_PRODUCT),
  ]);

  if (marketsRes.error) return fail(marketsRes.error.message, 500);
  if (pricesRes.error) return fail(pricesRes.error.message, 500);

  const prices = new Map<string, CurrentPriceRow>();
  for (const p of (pricesRes.data ?? []) as CurrentPriceRow[]) {
    prices.set(p.settlement_point, p);
  }

  const markets = (marketsRes.data ?? [] as MarketRow[])
    .filter((mkt) => mkt.active)
    .sort((a, b) => a.settlement_point.localeCompare(b.settlement_point))
    .map((mkt) => {
      const p = prices.get(mkt.settlement_point);
      const priceRaw = p?.price != null ? parseDec(p.price) : null;
      return {
        id: mkt.id,
        settlementPoint: mkt.settlement_point,
        type: mkt.settlement_point_type,
        description: mkt.description,
        price: priceRaw == null ? null : m(priceRaw),
        deliveryTimestamp: p?.delivery_timestamp ?? null,
        source: p?.source ?? null,
        product: p?.product ?? DEFAULT_MARKET_PRODUCT,
      };
    });

  return ok({ markets });
}