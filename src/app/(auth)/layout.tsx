import { Brand } from "@/components/brand";
import { Lamp } from "@/components/ui/lamp";
import { LocalClock, ZoneCaption } from "@/components/ui/clock";

/**
 * The auth surface.
 *
 * Two panels rather than one centred column: the left states what the desk is
 * and what an account starts with, the right holds the form. It keeps the
 * sign-in screen from being an empty field of whitespace, and it gives the
 * reader the terms before they hand over an address.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
      <aside className="hidden flex-col justify-between border-r border-white/10 p-10 lg:flex">
        <Brand tag="paper trading" />

        <div className="max-w-md">
          <h2 className="font-display text-2xl leading-tight font-bold tracking-tight">
            A trading desk for the ERCOT power curve.
          </h2>
          <p className="mt-4 text-[13px] leading-relaxed t-dim">
            Virtual bids and point-to-point obligations in the day-ahead market,
            settled against actual real-time prices.
          </p>

          <ul className="mt-8 space-y-3 border-t border-white/10 pt-6">
            {[
              "$100,000 virtual cash on account creation",
              "Bids hold collateral, sized on recent price gaps at each point",
              "Positions settled automatically at delivery",
              "Actual ERCOT prices, every one labelled with its report and publication time",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5">
                <Lamp className="t-accent mt-[7px]" />
                <span className="text-[12.5px] leading-relaxed t-dim">
                  {line}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="caption">
          <LocalClock /> · <ZoneCaption />
        </p>
      </aside>

      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="mb-5 lg:hidden">
            <Brand tag="paper trading" />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
