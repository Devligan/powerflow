"use client";

import { useSyncExternalStore } from "react";
import { centralParts } from "@/lib/format";

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
 * The desk clock, on ERCOT's market time (US Central, CDT or CST).
 *
 * Instants are stored in UTC, but every time the desk shows is Central, the
 * clock ERCOT schedules and settles on, so this is the one place the zone is
 * stated in full.
 */
export function MarketClock() {
  const seconds = useSyncExternalStore<number | null>(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );
  const p = seconds === null ? null : centralParts(seconds * 1000);

  return (
    <span
      className="mono t-mute text-[11px]"
      title="ERCOT market time (US Central). Every time on this desk is Central."
    >
      {p ? `${p.hh}:${p.mm}:${p.ss}` : "--:--:--"}
      <span className="ml-1 t-mute opacity-60">{p?.zone ?? "CT"}</span>
    </span>
  );
}
