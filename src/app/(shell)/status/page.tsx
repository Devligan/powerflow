import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Lamp } from "@/components/ui/lamp";
import { Stat } from "@/components/ui/stat";
import { loadSystemStatus, type SystemStatus } from "@/lib/system-status";
import { getViewerTimeZone } from "@/lib/time-zone-server";
import { briefDateTime } from "@/lib/time";
import { timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "System status — PowerFlow",
  description:
    "Live health of PowerFlow: ERCOT data freshness, the ingestion pipeline, and the hourly reconciliation that proves every account's books balance.",
};

/** Same thresholds the Production workflow fails on (scripts/smoke-production.mjs). */
const MAX_RUN_AGE_MIN = 45;
const MAX_RT_PUBLISH_AGE_MIN = 90;
const MAX_STORAGE_PERCENT = 80;

const SERIES: Array<{ product: keyof SystemStatus["newestByProduct"]; label: string; cadence: string }> = [
  { product: "RTM_15MIN", label: "Real-time, 15-minute", cadence: "Posted ~15 min after each interval" },
  { product: "RTM_HOURLY", label: "Real-time, hourly", cadence: "Once all four intervals are in" },
  { product: "DAM_HOURLY", label: "Day-ahead clearing", cadence: "Daily, ~13:30 Central for tomorrow" },
];

const minutesSince = (iso: string | null | undefined) => (iso ? (Date.now() - Date.parse(iso)) / 60_000 : Infinity);

type Health = "ok" | "warn" | "down";

function Badge({ health, children }: { health: Health; children: React.ReactNode }) {
  const tone = health === "ok" ? "badge-green" : health === "warn" ? "badge-amber" : "badge-red";
  return (
    <span className={`badge ${tone}`}>
      <Lamp pulse={health === "ok"} />
      {children}
    </span>
  );
}

