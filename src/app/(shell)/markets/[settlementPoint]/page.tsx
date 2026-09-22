import { notFound } from "next/navigation";
import Link from "next/link";
import { getMarketPrices, listMarketOptions } from "@/lib/markets";
import { TradePanel } from "@/components/trade-panel";
import { PriceChart } from "@/components/price-chart";
import { dateTime, sourceInfo } from "@/lib/format";
import { Lamp } from "@/components/ui/lamp";

export const dynamic = "force-dynamic";

export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ settlementPoint: string }>;
}) {
  const { settlementPoint } = await params;

  let data: Awaited<ReturnType<typeof getMarketPrices>>;
  let marketOptions: Awaited<ReturnType<typeof listMarketOptions>> = [];
  try {
    // The point list feeds the ticket's second leg, so a spread can be placed
    // without leaving the page.
    [data, marketOptions] = await Promise.all([
      getMarketPrices(settlementPoint),
      listMarketOptions(),
    ]);
  } catch {
    notFound();
  }

  const { market, latest, series } = data;
  const sr = sourceInfo(market.source);

  return (
    <div className="space-y-5">
      <header className="reveal flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
        <div className="min-w-0">
          <Link href="/markets" className="caption t-mute hover:underline">
            ← All settlement points
          </Link>
          <h1 className="mono mt-2 font-display text-[1.35rem] font-bold tracking-tight">
            {market.settlementPoint}
          </h1>
          <p className="mt-1 text-[13px] t-dim">
            {market.type} · {market.description}
          </p>
        </div>
        <span
          className={
            sr.tone === "live"
              ? "badge badge-green"
              : sr.tone === "sim"
                ? "badge badge-amber"
                : "badge badge-neutral"
          }
        >
          <Lamp pulse={sr.tone === "sim"} />
          {sr.label}
        </span>
      </header>

      {market.type === "LOAD_ZONE" && (
        <p className="note">
          Load-zone products trade at the zonal price with local congestion
          embedded. Hubs are the cleaner benchmark for a basis trade.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <section className="card">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="card-title mb-0">Forward curve</h2>
            {latest && (
              <span className="caption">
                through {dateTime(latest.deliveryTimestamp)}
              </span>
            )}
          </div>
          <PriceChart points={series} />
          {latest && (
            <p className="caption mt-3">
              Latest delivery {dateTime(latest.deliveryTimestamp)} ·{" "}
              {sourceInfo(latest.source).label}
            </p>
          )}
        </section>

        <TradePanel
          marketId={market.id}
          settlementPoint={market.settlementPoint}
          latestPrice={market.price}
          product={market.product}
          pricedThrough={latest?.deliveryTimestamp ?? null}
          markets={marketOptions}
          series={series}
        />
      </div>
    </div>
  );
}
