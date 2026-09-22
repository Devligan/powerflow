"use client";

import { useEffect, useRef, useState } from "react";

/** The signed numeric gap between two figures, ignoring currency and grouping. */
function delta(previous: string, next: string): number {
  const read = (v: string) => Number(v.replace(/[^0-9.-]/g, ""));
  const a = read(previous);
  const b = read(next);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return b - a;
}

/**
 * A figure that reports the tick it just took.
 *
 * A live price that silently redraws tells the reader nothing about whether it
 * moved, so a changed value flashes in its direction once and then settles.
 * The flash is a report, not decoration: it only fires when the number
 * genuinely changed, and it is suppressed entirely under reduced-motion.
 */
export function FlashValue({
  value,
  className = "",
}: {
  value: string;
  className?: string;
}) {
  const previous = useRef<string | null>(null);
  const [flash, setFlash] = useState<"" | "flash-up" | "flash-down">("");

  useEffect(() => {
    const was = previous.current;
    previous.current = value;
    if (was === null || was === value) return;

    const move = delta(was, value);
    if (move === 0) return;

    setFlash(move > 0 ? "flash-up" : "flash-down");
    const id = setTimeout(() => setFlash(""), 660);
    return () => clearTimeout(id);
  }, [value]);

  return <span className={`${className} ${flash}`}>{value}</span>;
}
