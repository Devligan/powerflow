import { getHourlyHistory } from "@/lib/markets";
import { dartByHour, priceHeatmap } from "@/lib/market-stats";
import { centralHourEnding } from "@/lib/ercot/hour-ending";
import { DEFAULT_MARKET_PRODUCT, FORWARD_MARKET_PRODUCT } from "@/lib/ercot/types";
import { DartChart } from "@/components/dart-chart";
import { PriceHeatmap } from "@/components/price-heatmap";

const DAY_MS = 86_400_000;
const DART_DAYS = 30;
const HEATMAP_DAYS = 14;

/**
 * The desk's read on a settlement point: how day-ahead has cleared hour by
 * hour, and how real time has settled against it. Everything is as of the
 * account's clock, so a replay sees only what had been published by then.
 */
export async function MarketIntel({
  marketId,
  nowMs: now,
  asOf,
}: {
  marketId: string;
  /** The account's clock: wall time when live, replay time otherwise. */
  nowMs: number;
  /** Set only in replay, where reads are limited to what was published by then. */
  asOf: Date | null;
}) {
  const from = now - DART_DAYS * DAY_MS;
  let dayAhead, realTime;
  try {
    [dayAhead, realTime] = await Promise.all([
      // Day-ahead runs into tomorrow once it has cleared.
      getHourlyHistory(marketId, FORWARD_MARKET_PRODUCT, from, now + 2 * DAY_MS, asOf),
      getHourlyHistory(marketId, DEFAULT_MARKET_PRODUCT, from, now, asOf),
    ]);
  } catch {
    // Analysis is optional; it must never take the ticket down with it.
    return <p className="note note-warn">Price history is unavailable right now; trading is unaffected.</p>;
  }

  const dart = dartByHour(dayAhead, realTime);
  const settledDays = new Set(realTime.map((p) => centralHourEnding(p.t).day)).size;
  const heat = priceHeatmap(dayAhead).slice(0, HEATMAP_DAYS + 1);
  const today = centralHourEnding(now).day;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-2">
      <section className="card">
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <h2 className="card-title mb-0">DART by hour</h2>
          <span className="caption">real time − day-ahead</span>
        </div>
        <p className="caption mb-3">
          What a 1 MWh virtual earned on average in each hour. An INC (buy DA, sell RT) is paid the
          bar; a DEC is paid its negative.
        </p>
        <DartChart stats={dart} days={Math.min(DART_DAYS, settledDays)} />
      </section>
      <section className="card">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="card-title mb-0">Day-ahead by hour</h2>
          <span className="caption">$/MWh · last {HEATMAP_DAYS} days</span>
        </div>
        <PriceHeatmap rows={heat} todayDay={today} />
      </section>
    </div>
  );
}

export function MarketIntelSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-2">
      {["DART by hour", "Day-ahead by hour"].map((t) => (
        <section key={t} className="card opacity-60">
          <h2 className="card-title">{t}</h2>
          <p className="py-16 text-center text-[13px] t-mute">Loading history…</p>
        </section>
      ))}
    </div>
  );
}
