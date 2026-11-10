"use client";

import { useId, useState } from "react";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";

/**
 * A word with its plain-language meaning one hover, focus or tap away.
 * The definition is a real element tied to the word (aria-describedby), so a
 * screen reader announces it and it works without a mouse.
 */
export function Term({ k, children }: { k: GlossaryKey; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const entry = GLOSSARY[k];
  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="cursor-help border-b border-dotted border-current p-0 text-inherit"
        aria-describedby={id}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      >
        {children ?? entry.term}
      </button>
      <span
        id={id}
        role="tooltip"
        className={`${open ? "block" : "hidden"} absolute left-0 top-full z-50 mt-1 w-72 max-w-[80vw] rounded border border-white/15 bg-[var(--ink-panel)] p-2.5 text-left text-[12px] font-normal normal-case leading-snug tracking-normal shadow-lg`}
      >
        <span className="mb-1 block font-medium">{entry.term}</span>
        {entry.short}
      </span>
    </span>
  );
}
