"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Cancel a working limit order. The server re-checks ownership and
 * open-status; the button only makes the intent convenient.
 */
export function OrderCancelButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Cancel failed");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-[11px] t-short">{error}</span>}
      <button
        type="button"
        onClick={cancel}
        disabled={busy}
        className="btn px-2 py-1 text-[11px]"
      >
        {busy ? "Cancelling" : "Cancel"}
      </button>
    </span>
  );
}
