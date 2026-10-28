/**
 * Configures which OAuth providers show on the login/signup screens.
 *
 * Supabase supports many providers; each one is gated on its own
 * NEXT_PUBLIC_*_CLIENT_ID env var (set in Supabase → Authentication →
 * Providers → "Enable" the provider and paste the client id/secret).
 *
 * NOTE: env keys are read statically so Next.js can inline them into the
 * client bundle — that is why `ENABLED_PROVIDERS` uses literal key access.
 */export type OAuthProviderId = "github" | "google";
export const OAUTH_PROVIDERS: OAuthProviderId[] = ["github", "google"];
export const OAUTH_LABELS: Record<OAuthProviderId, string> = {
  github: "GitHub",
  google: "Google",
};
export const OAUTH_PROVIDER_LABELS = OAUTH_LABELS;

export function oauthLabel(provider: OAuthProviderId): string {
  return OAUTH_LABELS[provider];
}

const ENABLED_PROVIDERS: Record<OAuthProviderId, boolean> = {
  google: Boolean(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID),
  github: Boolean(process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID),
};
export function configuredOAuthProviders(): OAuthProviderId[] {
  return (Object.keys(OAUTH_LABELS) as OAuthProviderId[]).filter(
    (p) => ENABLED_PROVIDERS[p]
  );
}
export function oauthScopes(provider: OAuthProviderId): string[] {
  return [];
}
export function parseEnabledProviders(text: unknown): OAuthProviderId[] {
  if (typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    return [];
  } catch {
    return [];
  }
}
export function fetchEnabledProviders(): Promise<OAuthProviderId[]> {
  return Promise.resolve(configuredOAuthProviders());
}
export function describeCallbackError(error: string): string {
  return error;
}