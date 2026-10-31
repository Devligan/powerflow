import { requireUser } from "@/lib/auth";
import { getAnalytics } from "@/lib/analytics";
import { AnalyticsCharts } from "./analytics-charts";
import { usd, sign, bpsToPercent, num, volumeUnitLabel } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";

export const dynamic = "force-dynamic";

const toneOf = (v: string): "pos" | "neg" | undefined => {
  const n = parseFloat(v);
  return n > 0 ? "pos" : n < 0 ? "neg" : undefined;
};

export default async function AnalyticsPage() {
  const user = await requireUser();
  const a = await getAnalytics(user.id);

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
      tone: a.returnBps >= 0 ? "pos" : "neg",
    },
    {
      label: "Realized P&L",
      value: sign(a.realizedPnl),
      tone: toneOf(a.realizedPnl),
    },
    {
      label: "Unrealized",
      value: sign(a.unrealizedPnl),
      tone: toneOf(a.unrealizedPnl),
    },
    { label: "Executed trades", value: String(a.totalTrades) },
    { label: "Win rate", value: a.winRatePercent == null ? "—" : `${a.winRatePercent}%` },
    {
      label: "Avg trade P&L",
      value: sign(a.avgTradePnl),
      tone: toneOf(a.avgTradePnl),
    },
    // Coloured by the figure's own sign: a profitable worst trade is still a
    // profit, and a zero drawdown is not a loss.
    { label: "Best trade", value: sign(a.bestTradePnl), tone: toneOf(a.bestTradePnl) },
    { label: "Worst trade", value: sign(a.worstTradePnl), tone: toneOf(a.worstTradePnl) },
    {
      label: "Max drawdown",
      value: sign(a.maxDrawdown),
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
        aside={<span className="badge badge-neutral">{a.totalTrades} trades</span>}
      >
        Derived exclusively from reconciled, immutable trades. Nothing here is
        carried forward from a running total.
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
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
    </div>
  );
}
