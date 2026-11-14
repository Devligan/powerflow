"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseDec } from "@/lib/money";
import { usd } from "@/lib/format";
import { dateTime, localTime, operatingDayLabel } from "@/lib/time";
import { useTimeZone } from "@/components/time-zone";
import {
  damDeadlineUtc,
  firstOpenOperatingDay,
  isPeakWeekday,
  lastOpenOperatingDay,
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
  MIN_BID_MW,
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
 * - bids for an operating day open fourteen days before it and close at
 *   10:00 Central the day before, and nobody knows the clearing price when
 *   they do (0045);
 * - quantities are in ERCOT's 0.1 MW steps, at least 1 MW an hour;
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
/** ERCOT takes bid quantities in steps of 0.1 MW (0045). */
const MW_RE = /^\d+(\.\d)?$/;

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
  const [mountedAt] = useState(() => Date.now());
  const nowMs = simNowMs ?? mountedAt;
  const [opDay, setOpDay] = useState(() => firstOpenOperatingDay(nowMs));
  const [hours, setHours] = useState<HourKey[]>(["18"]);
  const [bidType, setBidType] = useState<"MARKET" | "LIMIT">("MARKET");
  // A limit bid is a curve: up to four MW-at-price steps per hour, as ERCOT
  // takes them. Each step is its own order, so the fill at any clearing price
  // is exactly the curve's: a bid step clears at or below its price, an offer
  // step at or above.
  const [steps, setSteps] = useState<Array<{ mw: string; price: string }>>([{ mw: "10", price: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ label: string; ok: boolean; detail: string }> | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);

  const instrument = requireInstrument(instrumentCode);
  const isPath = needsCounterPoint(instrument.settlementRule);
  const sideLabels = SIDE_LABEL[instrument.code] ?? SIDE_LABEL.VIRTUAL;

  // The chosen hours of the operating day, in delivery order.
  const dayHours = operatingDayHours(opDay);
  const chosen = dayHours.filter((h) => hours.includes(keyOf(h)));
  const legs = chosen.map((h) => hourWindow(h.startMs));
  const peakDay = isPeakWeekday(opDay);

  const deadlineMs = dayHours[0] ? damDeadlineUtc(dayHours[0].startMs) : null;
  // ERCOT's DAM postings (NP4-190) land at about 12:32 Central on a normal
  // day, later when the run is delayed: 2.5 hours after the 10:00 deadline.
  const clearingMs = deadlineMs != null ? deadlineMs + 2.5 * 3_600_000 : null;
  const minutesLeft =
    deadlineMs != null && simNowMs != null ? Math.floor((deadlineMs - simNowMs) / 60_000) : null;

  // Limit: ERCOT's bounds, below zero included.
  const limitProblem = (() => {
    if (bidType !== "LIMIT") return null;
    for (const s of steps) {
      if (!LIMIT_RE.test(s.price.trim())) return "Enter each step's price in $/MWh (it may be negative).";
      const v = parseDec(s.price.trim());
      if (v < parseDec(String(BID_PRICE_FLOOR)) || v > parseDec(String(BID_PRICE_CAP))) {
        return `ERCOT accepts bid prices from −$${-BID_PRICE_FLOOR} to $${BID_PRICE_CAP.toLocaleString("en-US")}/MWh.`;
      }
      if (!(Number(s.mw) > 0) || Number(s.mw) > MAX_QUANTITY) return `Each step needs 0–${MAX_QUANTITY} MW.`;
      if (!MW_RE.test(s.mw.trim())) return "ERCOT takes bid quantities in steps of 0.1 MW.";
    }
    return null;
  })();
  const totalMw = bidType === "LIMIT" ? steps.reduce((a, s) => a + (Number(s.mw) || 0), 0) : Number(quantity);
  // ERCOT's minimum is per bid, and a curve's steps make one bid per hour.
  const minimumProblem =
    totalMw > 0 && totalMw < MIN_BID_MW ? `ERCOT's minimum bid is ${MIN_BID_MW} MW an hour.` : null;

  const check = (() => {
    if (legs.length === 0) return { ok: false as const, message: "Choose at least one hour." };
    for (const w of legs) {
      const c = checkOrderForm({
        instrument,
        product: DAM_PRODUCT,
        counterMarketId: isPath ? counterMarketId : null,
        marketId,
        quantity: bidType === "LIMIT" ? steps[0].mw : quantity,
        delivery: w,
        intervalMinutes: 60,
        priceProbe: "unknown",
        now: simNowMs,
      });
      if (!c.ok) return c;
    }
    if (limitProblem) return { ok: false as const, message: limitProblem };
    if (minimumProblem) return { ok: false as const, message: minimumProblem };
    return { ok: true as const };
  })();

  const formKey = [instrumentCode, counterMarketId, side, quantity, opDay, hours.join(","), bidType, JSON.stringify(steps)].join("|");
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

  async function placeOne(w: DeliveryWindow, mw: string, limit: string | null) {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        marketId,
        instrument: instrument.code,
        product: DAM_PRODUCT,
        counterMarketId: isPath ? counterMarketId : null,
        side,
        quantityMwh: mw,
        limitPrice: limit,
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
        if (bidType === "LIMIT") {
          for (const s of steps) await placeOne(hourWindow(h.startMs), s.mw.trim(), s.price.trim());
        } else {
          await placeOne(hourWindow(h.startMs), quantity, null);
        }
        out.push({ label, ok: true, detail: bidType === "LIMIT" ? `-step curve` : "at clearing" });
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
  const qtyNum = totalMw;
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
          <span
            className="badge badge-amber"
            title="Day-ahead clearing price for the next hour ERCOT has already cleared at this point — a reference, not the price this bid will get"
          >
            Next cleared DA {usd(latestPrice)}
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
          <p className="mt-2 text-[11px] leading-relaxed t-mute">{HOW_IT_PAYS[instrument.code]}</p>
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

        {/* Quantity: an at-clearing bid's MW (a curve carries MW per step) */}
        {bidType === "MARKET" && (
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
        )}

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
                // ERCOT opens an operating day fourteen days ahead (0045) and
                // closes it at 10:00 the day before (0038).
                min={firstOpenOperatingDay(nowMs)}
                max={lastOpenOperatingDay(nowMs)}
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
              <span className="label">
                Bid curve · MW at $/MWh (−{BID_PRICE_FLOOR * -1} to {BID_PRICE_CAP.toLocaleString("en-US")})
              </span>
              <div className="space-y-1.5">
                {steps.map((s, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      aria-label={`Step ${i + 1} MW`}
                      inputMode="decimal"
                      className="input mono w-20"
                      value={s.mw}
                      onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, mw: e.target.value } : x)))}
                    />
                    <span className="text-[11px] t-mute">MW at</span>
                    <input
                      id={i === 0 ? "limit-price" : undefined}
                      aria-label={`Step ${i + 1} price`}
                      inputMode="decimal"
                      className="input mono flex-1"
                      value={s.price}
                      onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))}
                      placeholder={isBuy ? "35.00" : "-5.00"}
                    />
                    {steps.length > 1 && (
                      <button type="button" className="btn btn-sm" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {steps.length < 4 && (
                  <button type="button" className="btn btn-sm" onClick={() => setSteps([...steps, { mw: "5", price: "" }])}>
                    + step
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed t-mute">
                {isBuy
                  ? "The most you will pay day-ahead: the bid clears in hours that price at or below it."
                  : "The least you will sell for day-ahead: the offer clears in hours that price at or above it."}{" "}
                Prices can be below zero. Each step is a separate order; the fill is the clearing price itself, never your limit.
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
              . ERCOT usually publishes the clearing prices around{" "}
              <span className="t-dim">{clearingMs != null ? localTime(clearingMs, tz) : "—"}</span> that day (later
              when the market run is delayed); each hour
              then fills at its own clearing price and settles against that hour&apos;s real-time price.
            </p>
          ) : (
            <p>Pick an operating day.</p>
          )}
          {pricedThrough != null && (
            <p className="mt-1">
              {/* pricedThrough is the END of the last published hour, so the
                  instant before it names that hour's operating day. */}
              Day-ahead prices are published through operating day{" "}
              <span className="t-dim">{operatingDayLabel(Date.parse(pricedThrough) - 1)}</span>.
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
            : `${sideLabels[side][0]} ${totalMw || 0} MW × ${chosen.length} h ${
                bidType === "LIMIT" ? `on a ${steps.length}-step curve` : "at clearing"
              }`}
        </button>

        {qtyNum > MAX_QUANTITY && (
          <p className="text-[11px] t-short">The desk accepts at most {MAX_QUANTITY} MW per hour.</p>
        )}
      </div>
    </form>
  );
}
