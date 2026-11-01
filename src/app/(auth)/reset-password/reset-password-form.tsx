"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PASSWORD_MIN } from "@/lib/profile";

export function ResetPasswordForm({
  email,
  minutesLeft,
}: {
  email: string;
  minutesLeft: number;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < PASSWORD_MIN) {
      setError(`Passwords must be at least ${PASSWORD_MIN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not change your password");
      router.push("/settings?password=changed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change your password");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <div role="alert" className="note note-error">
          {error}
        </div>
      )}
      {/* Lets a password manager file the new password under the account. */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <div>
        <label className="label" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          required
          minLength={PASSWORD_MIN}
          autoComplete="new-password"
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`At least ${PASSWORD_MIN} characters`}
        />
      </div>
      <div>
        <label className="label" htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          type="password"
          required
          autoComplete="new-password"
          className="input"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <button type="submit" disabled={busy} className="btn btn-primary w-full">
        {busy ? "Saving" : "Set new password"}
      </button>
      <p className="text-[11px] t-mute">
        For {email}. This page accepts a new password for about {Math.max(1, minutesLeft)} more
        minute{minutesLeft === 1 ? "" : "s"}. Your other devices will be signed out.
      </p>
    </form>
  );
}

/** For a signed-in trader whose link was missing or stale. */
export function RequestNewLink({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setState("busy");
    setError(null);
    try {
      const res = await fetch("/api/account/password/link", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not send the link");
      setState("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the link");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <div className="note note-ok">
        Sent to <span className="mono">{email}</span>. Open it in this browser.
      </div>
    );
  }
  return (
    <>
      {error && (
        <div role="alert" className="note note-error">
          {error}
        </div>
      )}
      <button type="button" className="btn btn-primary w-full" disabled={state === "busy"} onClick={send}>
        {state === "busy" ? "Sending" : `Email a new link to ${email}`}
      </button>
    </>
  );
}
