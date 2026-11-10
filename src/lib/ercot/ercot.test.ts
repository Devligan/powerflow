import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DA_SYSTEM_WIDE_OFFER_CAP,
  HUB_AVERAGES,
  HUBS,
  INSTRUMENTS,
  LOAD_ZONES,
  NOIE_LOAD_ZONES,
  PRODUCTS,
  REGIONAL_HUBS,
  RT_PRICE_FLOOR,
  SOURCE_ERCOT_MIS,
  SOURCE_SIMULATED,
  getInstrument,
  getProduct,
  normalizePriceRecord,
  tradableInstruments,
  deskInstruments,
  tradableProducts,
  truncateToHour,
} from "@/lib/ercot/types";
import {
  SIMULATED_MARKETS,
  SimulatedErcotSource,
  generateMarketPrices,
  simulatedPrice,
} from "@/lib/ercot/simulated";
import {
  ErcotMISSource,
  deliveryCentralToUtc,
  listMisDocs,
  misPostedAt,
  parseDamSppCsv,
  parseErcotSppCsv,
  parseMisListingJson,
  parseMisListingPage,
  parseRtmSppCsv,
} from "@/lib/ercot/mis";
import { needsBothMarkets, needsCounterPoint } from "@/lib/trading/instruments";

const byPoint = (point: string) => {
  const m = SIMULATED_MARKETS.find((x) => x.settlementPoint === point);
  if (!m) throw new Error(`missing simulated location: ${point}`);
  return m;
};

describe("product catalog", () => {
  it("catalogues every product with a valid venue and interval", () => {
    expect(PRODUCTS.length).toBeGreaterThan(0);
    for (const p of PRODUCTS) {
      expect(["DAM", "RTM", "AS", "CRR"]).toContain(p.venue);
      expect([15, 60]).toContain(p.intervalMinutes);
      expect(["ENERGY", "ANCILLARY", "CONGESTION"]).toContain(p.kind);
    }
  });

  it("represents the tradable energy products and the priced-only series", () => {
    const tradable = tradableProducts().map((p) => p.code);
    // The day-ahead market is where a desk commits forward. Real-time prints
    // exist only AFTER delivery, so the RT series are reference data — reach
    // RT exposure through DART/VIRTUAL/PTP instruments (0025).
    expect(tradable).toContain("DAM_HOURLY");
    expect(getProduct("RTM_15MIN")?.tradable).toBe(false);
    expect(getProduct("RTM_HOURLY")?.tradable).toBe(false);
    // Ancillary services are priced but not tradable *as a series*, and a desk
    // with no assets cannot hold one anyway — providing AS is a resource
    // obligation. CRRs are the same: the series is priced-only, while the CRR
    // *instruments* are open for order entry.
    expect(getProduct("REGUP")?.tradable).toBe(false);
    expect(getProduct("CRR_OBLIGATION")?.tradable).toBe(false);
  });

  it("carries ERCOT's published ancillary-service set and its capacity unit", () => {
    // ERCOT publishes exactly five AS price series — ECRS, NSPIN, REGDN,
    // REGUP and RRS — plus DRRS, which is real but still in design. RRS is
    // deliberately *one* product: its Primary/Under/Fast split is a requirement
    // allocation inside RRS, not three series, so modelling the tiers would
    // invent prices ERCOT never publishes. Pinned so a tier cannot creep back.
    const asCodes = PRODUCTS.filter((p) => p.venue === "AS").map((p) => p.code);
    expect(asCodes.sort()).toEqual(
      ["DRRS", "ECRS", "NSPIN", "REGDN", "REGUP", "RRS"].sort()
    );
    for (const p of PRODUCTS) {
      expect(p.pricedPer).toBe(p.kind === "ANCILLARY" ? "MW" : "MWH");
    }
  });
});