export default async function StatusPage() {
  const [{ tz }, status] = await Promise.all([
    getViewerTimeZone(),
    loadSystemStatus().catch(() => null),
  ]);

  if (!status) {
    return (
      <div className="space-y-6">
        <PageHeader kicker="System status" title="Status is unavailable" aside={<Badge health="down">Unreachable</Badge>}>
          The status store could not be read just now. The six-hourly production check will flag it if this persists.
        </PageHeader>
      </div>
    );
  }

  const run = status.latestRuns[0];
  const ingestHealthy = run?.status === "SUCCESS" && minutesSince(run.started_at) <= MAX_RUN_AGE_MIN;
  const rt = status.newestByProduct.RTM_15MIN;
  const rtFresh = minutesSince(rt?.publishedAt) <= MAX_RT_PUBLISH_AGE_MIN;
  const ledger = status.ledger;
  const ledgerHealthy = ledger != null && ledger.ok && !ledger.stale;
  const storageOk = status.storage != null && status.storage.percentOfFreeTier < MAX_STORAGE_PERCENT;

  const overall: Health =
    !ledgerHealthy ? "down" : ingestHealthy && rtFresh && storageOk ? "ok" : "warn";

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="System status"
        title={overall === "ok" ? "All systems normal" : overall === "warn" ? "Degraded" : "Attention needed"}
        aside={<Badge health={overall}>{overall === "ok" ? "Operational" : overall === "warn" ? "Degraded" : "Failing"}</Badge>}
      >
        What the platform checks about itself, live. ERCOT prices arrive through a Postgres-scheduled pipeline every
        15 minutes, and every hour the database reconciles every account&apos;s books against its fills. A GitHub
        Actions workflow fails on the same thresholds after each deploy and every six hours.
      </PageHeader>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Last ingestion"
          value={run ? timeAgo(run.started_at) : "never"}
          note={run ? `${run.status.toLowerCase()} · ${run.records_inserted.toLocaleString("en-US")} rows written` : undefined}
        />
        <Stat
          label="Newest real-time print"
          value={rt ? timeAgo(rt.publishedAt) : "none"}
          note={rt ? `interval ${briefDateTime(rt.deliveryTimestamp, tz)}` : undefined}
        />
        <Stat
          label="Books reconciled"
          value={ledger ? timeAgo(ledger.checkedAt) : "not yet"}
          note={
            ledger
              ? `${ledger.trades.toLocaleString("en-US")} fills · ${ledger.accounts.toLocaleString("en-US")} accounts · ${ledger.durationMs} ms`
              : undefined
          }
        />
        <Stat
          label="Database"
          value={status.storage ? `${status.storage.percentOfFreeTier}%` : "unknown"}
          note={`of the free tier · alarm at ${MAX_STORAGE_PERCENT}%`}
        />
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title">Ledger reconciliation</h2>
          {ledger ? (
            <Badge health={ledgerHealthy ? "ok" : "down"}>
              {ledger.stale ? "Overdue" : ledger.ok ? "Balanced" : "Out of balance"}
            </Badge>
          ) : (
            <Badge health="warn">Awaiting first run</Badge>
          )}
        </div>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed t-dim">
          Money only moves inside a few audited database functions, and each is pinned by tests. This checks the result
          as a whole: one read-only SQL statement over a single snapshot, run by <span className="mono">pg_cron</span>{" "}
          at :40 every hour, after the settlement sweep. Every engine test runs it too, before tearing down its
          accounts.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Invariant</th>
                <th scope="col">What must hold</th>
                <th scope="col" className="text-right">
                  Violations
                </th>
              </tr>
            </thead>
            <tbody>
              {(ledger?.checks ?? []).map((c) => (
                <tr key={c.check}>
                  <td className="whitespace-nowrap font-medium">{c.label}</td>
                  <td className="t-dim">{c.proves}</td>
                  <td className={`mono text-right ${c.violations === 0 ? "pos" : "neg"}`}>
                    {c.violations ?? "not run"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ledger && (
          <p className="hint mt-2">
            Last run {briefDateTime(ledger.checkedAt, tz)}. Compared exactly, at the app&apos;s money scale of a
            millionth of a dollar.
          </p>
        )}
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title">ERCOT market data</h2>
          <Badge health={ingestHealthy && rtFresh ? "ok" : "warn"}>
            {status.mode === "ERCOT_LIVE" ? "Live ERCOT MIS" : status.mode}
          </Badge>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Series</th>
                <th scope="col">Newest interval</th>
                <th scope="col">Posted</th>
                <th scope="col">Cadence</th>
              </tr>
            </thead>
            <tbody>
              {SERIES.map((s) => {
                const newest = status.newestByProduct[s.product];
                return (
                  <tr key={s.product}>
                    <td className="whitespace-nowrap font-medium">{s.label}</td>
                    <td className="mono whitespace-nowrap">
                      {newest ? briefDateTime(newest.deliveryTimestamp, tz) : "—"}
                    </td>
                    <td className="whitespace-nowrap">{newest ? timeAgo(newest.publishedAt) : "—"}</td>
                    <td className="t-dim">{s.cadence}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h3 className="caption mt-5">Recent ingestion runs</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Result</th>
                <th scope="col" className="text-right">
                  Received
                </th>
                <th scope="col" className="text-right">
                  Written
                </th>
                <th scope="col" className="text-right">
                  Took
                </th>
              </tr>
            </thead>
            <tbody>
              {status.latestRuns.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{briefDateTime(r.started_at, tz)}</td>
                  <td className={r.status === "SUCCESS" ? "pos" : r.status === "FAILED" ? "neg" : "t-dim"}>
                    {r.status.toLowerCase()}
                  </td>
                  <td className="mono text-right">{r.records_received.toLocaleString("en-US")}</td>
                  <td className="mono text-right">{r.records_inserted.toLocaleString("en-US")}</td>
                  <td className="mono text-right">
                    {r.finished_at
                      ? `${((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000).toFixed(1)} s`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="hint">
        Machine-readable: <Link href="/api/market-data/status" className="underline">/api/market-data/status</Link>.
        How the engine works: <Link href="/learn" className="underline">How it works</Link>.
      </p>
    </div>
  );
}
