"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseDec } from "@/lib/money";
import { instrumentInfo, usd } from "@/lib/format";
import { dateTime, localTime } from "@/lib/time";
import { useTimeZone } from "@/components/time-zone";
import {
  damDeadlineUtc,
  firstOpenOperatingDay,
  isPeakWeekday,
  operatingDayHours,
  type OperatingHour,
} from "@/lib/ercot/hour-ending";
import {
  BID_PRICE_CAP,
  BID_PRICE_FLOOR,
  deskInstruments,
  requireInstrument,
} from "@/lib/ercot/types";
import { needsCounterPoint } from "@/lib/trading/instruments";
import {
  MAX_QUANTITY,
  checkOrderForm,
  type DeliveryWindow,
} from "@/lib/trading/order-form";

/**
 * The order ticket: an hourly day-ahead bid sheet.
 *
 * It offers what a QSE with no assets actually bids into ERCOT's day-ahead
 * market — virtual INC/DEC bids at one settlement point, and DA PTP
 * obligations on a source→sink path — and works the way that market does
 * (0038):
 *
 * - bids for an operating day close at 10:00 Central the day before, and
 *   nobody knows the clearing price when they do;
 * - a bid is for a quantity of MW in each chosen hour ending, at the clearing
 *   price or with a limit anywhere in ERCOT's -$250 to $5,000/MWh range
 *   (negative prices are ordinary in the west);
 * - the standard shapes — 5x16 peak (2x16 on weekends and NERC holidays),
 *   7x8 off-peak, 7x24 — are presets over the hours of the chosen day;
 * - each hour fills at its clearing price when ERCOT publishes the day-ahead
 *   results, and settles against that hour's real-time price.
 */

/** Every desk instrument clears in the day-ahead market. */
const DAM_PRODUCT = "DAM_HOURLY";

type HourKey = string;
const keyOf = (h: OperatingHour): HourKey => `${h.he}${h.repeated ? "r" : ""}`;

const LIMIT_RE = /^-?\d+(\.\d{1,6})?$/;

function hourWindow(startMs: number): DeliveryWindow {
  const endMs = startMs + 3_600_000;
  return {
    startMs,
    endMs,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    minutes: 60,
  };
}

const SIDE_LABEL: Record<string, { BUY: [string, string]; SELL: [string, string] }> = {
  VIRTUAL: {
    BUY: ["DEC", "buy DA · sell back RT"],
    SELL: ["INC", "sell DA · buy back RT"],
  },
  PTP_OBLIGATION: {
    BUY: ["Buy path", "pay DA congestion · earn RT"],
    SELL: ["Sell path", "earn DA congestion · pay RT"],
  },
};

const HOW_IT_PAYS: Record<string, string> = {
  VIRTUAL:
    "A DEC buys the hour in the day-ahead market and sells it back at the real-time price: it earns (RT − DA) × MW. An INC is the reverse and earns (DA − RT) × MW.",
  PTP_OBLIGATION:
    "Buying the path costs the day-ahead congestion from source to sink and earns the real-time congestion on it: it profits when real-time congestion on the path exceeds day-ahead.",
};

