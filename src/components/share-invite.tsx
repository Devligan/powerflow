"use client";

import { useState } from "react";

/**
 * Invite friends to a challenge: the phone's own share sheet where there is
 * one, else the link copied to the clipboard. The link is the page's own
 * address, which anyone can open (signed out, it offers to sign up).
 */
export function ShareInvite({ title, path }: { title: string; path: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function share() {
    const url = new URL(path, window.location.origin).toString();
    const text = `Trade ERCOT's real power prices against me in "${title}" on PowerFlow — paper money, best P&L wins.`;
    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch (e) {
      // Dismissing the share sheet is not a failure.
      if (e instanceof DOMException && e.name === "AbortError") return;
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2500);
  }

  return (
    <button type="button" className="btn btn-sm" onClick={share} aria-live="polite">
      {state === "copied" ? "Link copied" : state === "failed" ? "Copy the address bar" : "Share invite"}
    </button>
  );
}