describe("normalizePriceRecord", () => {
  const PUB = "2026-09-01T13:45:00.000Z";

  it("accepts a valid record and derives the interval end", () => {
    const res = normalizePriceRecord(
      {
        settlementPoint: "HB_HOUSTON",
        deliveryTimestamp: "2026-09-01T14:00:00Z",
        price: "58.2312",
        sourceTimestamp: PUB,
      },
      SOURCE_SIMULATED,
      "DAM_HOURLY"
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.record.price).toBe("58.2312");
      expect(res.record.product).toBe("DAM_HOURLY");
      expect(res.record.deliveryTimestamp).toBe("2026-09-01T14:00:00.000Z");
      expect(res.record.deliveryEnd).toBe("2026-09-01T15:00:00.000Z");
      // The publication time carries through as both names for the same
      // instant — the store column is published_at.
      expect(res.record.sourceTimestamp).toBe(PUB);
      expect(res.record.publishedAt).toBe(PUB);
      expect(res.record.isFinal).toBe(false);
    }
  });

  it("rejects a record with no publication time (the look-ahead guard needs it)", () => {
    expect(
      normalizePriceRecord(
        { settlementPoint: "X", deliveryTimestamp: "2026-09-01T00:00:00Z", price: "10" },
        SOURCE_SIMULATED
      ).ok
    ).toBe(false);
    expect(
      normalizePriceRecord(
        { settlementPoint: "X", deliveryTimestamp: "2026-09-01T00:00:00Z", price: "10", sourceTimestamp: "garbage" },
        SOURCE_SIMULATED
      ).ok
    ).toBe(false);
  });

  it("accepts publishedAt as the publication field and carries isFinal", () => {
    const res = normalizePriceRecord(
      {
        settlementPoint: "X",
        deliveryTimestamp: "2026-09-01T00:00:00Z",
        price: "10",
        publishedAt: PUB,
        isFinal: true,
      },
      SOURCE_ERCOT_MIS,
      "DAM_HOURLY"
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.record.publishedAt).toBe(PUB);
      expect(res.record.isFinal).toBe(true);
    }
  });

  it("rejects out-of-range, non-finite and missing values", () => {
    expect(
      normalizePriceRecord({ settlementPoint: "X", deliveryTimestamp: "2026-09-01T00:00:00Z", price: "999999", sourceTimestamp: PUB }, SOURCE_SIMULATED).ok
    ).toBe(false);
    expect(
      normalizePriceRecord({ settlementPoint: "X", deliveryTimestamp: "2026-09-01T00:00:00Z", price: "not-a-number", sourceTimestamp: PUB }, SOURCE_SIMULATED).ok
    ).toBe(false);
    expect(
      normalizePriceRecord({ settlementPoint: "", deliveryTimestamp: "2026-09-01T00:00:00Z", price: "10", sourceTimestamp: PUB }, SOURCE_SIMULATED).ok
    ).toBe(false);
    expect(
      normalizePriceRecord({ settlementPoint: "X", deliveryTimestamp: "garbage", price: "10", sourceTimestamp: PUB }, SOURCE_SIMULATED).ok
    ).toBe(false);
  });

  it("accepts negative prices (ERCOT can go negative)", () => {
    const res = normalizePriceRecord(
      { settlementPoint: "LZ_HOUSTON", deliveryTimestamp: "2026-09-01T00:00:00Z", price: "-8.5", sourceTimestamp: PUB },
      SOURCE_SIMULATED
    );
    expect(res.ok).toBe(true);
  });

  it("rejects an unknown product rather than coercing it", () => {
    expect(
      normalizePriceRecord(
        { settlementPoint: "X", deliveryTimestamp: "2026-09-01T00:00:00Z", price: "10", product: "NOPE", sourceTimestamp: PUB },
        SOURCE_SIMULATED
      ).ok
    ).toBe(false);
  });

  it("requires the interval to align to the product's own interval", () => {
    // 15-minute product cannot start at :07
    expect(
      normalizePriceRecord(
        { settlementPoint: "X", deliveryTimestamp: "2026-09-01T14:07:00Z", price: "10", sourceTimestamp: PUB },
        SOURCE_SIMULATED,
        "RTM_15MIN"
      ).ok
    ).toBe(false);
    // hourly product cannot start at :15
    expect(
      normalizePriceRecord(
        { settlementPoint: "X", deliveryTimestamp: "2026-09-01T14:15:00Z", price: "10", sourceTimestamp: PUB },
        SOURCE_SIMULATED,
        "DAM_HOURLY"
      ).ok
    ).toBe(false);
    // ...but a quarter-hour boundary is a valid 15-minute interval start
    expect(
      normalizePriceRecord(
        { settlementPoint: "X", deliveryTimestamp: "2026-09-01T14:15:00Z", price: "10", sourceTimestamp: PUB },
        SOURCE_SIMULATED,
        "RTM_15MIN"
      ).ok
    ).toBe(true);
  });
});

