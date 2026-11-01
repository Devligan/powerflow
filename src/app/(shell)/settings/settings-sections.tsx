"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

/*
 * The interactive parts of Settings. Every one calls a route handler: the
 * session cookies are httpOnly, so the browser never talks to Supabase Auth
 * directly (see src/lib/account.ts).
 */

async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new Error(String(data?.error ?? "Something went wrong. Please try again."));
  return data ?? {};
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function Alert({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="text-[12px] t-short">
      {text}
    </p>
  );
}

/* ---------------------------------------------------------------- */

export function PrivacyToggle({ listed }: { listed: boolean }) {
  const router = useRouter();
  const [isListed, setListed] = useState(listed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPrivate = !isListed;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const data = await call("/api/profile/leaderboard", json("POST", { optIn: !isListed }));
      setListed(Boolean(data.optIn));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update your privacy setting");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium">Private account</p>
          <p className="mt-0.5 text-[12px] t-mute">
            {isPrivate
              ? "You are hidden from the Rank standings."
              : "You are listed on the Rank standings with your name, picture and aggregate figures."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isPrivate}
          aria-label="Private account"
          disabled={busy}
          onClick={toggle}
          className={`relative h-6 w-11 flex-none rounded-full border transition-colors disabled:opacity-60 ${
            isPrivate
              ? "border-[var(--accent-line)] bg-[var(--accent-bg)]"
              : "border-white/15 bg-white/[0.04]"
          }`}
        >
          <span
            className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all ${
              isPrivate ? "left-[1.4rem] bg-[var(--accent)]" : "left-1 bg-white/40"
            }`}
          />
        </button>
      </div>
      <Alert text={error} />
    </div>
  );
}

/* ---------------------------------------------------------------- */

export function EmailChange({
  email,
  pendingEmail,
}: {
  email: string;
  pendingEmail: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(pendingEmail);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await call("/api/account/email", json("POST", { email: value }));
      setPending(String(data.pendingEmail ?? value));
      setOpen(false);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the change");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="label mb-0.5">Email</p>
          <p className="mono truncate text-[13px]">{email || "—"}</p>
        </div>
        {!open && (
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
            Change email
          </button>
        )}
      </div>
      {pending && (
        <div className="note note-warn">
          Waiting for confirmation of <span className="mono">{pending}</span>.
          Follow the link we sent to it, and the one sent to your current
          address if you received one. Until then you keep signing in with{" "}
          <span className="mono">{email}</span>.
        </div>
      )}
      {open && (
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="label" htmlFor="new-email">
              New email
            </label>
            <input
              id="new-email"
              type="email"
              required
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              className="input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="you@firm.com"
            />
          </div>
          <Alert text={error} />
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? "Sending" : "Send confirmation"}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */

export function PasswordChange({
  email,
  hasPassword,
}: {
  email: string;
  hasPassword: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setState("busy");
    setError(null);
    try {
      await call("/api/account/password/link", { method: "POST" });
      setState("sent");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the link");
      setState("idle");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label mb-0.5">Password</p>
          <p className="text-[12px] t-mute">
            {hasPassword
              ? "We email you a link; the new password is set from that link."
              : "You sign in with a provider. Set a password to sign in with your email too."}
          </p>
        </div>
        {state !== "sent" && (
          <button type="button" className="btn btn-sm" disabled={state === "busy"} onClick={send}>
            {state === "busy" ? "Sending" : hasPassword ? "Change password" : "Set a password"}
          </button>
        )}
      </div>
      {state === "sent" && (
        <div className="note note-ok">
          Check <span className="mono">{email}</span> and open the link in this
          browser within the hour. It brings you to a page to choose the new
          password.
        </div>
      )}
      <Alert text={error} />
    </div>
  );
}

/* ---------------------------------------------------------------- */

export function SignOutOthers() {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setState("busy");
    setError(null);
    try {
      await call("/api/account/sessions", { method: "DELETE" });
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign out other sessions");
      setState("idle");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label mb-0.5">Other sessions</p>
          <p className="text-[12px] t-mute">
            Sign out every other browser and device. This one stays signed in.
          </p>
        </div>
        <button type="button" className="btn btn-sm" disabled={state !== "idle"} onClick={run}>
          {state === "busy" ? "Signing out" : state === "done" ? "Done" : "Sign out other devices"}
        </button>
      </div>
      <Alert text={error} />
    </div>
  );
}

/* ---------------------------------------------------------------- */

export function DeleteAccount({ username }: { username: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = confirm.trim().toLowerCase() === username;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await call("/api/account", json("DELETE", { confirm }));
      // The response cleared the session cookies; refresh so nothing cached
      // from the signed-in desk renders again.
      router.replace("/login?deleted=1");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete your account");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] t-dim">
          Deletes your profile, paper account, orders, trades, positions and
          history, and removes you from the standings.
        </p>
        <button type="button" className="btn btn-danger btn-sm" onClick={() => setOpen(true)}>
          Delete account…
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="note note-error">
        This permanently deletes <span className="mono">@{username}</span> and
        everything in it. Download your blotter first if you want a copy.
      </div>
      <div>
        <label className="label" htmlFor="delete-confirm">
          Type <span className="mono normal-case">{username}</span> to confirm
        </label>
        <input
          id="delete-confirm"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="input mono"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <Alert text={error} />
      <div className="flex gap-2">
        <button type="submit" className="btn btn-danger btn-sm" disabled={!matches || busy}>
          {busy ? "Deleting" : "Permanently delete my account"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setOpen(false);
            setConfirm("");
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
