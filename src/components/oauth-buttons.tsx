"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { OAuthProviderGlyph } from "@/components/oauth-provider-glyph";
import {
  fetchEnabledProviders,
  oauthLabel,
  oauthScopes,
  type OAuthProviderId,
} from "@/lib/oauth";

/**
 * "Continue with …" for every provider the Supabase project has enabled.
 *
 * The list arrives from the project's own settings, so this component renders
 * nothing while it is in flight and nothing if the answer never comes. That is
 * deliberate: a provider button is a promise that a round trip will work.
 *
 * Accessibility notes, since this sits on the first screen anyone sees:
 *
 *   - the buttons are a labelled `group`, so they are announced as one cluster
 *     rather than as orphans next to the email form;
 *   - the clicked button carries `aria-busy`, and the redirect is announced in
 *     a live region, because focus follows the user into the redirect and the
 *     changed button label alone is not read out;
 *   - a failure is `role="alert"` — the same text is visible and spoken.
 */
export function OAuthButtons({ next = "/dashboard" }: { next?: string }) {
  const [providers, setProviders] = useState<OAuthProviderId[] | null>(null);
  const [busy, setBusy] = useState<OAuthProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchEnabledProviders().then((enabled) => {
      if (live) setProviders(enabled);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!providers || providers.length === 0) return null;

  async function signIn(provider: OAuthProviderId) {
    setBusy(provider);
    setError(null);
    try {
      const supabase = createClient();
      const scopes = oauthScopes(provider);
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          ...(scopes ? { scopes } : {}),
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw new Error(error.message);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `${oauthLabel(provider)} sign in failed`
      );
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-white/10" />
        <span className="caption">Or</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>

      <div
        role="group"
        aria-label="Continue with a provider"
        className="space-y-2"
      >
        {providers.map((provider) => {
          const label = oauthLabel(provider);
          const pending = busy === provider;
          return (
            <button
              key={provider}
              type="button"
              onClick={() => signIn(provider)}
              disabled={busy !== null}
              aria-busy={pending}
              className="btn w-full"
            >
              <OAuthProviderGlyph provider={provider} />
              {pending ? `Redirecting to ${label}` : `Continue with ${label}`}
            </button>
          );
        })}
      </div>

      {/* The button label changes but focus stays put, so the redirect is
          announced here rather than relied on to be re-read. */}
      <p role="status" className="sr-only">
        {busy ? `Redirecting to ${oauthLabel(busy)}` : ""}
      </p>

      {error && (
        <div role="alert" className="note note-error">
          {error}
        </div>
      )}
    </div>
  );
}
