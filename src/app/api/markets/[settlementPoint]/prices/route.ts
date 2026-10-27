import { supabaseAdmin } from "@/lib/supabase/admin";
import { ok, fail, m } from "@/lib/api";
import { parseDec } from "@/lib/money";
import { DEFAULT_MARKET_PRODUCT, getProduct } from "@/lib/ercot/types";

export const dynamic = "force-dynamic";

export const maxDuration = 10;

interface Params {
  params: Promise<{ settlementPoint: string }>;
}

export async function GET(req: Request, { params }: Params) {
  const { settlementPoint } = await params;

  // A price series only means something for a given product, so the caller
  // must name one; the real-time hourly series is the default.
  const requested = new URL(req.url).searchParams.get("product");
  const product = requested ?? DEFAULT_MARKET_PRODUCT;
  if (!getProduct(product)) return fail(`Unknown product: ${product}`, 422);

  const admin = supabaseAdmin();
  const marketRes = await admin
    .from("markets")
    .select("id, settlement_point, settlement_point_type, description")
    .eq("settlement_point", settlementPoint.toUpperCase())
    .maybeSingle();
  if (marketRes.error) return fail(marketRes.error.message, 500);
  if (!marketRes.data) return fail("Market not found", 404);

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

  if (pricesRes.error) return fail(pricesRes.error.message, 500);

  const series = (pricesRes.data ?? []).map((r) => ({
    deliveryTimestamp: r.delivery_timestamp,
    deliveryEnd: r.delivery_end,
    price: m(parseDec(r.price)),
    source: r.source,
    product: r.product,
  }));

  const latest = series.length ? series[series.length - 1] : null;

  return ok({
    market: {
      id: marketRes.data.id,
      settlementPoint: marketRes.data.settlement_point,
      type: marketRes.data.settlement_point_type,
      description: marketRes.data.description,
      product,
    },
    latest,
    series,
  });
}