"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { parseDec, format } from "@/lib/money";
import { sourceInfo } from "@/lib/format";
import { Lamp } from "@/components/ui/lamp";
import { FlashValue } from "@/components/ui/flash-value";

interface MarketStripItem {
  id: string;
  settlementPoint: string;
  type: string;
  price: string | null;
  deliveryTimestamp: string | null;
  source: string | null;
}

/**
 * The settlement point strip.
 *
 * One tile per point, each a self-contained instrument readout: the point, its
 * price, how it moved on the last tick, and where the price came from. A moved
 * price flashes and carries a directional glyph, so the direction of a tick is
 * never signalled by colour alone.
 */
export function MarketsStrip() {
  const [items, setItems] = useState<MarketStripItem[]>([]);
  const [ts, setTs] = useState<number | null>(null);
  const [error, setError] = useState<boolean>(false);
  const [prev, setPrev] = useState<Map<string, bigint>>(new Map());

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/markets", { cache: "no-store" });
        if (!res.ok) throw new Error("failed");
        const data = await res.json();
        if (!alive) return;
        setItems(data.markets);
        setTs(Date.now());
        setError(false);
        const next = new Map<string, bigint>();
        for (const it of data.markets) {
          if (it.price != null) next.set(it.settlementPoint, parseDec(it.price));
        }
        setPrev(next);
      } catch {
        if (alive) setError(true);
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (items.length === 0) {
    return (
      <div className="scroll-thin flex gap-3 overflow-x-auto pb-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="tile">
            <span className="skeleton block h-3 w-20" />
            <span className="skeleton mt-3 block h-4 w-14" />
            <span className="skeleton mt-3 block h-3 w-24" />
          </div>
        ))}
      </div>
    );
  }

  // Feed staleness: the newest hourly observation should be the current
  // (running) hour; with the 5-minute ingest cron it lands within minutes of
  // its ~HH:02 posting. Older than that means the desk is looking at a
  // frozen feed — say so instead of leaving live-looking numbers.
  const newestDeliveryMs = items.reduce((max, it) => {
    const t = it.deliveryTimestamp ? Date.parse(it.deliveryTimestamp) : NaN;
    return Number.isNaN(t) ? max : Math.max(max, t);
  }, Number.NEGATIVE_INFINITY);
  const feedAgeMs =
    Number.isFinite(newestDeliveryMs) && ts != null
      ? ts - (newestDeliveryMs + 3_600_000)
      : null;
  const feedStale = feedAgeMs != null && feedAgeMs > 10 * 60_000;
  const feedAgeLabel =
    feedAgeMs == null
      ? null
      : feedAgeMs < 60_000
        ? "just now"
        : feedAgeMs < 3_600_000
          ? `${Math.floor(feedAgeMs / 60_000)} min ago`
          : `${Math.floor(feedAgeMs / 3_600_000)} h ago`;

  return (
    <div className="space-y-2">
      {feedAgeLabel && (
        <div className="flex items-center gap-2">
          <span className="caption t-mute">ERCOT hourly feed · {feedAgeLabel}</span>
          {feedStale && <span className="badge badge-amber">feed lagging</span>}
        </div>
      )}
      <div className="scroll-thin flex gap-3 overflow-x-auto pb-1">
        {items.map((it) => {
          const sr = sourceInfo(it.source);
          const last = prev.get(it.settlementPoint);
          const price = it.price != null ? parseDec(it.price) : null;
          const up = price != null && last != null && price > last;
          const down = price != null && last != null && price < last;
          const typeLabel =
            it.type === "HUB"
              ? "Hub"
              : it.type === "LOAD_ZONE"
                ? "Load zone"
                : it.type === "HUB_AVERAGE"
                  ? "Hub average"
                  : "Node";

          return (
            <Link key={it.id} href={`/markets/${it.settlementPoint}`} className="tile">
              <div className="flex items-center justify-between gap-2">
                <span className="mono truncate text-[11px] t-dim">
                  {it.settlementPoint}
                </span>
                <Lamp
                  pulse={sr.tone === "sim"}
                  className={
                    sr.tone === "live"
                      ? "t-long"
                      : sr.tone === "sim"
                        ? "t-accent"
                        : "t-mute"
                  }
                />
              </div>

              <div className="mt-2 flex items-baseline gap-1">
                <FlashValue
                  value={price != null ? `$${format(price, 2)}` : "—"}
                  className={`mono text-[15px] font-medium ${up ? "pos" : down ? "neg" : "t-fg"}`}
                />
                {up && (
                  <span className="mono text-[10px] pos" aria-label="up">
                    ▲
                  </span>
                )}
                {down && (
                  <span className="mono text-[10px] neg" aria-label="down">
                    ▼
                  </span>
                )}
              </div>

              <div className="mt-2.5 flex items-center gap-1">
                <span className="badge badge-neutral">{typeLabel}</span>
                <span
                  className={
                    sr.tone === "live"
                      ? "badge badge-green"
                      : sr.tone === "sim"
                        ? "badge badge-amber"
                        : "badge badge-neutral"
                  }
                >
                  {sr.label}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
      <p className="caption">
        {error
          ? "Market data unavailable right now."
          : ts
            ? `Updated ${new Date(ts).toISOString().slice(11, 19)}Z · simulated forward curve`
            : ""}
      </p>
    </div>
  );
}
