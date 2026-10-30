"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { Lamp } from "@/components/ui/lamp";
import { UtcClock } from "@/components/ui/clock";

const NAV = [
  { href: "/dashboard", label: "Desk" },
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/positions", label: "Positions" },
  { href: "/trades", label: "Blotter" },
  { href: "/analytics", label: "Analytics" },
  { href: "/leaderboard", label: "Rank" },
];

/**
 * The control bar.
 *
 * Section links are faceplate captions with a rule that grows under the
 * pointer and locks at full width in amber on the active section, so position
 * is shown by a marker rather than by a highlighted pill. The bar is opaque —
 * nothing scrolls behind it, so no element ever becomes half-legible.
 */
export function Nav({
  user,
  displayName,
}: {
  user: boolean;
  displayName: string;
}) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    <nav className="sticky top-0 z-40 border-b border-white/10 bg-[var(--ink-panel)]">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <Brand tag="desk" />

        <span className="hidden h-5 w-px bg-white/10 sm:block" />

        <div className="hidden items-center md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n.href) ? "page" : undefined}
              className={`nav-link ${isActive(n.href) ? "nav-link-active" : ""}`}
            >
              {n.label}
            </Link>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span
            className="badge badge-green hidden lg:inline-flex"
            title="Prices are ERCOT's own MIS publications; orders, fills and accounts are paper."
          >
            <Lamp pulse />
            ERCOT data · paper trading
          </span>
          <span className="hidden border-l border-white/10 pl-3 sm:block">
            <UtcClock />
          </span>

          {user ? (
            <>
              <span className="caption hidden max-w-[10rem] truncate sm:block">
                {displayName || "trader"}
              </span>
              <form action="/auth/signout" method="post">
                <button type="submit" className="btn btn-sm">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link href="/login" className="btn btn-primary btn-sm">
              Sign in
            </Link>
          )}
        </div>
      </div>

      <div className="scroll-thin flex items-center gap-1 overflow-x-auto border-t border-white/5 px-4 md:hidden">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={isActive(n.href) ? "page" : undefined}
            className={`nav-link ${isActive(n.href) ? "nav-link-active" : ""}`}
          >
            {n.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
