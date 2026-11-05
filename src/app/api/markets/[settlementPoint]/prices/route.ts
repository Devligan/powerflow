import { supabaseAdmin } from "@/lib/supabase/admin";
import { okPublic, fail, m, serverError } from "@/lib/api";
import { LIMITS, clientIp, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { parseDec } from "@/lib/money";
import { DEFAULT_MARKET_PRODUCT, getProduct } from "@/lib/ercot/types";

export const dynamic = "force-dynamic";

export const maxDuration = 10;

interface Params {
  params: Promise<{ settlementPoint: string }>;
}

export async function GET(req: Request, { params }: Params) {
  if (await overLimit(LIMITS.publicRead, clientIp(req))) return tooManyRequests(LIMITS.publicRead);

  const { settlementPoint } = await params;

  // A price series only means something for a given product, so the caller
  // must name one; the real-time hourly series is the default.
  const requested = new URL(req.url).searchParams.get("product");
  const product = requested ?? DEFAULT_MARKET_PRODUCT;
  if (!getProduct(product)) return fail("Unknown product", 422);

  const admin = supabaseAdmin();
  const marketRes = await admin
    .from("markets")
    .select("id, settlement_point, settlement_point_type, description")
    .eq("settlement_point", settlementPoint.toUpperCase())
    .maybeSingle();
  if (marketRes.error) return serverError("market lookup", marketRes.error.message);
  if (!marketRes.data) return fail("Market not found", 404);

  const horizonFrom = new Date();
  horizonFrom.setUTCHours(horizonFrom.getUTCHours() - 48);

  const pricesRes = await admin
    .from("market_prices")
    .select("delivery_timestamp, delivery_end, price, source, product")
    .eq("market_id", marketRes.data.id)
    .eq("product", product)
    .gte("delivery_timestamp", horizonFrom.toISOString())
    .lte("published_at", new Date().toISOString())
    // Newest first, so the cap drops the oldest intervals: ascending, a
    // 15-minute series hit it first and `latest` was most of a day old.
    .order("delivery_timestamp", { ascending: false })
    .order("published_at", { ascending: false })
    .limit(240);

  if (pricesRes.error) return serverError("market prices", pricesRes.error.message);

  // Revisions share an interval: the first seen is its latest publication.
  const seen = new Set<string>();
  const newest = (pricesRes.data ?? []).filter((r) => {
    if (seen.has(r.delivery_timestamp)) return false;
    seen.add(r.delivery_timestamp);
    return true;
  });

  const series = newest.slice(0, 120).reverse().map((r) => ({
    deliveryTimestamp: r.delivery_timestamp,
    deliveryEnd: r.delivery_end,
    price: m(parseDec(r.price)),
    source: r.source,
    product: r.product,
  }));

  const latest = series.length ? series[series.length - 1] : null;

  return okPublic({
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