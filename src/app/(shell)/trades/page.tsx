import { TradesTable } from "./trades-table";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default function TradesPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        kicker="Blotter"
        title="Executed trades"
        aside={<span className="badge badge-neutral">Append-only</span>}
      >
        Every executed paper trade is immutable and audited. P&amp;L is
        attributed per trade by replaying the blotter through the same engine
        that filled it.
      </PageHeader>
      <TradesTable />
    </div>
  );
}
