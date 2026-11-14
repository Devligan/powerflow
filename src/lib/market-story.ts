import { supabaseAdmin } from "@/lib/supabase/admin";
import { getHourlyHistory } from "@/lib/markets";
import { centralHourEnding, operatingDayHours } from "@/lib/ercot/hour-ending";
import { summarizeRecap, type RecapHour } from "@/lib/day-recap";

/**
 * "Yesterday on the Texas grid": the hour of the latest complete operating day
 * where day-ahead and real time were furthest apart, at the trading hubs, for
 * the landing page to lead with. Real ERCOT data, read as published; nothing
 * here moves money.
 */

/** The physical hubs, by the name a Texan would use. The averages are left out
 *  because no one has ever stood in one. */
export const STORY_HUBS: Record<string, string> = {
  HB_NORTH: "North Texas",
  HB_HOUSTON: "Houston",
  HB_SOUTH: "South Texas",
  HB_WEST: "West Texas",
  HB_PAN: "the Panhandle",
};

export interface MarketStory {
  /** Central operating day, YYYY-MM-DD. */
  day: string;
  point: string;
  place: string;
  /** The day at that hub, hour by hour. */
  hours: RecapHour[];
  /** The hour of the widest gap. */
  peak: { he: number; startMs: number; da: number; rt: number; dart: number };
}

/** Enough hours priced to call the day complete (a DST day has 23 or 25). */
const MIN_PRICED = 23;

/**
 * The widest gap across the hubs' days. Pure, so the choice is tested on its
 * own; a hub with a gap in its prices is passed over rather than half-drawn.
 */
export function pickStory(
  day: string,
  byPoint: Array<{ point: string; hours: RecapHour[] }>
): MarketStory | null {
  let best: MarketStory | null = null;
  for (const { point, hours } of byPoint) {
    if (hours.filter((h) => h.dart != null).length < MIN_PRICED) continue;
    for (const h of hours) {
      if (h.dart == null || h.da == null || h.rt == null) continue;
      if (!best || Math.abs(h.dart) > Math.abs(best.peak.dart)) {
        best = {
          day,
          point,
          place: STORY_HUBS[point] ?? point,
          hours,
          peak: { he: h.he, startMs: h.startMs, da: h.da, rt: h.rt, dart: h.dart },
        };
      }
    }
  }
  return best;
}

function daysBefore(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

async function loadStoryUncached(nowMs: number): Promise<MarketStory | null> {
  const { data, error } = await supabaseAdmin()
    .from("markets")
    .select("id, settlement_point")
    .in("settlement_point", Object.keys(STORY_HUBS));
  if (error) throw new Error(error.message);
  const hubs = data ?? [];

  // Yesterday in Central time, or the day before while yesterday's last real
  // time prices are still arriving.
  const today = centralHourEnding(nowMs).day;
  for (const back of [1, 2, 3]) {
    const day = daysBefore(today, back);
    const hours = operatingDayHours(day);
    if (hours.length === 0) continue;
    const from = hours[0].startMs;
    const to = hours[hours.length - 1].startMs + 3_600_000;
    const byPoint = await Promise.all(
      hubs.map(async (m) => {
        const [da, rt] = await Promise.all([
          getHourlyHistory(m.id, "DAM_HOURLY", from, to),
          getHourlyHistory(m.id, "RTM_HOURLY", from, to),
        ]);
        return { point: m.settlement_point, hours: summarizeRecap(da, rt).hours };
      })
    );
    const story = pickStory(day, byPoint);
    if (story) return story;
  }
  return null;
}

// The story changes once a day; the landing page is read far more often. One
// copy per server instance, refreshed every quarter hour, is plenty.
let cached: { at: number; value: MarketStory | null } | null = null;
const TTL_MS = 15 * 60_000;

export async function loadMarketStory(nowMs: number = Date.now()): Promise<MarketStory | null> {
  if (cached && nowMs - cached.at < TTL_MS) return cached.value;
  const value = await loadStoryUncached(nowMs);
  cached = { at: nowMs, value };
  return value;
}
