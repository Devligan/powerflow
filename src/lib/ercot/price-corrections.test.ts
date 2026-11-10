import { afterEach, describe, expect, it, vi } from "vitest";
import { ErcotMISSource, parseRtmPriceCorrectionCsv } from "@/lib/ercot/mis";

/**
 * Rows from ERCOT's NP4-197 file posted 2026-09-01 15:20 Central
 * (pricecorrection_RTM_SPP_20260901_to_20260901_NP4197), plus the shapes the
 * survey of every listed file turned up.
 */
const CSV = [
  "DeliveryDate,DeliveryHour,DeliveryInterval,SettlementPointName,SettlementPointType,SPPOriginal,SPPCorrected,PriceCorrectionTime,DSTFlag",
  "08/30/2026,10,1,HB_HOUSTON,HU,15.7,15.68,09/01/2026 16:00:00,N",
  "08/30/2026,10,2,HB_HOUSTON,HU,15.6,15.71,09/01/2026 16:00:00,N",
  "08/30/2026,10,1,LZ_HOUSTON,LZEW,15.74,15.69,09/01/2026 16:00:00,N",
  "08/30/2026,10,1,LZ_HOUSTON,LZ,15.74,15.69,09/01/2026 16:00:00,N",
  // Only the energy-weighted twin changed here: the LZ print stands.
  "08/30/2026,10,3,LZ_HOUSTON,LZEW,16.24,16.25,09/01/2026 16:00:00,N",
  "08/30/2026,10,1,7RNCHSLR_ALL,RN,15.64,15.68,09/01/2026 16:00:00,N",
  "08/30/2026,10,1,HB_BUSAVG,SH,15.66,-0.5,09/01/2026 16:00:00,N",
  "",
].join("\r\n");

describe("parseRtmPriceCorrectionCsv", () => {
  const rows = parseRtmPriceCorrectionCsv(CSV);
  const find = (point: string, interval: number) =>
    rows.find((r) => r.settlementPoint === point && r.deliveryInterval === interval);

  it("reads the corrected price, not the original", () => {
    expect(find("HB_HOUSTON", 1)).toMatchObject({
      deliveryDate: "08/30/2026",
      hourEnding: 10,
      original: "15.7",
      corrected: "15.68",
      dstFlag: false,
    });
    expect(find("HB_BUSAVG", 1)?.corrected).toBe("-0.5");
  });

  it("keeps the canonical load-zone print and never stands in its EHV twin", () => {
    expect(find("LZ_HOUSTON", 1)?.settlementPointType).toBe("LZ");
    expect(rows.filter((r) => r.settlementPoint === "LZ_HOUSTON")).toHaveLength(1);
    expect(find("LZ_HOUSTON", 3)).toBeUndefined();
  });

  it("leaves the choice of points to the caller", () => {
    expect(find("7RNCHSLR_ALL", 1)?.corrected).toBe("15.68");
  });

  it("refuses a file whose columns it does not know", () => {
    expect(() =>
      parseRtmPriceCorrectionCsv("DeliveryDate,HourEnding,SettlementPoint,Price\n08/30/2026,10,HB_NORTH,1")
    ).toThrow(/unexpected header/);
  });
});

const SEP1 =
  "cdr.00013045.0000000000000000.20260901.152040763.pricecorrection_RTM_SPP_20260901_to_20260901_NP4197_csv.zip";

describe("listRtmPriceCorrections", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the SPP CSVs, oldest posting first", async () => {
    const entry = (DocID: string, ConstructedName: string, PublishDate: string) => ({
      Document: { DocID, ConstructedName, PublishDate },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ListDocsByRptTypeRes: {
            DocumentList: [
              entry("4", SEP1.replace("SPP_", "SPLMP_"), "2026-09-01T15:00:28-06:00"),
              entry("3", SEP1.replace("_csv", "_xml"), "2026-09-01T15:20:40-06:00"),
              entry("2", SEP1, "2026-09-01T15:20:40-06:00"),
              entry(
                "1",
                "cdr.00013045.0000000000000000.20260714.143049000.pricecorrection_RTM_SPP_20260110_to_20260110_NP4197_csv.zip",
                "2026-07-14T14:30:49-06:00"
              ),
            ],
          },
        })
      )
    );
    expect(await new ErcotMISSource().listRtmPriceCorrections()).toEqual([
      { docId: "1", postedAt: "2026-07-14T19:30:49.000Z" },
      { docId: "2", postedAt: "2026-09-01T20:20:40.000Z" },
    ]);
  });
});
