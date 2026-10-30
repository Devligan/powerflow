import { describe, expect, it } from "vitest";
import { fairShare } from "@/lib/ingestion";

const row = (product: string, hour: number) => ({
  product,
  delivery_timestamp: new Date(Date.UTC(2026, 9, 30, hour)).toISOString(),
  published_at: new Date(Date.UTC(2026, 9, 30, hour, 17)).toISOString(),
});

describe("fairShare", () => {
  it("returns everything when the run is under budget", () => {
    const rows = [row("RTM_15MIN", 1), row("DAM_HOURLY", 2)];
    expect(fairShare(rows, 10)).toBe(rows);
  });

  it("does not let the first product fetched starve the others", () => {
    // The 15-minute series arrives first and alone exceeds the budget; under a
    // plain slice the hourly and day-ahead series never advanced.
    const rows = [
      ...Array.from({ length: 20 }, (_, h) => row("RTM_15MIN", h)),
      row("RTM_HOURLY", 0),
      row("RTM_HOURLY", 1),
      row("DAM_HOURLY", 0),
    ];
    const taken = fairShare(rows, 6);
    expect(taken).toHaveLength(6);
    expect(taken.filter((r) => r.product === "RTM_HOURLY")).toHaveLength(2);
    expect(taken.filter((r) => r.product === "DAM_HOURLY")).toHaveLength(1);
    expect(taken.filter((r) => r.product === "RTM_15MIN")).toHaveLength(3);
  });

  it("keeps each product's oldest deliveries, so deferred rows stay above the resume cursor", () => {
    // Out of delivery order, as concurrent MIS downloads return them.
    const rows = [5, 2, 9, 0, 7].map((h) => row("RTM_15MIN", h));
    const hours = fairShare(rows, 3).map((r) => new Date(r.delivery_timestamp).getUTCHours());
    expect(hours).toEqual([0, 2, 5]);
  });
});
