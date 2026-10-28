"use client";

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { safeNextPath } from "@/lib/redirect";
import { describeCallbackError } from "@/lib/oauth";
import { OAuthButtons } from "@/components/oauth-buttons";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A failed OAuth round trip lands here as `?error=…`, and the sign-in screen
  // used to say nothing about it. Derived rather than copied into state, so the
  // message is there on the first render and a later attempt can supersede it.
  const callbackError = describeCallbackError(searchParams.get("error"));
  const error = formError ?? callbackError;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body: { error?: string } = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Sign in failed");
      router.push(next);
      router.refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Sign in failed");
      setBusy(false);
    }
  }

  return (
    <div className="card p-0">
      <div className="border-b border-white/10 px-6 py-4">
        <h1 className="card-title mb-0">Sign in</h1>
        <p className="mt-1.5 text-[12px] t-mute">
          Access your desk. Virtual cash only.
        </p>
      </div>

      <div className="space-y-4 p-6">
        {!isSupabaseConfigured() && (
          <div className="note note-warn">
            Supabase credentials are not configured. Add
            <code className="mono mx-1">NEXT_PUBLIC_SUPABASE_URL</code>and
            <code className="mono mx-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>to
            .env to enable sign-in.
          </div>
        )}

        {error && (
          <div id="login-error" role="alert" className="note note-error">
            {error}
          </div>
        )}

        <form
          onSubmit={onSubmit}
          className="space-y-4"
          aria-describedby={error ? "login-error" : undefined}
        >
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
              autoCorrect="off"
              spellCheck={false}
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <button type="submit" disabled={busy} className="btn btn-primary w-full">
            {busy ? "Signing in" : "Sign in"}
          </button>
        </form>

        <OAuthButtons next={next} />

        <p className="border-t border-white/10 pt-4 text-[12px] t-mute">
          No account?{" "}
          <Link href="/signup" className="t-accent hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  void props;
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
