"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { parseDec, format } from "@/lib/money";
import {
  dateTime,
  volumeUnitLabel,
  positionUnit,
  instrumentInfo,
  usd,
  num,
  signedUsd,
} from "@/lib/format";
import {
  DEFAULT_INSTRUMENT,
  DEFAULT_MARKET_PRODUCT,
  getInstrument,
  getProduct,
  tradableInstruments,
} from "@/lib/ercot/types";
import { needsCounterPoint } from "@/lib/trading/instruments";
import {
  DEFAULT_WINDOW_INTERVALS,
  MAX_QUANTITY,
  buildWindow,
  checkOrderForm,
  effectiveProduct,
  estimateInstrumentPrice,
  orderRequest,
  probePrice,
  ruleHint,
  selectableProducts,
  windowIntervals,
  type SeriesPoint,
} from "@/lib/trading/order-form";
import { liveDeliveryDefault } from "@/lib/trading/live-defaults";

/**
 * The order ticket.
 *
 * It can place every instrument the desk trades, not just an energy point: the
 * instrument picker drives which controls exist, because the shapes genuinely
 * differ. A spread needs a second settlement point, a block forward needs a
 * window rather than an instant, and a virtual trade names a settlement point
 * and interval but takes no delivery leg at all.
 *
 * What can be priced here is stated and what cannot is said to be settled at
 * execution. A composed instrument's price is never previewed from leg A, and
 * a partly covered window is not previewed at all.
 */
