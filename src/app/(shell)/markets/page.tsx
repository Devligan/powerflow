import Link from "next/link";
import { listMarkets } from "@/lib/markets";
import { usd, timeAgo, sourceInfo } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default async function MarketsPage() {
  const markets = await listMarkets().catch(() => []);
  const hubs = markets.filter((m) => m.type === "HUB");
  const zones = markets.filter((m) => m.type === "LOAD_ZONE");

  function table(title: string, note: string, rows: typeof markets) {
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
                <th>Description</th>
                <th className="text-right">Last price</th>
                <th className="text-right">As of</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const sr = sourceInfo(m.source);
                return (
                  <tr key={m.id}>
                    <td className="mono font-medium">{m.settlementPoint}</td>
                    <td className="t-dim">{m.description}</td>
                    <td className="mono text-right">
                      {m.price != null ? usd(m.price) : "—"}
                    </td>
                    <td className="mono text-right t-mute">
                      {m.deliveryTimestamp ? timeAgo(m.deliveryTimestamp) : "—"}
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
        aside={
          <>
            <span className="badge badge-neutral">{markets.length} active</span>
            <Link href="/positions" className="btn btn-sm">
              Positions
            </Link>
          </>
        }
      >
        ERCOT trading hubs and load zones. Prices come from a deterministic
        simulated generator and are labelled as such on every row.
      </PageHeader>

      {table(
        "Trading hubs",
        "Hubs are the liquid reference points and the cleaner leg of a basis trade.",
        hubs
      )}
      {table(
        "Load zones",
        "Zonal products carry local congestion, so they trade at a basis to the hub.",
        zones
      )}
    </div>
  );
}
