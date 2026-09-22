import {
  instrumentInfo,
  legsLabel,
  num,
  positionUnit,
  sign,
  usd,
  volumeUnitLabel,
} from "@/lib/format";
import type { InstrumentBreakdown } from "@/lib/trading/accounting";
import type { PositionView } from "@/lib/queries";

/**
 * The book broken out by instrument.
 *
 * An instrument is the unit a position is actually held in, so this is the
 * level at which risk is read: a `BASIS_SPREAD` is one exposure, not the sum of
 * its two legs. Rows come from `portfolioMetrics`, which guarantees they sum to
 * the portfolio totals, and the weight is taken against the rows themselves so
 * the column always adds to 100%.
 *
 * Pure presentational, no hooks, so the dashboard and the portfolio page can
 * both render it without duplicating the table.
 */
export function InstrumentBreakdownTable({
  rows,
}: {
  rows: InstrumentBreakdown[];
}) {
  const totalGross = rows.reduce((acc, r) => acc + r.grossNotional, 0n);
  const unpriced = rows.reduce((acc, r) => acc + r.unmarkedPositions, 0);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Instrument</th>
              <th className="text-right">Gross value</th>
              <th className="text-right">Weight</th>
              <th className="text-right">Realized</th>
              <th className="text-right">Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const inst = instrumentInfo(row.instrument);
              const weight =
                totalGross > 0n
                  ? Number((row.grossNotional * 10000n) / totalGross) / 100
                  : 0;
              return (
                <tr key={row.instrument}>
                  <td>
                    <div className="flex flex-col gap-1">
                      {inst ? (
                        <>
                          <span className="whitespace-nowrap font-medium">
                            {inst.shortLabel}
                          </span>
                          <span className="flex items-center gap-1">
                            <span className={`badge ${inst.tone}`}>
                              {inst.ruleLabel}
                            </span>
                            <span className="text-[10px] t-mute">
                              {row.positions} position
                              {row.positions === 1 ? "" : "s"}
                              {row.volumes.length > 0 &&
                                ` · ${row.volumes
                                  .map((v) => volumeUnitLabel(v.unit))
                                  .join(" / ")}`}
                            </span>
                          </span>
                        </>
                      ) : (
                        <span className="font-medium t-dim">
                          {row.instrument}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="mono text-right">{usd(row.grossNotional)}</td>
                  <td className="mono text-right t-dim">
                    {weight.toFixed(1)}%
                  </td>
                  <td
                    className={`mono text-right ${row.realizedPnl > 0n ? "pos" : row.realizedPnl < 0n ? "neg" : "t-mute"}`}
                  >
                    {row.realizedPnl === 0n ? "—" : sign(row.realizedPnl)}
                  </td>
                  <td
                    className={`mono text-right ${row.unrealizedPnl > 0n ? "pos" : row.unrealizedPnl < 0n ? "neg" : "t-mute"}`}
                  >
                    {row.unrealizedPnl === 0n ? "—" : sign(row.unrealizedPnl)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {unpriced > 0 && (
        <p className="text-[11px] t-accent">
          {unpriced} position{unpriced === 1 ? "" : "s"} could not be priced, so
          they carry no marked value or unrealized P&amp;L above.
        </p>
      )}
    </div>
  );
}

/**
 * The same breakout at position level, one row per held instrument leg pair, so
 * a spread is visible as source → sink rather than as two point exposures.
 *
 * `weight` is against the marked book, so the column adds to the marked share
 * only; unpriced positions are listed at zero rather than omitted.
 */
export function PositionAllocationTable({
  positions,
  totalGross,
}: {
  positions: PositionView[];
  totalGross: bigint;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Market / legs</th>
            <th>Instrument</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Gross value</th>
            <th className="text-right">Weight</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const inst = instrumentInfo(p.instrument);
            const legB = inst?.legs === 2 ? p.counterSettlementPoint : null;
            const gross =
              p.markPrice != null
                ? (p.markPrice * (p.quantityMwh < 0n ? -p.quantityMwh : p.quantityMwh)) /
                  1000000n
                : 0n;
            const weight =
              totalGross > 0n ? Number((gross * 10000n) / totalGross) / 100 : 0;
            return (
              <tr key={p.id}>
                <td className="mono whitespace-nowrap font-medium">
                  {legsLabel(p.settlementPoint, legB)}
                </td>
                <td className="whitespace-nowrap t-dim">
                  {inst ? inst.shortLabel : p.instrument}
                  <span className="mono ml-2 text-[10px] t-mute">{p.product}</span>
                </td>
                <td className="mono whitespace-nowrap text-right">
                  {num(p.quantityMwh)}{" "}
                  <span className="t-mute">
                    {volumeUnitLabel(positionUnit(p.product))}
                  </span>
                </td>
                <td className="mono text-right">
                  {p.markPrice != null ? usd(gross) : "—"}
                </td>
                <td className="mono text-right t-dim">
                  {p.markPrice != null ? `${weight.toFixed(1)}%` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
