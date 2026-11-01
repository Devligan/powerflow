"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not send the link");
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-0">
      <div className="border-b border-white/10 px-6 py-4">
        <h1 className="card-title mb-0">Reset your password</h1>
        <p className="mt-1.5 text-[12px] t-mute">
          We will email you a link to choose a new one.
        </p>
      </div>
      <div className="space-y-4 p-6">
        {error && (
          <div role="alert" className="note note-error">
            {error}
          </div>
        )}
        {sentTo ? (
          <div className="note note-ok">
            If an account exists for <span className="mono">{sentTo}</span>, a
            link is on its way. Open it in this browser within the hour to
            choose a new password.
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <button type="submit" disabled={busy} className="btn btn-primary w-full">
              {busy ? "Sending" : "Email me a link"}
            </button>
          </form>
        )}
        <p className="border-t border-white/10 pt-4 text-[12px] t-mute">
          Remembered it?{" "}
          <Link href="/login" className="t-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
