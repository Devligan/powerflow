"use client";

import { createContext, useContext, useEffect } from "react";
import { useRouter } from "next/navigation";
import { TZ_COOKIE, TZ_MANUAL_COOKIE, isValidTimeZone } from "@/lib/time";

const TimeZoneContext = createContext<{ tz: string; manual: boolean }>({
  tz: "America/Chicago",
  manual: false,
});

/** The viewer's time zone, for client components. */
export function useTimeZone(): string {
  return useContext(TimeZoneContext).tz;
}

export function useTimeZoneSetting(): { tz: string; manual: boolean } {
  return useContext(TimeZoneContext);
}

const YEAR = 60 * 60 * 24 * 365;

function writeCookie(name: string, value: string | null) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    value == null
      ? `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
      : `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${YEAR}; SameSite=Lax${secure}`;
}

/** The zone this browser is set to. */
export function browserTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}

/**
 * Save a zone choice for this browser: a zone name to pin it, or null to
 * follow the browser's own zone again.
 */
export function saveTimeZoneChoice(tz: string | null) {
  if (tz && isValidTimeZone(tz)) {
    writeCookie(TZ_COOKIE, tz);
    writeCookie(TZ_MANUAL_COOKIE, "1");
  } else {
    writeCookie(TZ_MANUAL_COOKIE, null);
    const auto = browserTimeZone();
    if (auto) writeCookie(TZ_COOKIE, auto);
  }
}

/**
 * Provides the zone the server rendered with, and — unless the viewer pinned
 * one in Settings — keeps the cookie in step with the browser's own zone
 * (first visit, travel, a changed system setting), re-rendering once when it
 * differs.
 */
export function TimeZoneProvider({
  tz,
  manual,
  children,
}: {
  tz: string;
  manual: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  useEffect(() => {
    if (manual) return;
    const detected = browserTimeZone();
    if (detected && detected !== tz) {
      writeCookie(TZ_COOKIE, detected);
      router.refresh();
    }
  }, [tz, manual, router]);

  return (
    <TimeZoneContext.Provider value={{ tz, manual }}>{children}</TimeZoneContext.Provider>
  );
}
