"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  DISPLAY_NAME_MAX,
  displayNameProblem,
  normalizeUsername,
  usernameProblem,
} from "@/lib/profile";

type Availability =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; current?: boolean }
  | { state: "bad"; reason: string };

/**
 * The trader's name: what others see (display name) and the unique handle
 * (username). Used on /welcome, where saving it finishes onboarding, and in
 * Settings.
 */
export function ProfileForm({
  initial,
  mode,
  next = "/dashboard",
  onNameChange,
}: {
  initial: { username: string; displayName: string; leaderboardOptIn: boolean };
  mode: "welcome" | "settings";
  next?: string;
  onNameChange?: (name: string) => void;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [username, setUsername] = useState(initial.username);
  const [optIn, setOptIn] = useState(initial.leaderboardOptIn);
  const [availability, setAvailability] = useState<Availability>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  function onUsername(value: string) {
    setUsername(value);
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    const name = normalizeUsername(value);
    const local = usernameProblem(name, initial.username);
    if (local) {
      setAvailability({ state: "bad", reason: local });
      return;
    }
    if (name === initial.username) {
      setAvailability({ state: "ok", current: true });
      return;
    }
    setAvailability({ state: "checking" });
    const mine = ++seq.current;
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/account/username?name=${encodeURIComponent(name)}`);
        const data = await res.json();
        if (mine !== seq.current) return;
        setAvailability(
          data.available ? { state: "ok" } : { state: "bad", reason: data.reason ?? "Unavailable" }
        );
      } catch {
        if (mine === seq.current) setAvailability({ state: "idle" });
      }
    }, 350);
  }

  const nameProblem = displayNameProblem(displayName);
  const handleProblem = usernameProblem(username, initial.username);
  const blocked = Boolean(nameProblem || handleProblem || availability.state === "bad");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/account/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          displayName,
          ...(mode === "welcome" ? { leaderboardOptIn: optIn } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not save your profile");
      if (mode === "welcome") {
        router.push(next);
        router.refresh();
        return;
      }
      setSaved(true);
      onNameChange?.(data?.profile?.display_name ?? displayName);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your profile");
    } finally {
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
      <div>
        <label className="label" htmlFor="display-name">
          Display name
        </label>
        <input
          id="display-name"
          required
          maxLength={DISPLAY_NAME_MAX * 2}
          autoComplete="nickname"
          className="input"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setSaved(false);
          }}
          placeholder="e.g. Houston Hub Desk"
        />
        <p className="mt-1.5 text-[11px] t-mute">
          {nameProblem && displayName.trim() !== ""
            ? nameProblem
            : "Shown to other traders on the standings, so avoid your email address or anything private. Up to 40 characters."}
        </p>
      </div>
      <div>
        <label className="label" htmlFor="username">
          Username
        </label>
        <div className="flex items-center">
          <span className="mono mr-1.5 t-mute">@</span>
          <input
            id="username"
            required
            autoCapitalize="none"
            autoComplete="username"
            spellCheck={false}
            maxLength={30}
            className="input mono"
            value={username}
            onChange={(e) => onUsername(e.target.value)}
          />
        </div>
        <p
          className={`mt-1.5 text-[11px] ${availability.state === "bad" ? "t-short" : availability.state === "ok" && !availability.current ? "t-long" : "t-mute"}`}
          aria-live="polite"
        >
          {availability.state === "bad"
            ? availability.reason
            : availability.state === "checking"
              ? "Checking…"
              : availability.state === "ok" && !availability.current
                ? `@${normalizeUsername(username)} is available.`
                : "Unique and private: only you see it. Lowercase letters, digits and underscores, 3–30 characters."}
        </p>
      </div>

      {mode === "welcome" && (
        <label className="flex items-start gap-2.5 text-[12.5px] t-dim">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={optIn}
            onChange={(e) => setOptIn(e.target.checked)}
          />
          <span>
            List me on the public standings (Rank). Only your name, picture and
            aggregate figures are shown, never your positions or trades. You can
            change this any time in Settings.
          </span>
        </label>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy || blocked} className="btn btn-primary">
          {busy ? "Saving…" : mode === "welcome" ? "Continue to the desk" : "Save profile"}
        </button>
        {saved && <span className="text-[12px] t-long">Saved.</span>}
      </div>
    </form>
  );
}
