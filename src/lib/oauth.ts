/**
 * Which social sign-in buttons the auth screens offer.
 *
 * The list is not hard-coded, and it is not an env var anyone has to remember:
 * Supabase Auth publishes the providers a project has actually enabled at
 * `GET /auth/v1/settings`. That endpoint is public, readable with the anon key
 * the browser already holds, and CORS-enabled, so the buttons can follow the
 * project's real configuration. Enabling Discord in Supabase →
 * Authentication → Providers is all it takes for a "Continue with Discord"
 * button to appear on /login and /signup — there is nothing to keep in sync,
 * and no way for the UI to advertise a provider whose click would fail.
 *
 * The client ids and secrets never come near this app: they live in the
 * Supabase dashboard, and the browser is redirected to
 * `<project>/auth/v1/authorize`, which is what `signInWithOAuth` does.
 *
 * This module is imported by a client component, so everything here has to be
 * browser-safe. It reads the public Supabase config directly rather than going
 * through the browser client, which keeps it free of a Supabase dependency and
 * testable without one.
 */
import {
  isSupabaseConfigured,
  supabaseAnonKeyEnv,
  supabaseUrlEnv,
} from "@/lib/supabase/config";

/**
 * Every provider the app can offer, in the order the buttons appear —
 * declaration order *is* display order, most likely first.
 *
 * Keys must stay valid `Provider`s for `signInWithOAuth`; a name that is not
 * one fails to type-check at the call site. Two are deliberately absent:
 * `workos`, which needs a WorkOS connection id passed per call and so cannot
 * work as a bare button, and `linkedin`, the legacy provider Supabase has
 * replaced with `linkedin_oidc`.
 */
export const OAUTH_PROVIDER_LABELS = {
  google: "Google",
  github: "GitHub",
  azure: "Microsoft",
  apple: "Apple",
  discord: "Discord",
  gitlab: "GitLab",
  linkedin_oidc: "LinkedIn",
  slack_oidc: "Slack",
  facebook: "Facebook",
  notion: "Notion",
  spotify: "Spotify",
  twitch: "Twitch",
  x: "X",
  twitter: "X",
  bitbucket: "Bitbucket",
  figma: "Figma",
  kakao: "Kakao",
  keycloak: "Keycloak",
  zoom: "Zoom",
  fly: "Fly.io",
} as const;

export type OAuthProviderId = keyof typeof OAUTH_PROVIDER_LABELS;

/** The catalog in display order. */
export const OAUTH_PROVIDERS = Object.keys(
  OAUTH_PROVIDER_LABELS
) as OAuthProviderId[];

export function oauthLabel(provider: OAuthProviderId): string {
  return OAUTH_PROVIDER_LABELS[provider];
}

/**
 * Providers whose flow needs scopes named at call time, because the defaults
 * GoTrue asks for are not enough for a usable session:
 *
 *   azure         Supabase Auth requires a verified email address back from
 *                 Entra ID, so the email scope has to be requested.
 *   linkedin_oidc the OIDC scopes are not granted unless they are asked for.
 */
const PROVIDER_SCOPES: Partial<Record<OAuthProviderId, string>> = {
  azure: "email",
  linkedin_oidc: "openid profile email",
};

export function oauthScopes(provider: OAuthProviderId): string | undefined {
  return PROVIDER_SCOPES[provider];
}

/**
 * The enabled OAuth providers named by an `/auth/v1/settings` payload, in
 * display order.
 *
 * Anything the catalog does not know is dropped rather than shown with a
 * guessed label, and the payload's non-OAuth switches (`email`, `phone`,
 * `anonymous_users`, `saml_enabled`) are not providers at all.
 */
export function parseEnabledProviders(payload: unknown): OAuthProviderId[] {
  const external = (payload as { external?: unknown } | null | undefined)
    ?.external;
  if (!external || typeof external !== "object") return [];

  const flags = external as Record<string, unknown>;
  return OAUTH_PROVIDERS.filter((provider) => flags[provider] === true);
}

/**
 * The `?error=` reason the OAuth callback redirects to /login with, in words a
 * person can act on.
 *
 * GoTrue's own text is written for whoever is configuring the provider ("invalid
 * flow state, no valid flow exists"), which is not what a sign-in screen should
 * say. The raw value stays in the URL for that person; the screen says something
 * the user can do about it.
 */
export function describeCallbackError(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  if (raw === "missing_code") {
    return "That sign-in did not come back with an authorization code. Please try again.";
  }
  return (
    "Social sign-in could not be completed. Please try again, or sign in " +
    "with your email and password."
  );
}

let settingsPromise: Promise<OAuthProviderId[]> | null = null;

/**
 * The providers this project has enabled, fetched once per page load.
 *
 * Failure is not an error worth showing: with no answer the honest thing is to
 * render no buttons, because a button whose flow cannot complete is worse than
 * an absent one. Sign-in by email/password is unaffected — the auth screens
 * work either way.
 */
export function fetchEnabledProviders(): Promise<OAuthProviderId[]> {
  settingsPromise ??= loadProviders();
  return settingsPromise;
}

async function loadProviders(): Promise<OAuthProviderId[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const res = await fetch(
      `${supabaseUrlEnv.replace(/\/+$/, "")}/auth/v1/settings`,
      {
        headers: { apikey: supabaseAnonKeyEnv },
        // The answer changes when a developer flips a provider on, and it is
        // one small request: never serve it from a stale HTTP cache.
        cache: "no-store",
      }
    );
    if (!res.ok) return [];
    return parseEnabledProviders(await res.json());
  } catch {
    return [];
  }
}
