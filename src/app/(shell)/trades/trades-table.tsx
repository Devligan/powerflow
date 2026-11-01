"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { parseDec } from "@/lib/money";
import {
  sign,
  usd,
  instrumentInfo,
  legsLabel,
  positionUnit,
  volumeUnitLabel,
} from "@/lib/format";
import { dayStartUtc, shortDate } from "@/lib/time";
import { useTimeZone } from "@/components/time-zone";

/** The filter dates are calendar days in the viewer's zone: the first or last instant of one. */
function dayBound(day: string, edge: "start" | "end", tz: string): string {
  if (edge === "start") {
    const start = dayStartUtc(day, tz);
    return new Date(start ?? Date.parse(`${day}T00:00:00Z`)).toISOString();
  }
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const end = dayStartUtc(next, tz);
  return new Date((end ?? Date.parse(`${next}T00:00:00Z`)) - 1).toISOString();
}

interface TradeItem {
  id: string;
  instrument: string;
  counterMarketId: string | null;
  counterSettlementPoint: string | null;
  marketId: string;
  settlementPoint: string;
  product: string;
  side: "BUY" | "SELL";
  quantityMwh: string;
  executionPrice: string;
  deliveryStart: string;
  createdAt: string;
  realizedPnl: string;
  status: string;
}

interface MarketItem {
  id: string;
  settlementPoint: string;
}

const PAGE = 50;

export function TradesTable() {
  const tz = useTimeZone();
  const [trades, setTrades] = useState<TradeItem[]>([]);
  const [markets, setMarkets] = useState<MarketItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [side, setSide] = useState("");
  const [marketId, setMarketId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const filterParams = new URLSearchParams();
  if (side) filterParams.set("side", side);
  if (marketId) filterParams.set("marketId", marketId);
  if (dateFrom) filterParams.set("dateFrom", dayBound(dateFrom, "start", tz));
  if (dateTo) filterParams.set("dateTo", dayBound(dateTo, "end", tz));

  useEffect(() => {
    let alive = true;
    async function load() {
      setError(null);
      setLoading(true);
      const params = new URLSearchParams({
        limit: String(PAGE),
        offset: String(offset),
      });
      if (side) params.set("side", side);
      if (marketId) params.set("marketId", marketId);
      if (dateFrom) params.set("dateFrom", dayBound(dateFrom, "start", tz));
      if (dateTo) params.set("dateTo", dayBound(dateTo, "end", tz));

      const [tradesRes, marketsRes] = await Promise.all([
        fetch(`/api/trades?${params}`, { cache: "no-store" }),
        fetch("/api/markets", { cache: "no-store" }),
      ]);

      if (!alive) return;
      const body = await tradesRes.json();
      if (!tradesRes.ok) {
        setError(body?.error ?? "Failed to load trades");
      } else {
        setTrades(body.trades ?? []);
        setTotal(body.total ?? 0);
      }
      setMarkets(((await marketsRes.json()).markets ?? []) satisfies MarketItem[]);
      setLoading(false);
    }
    void load();
    return () => {
      alive = false;
    };
  }, [offset, side, marketId, dateFrom, dateTo, refreshKey, tz]);

  return (
    <div className="space-y-4">
      {/* Query strip. The controls refetch on change, so the button refreshes
          rather than applies. */}
      <section className="card">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="card-title mb-0">Query</h2>
          <div className="flex items-center gap-2">
            {/* Same filters as the table, every page, exact decimals. */}
            <a className="btn btn-sm" href={`/api/trades/export?${filterParams}`} download>
              Export CSV
            </a>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              Refresh
            </button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="f-market">
              Settlement point
            </label>
            <select
              id="f-market"
              className="input"
              value={marketId}
              onChange={(e) => {
                setMarketId(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">All points</option>
              {markets.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.settlementPoint}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-side">
              Side
            </label>
            <select
              id="f-side"
              className="input"
              value={side}
              onChange={(e) => {
                setSide(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">Both</option>
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-from">
              From
            </label>
            <input
              id="f-from"
              type="date"
              className="input"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setOffset(0);
              }}
            />
          </div>
          <div>
            <label className="label" htmlFor="f-to">
              To
            </label>
            <input
              id="f-to"
              type="date"
              className="input"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setOffset(0);
              }}
            />
          </div>
        </div>
      </section>

      {error && <div className="note note-error">{error}</div>}

      <section className="card p-0">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Market / legs</th>
                <th>Instrument</th>
                <th>Side</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Price</th>
                <th className="text-right">P&amp;L</th>
                <th>Delivery</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <td key={j}>
                        <span className="skeleton block h-3 w-16" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : trades.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-[13px] t-mute">
                    No trades match that query.{" "}
                    <Link href="/markets" className="t-accent hover:underline">
                      Place your first day-ahead bid
                    </Link>
                  </td>
                </tr>
              ) : (
                trades.map((t) => {
                  const r = parseDec(t.realizedPnl);
                  const inst = instrumentInfo(t.instrument);
                  // Only a path instrument has a second leg to show.
                  const legB = inst?.legs === 2 ? t.counterSettlementPoint : null;
                  return (
                    <tr key={t.id}>
                      <td className="mono t-mute">{shortDate(t.createdAt, tz)}</td>
                      <td className="mono">
                        <Link
                          href={`/markets/${t.settlementPoint}`}
                          className="font-medium hover:underline"
                        >
                          {legsLabel(t.settlementPoint, legB)}
                        </Link>
                      </td>
                      <td>
                        {inst ? (
                          <div className="flex flex-col gap-1">
                            <span className="whitespace-nowrap">
                              {inst.shortLabel}
                            </span>
                            <span className="flex items-center gap-1">
                              <span className={`badge ${inst.tone}`}>
                                {inst.ruleLabel}
                              </span>
                              <span className="mono text-[10px] t-mute">
                                {t.product}
                              </span>
                            </span>
                          </div>
                        ) : (
                          <span className="t-mute">{t.instrument}</span>
                        )}
                      </td>
                      <td>
                        <span
                          className={`badge ${t.side === "BUY" ? "badge-green" : "badge-red"}`}
                        >
                          {t.side}
                        </span>
                      </td>
                      <td className="mono whitespace-nowrap text-right">
                        {t.quantityMwh}{" "}
                        <span className="t-mute">
                          {volumeUnitLabel(positionUnit(t.product))}
                        </span>
                      </td>
                      <td className="mono text-right">{usd(t.executionPrice)}</td>
                      <td
                        className={`mono text-right ${r > 0n ? "pos" : r < 0n ? "neg" : ""}`}
                      >
                        {r === 0n ? "—" : sign(r)}
                      </td>
                      <td className="mono t-mute">
                        {shortDate(t.deliveryStart, tz)}
                      </td>
                      <td>
                        <span className="badge badge-neutral">{t.status}</span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3">
          <span className="caption">
            {total} trade{total === 1 ? "" : "s"} · showing{" "}
            {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)}
          </span>
          <div className="flex gap-2">
            <button
              className="btn btn-sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              ← Newer
            </button>
            <button
              className="btn btn-sm"
              disabled={offset + PAGE >= total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Older →
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
