import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "@/components/brand";

export const LEGAL_CONTACT = "sriharshachallangi@gmail.com";
export const LEGAL_EFFECTIVE = "October 30, 2026";

/** Shared frame for the public policy pages: the site header, a readable
 *  measure, and the cross-links a visitor expects at the foot. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-white/10 bg-[var(--ink-panel)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Brand tag="paper trading" />
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-12">
        <p className="caption">Effective {LEGAL_EFFECTIVE}</p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight">{title}</h1>
        <div className="legal mt-8 space-y-6 text-[14px] leading-relaxed t-dim">{children}</div>
        <p className="caption mt-12 flex gap-4">
          <Link href="/privacy" className="hover:underline">Privacy</Link>
          <Link href="/terms" className="hover:underline">Terms</Link>
          <Link href="/" className="hover:underline">Home</Link>
        </p>
      </main>
    </div>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-display text-[15px] font-semibold t-fg">{heading}</h2>
      {children}
    </section>
  );
}
