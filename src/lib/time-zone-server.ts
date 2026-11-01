import { cookies } from "next/headers";
import { TZ_COOKIE, TZ_MANUAL_COOKIE, normalizeTimeZone } from "@/lib/time";

/**
 * The viewer's time zone for server-rendered output, from the cookie the
 * browser keeps current (TimeZoneSync) or the one chosen in Settings. Before
 * a browser has reported its zone, ERCOT's Central clock is used; the client
 * corrects it on first load.
 */
export async function getViewerTimeZone(): Promise<{ tz: string; manual: boolean }> {
  const store = await cookies();
  return {
    tz: normalizeTimeZone(store.get(TZ_COOKIE)?.value),
    manual: store.get(TZ_MANUAL_COOKIE)?.value === "1",
  };
}
