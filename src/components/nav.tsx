"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { LocalClock } from "@/components/ui/clock";
import { Avatar } from "@/components/ui/avatar";

const NAV = [
  { href: "/dashboard", label: "Desk" },
  { href: "/markets", label: "Markets" },
  { href: "/positions", label: "Positions" },
  { href: "/orders", label: "Orders" },
  { href: "/trades", label: "Blotter" },
  { href: "/analytics", label: "Analytics" },
  { href: "/leaderboard", label: "Rank" },
];

/** A visitor without an account sees the pages they can open, not a row of
 *  desk sections that would each send them to sign in. */
const PUBLIC_NAV = [
  { href: "/learn", label: "How it works" },
  { href: "/engineering", label: "How it's built" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/status", label: "Status" },
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
  avatarUrl,
}: {
  user: boolean;
  displayName: string;
  avatarUrl: string | null;
}) {
  const pathname = usePathname();
  const links = user ? NAV : PUBLIC_NAV;

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    <nav className="sticky top-0 z-40 border-b border-white/10 bg-[var(--ink-panel)]">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <Brand tag={user ? "desk" : "paper trading"} />

        <span className="hidden h-5 w-px bg-white/10 sm:block" />

        <div className="hidden items-center lg:flex">
          {links.map((n) => (
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

        {/* Seven sections, the clock and the account fit the 6xl
            column, so the "ERCOT data · paper trading" badge lives in the
            shell footer instead. */}
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden border-l border-white/10 pl-3 sm:block">
            <LocalClock />
          </span>

          {user ? (
            <>
              <Link
                href="/settings"
                aria-current={isActive("/settings") ? "page" : undefined}
                title="Account settings"
                className="flex items-center gap-2 rounded-full hover:opacity-90"
              >
                <Avatar url={avatarUrl} name={displayName} size={26} />
                <span className="caption hidden max-w-[10rem] truncate xl:block">
                  {displayName || "trader"}
                </span>
                <span className="sr-only">Account settings</span>
              </Link>
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

      <div className="scroll-thin flex items-center gap-1 overflow-x-auto border-t border-white/5 px-4 lg:hidden">
        {links.map((n) => (
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