describe("deterministic simulated feed", () => {
  it("produces the same price for the same delivery interval", () => {
    const ts = new Date("2026-09-08T12:00:00Z");
    expect(simulatedPrice(SIMULATED_MARKETS[0], ts, SOURCE_SIMULATED)).toBe(
      simulatedPrice(SIMULATED_MARKETS[0], ts, SOURCE_SIMULATED)
    );
  });

  it("prices the two energy markets separately", () => {
    const ts = new Date("2026-09-08T18:00:00Z");
    const market = SIMULATED_MARKETS[0];
    const da = simulatedPrice(market, ts, SOURCE_SIMULATED, "DAM_HOURLY");
    const rt = simulatedPrice(market, ts, SOURCE_SIMULATED, "RTM_HOURLY");
    expect(da).not.toBe(rt);
  });

  it("derives the hourly real-time price as the average of its four 15-minute intervals", () => {
    const from = new Date("2026-09-08T00:00:00Z");
    const to = new Date("2026-09-08T02:00:00Z");
    const records = generateMarketPrices(
      SIMULATED_MARKETS,
      from,
      to,
      SOURCE_SIMULATED,
      ["RTM_15MIN", "RTM_HOURLY"]
    );
    const hourly = records.filter(
      (r) => r.product === "RTM_HOURLY" && r.settlementPoint === "HB_WEST"
    );
    const quarters = records.filter(
      (r) => r.product === "RTM_15MIN" && r.settlementPoint === "HB_WEST"
    );
    expect(hourly.length).toBe(2);
    expect(quarters.length).toBe(8);

    for (const h of hourly) {
      const start = new Date(h.deliveryTimestamp).getTime();
      const four = quarters.filter((q) => {
        const t = new Date(q.deliveryTimestamp).getTime();
        return t >= start && t < start + 3_600_000;
      });
      expect(four.length).toBe(4);
      const mean = four.reduce((a, q) => a + Number(q.price), 0) / 4;
      expect(Number(h.price)).toBeCloseTo(mean, 3);
    }
  });

  it("stays inside ERCOT's administrative floor and offer caps", () => {
    const from = new Date("2026-09-08T00:00:00Z");
    const to = new Date("2026-09-09T00:00:00Z");
    const records = generateMarketPrices(
      SIMULATED_MARKETS,
      from,
      to,
      SOURCE_SIMULATED,
      ["DAM_HOURLY", "RTM_15MIN", "RTM_HOURLY"]
    );
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      const price = Number(r.price);
      expect(price).toBeGreaterThanOrEqual(RT_PRICE_FLOOR);
      // Extreme congestion can exceed the offer cap, but never the day-ahead
      // cap that stands in for effective VOLL.
      expect(price).toBeLessThanOrEqual(DA_SYSTEM_WIDE_OFFER_CAP);
    }
  });

  it("prices West rich and Houston cheap, per the IMM zone averages", () => {
    const base = new Map(SIMULATED_MARKETS.map((m) => [m.settlementPoint, m.dayBase]));
    expect(base.get("LZ_WEST")!).toBeGreaterThan(base.get("LZ_HOUSTON")!);
    expect(base.get("HB_WEST")!).toBeGreaterThan(base.get("HB_HOUSTON")!);
  });

  it("emits one record per product per interval, with a matching interval end", async () => {
    const src = new SimulatedErcotSource();
    const from = new Date("2026-09-08T10:30:00Z");
    const to = new Date("2026-09-08T14:30:00Z");
    const records = await src.getPrices(from, to);
    expect(records.length).toBe(
      (4 * SIMULATED_MARKETS.length * 2) /* hourly: DAM + RTH */ +
        16 * SIMULATED_MARKETS.length /* quarter-hour RT */
    );
    for (const r of records) {
      const mins = getProduct(r.product)!.intervalMinutes;
      const start = new Date(r.deliveryTimestamp).getTime();
      expect(new Date(r.deliveryEnd).getTime() - start).toBe(mins * 60_000);
      expect(src.sourceName).toBe("SIMULATED (GENERATED)");
      // The generated feed's publication model: each interval publishes
      // exactly 24h before delivery and is final, so re-ingestion is a
      // byte-identical no-op under the observation key.
      expect(new Date(r.publishedAt).getTime()).toBe(start - 24 * 3_600_000);
      expect(r.isFinal).toBe(true);
    }
  });

  it("is reproducible run-to-run (idempotent source)", () => {
    const from = new Date("2026-09-08T00:00:00Z");
    const to = new Date("2026-09-08T03:00:00Z");
    const stripTimestamps = (rows: ReturnType<typeof generateMarketPrices>) =>
      rows.map((row) => ({
        settlementPoint: row.settlementPoint,
        product: row.product,
        deliveryTimestamp: row.deliveryTimestamp,
        price: row.price,
      }));
    const run1 = stripTimestamps(
      generateMarketPrices(SIMULATED_MARKETS, from, to, SOURCE_SIMULATED)
    );
    const run2 = stripTimestamps(
      generateMarketPrices(SIMULATED_MARKETS, from, to, SOURCE_SIMULATED)
    );
    expect(run1).toEqual(run2);
  });
});

