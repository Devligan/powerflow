"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refresh the shell's server components on a cadence.
 *
 * The shell's pages are `force-dynamic` — correct on navigation, frozen when
 * parked. A desk whose feed ticks every few minutes cannot leave marks,
 * equity and positions stale until the next click, so the shell refreshes
 * itself every 30 seconds while the tab is visible. A hidden tab neither
 * refreshes nor counts staleness (a trader coming back sees a fresh render
 * immediately rather than a flicker of old numbers).
 *
 * The staleness signal is deliberate: if a refresh fails (network, deploy,
 * upstream outage) the banner says so instead of leaving frozen numbers
 * looking live.
 */
export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let failed = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        await router.refresh();
        failed = false;
      } catch {
        failed = true;
      }
      document.documentElement.dataset.stale = failed ? "true" : "false";
    };
    tick();
    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      delete document.documentElement.dataset.stale;
    };
  }, [router, intervalMs]);

  return null;
}
