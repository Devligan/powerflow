"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Term } from "@/components/term";

const DISMISS_KEY = "pf_first_trade_dismissed";

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The first trade in three steps, for an account that has never placed an
 * order. Dismissing it is remembered in this browser only; it also goes away
 * on its own once the first bid exists.
 */
const noSubscription = () => () => {};

export function FirstTrade() {
  // The server cannot see this browser's choice: it renders the card, and the
  // stored dismissal takes over on hydration without a mismatch.
  const dismissedBefore = useSyncExternalStore(noSubscription, wasDismissed, () => false);
  const [dismissedNow, setHidden] = useState(false);
  if (dismissedBefore || dismissedNow) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // private mode: it simply shows again next visit
    }
    setHidden(true);
  }

  return (
    <section className="card border-amber-400/30 p-4" aria-labelledby="first-trade-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="first-trade-title" className="card-title mb-0">
          Your first trade, in three steps
        </h2>
        <button type="button" className="caption t-mute hover:underline" onClick={dismiss}>
          Dismiss
        </button>
      </div>
      <ol className="mt-3 grid gap-3 md:grid-cols-3">
        <li>
          <div className="caption t-mute">1 · Pick a place</div>
          <p className="mt-1 text-[13px] t-dim">
            Open a <Term k="settlementPoint">hub</Term> such as{" "}
            <Link href="/markets/HB_NORTH" className="t-accent hover:underline">
              HB_NORTH
            </Link>{" "}
            and look at tomorrow&apos;s <Term k="dam">day-ahead</Term> curve against recent{" "}
            <Term k="rt">real time</Term>.
          </p>
        </li>
        <li>
          <div className="caption t-mute">2 · Take a side</div>
          <p className="mt-1 text-[13px] t-dim">
            Expect the evening peak to price higher in real time? Bid a 1 MW <Term k="virtual">DEC</Term> on{" "}
            <Term k="hourEnding">HE18</Term>. Expect it lower? An INC. Bids close at 10:00 Central the day before.
          </p>
        </li>
        <li>
          <div className="caption t-mute">3 · See it play out</div>
          <p className="mt-1 text-[13px] t-dim">
            Live, it fills this afternoon and settles in about four days. To see the whole cycle in minutes, switch
            to the <strong>Practice</strong> desk above and run a past day.
          </p>
        </li>
      </ol>
      <p className="caption mt-3 t-mute">
        New to power markets?{" "}
        <Link href="/learn" className="t-accent hover:underline">
          How it works, in five minutes →
        </Link>
      </p>
    </section>
  );
}
