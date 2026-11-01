import { Suspense } from "react";
import { notFound } from "next/navigation";
import { MarketIntel, MarketIntelSkeleton } from "@/components/market-intel";
import Link from "next/link";
import { getMarketPrices, listMarketOptions } from "@/lib/markets";
import { TradePanel } from "@/components/trade-panel";
import { PriceChart } from "@/components/price-chart";
import { dateTime, sourceInfo } from "@/lib/format";
import { Lamp } from "@/components/ui/lamp";
import { requireUser } from "@/lib/auth";
import { getSimClock } from "@/lib/sim-clock";
import { DEFAULT_MARKET_PRODUCT, FORWARD_MARKET_PRODUCT } from "@/lib/ercot/types";

export const dynamic = "force-dynamic";

export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ settlementPoint: string }>;
}) {
  const user = await requireUser();
  const { settlementPoint } = await params;
  const clock = await getSimClock(user.id).catch(() => null);
  const asOf = clock && clock.mode === "REPLAY" ? new Date(clock.now) : null;

  let data: Awaited<ReturnType<typeof getMarketPrices>>;
  let forward: Awaited<ReturnType<typeof getMarketPrices>>;
  let marketOptions: Awaited<ReturnType<typeof listMarketOptions>> = [];
  try {
    // Real time is the settled reference; day-ahead is the curve a desk
    // trades forward, and the only orderable energy series. The point list
    // feeds the ticket's second leg, so a spread can be placed in place.
    [data, forward, marketOptions] = await Promise.all([
      getMarketPrices(settlementPoint, DEFAULT_MARKET_PRODUCT, asOf),
      getMarketPrices(settlementPoint, FORWARD_MARKET_PRODUCT, asOf),
      listMarketOptions(),
    ]);
  } catch {
    notFound();
  }

  const { market, latest, series } = data;
  const sr = sourceInfo(market.source);
  // The desk's own clock (wall time when live, replay time otherwise).
  const nowMs = clock
    ? Date.parse(clock.now)
    : latest
      ? Date.parse(latest.deliveryTimestamp) + 3600_000
      : undefined;
  const forwardLast = forward.latest;
  // The ticket checks delivery END against this, so it is the end of the last
  // published hour, not its start.
  const forwardPricedThrough = forwardLast
    ? forwardLast.deliveryEnd ??
      new Date(Date.parse(forwardLast.deliveryTimestamp) + 3600_000).toISOString()
    : null;
  // The headline on the ticket: day-ahead for the next hour that can trade.
  const nextForward =
    (nowMs != null
      ? forward.series.find((p) => Date.parse(p.deliveryTimestamp) >= nowMs)
      : undefined) ?? forwardLast;

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

      {asOf && (
        <p className="note">
          Replay · showing only observations ERCOT had published by
          <span className="moni">
            {clock!.now.slice(0, 19).replace("T", " ")}Z</span
          >
          .
        </p>
      )}

      {market.type === "LOAD_ZONE" && (
        <p className="note">
          Load-zone products trade at the zonal price with local congestion
            embedded. Hubs are the cleaner benchmark for a basis trade.
        </p>
      )}

      {/* Chart and analysis stack on the left with the ticket spanning both on
          the right; on a phone the ticket comes straight after the chart. */}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="card lg:col-start-1 lg:row-start-1">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="card-title mb-0">Day-ahead curve vs real time</h2>
            {forwardLast && (
              <span className="caption">
                day-ahead through {dateTime(forwardPricedThrough!)}
              </span>
            )}
          </div>
          <PriceChart
            points={forward.series.length ? forward.series : series}
            reference={forward.series.length ? series : undefined}
            label={forward.series.length ? "Day-ahead" : "Real time"}
            referenceLabel="Real time"
            nowMs={nowMs}
          />
          <p className="caption mt-3">
            Day-ahead clears the afternoon before delivery; real time settles
            each hour after it ends. Their gap is DART — what a virtual or DART
            spread on this point is paid.
            {latest && (
              <>
                {" "}Latest real-time hour {dateTime(latest.deliveryTimestamp)} ·{" "}
                {sourceInfo(latest.source).label}.
              </>
            )}
          </p>
        </section>

        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <TradePanel
            marketId={market.id}
            settlementPoint={market.settlementPoint}
            latestPrice={nextForward?.price ?? market.price}
            product={forwardLast ? FORWARD_MARKET_PRODUCT : market.product}
            pricedThrough={forwardPricedThrough ?? latest?.deliveryTimestamp ?? null}
            markets={marketOptions}
            series={forwardLast ? forward.series : series}
            simNowMs={asOf ? asOf.getTime() : undefined}
          />
        </div>

        {/* Streams in after the ticket: weeks of history, not on the trade path. */}
        {clock && (
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <Suspense fallback={<MarketIntelSkeleton />}>
              <MarketIntel marketId={market.id} nowMs={Date.parse(clock.now)} asOf={asOf} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}