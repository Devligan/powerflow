import { getFundamentals } from "@/lib/fundamentals";

const gw = (mw: number | null) => (mw == null ? "—" : (mw / 1000).toFixed(1));

/**
 * The fundamentals a trader bids on: tomorrow's hourly load, wind and solar
 * forecasts, net load and reserve margin, plus the week's peak load. Net-load
 * troughs are where negative prices print; thin reserves are where scarcity
 * does. ERCOT's public forecasts, refreshed every five minutes.
 */
export async function FundamentalsPanel() {
  const f = await getFundamentals();
  if (!f?.next) return null;
  const hours = f.next.hours;
  const nets = hours.map((h) => h.netLoad).filter((v): v is number => v != null);
  const minNet = nets.length ? Math.min(...nets) : null;
  const maxNet = nets.length ? Math.max(...nets) : null;
  const reserves = hours.map((h) => h.reserve).filter((v): v is number => v != null);
  const minReserve = reserves.length ? Math.min(...reserves) : null;

  return (
    <section className="card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="card-title mb-0">Fundamentals · operating day {f.next.day}</h2>
        <span className="caption t-mute">ERCOT forecasts · GW</span>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed t-dim">
        Net load = load − wind − solar. Its low hours (here {gw(minNet)} GW) are where prices go
        negative; its high hours ({gw(maxNet)} GW) and the thinnest reserve ({gw(minReserve)} GW) are
        where real time spikes above day-ahead.
      </p>
      <div className="scroll-thin mt-3 overflow-x-auto">
        <table className="table text-[11px]">
          <thead>
            <tr>
              <th>HE</th>
              <th className="text-right">Load</th>
              <th className="text-right">Wind</th>
              <th className="text-right">Solar</th>
              <th className="text-right">Net load</th>
              <th className="text-right">Reserve</th>
            </tr>
          </thead>
          <tbody>
            {hours.map((h) => (
              <tr key={`${h.he}${h.repeated ? "r" : ""}`}>
                <td className="mono">
                  {h.he}
                  {h.repeated ? "*" : ""}
                </td>
                <td className="mono text-right">{gw(h.load)}</td>
                <td className="mono text-right">{gw(h.wind)}</td>
                <td className="mono text-right">{gw(h.solar)}</td>
                <td
                  className={`mono text-right ${h.netLoad === minNet ? "t-steel" : h.netLoad === maxNet ? "t-accent" : ""}`}
                >
                  {gw(h.netLoad)}
                </td>
                <td className={`mono text-right ${h.reserve === minReserve ? "t-short" : "t-mute"}`}>
                  {gw(h.reserve)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {f.weekPeaks.length > 1 && (
        <p className="mt-3 text-[11px] t-mute">
          Week ahead, peak load:{" "}
          {f.weekPeaks.map((d) => `${d.day.slice(5)} ${gw(d.peakLoad)}`).join(" · ")} GW
        </p>
      )}
    </section>
  );
}
