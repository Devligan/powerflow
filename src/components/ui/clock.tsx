"use client";

import { useSyncExternalStore } from "react";

/*
 * A clock is an external system, not component state, so it is read through
 * `useSyncExternalStore`. That keeps the tick out of an effect, which is both
 * the pattern React asks for and the one that avoids a cascading render on
 * every second.
 */

function subscribe(onChange: () => void) {
  // Four polls a second keeps the display on the second instead of drifting
  // up to a second behind it.
  const id = setInterval(onChange, 250);
  return () => clearInterval(id);
}

/** Whole seconds since the epoch: a primitive, so snapshots compare equal. */
function getSnapshot(): number {
  return Math.floor(Date.now() / 1000);
}

/** The server has no clock to agree with, so it renders the placeholder. */
function getServerSnapshot(): null {
  return null;
}

/**
 * The desk clock, in UTC.
 *
 * Every timestamp in this application is UTC (market data, delivery windows,
 * settlement), so the clock is the one place that is stated once instead of
 * repeated on every row.
 */
export function UtcClock() {
  const seconds = useSyncExternalStore<number | null>(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  return (
    <span
      className="mono t-mute text-[11px]"
      title="Coordinated Universal Time. Every timestamp on this desk is UTC."
    >
      {seconds === null
        ? "--:--:--"
        : new Date(seconds * 1000).toISOString().slice(11, 19)}
      <span className="t-mute opacity-60">Z</span>
    </span>
  );
}
