"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  configuredOAuthProviders,
  type OAuthProviderId,
} from "@/lib/oauth";
import { OAUTH_PROVIDER_LABELS as OAUTH_LABELS } from "@/lib/oauth";

import { OAuthProviderGlyph } from "@/components/oauth-provider-glyph";

function ProviderGlyph({ provider }: { provider: OAuthProviderId }) {
  return <OAuthProviderGlyph provider={provider} />;
}

export function OAuthButtons({ next = "/dashboard" }: { next?: string }) {
  const [busy, setBusy] = useState<OAuthProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providers = configuredOAuthProviders();

  if (providers.length === 0) return null;

  async function signIn(provider: OAuthProviderId) {
    setBusy(provider);
    setError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: provider as Parameters<typeof supabase.auth.signInWithOAuth>[0]['provider'],
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw new Error(error.message);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `${OAUTH_LABELS[provider]} sign in failed`
      );
      setBusy(null);
    }
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-white/10" />
        <span className="caption">Or</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>
      <div className="space-y-2">
        {providers.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => signIn(p)}
            disabled={busy !== null}
            className="btn w-full"
          >
            <ProviderGlyph provider={p} />
            {busy === p ? "Redirecting" : `Continue with ${OAUTH_LABELS[p]}`}
          </button>
        ))}
      </div>
      {error && <div className="note note-error">{error}</div>}
    </>
  );
}
