"use client";

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { safeNextPath } from "@/lib/redirect";
import { OAuthButtons } from "@/components/oauth-buttons";

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw new Error(error.message);
      // Confirmation-dependent: if a session was issued, proceed; otherwise
      // tell the user to confirm their inbox.
      if (data?.session) {
        router.push(next);
        router.refresh();
      } else {
        setMessage("Check your inbox to confirm your email, then sign in.");
        setBusy(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
      setBusy(false);
    }
  }

  return (
    <div className="card p-0">
      <div className="border-b border-white/10 px-6 py-4">
        <h1 className="card-title mb-0">Open an account</h1>
        <p className="mt-1.5 text-[12px] t-mute">
          Credited with $100,000 virtual cash on creation.
        </p>
      </div>

      <div className="space-y-4 p-6">
        {!isSupabaseConfigured() && (
          <div className="note note-warn">
            Supabase credentials are not configured. Add
            <code className="mono mx-1">NEXT_PUBLIC_SUPABASE_URL</code>and
            <code className="mono mx-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>to
            .env to enable sign-up.
          </div>
        )}

        {error && <div className="note note-error">{error}</div>}
        {message && <div className="note note-ok">{message}</div>}

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
              autoComplete="new-password"
              minLength={8}
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <div>
            <label className="label" htmlFor="confirm">
              Confirm password
            </label>
            <input
              id="confirm"
              type="password"
              required
              autoComplete="new-password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat your password"
            />
          </div>
          <button type="submit" disabled={busy} className="btn btn-primary w-full">
            {busy ? "Creating account" : "Create account"}
          </button>
        </form>

        <OAuthButtons next={next} />

        <p className="border-t border-white/10 pt-4 text-[12px] t-mute">
          Already have an account?{" "}
          <Link href="/login" className="t-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
