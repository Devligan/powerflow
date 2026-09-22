import { isSupabaseConfigured } from "@/lib/supabase/config";
import { Lamp } from "@/components/ui/lamp";

/** Banner shown while .env values for Supabase are missing (dev scaffolding). */
export function SetupBanner() {
  if (isSupabaseConfigured()) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--accent-line)] bg-[var(--accent-bg)] px-4 py-2 text-[11px] text-[#f0d3a0]">
      <Lamp className="t-accent" />
      <span className="font-semibold tracking-wide uppercase">
        Not connected
      </span>
      <span>
        Add <code className="mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to{" "}
        <code className="mono">.env</code> to enable sign-in.
      </span>
    </div>
  );
}