export function TradePanel({
  marketId,
  settlementPoint,
  latestPrice,
  product,
  pricedThrough,
  markets,
  series,
  simNowMs,
}: {
  marketId: string;
  settlementPoint: string;
  latestPrice: string | null;
  /** Product this market page is showing; the starting point for the ticket. */
  product: string;
  /**
   * Latest delivery interval the feed has published for this series. An order
   * is filled only at a price that exists for its own delivery interval, so
   * this is the boundary of what can be traded at all.
   */
  pricedThrough: string | null;
  /** Active settlement points, for a spread's second leg. */
  markets: Array<{ id: string; settlementPoint: string }>;
  /** Leg A's prices for the product on this page, for previews. */
  series: SeriesPoint[];
  /** The desk's simulation time (ms). In replay the ticket's horizon checks
   *  run against this — the engine validates against the same clock. */
  simNowMs?: number;
}) {
  const router = useRouter();
  const [instrumentCode, setInstrumentCode] = useState(DEFAULT_INSTRUMENT);
  // The page's series anchors the ticket, but only an orderable series can be
  // traded (0025: the RT references are not). Snap the initial choice into
  // the selectable set so the displayed option is always the submitted one;
  // the reference note below explains the page's own series.
  const [chosenProduct, setChosenProduct] = useState(() => {
    const options = selectableProducts(getInstrument(DEFAULT_INSTRUMENT)!);
    return options.includes(product) ? product : (options[0] ?? product);
  });
  const [counterMarketId, setCounterMarketId] = useState<string | null>(null);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState("10");
  const [dateStr, setDateStr] = useState(() => liveDeliveryDefault(product).date);
  const [hour, setHour] = useState(() => liveDeliveryDefault(product).hour);
  const [referenceNote, setReferenceNote] = useState<string | null>(
    () => liveDeliveryDefault(product).note
  );
  const [windowLength, setWindowLength] = useState(DEFAULT_WINDOW_INTERVALS);
  // Execution mode: fill now at the interval's actual print, or work a
  // resting limit that the sweep fills when the print crosses.
  const [executionMode, setExecutionMode] = useState<"MARKET" | "LIMIT">("MARKET");
  const [limitPrice, setLimitPrice] = useState("");
  const [placed, setPlaced] = useState<null | { orderId: string; limitPrice: string; side: string }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fill, setFill] = useState<null | {
    executionPrice: string;
    notional: string;
    cashBalance: string;
    positionQuantity: string;
    realizedDelta: string;
    instrument: string;
    settlementRule: string;
    replayed: boolean;
  }>(null);
  const [orderNonce, setOrderNonce] = useState(0);

  const instrument = getInstrument(instrumentCode) ?? getInstrument(DEFAULT_INSTRUMENT)!;
  const info = instrumentInfo(instrument.code);
  const offersProducts = instrument.productFromTrade;
  const productOptions = useMemo(() => selectableProducts(instrument), [instrument]);
  // A derived product is not chosen, so the ticket shows what it will settle in.
  const tradedProduct = effectiveProduct(
    instrument,
    offersProducts ? chosenProduct : DEFAULT_MARKET_PRODUCT
  );
  const productDef = getProduct(tradedProduct);
  const intervalMinutes = productDef?.intervalMinutes ?? 60;
  const unit = volumeUnitLabel(positionUnit(tradedProduct));

  const intervals = windowIntervals(instrument.settlementRule, windowLength);
  const delivery = buildWindow({ date: dateStr, hour, intervalMinutes, intervals });

  const probe = delivery
    ? probePrice(instrument, delivery, intervalMinutes, series, product, tradedProduct)
    : "unknown";

  const estimate = delivery
    ? estimateInstrumentPrice(
        instrument,
        delivery,
        intervalMinutes,
        series,
        product,
        tradedProduct
      )
    : null;

  const qty = safeQty(quantity);
  const estimatedNotional =
    estimate !== null && qty > 0n ? (estimate * qty) / 1_000_000n : null;

  const check = delivery
    ? checkOrderForm({
        instrument,
        product: offersProducts ? chosenProduct : tradedProduct,
        counterMarketId,
        marketId,
        quantity,
        delivery,
        intervalMinutes,
        priceProbe: probe,
        now: simNowMs,
      })
    : { ok: false as const, message: "That delivery date is not valid." };

  // The series horizon the page was rendered with: in replay it is bounded by
  // the reader's clock (the page passes the as-of series), so an order beyond
  // it would promise a price nobody has seen. The wall clock is never read
  // during render; the ticket's own time check lives in checkOrderForm.
  const pricedThroughMs = pricedThrough ? new Date(pricedThrough).getTime() : null;
  const beyondHorizon =
    delivery != null &&
    pricedThroughMs != null &&
    delivery.endMs > pricedThroughMs;

  // A stable id per intent, rotated after a fill: a retry of the order in the
  // box cannot double-fill, while deliberately repeating it still executes.
  const clientOrderId = useMemo(
    () => newOrderId(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [marketId, instrumentCode, chosenProduct, counterMarketId, side, quantity, dateStr, hour, intervals, orderNonce]
  );

  function pickInstrument(code: string) {
    const next = getInstrument(code);
    if (!next) return;
    setInstrumentCode(code);
    setFill(null);
    setError(null);
    const options = selectableProducts(next);
    if (options.length > 0 && !options.includes(chosenProduct)) {
      setChosenProduct(options[0]);
    }
    if (!needsCounterPoint(next.settlementRule)) setCounterMarketId(null);
    // The traded product changes what the default delivery means: a legless
    // or path instrument clears in the day-ahead market even from an RT
    // page, so the default re-solves for the product actually traded.
    const nextProduct = options.length > 0 ? options[0] : tradedProduct;
    const def = liveDeliveryDefault(nextProduct);
    setDateStr(def.date);
    setHour(def.hour);
    setReferenceNote(def.note);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!delivery || !check.ok) {
      setError(check.ok ? "That delivery date is not valid." : check.message);
      return;
    }
    if (executionMode === "LIMIT" && !/^\d+(\.\d{1,6})?$/.test(limitPrice)) {
      setError("Limit price must be a positive number.");
      return;
    }
    setBusy(true);
    setError(null);
    setFill(null);
    setPlaced(null);
    try {
      if (executionMode === "LIMIT") {
        const res = await fetch("/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            marketId,
            instrument: instrument.code,
            product: tradedProduct,
            counterMarketId,
            side,
            quantityMwh: quantity,
            limitPrice,
            deliveryStart: delivery.start,
            deliveryEnd: delivery.end,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Order failed");
        setPlaced({ orderId: body.orderId, limitPrice, side });
        setOrderNonce((n) => n + 1);
        router.refresh();
        return;
      }
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          orderRequest({
            marketId,
            instrumentCode: instrument.code,
            product: tradedProduct,
            counterMarketId,
            side,
            quantity,
            delivery,
            clientOrderId,
          })
        ),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Trade failed");
      setFill(body.trade);
      setOrderNonce((n) => n + 1);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trade failed");
    } finally {
      setBusy(false);
    }
  }

  const counterOptions = markets.filter((m) => m.id !== marketId);
  const counterPoint =
    counterMarketId != null
      ? markets.find((m) => m.id === counterMarketId)?.settlementPoint ?? null
      : null;
  const legsNeedSecond = needsCounterPoint(instrument.settlementRule);
  const isBuy = side === "BUY";

  return (
    <form onSubmit={onSubmit} className="card p-0">
      {/* Faceplate */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <h2 className="card-title mb-0">Order ticket</h2>
          <p className="mono mt-1 truncate text-[11px] t-mute">
            {settlementPoint}
          </p>
        </div>
        {latestPrice != null && (
          <span
            className="badge badge-amber"
            title="Server-authoritative price for the latest published interval"
          >
            {`$${format(parseDec(latestPrice), 2)}`}
          </span>
        )}
      </div>

      <div className="space-y-4 p-4">
        {/* Instrument */}
        <div>
          <label className="label" htmlFor="instrument">
            Instrument
          </label>
          <select
            id="instrument"
            className="input"
            value={instrumentCode}
            onChange={(e) => pickInstrument(e.target.value)}
          >
            {tradableInstruments().map((i) => (
              <option key={i.code} value={i.code}>
                {i.label}
              </option>
            ))}
          </select>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            {info && (
              <span className={`badge ${info.tone}`}>{info.ruleLabel}</span>
            )}
            <span className="text-[11px] leading-relaxed t-mute">
              {ruleHint(instrument)}
            </span>
          </p>
          {referenceNote && (
            <p className="note mt-2">{referenceNote}</p>
          )}
        </div>

        {/* Legs: leg A is this page; a spread needs a sink */}
        {legsNeedSecond && (
          <div className="border-t border-white/10 pt-4">
            <label className="label" htmlFor="counter-point">
              Second leg · sink
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
            <p className="mt-2 text-[11px] leading-relaxed t-mute">
              <span className="mono t-dim">{settlementPoint}</span> →{" "}
              <span className="mono t-dim">{counterPoint ?? "—"}</span>. A long
              position profits when congestion runs from the source to the sink.
            </p>
          </div>
        )}

        {/* Product */}
        {offersProducts ? (
          <div className="border-t border-white/10 pt-4">
            <label className="label" htmlFor="product">
              Price series
            </label>
            <select
              id="product"
              className="input"
              value={chosenProduct}
              onChange={(e) => {
                setChosenProduct(e.target.value);
                const def = liveDeliveryDefault(e.target.value);
                setDateStr(def.date);
                setHour(def.hour);
                setReferenceNote(def.note);
              }}
            >
              {productOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="border-t border-white/10 pt-4 text-[11px] leading-relaxed t-mute">
            Settles in <span className="mono t-dim">{tradedProduct}</span>. This
            instrument has no series of its own.
          </p>
        )}

        {/* Side: a sliding indicator, so the selection is a position not a fill */}
        <div className="border-t border-white/10 pt-4">
          <span className="label">Direction</span>
          <div className="relative grid grid-cols-2 border border-white/15">
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-1/2 transition-transform duration-200 ease-out"
              style={{
                transform: isBuy ? "translateX(0)" : "translateX(100%)",
                background: isBuy ? "var(--long-bg)" : "var(--short-bg)",
                boxShadow: `inset 0 -2px 0 ${isBuy ? "var(--long)" : "var(--short)"}`,
              }}
            />
            <button
              type="button"
              aria-pressed={isBuy}
              onClick={() => setSide("BUY")}
              className={`relative z-10 py-2 text-[11px] font-semibold tracking-[0.08em] uppercase transition-colors ${isBuy ? "t-long" : "t-mute hover:text-white/80"}`}
            >
              Buy long
            </button>
            <button
              type="button"
              aria-pressed={!isBuy}
              onClick={() => setSide("SELL")}
              className={`relative z-10 py-2 text-[11px] font-semibold tracking-[0.08em] uppercase transition-colors ${!isBuy ? "t-short" : "t-mute hover:text-white/80"}`}
            >
              Sell short
            </button>
          </div>
        </div>

        {/* Quantity */}
        <div className="border-t border-white/10 pt-4">
          <label className="label" htmlFor="qty">
            Quantity · {unit}
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

        {/* Execution mode: fill now at the print, or rest a working limit */}
        <div className="border-t border-white/10 pt-4">
          <span className="label">Execution</span>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={executionMode === "MARKET"}
              onClick={() => setExecutionMode("MARKET")}
              className={`border px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors ${
                executionMode === "MARKET"
                  ? "border-white/40 bg-white/10 text-white"
                  : "border-white/15 t-mute hover:text-white/80"
              }`}
            >
              Fill now
            </button>
            <button
              type="button"
              aria-pressed={executionMode === "LIMIT"}
              onClick={() => setExecutionMode("LIMIT")}
              className={`border px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors ${
                executionMode === "LIMIT"
                  ? "border-white/40 bg-white/10 text-white"
                  : "border-white/15 t-mute hover:text-white/80"
              }`}
            >
              Working limit
            </button>
          </div>
          {executionMode === "LIMIT" && (
            <div className="mt-3">
              <label className="label" htmlFor="limit-price">
                Limit price · $/MWh
              </label>
              <input
                id="limit-price"
                type="text"
                inputMode="decimal"
                required
                className="input mono"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                placeholder="35.00"
              />
              <p className="mt-2 text-[11px] leading-relaxed t-mute">
                Rests on the book until the interval&apos;s actual ERCOT print
                crosses it — a buy fills at or below your limit, a sell at or
                above (ties fill). The fill price is the print itself, never
                your limit. Unfilled orders expire after 7 days.
              </p>
            </div>
          )}
        </div>

        {/* Delivery */}
        <div className="grid grid-cols-2 gap-3 border-t border-white/10 pt-4">
          <div>
            <label className="label" htmlFor="delivery-date">
              {intervals > 1 ? "Window start · UTC" : "Delivery · UTC"}
            </label>
            <input
              id="delivery-date"
              type="date"
              required
              className="input"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="delivery-hour">
              Start hour · UTC
            </label>
            <select
              id="delivery-hour"
              className="input mono"
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {String(i).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Window, for instruments whose delivery is a period */}
        {intervals !== undefined && instrument.settlementRule === "AVERAGE" && (
          <div className="border-t border-white/10 pt-4">
            <label className="label" htmlFor="window">
              Settlement window
            </label>
            <div className="flex items-center gap-2">
              <input
                id="window"
                type="number"
                min={1}
                max={Math.floor((35 * 24 * 60) / intervalMinutes)}
                className="input mono w-24"
                value={windowLength}
                onChange={(e) => setWindowLength(Number(e.target.value))}
              />
              <span className="text-[11px] t-mute">
                × {intervalMinutes} min ={" "}
                {delivery ? formatMinutes(delivery.minutes) : "—"} on {tradedProduct}
              </span>
            </div>
          </div>
        )}

        {/* Settlement rule note */}
        <p className="border-t border-white/10 pt-4 text-[11px] leading-relaxed t-mute">
          {instrument.settlementRule === "AVERAGE"
            ? "A window must be a whole number of settlement intervals, and every interval in it must be priced."
            : "One trade covers one settlement interval. Settled intervals and sessions beyond 35 days are rejected."}
        </p>

        <p className="text-[11px] leading-relaxed t-mute">
          Fills at the price published for that exact interval, never one carried
          forward from another.
          <br />
          {tradedProduct} priced through{" "}
          <span className="mono t-dim">
            {pricedThrough != null ? `${dateTime(pricedThrough)} UTC` : "—"}
          </span>
          .
        </p>

        {beyondHorizon && (
          <div className="note note-warn">
            {instrument.settlementRule === "AVERAGE"
              ? "That window runs past the priced horizon, so no order can fill there."
              : "That delivery is past the priced horizon, so no order can fill there."}{" "}
            It will be refused rather than filled at an older price.
          </div>
        )}

        {/* Execution preview */}
        {estimatedNotional != null && estimate !== null ? (
          <div className="flex items-baseline justify-between gap-3 border border-white/10 bg-[var(--ink-well)] px-3 py-2">
            <span className="caption">
              Est. {instrument.settlementRule === "AVERAGE" ? "window avg" : "price"}
            </span>
            <span className="mono text-[12px]">
              ${format(estimate, 2)}
              <span className="t-mute">
                {" "}
                · notional ${format(estimatedNotional, 2)}
              </span>
            </span>
          </div>
        ) : (
          <div className="border border-white/10 bg-[var(--ink-well)] px-3 py-2 text-[11px] t-mute">
            Price is composed at execution
            {instrument.settlementRule === "DIFFERENCE"
              ? " from both legs"
              : instrument.settlementRule === "CONVERGENCE"
                ? " from the two energy markets"
                : ""}
            .
          </div>
        )}

        {!check.ok && <div className="note note-warn">{check.message}</div>}

        {error && <div className="note note-error">{error}</div>}

        {fill && (
          <div className="note note-ok">
            {fill.replayed && (
              <span
                className="badge badge-amber mr-2"
                title="This order id has already executed"
              >
                Replayed
              </span>
            )}
            Filled {instrumentInfo(fill.instrument)?.shortLabel ?? fill.instrument}{" "}
            at <span className="mono">{usd(fill.executionPrice)}</span>, notional{" "}
            {usd(fill.notional)}. Cash now {usd(fill.cashBalance)} · position{" "}
            <span className="mono">{num(fill.positionQuantity, 3)}</span> {unit}
            {parseDec(fill.realizedDelta) !== 0n && (
              <span className={parseDec(fill.realizedDelta) > 0n ? " pos" : " neg"}>
                {" "}
                · realized {signedUsd(fill.realizedDelta)}
              </span>
            )}
          </div>
        )}

        {placed && (
          <div className="note note-ok">
            Working {placed.side === "BUY" ? "buy" : "sell"} for{" "}
            <span className="mono">{placed.limitPrice}</span> — resting until the
            print crosses. View it under <span className="mono">Orders</span>.
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !check.ok}
          className="btn btn-primary w-full"
        >
          {busy
            ? executionMode === "LIMIT"
              ? "Placing"
              : "Executing"
            : executionMode === "LIMIT"
              ? `Work ${isBuy ? "buy" : "sell"} ${quantity || "0"} ${unit} @ ${limitPrice || "—"}`
              : `${isBuy ? "Buy" : "Sell"} ${quantity || "0"} ${unit} · ${
                  info?.shortLabel ?? instrument.label
                }`}
        </button>

        {Number(quantity) > MAX_QUANTITY && (
          <p className="text-[11px] t-short">
            The desk accepts at most {MAX_QUANTITY} {unit} per order.
          </p>
        )}
      </div>
    </form>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function safeQty(v: string): bigint {
  try {
    return parseDec(v);
  } catch {
    return 0n;
  }
}

/**
 * A client order id for one intent. Prefers the platform UUID generator and
 * falls back to a timestamp+counter shape where it is unavailable (older
 * browsers, non-secure contexts) rather than silently sending no id at all.
 */
function newOrderId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ord-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}