export function TradePanel({
  marketId,
  settlementPoint,
  latestPrice,
  pricedThrough,
  markets,
  simNowMs,
}: {
  marketId: string;
  settlementPoint: string;
  latestPrice: string | null;
  /** The series the page shows (the ticket always bids day-ahead). */
  product?: string;
  /** Latest day-ahead interval ERCOT has published. */
  pricedThrough: string | null;
  /** Active settlement points, for a path's sink. */
  markets: Array<{ id: string; settlementPoint: string }>;
  series?: unknown;
  /** The account's clock (ms): deadlines and checks run against it. */
  simNowMs?: number;
}) {
  const router = useRouter();
  const tz = useTimeZone();
  const desk = deskInstruments();

  const [instrumentCode, setInstrumentCode] = useState(desk[0].code);
  const [counterMarketId, setCounterMarketId] = useState<string | null>(null);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState("10");
  const [opDay, setOpDay] = useState(() => firstOpenOperatingDay(simNowMs ?? Date.now()));
  const [hours, setHours] = useState<HourKey[]>(["18"]);
  const [bidType, setBidType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [limitPrice, setLimitPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ label: string; ok: boolean; detail: string }> | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);

  const instrument = requireInstrument(instrumentCode);
  const info = instrumentInfo(instrument.code);
  const isPath = needsCounterPoint(instrument.settlementRule);
  const sideLabels = SIDE_LABEL[instrument.code] ?? SIDE_LABEL.VIRTUAL;

  // The chosen hours of the operating day, in delivery order.
  const dayHours = operatingDayHours(opDay);
  const chosen = dayHours.filter((h) => hours.includes(keyOf(h)));
  const legs = chosen.map((h) => hourWindow(h.startMs));
  const peakDay = isPeakWeekday(opDay);

  const deadlineMs = dayHours[0] ? damDeadlineUtc(dayHours[0].startMs) : null;
  const clearingMs = deadlineMs != null ? deadlineMs + 3.5 * 3_600_000 : null;
  const minutesLeft =
    deadlineMs != null && simNowMs != null ? Math.floor((deadlineMs - simNowMs) / 60_000) : null;

  // Limit: ERCOT's bounds, below zero included.
  const limitProblem = (() => {
    if (bidType !== "LIMIT") return null;
    if (!LIMIT_RE.test(limitPrice.trim())) return "Enter a limit price in $/MWh (it may be negative).";
    const v = parseDec(limitPrice.trim());
    if (v < parseDec(String(BID_PRICE_FLOOR)) || v > parseDec(String(BID_PRICE_CAP))) {
      return `ERCOT accepts bid prices from −$${-BID_PRICE_FLOOR} to $${BID_PRICE_CAP.toLocaleString("en-US")}/MWh.`;
    }
    return null;
  })();

  const check = (() => {
    if (legs.length === 0) return { ok: false as const, message: "Choose at least one hour." };
    for (const w of legs) {
      const c = checkOrderForm({
        instrument,
        product: DAM_PRODUCT,
        counterMarketId: isPath ? counterMarketId : null,
        marketId,
        quantity,
        delivery: w,
        intervalMinutes: 60,
        priceProbe: "unknown",
        now: simNowMs,
      });
      if (!c.ok) return c;
    }
    if (limitProblem) return { ok: false as const, message: limitProblem };
    return { ok: true as const };
  })();

  const formKey = [instrumentCode, counterMarketId, side, quantity, opDay, hours.join(","), bidType, limitPrice].join("|");
  const showResult = resultKey === formKey;

  function setPreset(which: "PEAK" | "OFFPEAK" | "ATC" | "NONE") {
    const pick = (h: OperatingHour) =>
      which === "ATC" ||
      (which === "PEAK" && h.he >= 7 && h.he <= 22) ||
      (which === "OFFPEAK" && (h.he <= 6 || h.he >= 23));
    setHours(which === "NONE" ? [] : dayHours.filter(pick).map(keyOf));
  }

  function toggleHour(h: OperatingHour) {
    const k = keyOf(h);
    setHours((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  }

  function pickInstrument(code: string) {
    setInstrumentCode(code);
    setError(null);
    if (!needsCounterPoint(requireInstrument(code).settlementRule)) setCounterMarketId(null);
  }

  async function placeOne(w: DeliveryWindow) {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        marketId,
        instrument: instrument.code,
        product: DAM_PRODUCT,
        counterMarketId: isPath ? counterMarketId : null,
        side,
        quantityMwh: quantity,
        limitPrice: bidType === "LIMIT" ? limitPrice.trim() : null,
        deliveryStart: w.start,
        deliveryEnd: w.end,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? "Order failed");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setResultKey(formKey);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setBusy(true);
    setError(null);
    setResults(null);
    // Sequential: a refused hour is reported and the rest carry on.
    const out: Array<{ label: string; ok: boolean; detail: string }> = [];
    for (const h of chosen) {
      const label = `HE${String(h.he).padStart(2, "0")}${h.repeated ? "*" : ""}`;
      try {
        await placeOne(hourWindow(h.startMs));
        out.push({ label, ok: true, detail: bidType === "LIMIT" ? `limit ${limitPrice.trim()}` : "at clearing" });
      } catch (err) {
        out.push({ label, ok: false, detail: err instanceof Error ? err.message : "Refused" });
      }
      setResults([...out]);
    }
    setBusy(false);
    router.refresh();
  }

  const counterOptions = markets.filter((m) => m.id !== marketId);
  const counterPoint = counterOptions.find((m) => m.id === counterMarketId)?.settlementPoint ?? null;
  const isBuy = side === "BUY";
  const qtyNum = Number(quantity);
  const placedCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <form onSubmit={onSubmit} className="card p-0">
      {/* Faceplate */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <h2 className="card-title mb-0">Day-ahead bid</h2>
          <p className="mono mt-1 truncate text-[11px] t-mute">{settlementPoint}</p>
        </div>
        {latestPrice != null && (
          <span className="badge badge-amber" title="Latest published day-ahead price at this point">
            {usd(latestPrice)}
          </span>
        )}
      </div>

      <div className="space-y-4 p-4">
        {/* Instrument */}
        <div>
          <label className="label" htmlFor="instrument">
            Instrument
          </label>
          <select id="instrument" className="input" value={instrumentCode} onChange={(e) => pickInstrument(e.target.value)}>
            {desk.map((i) => (
              <option key={i.code} value={i.code}>
                {i.label}
              </option>
            ))}
          </select>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            {info && <span className={`badge ${info.tone}`}>{info.ruleLabel}</span>}
            <span className="text-[11px] leading-relaxed t-mute">{HOW_IT_PAYS[instrument.code]}</span>
          </p>
        </div>

        {/* Path sink */}
        {isPath && (
          <div className="border-t border-white/10 pt-4">
            <label className="label" htmlFor="counter-point">
              Sink
            </label>
            <select
              id="counter-point"
              className="input"
              value={counterMarketId ?? ""}
              onChange={(e) => setCounterMarketId(e.target.value || null)}
            >
              <option value="">Select a settlement point…</option>
              {counterOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.settlementPoint}
                </option>
              ))}
            </select>
            <p className="mt-2 text-[11px] t-mute">
              <span className="mono t-dim">{settlementPoint}</span> (source) →{" "}
              <span className="mono t-dim">{counterPoint ?? "—"}</span> (sink)
            </p>
          </div>
        )}

        {/* Side */}
        <div className="border-t border-white/10 pt-4">
          <span className="label">Side</span>
          <div className="grid grid-cols-2 border border-white/15">
            {(["BUY", "SELL"] as const).map((s) => {
              const on = side === s;
              const [title, sub] = sideLabels[s];
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSide(s)}
                  className={`px-2 py-2 text-left transition-colors ${
                    on ? (s === "BUY" ? "bg-[var(--long-bg)] t-long" : "bg-[var(--short-bg)] t-short") : "t-mute hover:text-white/80"
                  }`}
                >
                  <span className="block text-[11px] font-semibold uppercase tracking-[0.08em]">{title}</span>
                  <span className="block text-[10.5px] opacity-80">{sub}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Quantity */}
        <div className="border-t border-white/10 pt-4">
          <label className="label" htmlFor="qty">
            Quantity · MW in each hour
          </label>
          <input
            id="qty"
            type="text"
            inputMode="decimal"
            required
            className="input mono"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="10"
          />
        </div>

        {/* Operating day and hours */}
        <div className="border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <label className="label" htmlFor="op-day">
                ERCOT operating day
              </label>
              <input
                id="op-day"
                type="date"
                required
                className="input"
                value={opDay}
                onChange={(e) => e.target.value && setOpDay(e.target.value)}
              />
            </div>
            <span className={`badge ${peakDay ? "badge-blue" : "badge-neutral"}`}>
              {peakDay ? "5x16 weekday" : "2x16 weekend / NERC holiday"}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <button type="button" className="btn btn-sm" onClick={() => setPreset("PEAK")}>
              {peakDay ? "5x16 peak" : "2x16 peak"} · HE7–22
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setPreset("OFFPEAK")}>
              7x8 off-peak
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setPreset("ATC")}>
              7x24
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setPreset("NONE")}>
              Clear
            </button>
          </div>

          <div className="mt-3 grid grid-cols-6 gap-1" role="group" aria-label="Hours ending">
            {dayHours.map((h) => {
              const on = hours.includes(keyOf(h));
              return (
                <button
                  key={keyOf(h)}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleHour(h)}
                  title={`HE${h.he}${h.repeated ? " (repeated)" : ""} · starts ${localTime(h.startMs, tz)}`}
                  className={`mono border py-1 text-[11px] transition-colors ${
                    on ? "border-[var(--accent-line)] bg-[var(--accent-bg)] t-accent" : "border-white/10 t-mute hover:text-white/80"
                  }`}
                >
                  {h.he}
                  {h.repeated ? "*" : ""}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] t-mute">
            {chosen.length === 0
              ? "No hours chosen."
              : `${chosen.length} hour${chosen.length === 1 ? "" : "s"} · ${
                  Number.isFinite(qtyNum) ? `${(qtyNum * chosen.length).toLocaleString("en-US")} MWh total` : "—"
                } · first ${localTime(chosen[0].startMs, tz)}`}
          </p>
        </div>

        {/* Bid price */}
        <div className="border-t border-white/10 pt-4">
          <span className="label">Bid price</span>
          <div className="grid grid-cols-2 gap-2">
            {(["MARKET", "LIMIT"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={bidType === t}
                onClick={() => setBidType(t)}
                className={`border px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors ${
                  bidType === t ? "border-white/40 bg-white/10 text-white" : "border-white/15 t-mute hover:text-white/80"
                }`}
              >
                {t === "MARKET" ? "At clearing price" : "Limit"}
              </button>
            ))}
          </div>
          {bidType === "LIMIT" && (
            <div className="mt-3">
              <label className="label" htmlFor="limit-price">
                Limit · $/MWh (−{BID_PRICE_FLOOR * -1} to {BID_PRICE_CAP.toLocaleString("en-US")})
              </label>
              <input
                id="limit-price"
                type="text"
                inputMode="decimal"
                required
                className="input mono"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                placeholder={isBuy ? "35.00" : "-5.00"}
              />
              <p className="mt-2 text-[11px] leading-relaxed t-mute">
                {isBuy
                  ? "The most you will pay day-ahead: the bid clears in hours that price at or below it."
                  : "The least you will sell for day-ahead: the offer clears in hours that price at or above it."}{" "}
                It can be below zero. The fill is the clearing price itself, never your limit.
              </p>
            </div>
          )}
        </div>

        {/* The day-ahead calendar for this operating day */}
        <div className="border-t border-white/10 pt-4 text-[11px] leading-relaxed t-mute">
          {deadlineMs != null ? (
            <p>
              Bids for <span className="mono t-dim">{opDay}</span> close{" "}
              <span className="t-dim">{dateTime(deadlineMs, tz)}</span>
              {minutesLeft != null && minutesLeft > 0 && (
                <span className="t-dim">
                  {" "}
                  (in {minutesLeft >= 60 ? `${Math.floor(minutesLeft / 60)}h ` : ""}
                  {minutesLeft % 60}m)
                </span>
              )}
              . ERCOT publishes the clearing prices around{" "}
              <span className="t-dim">{clearingMs != null ? localTime(clearingMs, tz) : "—"}</span> that day; each hour
              then fills at its own clearing price and settles against that hour&apos;s real-time price.
            </p>
          ) : (
            <p>Pick an operating day.</p>
          )}
          {pricedThrough != null && (
            <p className="mt-1">
              Day-ahead prices published through <span className="mono t-dim">{dateTime(pricedThrough, tz)}</span>.
            </p>
          )}
        </div>

        {!check.ok && <div className="note note-warn">{check.message}</div>}
        {showResult && error && <div className="note note-error">{error}</div>}

        {showResult && results && (
          <div className={`note ${results.every((r) => r.ok) ? "note-ok" : "note-warn"}`}>
            <p className="mb-1">
              {placedCount} of {chosen.length} hourly bids placed{busy ? "…" : "."}{" "}
              {placedCount > 0 && (
                <>
                  They fill when ERCOT publishes the day-ahead prices.{" "}
                  <Link href="/orders" className="underline">
                    Orders
                  </Link>
                </>
              )}
            </p>
            {results.some((r) => !r.ok) && (
              <ul className="mono space-y-0.5 text-[11px]">
                {results
                  .filter((r) => !r.ok)
                  .map((r) => (
                    <li key={r.label} className="t-short">
                      {r.label} · {r.detail}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}

        <button type="submit" disabled={busy || !check.ok} className="btn btn-primary w-full">
          {busy
            ? "Placing"
            : `${sideLabels[side][0]} ${quantity || "0"} MW × ${chosen.length} h ${
                bidType === "LIMIT" ? `@ ${limitPrice || "—"}` : "at clearing"
              }`}
        </button>

        {qtyNum > MAX_QUANTITY && (
          <p className="text-[11px] t-short">The desk accepts at most {MAX_QUANTITY} MW per hour.</p>
        )}
        <p className="text-[10.5px] leading-relaxed t-mute">
          Forwards, swaps and CRRs are not offered: they would enter and settle on the same published day-ahead price.
          Real term trading needs a forward curve (ICE/OTC) and ERCOT&apos;s CRR auctions.
        </p>
      </div>
    </form>
  );
}
