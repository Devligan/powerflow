import Link from "next/link";
import { Bolt } from "@/components/bolt";

/** The desk mark: a bracketed plate, the same on every surface. */
export function Brand({
  tag,
  href = "/",
}: {
  /** Optional faceplate caption, e.g. "paper trading". */
  tag?: string;
  href?: string;
}) {
  return (
    <Link href={href} className="flex flex-none items-center gap-2.5">
      <span className="grid h-7 w-7 place-items-center border border-[var(--accent-line)] text-[var(--accent)]">
        <Bolt className="h-4 w-4" />
      </span>
      <span className="font-display text-sm font-semibold tracking-tight t-fg">
        PowerFlow
      </span>
      {tag && <span className="badge badge-neutral hidden sm:inline-flex">{tag}</span>}
    </Link>
  );
}
