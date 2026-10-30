import Link from "next/link";
import { listMarkets } from "@/lib/markets";
import { usd, signedUsd, timeAgo, sourceInfo } from "@/lib/format";
import { parseDec } from "@/lib/money";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { getSimClock } from "@/lib/sim-clock";

export const dynamic = "force-dynamic";

export default async function MarketsPage() {
  const user = await requireUser();
  const clock = await getSimClock(user.id).catch(() => null);
  const asOf = clock && clock.mode === "REPLAY" ? new Date(clock.now) : null;
  const markets = await listMarkets(asOf).catch(() => []);
  type Market = (typeof markets)[number];
  const rtHour = markets.find((m) => m.deliveryTimestamp)?.deliveryTimestamp ?? null;

  function table(title: string, note: string, rows: Market[]) {
    return (
      <section className="card p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 px-4 py-3">
          <h2 className="card-title mb-0">{title}</h2>
          <span className="caption">
            {rows.length} point{rows.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Settlement point</th>
                <th>Name</th>
                <th className="text-right">Real time</th>
                <th className="text-right">Day-ahead</th>
                <th className="text-right">DART</th>
                <th className="text-right">DA next day avg</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m: Market) => {
                const sr = sourceInfo(m.source);
                const dart =
                  m.price != null && m.dayAheadPrice != null
                    ? parseDec(m.price) - parseDec(m.dayAheadPrice)
                    : null;
                return (
                  <tr key={m.settlementPoint}>
                    <td className="mono font-medium">{m.settlementPoint}</td>
                    <td className="t-dim">{m.description}</td>
                    <td className="mono text-right">
                      {m.price != null ? usd(m.price) : "—"}
                    </td>
                    <td className="mono text-right t-dim">
                      {m.dayAheadPrice != null ? usd(m.dayAheadPrice) : "—"}
                    </td>
                    <td
                      className={`mono text-right ${dart == null ? "t-mute" : dart > 0n ? "pos" : dart < 0n ? "neg" : ""}`}
                    >
                      {dart == null ? "—" : signedUsd(dart)}
                    </td>
                    <td className="mono text-right">
                      {m.dayAheadNextDayAvg != null ? usd(m.dayAheadNextDayAvg) : "—"}
                    </td>
                    <td>
                      <span
                        className={
                          sr.tone === "live"
                            ? "badge badge-green"
                            : sr.tone === "sim"
                              ? "badge badge-amber"
                              : "badge badge-neutral"
                        }
                      >
                        {sr.label}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/markets/${m.settlementPoint}`}
                        className="caption t-accent hover:underline"
                      >
                        Trade →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="caption border-t border-white/10 px-4 py-2.5">{note}</p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Market data"
        title="Settlement points"
        aside={(
          <>
            <span className="badge badge-neutral">{markets.length} active</span>
            <Link href="/positions" className="btn btn-sm">
              Positions
            </Link>
          </>
        )}
      >
        ERCOT trading hubs and load zones, priced from ERCOT&apos;s own MIS
        reports at the desk&apos;s simulation clock. Real time is the settled
        hourly price
        {rtHour ? <> for the hour that ended {timeAgo(new Date(Date.parse(rtHour) + 3600_000).toISOString())}</> : null};
        day-ahead is the clearing for that same hour, and DART is the gap
        between them — what a virtual or DART spread settles on. When the grid
        is unconstrained every point clears at one price; the day-ahead column
        still shows where congestion was expected.
      </PageHeader>

      {table(
        "Trading hubs",
        "Hubs are the liquid reference points and the cleaner leg of a basis trade.",
        markets.filter((m) => m.type === "HUB")
      )}
      {table(
        "Load zones",
        "Zonal products carry local congestion, so they trade at a basis to the hub.",
        markets.filter((m) => m.type === "LOAD_ZONE")
      )}
    </div>
  );
}