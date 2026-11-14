import { requireUser } from "@/lib/auth";
import { getAnalytics, SHARPE_MIN_DAYS } from "@/lib/analytics";
import { AnalyticsCharts } from "./analytics-charts";
import { usd, sign, signedUsd, bpsToPercent, num, volumeUnitLabel, signTone } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { parseDec } from "@/lib/money";
import { Stat } from "@/components/ui/stat";

export const dynamic = "force-dynamic";

const absDec = (v: string): bigint => {
  const n = parseDec(v);
  return n < 0n ? -n : n;
};

const toneOf = (v: string): "pos" | "neg" | undefined => {
  const n = parseFloat(v);
  return n > 0 ? "pos" : n < 0 ? "neg" : undefined;
};

export default async function AnalyticsPage() {
  const user = await requireUser();
  const a = await getAnalytics(user.id);
  // Per-trade figures describe closed trades; with none, there is no figure.
  const perTrade = (v: string) =>
    a.closedTrades === 0 ? { value: "—" } : { value: signedUsd(v), tone: toneOf(v) };

  const kpis: Array<{
    label: string;
    value: string;
    tone?: "pos" | "neg";
    note?: string;
  }> = [
    { label: "Equity", value: usd(a.currentEquity) },
    {
      label: "Return",
      value: bpsToPercent(a.returnBps),
      tone: signTone(Math.round(a.returnBps)),
    },
    {
      label: "Realized P&L",
      value: signedUsd(a.realizedPnl),
      tone: toneOf(a.realizedPnl),
    },
    {
      label: "Unrealized",
      value: signedUsd(a.unrealizedPnl),
      tone: toneOf(a.unrealizedPnl),
    },
    { label: "Closed trades", value: String(a.closedTrades), note: `of ${a.totalTrades} fills` },
    { label: "Win rate", value: a.winRatePercent == null ? "—" : `${a.winRatePercent}%` },
    { label: "Avg trade P&L", ...perTrade(a.avgTradePnl) },
    // Coloured by the figure's own sign: a profitable worst trade is still a
    // profit, and a zero drawdown is not a loss.
    { label: "Best trade", ...perTrade(a.bestTradePnl) },
    { label: "Worst trade", ...perTrade(a.worstTradePnl) },
    {
      label: "Max drawdown",
      // Stored as a magnitude; shown as the loss it is from the peak.
      value: signedUsd(-absDec(a.maxDrawdown)),
      tone: parseFloat(a.maxDrawdown) !== 0 ? "neg" : undefined,
    },
  ];

  // Volume is reported per unit: energy traded in MWh and capacity in MW are
  // different dimensions, so they get their own readouts rather than one total.
  for (const v of a.volumes) {
    kpis.push({
      label: `Volume · ${volumeUnitLabel(v.unit)}`,
      value: `${num(v.long)} / ${num(v.short)}`,
      note: "long / short",
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Performance"
        title="Analytics"
        aside={<span className="badge badge-neutral">{a.totalTrades} fills</span>}
      >
        How your trading has gone, worked out from every fill and settlement:
        which side, which hubs and which hours made you money.
      </PageHeader>

      <div className="stat-grid grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {kpis.map((k, i) => (
          <Stat
            key={k.label}
            label={k.label}
            value={k.value}
            tone={k.tone}
            note={k.note}
            delay={i * 30}
          />
        ))}
      </div>

      <AnalyticsCharts pnlByDay={a.pnlByDay} pnlByMarket={a.pnlByMarket} />

      {/* How a DART desk is judged: spread captured per MWh, by side, by hour. */}
      <section className="card">
        <h2 className="card-title">Desk performance</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
          <div>
            <p className="caption t-mute">P&amp;L per settled MWh</p>
            <p className="mono">{a.desk.pnlPerMwh == null ? "—" : signedUsd(a.desk.pnlPerMwh)}</p>
          </div>
          <div>
            <p className="caption t-mute">DEC P&amp;L</p>
            <p className={`mono ${signTone(a.desk.decPnl) ?? ""}`}>{signedUsd(a.desk.decPnl)}</p>
          </div>
          <div>
            <p className="caption t-mute">INC P&amp;L</p>
            <p className={`mono ${signTone(a.desk.incPnl) ?? ""}`}>{signedUsd(a.desk.incPnl)}</p>
          </div>
          <div>
            <p className="caption t-mute">Sharpe (daily, annualized)</p>
            {a.desk.sharpe != null ? (
              <p className="mono">{a.desk.sharpe.toFixed(2)}</p>
            ) : (
              <p className="t-mute" title="Under a month of daily P&L, a Sharpe ratio is mostly noise">
                After {SHARPE_MIN_DAYS} trading days ({a.desk.sharpeDays} so far)
              </p>
            )}
          </div>
        </div>
        {/* Settled P&L by hour ending: where in the day the desk makes and
            loses its money, one cell per hour it traded. */}
        {a.desk.pnlByHour.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-center text-[11px]" aria-label="Settled P&L by hour ending">
              <thead>
                <tr>
                  {a.desk.pnlByHour.map((h) => (
                    <th key={h.he} scope="col" className="caption px-1 pb-1 font-normal">
                      HE{h.he}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {a.desk.pnlByHour.map((h) => (
                    <td key={h.he} className={`mono border border-white/5 px-1.5 py-1.5 whitespace-nowrap ${signTone(h.pnl) ?? "t-mute"}`}>
                      {sign(h.pnl, 0)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] t-mute">
          {num(a.desk.settledMwh)} MWh settled. A DEC earns when real time clears above day-ahead, an INC
          when it clears below.
        </p>
      </section>
    </div>
  );
}
