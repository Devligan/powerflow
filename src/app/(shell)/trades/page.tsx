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
        Every fill and settlement on your book, newest first. Fills can only be
        added, never edited, and each one carries the P&amp;L it realized.
      </PageHeader>
      <TradesTable />
    </div>
  );
}
