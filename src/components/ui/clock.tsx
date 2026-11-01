"use client";

import { useSyncExternalStore } from "react";
import { zonedParts, zoneName } from "@/lib/time";
import { useTimeZone } from "@/components/time-zone";

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
 * The desk clock, on the viewer's own time zone — the zone every time on the
 * site is shown in, so it is the one place that zone is stated in full.
 */
export function LocalClock() {
  const tz = useTimeZone();
  const seconds = useSyncExternalStore<number | null>(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );
  const p = seconds === null ? null : zonedParts(seconds * 1000, tz);

  return (
    <span
      className="mono t-mute text-[11px]"
      title={`Your time zone (${zoneName(tz)}). Every time on this site is shown in it; change it in Settings.`}
    >
      {p ? `${p.hh}:${p.mm}:${p.ss}` : "--:--:--"}
      <span className="ml-1 t-mute opacity-60">{p?.zone ?? ""}</span>
    </span>
  );
}

/** "your time (Central Time)" — the zone in words, for captions. */
export function ZoneCaption() {
  const tz = useTimeZone();
  return <>your time zone ({zoneName(tz)})</>;
}