describe("ERCOT MIS CSV adapter", () => {
  const fixture =
    "\ufeffExperiment:60-Day RTM SPP Report\n" +
    "Release Time:09/08/2026 15:45:00\n" +
    "DeliveryDate,DeliveryHourEnding,RepeatedHourFlag,SettlementPointType,SettlementPoint,SPP\n" +
    "09/08/2026,1,N,LOAD_ZONE,LZ_HOUSTON,42.01\n" +
    "09/08/2026,2,N,HUB,HB_NORTH,47.3000\n" +
    "09/08/2026,1,Y,LOAD_ZONE,LZ_HOUSTON,41.99\n" +
    "bad,row,here\n" +
    "09/08/2026,25,N,HUB,HB_NORTH,999\n" +
    "DosId,123,456,789\n" +
    "";

  it("parses the SPP CSV, skipping malformed rows", () => {
    const rows = parseErcotSppCsv(fixture);
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({
      deliveryDate: "09/08/2026",
      hourEnding: 1,
      settlementPoint: "LZ_HOUSTON",
      price: "42.01",
    });
    expect(rows[1].settlementPoint).toBe("HB_NORTH");
    expect(rows[2].repeatedHour).toBe(true);
  });

  it("exposes exactly the products ERCOT MIS publishes", async () => {
    // The adapter is constructed directly over the public MIS reports, no
    // gateway, no credentials: DAM clearing (final), rolling RT intervals
    // (interim), the hourly RT settlement series, and the DAM ancillary-
    // service clearing (report NP4-188-CD) for ERCOT's five published types.
    const src = new ErcotMISSource();
    expect(await src.getProducts()).toEqual([
      "DAM_HOURLY",
      "RTM_15MIN",
      "RTM_HOURLY",
      "REGUP",
      "REGDN",
      "RRS",
      "NSPIN",
      "ECRS",
    ]);
    expect(src.sourceName).toBe(SOURCE_ERCOT_MIS);
  });

  it("converts ERCOT Central delivery into UTC (winter offset)", () => {
    // Jan 15 = CST (UTC-6): hour ending 12 → 11:00 Central = 17:00 UTC
    expect(deliveryCentralToUtc("01/15/2026", 12)).toBe("2026-01-15T17:00:00.000Z");
  });

  it("converts ERCOT Central delivery into UTC (summer offset)", () => {
    // Jul 15 = CDT (UTC-5): hour ending 1 → 00:00 Central = 05:00 UTC
    expect(deliveryCentralToUtc("07/15/2026", 1)).toBe("2026-07-15T05:00:00.000Z");
    // Sep 8 (DST still active in 2026) hour ending 14 → 13:00 Central = 18:00 UTC
    expect(deliveryCentralToUtc("09/08/2026", 14)).toBe("2026-09-08T18:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// The two 23/25-hour days. A fixed offset applied to local midnight gets these
// wrong in opposite directions, and both errors were real: the spring day was
// given 24 instants (one of them colliding with the next day) and the fall day's
// extra hour was dropped, losing an hour of settlement every November.
// ---------------------------------------------------------------------------
describe("ERCOT delivery conversion across DST", () => {
  it("spring forward: 23 distinct instants, and the skipped hour has none", () => {
    // 2026: DST begins Sunday 8 March, 02:00 CST = 08:00 UTC.
    const instants = new Set<string>();
    for (let he = 1; he <= 24; he++) {
      const iso = deliveryCentralToUtc("03/08/2026", he);
      if (iso !== null) instants.add(iso);
    }
    expect(instants.size).toBe(23);

    // 00:00 and 01:00 are still CST; the 02:00 hour never happens.
    expect(deliveryCentralToUtc("03/08/2026", 1)).toBe("2026-03-08T06:00:00.000Z");
    expect(deliveryCentralToUtc("03/08/2026", 2)).toBe("2026-03-08T07:00:00.000Z");
    expect(deliveryCentralToUtc("03/08/2026", 3)).toBeNull();
    // 03:00 is CDT, and the day ends at 23:00 CDT = 04:00 UTC on the 9th.
    expect(deliveryCentralToUtc("03/08/2026", 4)).toBe("2026-03-08T08:00:00.000Z");
    expect(deliveryCentralToUtc("03/08/2026", 24)).toBe("2026-03-09T04:00:00.000Z");
  });

  it("fall back: 25 distinct instants, with the repeated hour told apart", () => {
    // 2026: DST ends Sunday 1 November, 02:00 CDT = 07:00 UTC.
    const instants = new Set<string>();
    for (let he = 1; he <= 24; he++) {
      const plain = deliveryCentralToUtc("11/01/2026", he, false);
      const flagged = deliveryCentralToUtc("11/01/2026", he, true);
      if (plain !== null) instants.add(plain);
      if (flagged !== null) instants.add(flagged);
    }
    expect(instants.size).toBe(25);

    // 00:00 is CDT; 01:00 happens twice — 06:00 UTC as CDT, 07:00 UTC as CST.
    expect(deliveryCentralToUtc("11/01/2026", 1, false)).toBe("2026-11-01T05:00:00.000Z");
    expect(deliveryCentralToUtc("11/01/2026", 2, false)).toBe("2026-11-01T06:00:00.000Z");
    expect(deliveryCentralToUtc("11/01/2026", 2, true)).toBe("2026-11-01T07:00:00.000Z");
    // 02:00 exists once, as CST.
    expect(deliveryCentralToUtc("11/01/2026", 3, false)).toBe("2026-11-01T08:00:00.000Z");
    // The flag only changes the one ambiguous hour.
    expect(deliveryCentralToUtc("11/01/2026", 5, true)).toBe(
      deliveryCentralToUtc("11/01/2026", 5, false)
    );
  });

  it("keeps ordinary days at 24 distinct instants", () => {
    for (const day of ["01/15/2026", "07/15/2026", "11/15/2026"]) {
      const instants = new Set<string>();
      for (let he = 1; he <= 24; he++) {
        instants.add(deliveryCentralToUtc(day, he)!);
      }
      expect(instants.size, day).toBe(24);
    }
  });

  it("parses the rolling RT CSV (interval columns, DST flag)", () => {
    // MIS 12301's rolling layout: hour-ending + the 1..4 interval inside it.
    const csv = [
      "DeliveryDate,DeliveryHour,DeliveryInterval,SettlementPointName,SettlementPointType,SettlementPointPrice,DSTFlag",
      "09/08/2026,14,1,HB_NORTH,HUB,47.30,N",
      "09/08/2026,14,3,LZ_HOUSTON,LZ,42.01,N",
      "bad,row,here",
    ].join("\n");
    const rows = parseRtmSppCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      deliveryDate: "09/08/2026",
      hourEnding: 14,
      deliveryInterval: 1,
      settlementPoint: "HB_NORTH",
      price: "47.30",
    });
    expect(rows[1]).toMatchObject({ deliveryInterval: 3, settlementPoint: "LZ_HOUSTON" });
    // Interval 3 of hour ending 14 starts at 13:30 Central = 18:30 UTC (DST).
    const hourStart = deliveryCentralToUtc("09/08/2026", 14)!;
    expect(
      new Date(new Date(hourStart).getTime() + 2 * 15 * 60_000).toISOString()
    ).toBe("2026-09-08T18:30:00.000Z");
  });

  it("dedupes the report's LZ/LZEW double print to one observation", () => {
    // MIS 12301 prints every load zone and DC tie twice per interval — once
    // under the point's own type code (LZ/DC) and once under its EHV variant
    // (LZEW/DCEW), prices within a rounding hair. They are ONE settlement
    // observation; the canonical typed print survives. Hubs print once.
    const csv = [
      "DeliveryDate,DeliveryHour,DeliveryInterval,SettlementPointName,SettlementPointType,SettlementPointPrice,DSTFlag",
      "09/23/2026,17,4,LZ_WEST,LZ,46.25,N",
      "09/23/2026,17,4,LZ_WEST,LZEW,46.25,N",
      "09/23/2026,17,4,LZ_RAYBN,LZEW,62.46,N",
      "09/23/2026,17,4,LZ_RAYBN,LZ,62.45,N",
      "09/23/2026,17,4,HB_NORTH,HUB,47.30,N",
    ].join("\n");
    const rows = parseRtmSppCsv(csv);
    expect(rows).toHaveLength(3); // not 5
    expect(rows.map((r) => [r.settlementPoint, r.settlementPointType, r.price]))
      .toEqual([
        ["LZ_WEST", "LZ", "46.25"],
        ["LZ_RAYBN", "LZ", "62.45"], // canonical LZ row, not the LZEW twin
        ["HB_NORTH", "HUB", "47.30"],
      ]);
  });

  it("parses the daily DAM clearing CSV (its own column layout)", () => {
    // MIS 12331's layout: "HH:00" hour endings, no type column, a DST flag.
    const csv = [
      "DeliveryDate,HourEnding,SettlementPoint,SettlementPointPrice,DSTFlag",
      "09/23/2026,01:00,HB_NORTH, 37.87,N",
      "09/23/2026,24:00,LZ_WEST, 51.02,N",
    ].join("\n");
    const rows = parseDamSppCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      deliveryDate: "09/23/2026",
      hourEnding: 1,
      settlementPoint: "HB_NORTH",
      price: "37.87",
    });
    expect(deliveryCentralToUtc(rows[0].deliveryDate, rows[0].hourEnding)).toBe(
      "2026-09-23T05:00:00.000Z"
    );
  });

  it("pairs MIS listing documents with their download ids and posting stamps", () => {
    // The listing API's exact shape (IceDocListJsonWS): DocID is the download
    // key, ConstructedName carries the cdr posting stamp, PublishDate is
    // ERCOT's own posting instant with offset.
    const payload = {
      ListDocsByRptTypeRes: {
        DocumentList: [
          {
            Document: {
              DocID: "1277731220",
              ConstructedName:
                "cdr.00012301.0000000000000000.20260922.160202477.SPPHLZNP6905_20260922_1600_csv.zip",
              PublishDate: "2026-09-22T16:02:01-05:00",
            },
          },
          { Document: { DocID: "1", ConstructedName: "not-a-cdr-name.zip" } },
          { Document: { ConstructedName: "cdr.00012301.0.20260922.160202477.x.zip" } },
        ],
      },
    };
    const docs = parseMisListingJson(payload);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ doclookupId: "1277731220" });
    expect(docs[0].publishDate).toBe("2026-09-22T16:02:01-05:00");
  });

  it("reads a posting's PublishDate on its own date's offset, not the listing's", () => {
    // NP4-197, posted 15:20:40 CDT on 2026-09-01 (its cdr stamp), ahead of the
    // 16:00 deadline it corrected for. Listed in November it reads -06:00;
    // listed in September the same document read -05:00.
    const filename =
      "cdr.00013045.0000000000000000.20260901.152040763.pricecorrection_RTM_SPP_20260901_to_20260901_NP4197_csv.zip";
    const doc = { doclookupId: "1269374426", filename, publishDate: "2026-09-01T15:20:40-06:00" };
    expect(misPostedAt(doc)?.toISOString()).toBe("2026-09-01T20:20:40.000Z");
    expect(misPostedAt({ ...doc, publishDate: "2026-09-01T15:20:40-05:00" })?.toISOString()).toBe(
      "2026-09-01T20:20:40.000Z"
    );
    // ERCOT posts the DAM at 12:32 wall time either side of the DST change, so
    // a January posting listed in summer must not move an hour earlier.
    expect(
      misPostedAt({
        doclookupId: "1",
        filename: "cdr.00012331.0000000000000000.20260115.123246075.DAMSPNP4190_csv.zip",
        publishDate: "2026-01-15T12:32:45-05:00",
      })?.toISOString()
    ).toBe("2026-01-15T18:32:45.000Z");
    // Without a PublishDate, the cdr stamp.
    expect(misPostedAt({ doclookupId: "1", filename })?.toISOString()).toBe(
      "2026-09-01T20:20:40.000Z"
    );
  });

  it("parses the MIS listing PAGE (scrape), pairing filenames with download links", () => {
    // The website table pairs each document's cdr filename with its
    // mirDownload link by proximity: every link after a filename and before
    // the next filename belongs to it. XML/CSV rows alternate but each
    // carries exactly one link, so the pairs stay intact. No posting stamp
    // exists on the page — scraped docs date from the cdr name.
    const html = [
      // an orphan link before any filename belongs to nothing
      "<a href='/misdownload/servlets/mirDownload?doclookupId=999'>zip</a>",
      "<td class='labelOptional_ind'>cdr.00012301.0000000000000000.20260924.103202202.SPPHLZNP6905_20260924_1030_csv.zip</td>",
      "<a href='/misdownload/servlets/mirDownload?mimic_duns=000000000&doclookupId=1278443703'>zip</a>",
      "<td class='labelOptional_ind'>cdr.00012301.0000000000000000.20260924.103202106.SPPHLZNP6905_20260924_1030_xml.zip</td>",
      "<a href='/misdownload/servlets/mirDownload?mimic_duns=000000000&doclookupId=1278443702'>zip</a>",
      // a different report's document pairs within its own row, not against
      // the previous filename's slot
      "<td class='labelOptional_ind'>cdr.00012331.0000000000000000.20260924.123501123.DAMSPNP4190_csv.zip</td>",
      "<a href='/misdownload/servlets/mirDownload?doclookupId=555'>zip</a>",
      // a trailing filename with no link is dropped rather than left dangling
      "<td class='labelOptional_ind'>cdr.00012301.0000000000000000.20260924.104701111.SPPHLZNP6905_20260924_1045_csv.zip</td>",
    ].join("\n");
    const docs = parseMisListingPage(html);
    expect(docs).toHaveLength(3); // orphan and trailing filename excluded
    expect(docs[0]).toEqual({
      doclookupId: "1278443703",
      filename: "cdr.00012301.0000000000000000.20260924.103202202.SPPHLZNP6905_20260924_1030_csv.zip",
    });
    expect(docs[1].doclookupId).toBe("1278443702");
    expect(docs[2].doclookupId).toBe("555"); // the DAM doc, from its own row
    expect(docs[2].filename).toContain("DAMSPNP4190");
    expect(docs.every((d) => d.publishDate === undefined)).toBe(true);
  });

  it("prefers the JSON API and falls back to the website listing page", async () => {
    // Measured on 2026-09-24: the API surfaced two consecutive RT postings
    // 23s and 35s before the page did, and costs ~30ms of JSON vs ~2s of
    // 600KB HTML — so the API goes first; the page is the fallback for the
    // day that ordering reverses or the API fails.
    const pageDoc = {
      doclookupId: "1278443703",
      filename: "cdr.00012301.0000000000000000.20260924.103202202.SPPHLZNP6905_20260924_1030_csv.zip",
    };
    const apiDoc = { ...pageDoc, publishDate: "2026-09-24T10:32:01-05:00" };

    const fetchMockFallback = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("IceDocListJsonWS")) return new Response("boom", { status: 503 });
      return new Response(
        `<td>cdr.00012301.0000000000000000.20260924.103202202.SPPHLZNP6905_20260924_1030_csv.zip</td>
         <a href="mirDownload?doclookupId=1278443703">zip</a>`,
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMockFallback);
    expect(await listMisDocs(12301)).toEqual([pageDoc]);

    // API healthy → page never called.
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("IceDocListJsonWS")) {
        return Response.json({
          ListDocsByRptTypeRes: {
            DocumentList: [
              { Document: { DocID: "1278443703", ConstructedName: pageDoc.filename, PublishDate: "2026-09-24T10:32:01-05:00" } },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await listMisDocs(12301)).toEqual([apiDoc]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // page never called
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe("truncateToHour", () => {
  it("floors minutes/seconds to an hour boundary", () => {
    const d = truncateToHour(new Date("2026-09-08T11:37:22Z"));
    expect(d.toISOString()).toBe("2026-09-08T11:00:00.000Z");
  });
});

describe("location universe", () => {
  it("covers hubs, hub averages, competitive and NOIE zones, and resource nodes", () => {
    const points = new Set(SIMULATED_MARKETS.map((m) => m.settlementPoint));
    for (const p of HUBS) expect(points.has(p)).toBe(true);
    for (const p of HUB_AVERAGES) expect(points.has(p)).toBe(true);
    for (const p of LOAD_ZONES) expect(points.has(p)).toBe(true);

    for (const p of NOIE_LOAD_ZONES) {
      expect(points.has(p)).toBe(true);
      expect(byPoint(p).settlementPointType).toBe("LOAD_ZONE");
    }

    const nodes = SIMULATED_MARKETS.filter(
      (m) => m.settlementPointType === "RESOURCE_NODE"
    );
    expect(nodes.length).toBeGreaterThan(0);
    expect(byPoint("HB_PAN").description).toContain("Panhandle");
  });

  it("derives the hub average from the four regional hubs, excluding Panhandle", () => {
    const ts = new Date("2026-09-08T18:00:00Z");
    const mean =
      REGIONAL_HUBS.reduce(
        (a, p) => a + Number(simulatedPrice(byPoint(p), ts, SOURCE_SIMULATED)),
        0
      ) / REGIONAL_HUBS.length;
    const hubAvg = Number(
      simulatedPrice(byPoint("HB_HUBAVG"), ts, SOURCE_SIMULATED)
    );
    expect(hubAvg).toBeCloseTo(mean, 3);
    expect(hubAvg).not.toBeCloseTo(
      Number(simulatedPrice(byPoint("HB_PAN"), ts, SOURCE_SIMULATED)),
      3
    );
  });

  it("prices resource nodes around their zone rather than on it", () => {
    const zone = byPoint("LZ_WEST");
    const nodes = SIMULATED_MARKETS.filter(
      (m) => m.settlementPointType === "RESOURCE_NODE" && m.settlementPoint.startsWith("RN_WEST_")
    );
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.some((n) => n.dayBase !== zone.dayBase)).toBe(true);
  });
});

describe("instrument catalog", () => {
  it("covers ERCOT-cleared and OTC instruments", () => {
    const codes = INSTRUMENTS.map((i) => i.code);
    for (const expected of [
      "ENERGY_SPOT",
      "VIRTUAL",
      "DART_SPREAD",
      "BASIS_SPREAD",
      "PTP_OBLIGATION",
      "PTP_OPTION",
      "AS_CAPACITY",
      "CRR_OBLIGATION",
      "CRR_OPTION",
      "BLOCK_FORWARD",
      "INDEX_SWAP",
      "PRICE_OPTION",
    ]) {
      expect(codes).toContain(expected);
    }
  });

  it("keeps leg count coherent with the settlement rule", () => {
    for (const i of INSTRUMENTS) {
      if (i.kind === "VIRTUAL") expect(i.legs).toBe(0);
      if (i.settlementRule === "DIFFERENCE") expect(i.legs).toBe(2);
      if (i.settlementRule === "CONVERGENCE") expect(i.legs).toBeLessThanOrEqual(1);
      if (i.settlementRule === "CONGESTION_CONVERGENCE") expect(i.legs).toBe(2);
      if (i.settlementRule === "POINT") expect(i.legs).toBe(1);
      // A path instrument has two legs and therefore needs its counter point;
      // a legless or single-leg one must not ask for one, or the ticket would
      // demand a parameter that does not price it.
      expect(needsCounterPoint(i.settlementRule), i.code).toBe(i.legs === 2);
    }
  });

  it("gives OTC instruments a venue but no invented ERCOT price series", () => {
    const otc = INSTRUMENTS.filter((i) => i.venue === "OTC");
    expect(otc.length).toBeGreaterThan(0);
    // OTC settles against ERCOT indices, so it reuses a product series.
    for (const i of otc) expect(i.productFromTrade).toBe(true);
  });

  it("separates the day-ahead PTP pair from the auctioned CRRs", () => {
    // Two different ERCOT congestion products, and the rule is what tells them
    // apart: a CRR settles on day-ahead congestion (Nodal Protocols 7.9.1.1),
    // while a day-ahead PTP instrument is bought at the day-ahead spread and
    // settled at the real-time one. If they shared a rule the desk could not
    // represent the day-ahead market product at all.
    for (const code of ["PTP_OBLIGATION", "PTP_OPTION"]) {
      const i = getInstrument(code)!;
      expect(i.settlementRule, code).toBe("CONGESTION_CONVERGENCE");
      expect(needsCounterPoint(i.settlementRule), code).toBe(true);
      expect(needsBothMarkets(i.settlementRule), code).toBe(true);
    }
    for (const code of ["CRR_OBLIGATION", "CRR_OPTION"]) {
      const i = getInstrument(code)!;
      expect(i.settlementRule, code).toBe("DIFFERENCE");
      expect(needsCounterPoint(i.settlementRule), code).toBe(true);
      // A CRR needs no real-time prices, which is exactly what separates it
      // from the day-ahead PTP instrument on the same path.
      expect(needsBothMarkets(i.settlementRule), code).toBe(false);
    }
  });

  it("opens only the instruments a participant with no assets can hold", () => {
    // Everything purely financial is tradeable; ancillary-service capacity is
    // not, because supplying one needs a qualified resource. This set is the
    // completeness boundary for a no-asset desk, so it is asserted rather than
    // assumed — a new instrument has to be added here deliberately.
    const expected = [
      "BASIS_SPREAD",
      "BLOCK_FORWARD",
      "CRR_OBLIGATION",
      "CRR_OPTION",
      "DART_SPREAD",
      "ENERGY_SPOT",
      "INDEX_SWAP",
      "PRICE_OPTION",
      "PTP_OBLIGATION",
      "VIRTUAL",
    ];
    expect(tradableInstruments().map((i) => i.code).sort()).toEqual(expected);
    expect(getInstrument("AS_CAPACITY")?.tradable).toBe(false);
    // NOIE-only in ERCOT's DAM, and a free option at a $0 entry (0039).
    expect(getInstrument("PTP_OPTION")?.tradable).toBe(false);
  });

  it("offers on the desk only bids that settle against real time", () => {
    // Every desk instrument enters at the day-ahead clearing and settles in
    // real time; anything settling on its own entry price can only make $0.
    expect(deskInstruments().map((i) => i.code)).toEqual(["VIRTUAL", "PTP_OBLIGATION"]);
    for (const i of deskInstruments()) {
      expect(["CONVERGENCE", "CONGESTION_CONVERGENCE"]).toContain(i.settlementRule);
      expect(i.tradable).toBe(true);
    }
  });
});

