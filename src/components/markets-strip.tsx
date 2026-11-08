"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { parseDec } from "@/lib/money";
import { sourceInfo, usd, signedUsd } from "@/lib/format";
import { localTime } from "@/lib/time";
import { useTimeZone } from "@/components/time-zone";
import { Lamp } from "@/components/ui/lamp";
import { FlashValue } from "@/components/ui/flash-value";

interface MarketStripItem {
  id: string;
  settlementPoint: string;
  type: string;
  price: string | null;
  deliveryTimestamp: string | null;
  source: string | null;
  dayAheadPrice?: string | null;
}

/**
 * The settlement point strip.
 *
 * One tile per point, each a self-contained instrument readout: the point, its
 * price, how it moved on the last tick, and where the price came from. A moved
 * price flashes and carries a directional glyph, so the direction of a tick is
 * never signalled by colour alone.
 */
export function MarketsStrip({ offsetMs = 0 }: { offsetMs?: number } = {}) {
  const tz = useTimeZone();
  const [items, setItems] = useState<MarketStripItem[]>([]);
  const [ts, setTs] = useState<number | null>(null);
  const [error, setError] = useState<boolean>(false);
  const [prev, setPrev] = useState<Map<string, bigint>>(new Map());
  const replay = offsetMs !== 0;

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        // A replay desk reads the market as of its own clock: what ERCOT had
        // published by then, never the hours after it.
        const at = Date.now() + offsetMs;
        const url = offsetMs !== 0 ? `/api/markets?asOf=${new Date(at).toISOString()}` : "/api/markets";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error("failed");
        const data = await res.json();
        if (!alive) return;
        setItems(data.markets);
        setTs(at);
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
  }, [offsetMs]);

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

  // Feed staleness. An hourly real-time price exists only once its hour has
  // ENDED (ERCOT posts it ~2 minutes later, and the ingest runs every 15), so
  // the newest hour is normally the last completed one and its end is up to
  // ~75 minutes old. Past that, the desk is looking at a frozen feed — say so
  // instead of leaving live-looking numbers.
  const newestDeliveryMs = items.reduce((max, it) => {
    const t = it.deliveryTimestamp ? Date.parse(it.deliveryTimestamp) : NaN;
    return Number.isNaN(t) ? max : Math.max(max, t);
  }, Number.NEGATIVE_INFINITY);
  const feedAgeMs =
    Number.isFinite(newestDeliveryMs) && ts != null
      ? ts - (newestDeliveryMs + 3_600_000)
      : null;
  const feedStale = feedAgeMs != null && feedAgeMs > 80 * 60_000;
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
          <span className="caption t-mute">
            Real-time hour ended {feedAgeLabel}
            {replay ? " on the replay clock" : ""} · DA = day-ahead clearing for the same hour
          </span>
          {feedStale && !replay && <span className="badge badge-amber">feed lagging</span>}
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
                  value={price != null ? usd(price) : "—"}
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

              {it.dayAheadPrice != null && price != null && (() => {
                // Real time minus day-ahead for the same hour: what a DEC
                // earns per MWh (an INC earns its negative). Named by its sign
                // convention, since desks quote "DART" both ways round.
                const dart = price - parseDec(it.dayAheadPrice);
                return (
                  <div className="mt-1 mono text-[10.5px] t-mute">
                    DA {usd(it.dayAheadPrice)} · RT−DA{" "}
                    <span
                      className={`whitespace-nowrap ${dart > 0n ? "pos" : dart < 0n ? "neg" : ""}`}
                    >
                      {signedUsd(dart)}
                    </span>
                  </div>
                );
              })()}

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
            ? `${replay ? "Replay as of" : "Updated"} ${localTime(ts, tz, true)} · actual ERCOT settlement point prices`
            : ""}
      </p>
    </div>
  );
}
