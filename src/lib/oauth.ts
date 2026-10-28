/**
 * Configures which OAuth providers show on the login/signup screens.
 *
 * Supabase supports many providers; each one is gated on its own
 * NEXT_PUBLIC_*_CLIENT_ID env var (set in Supabase → Authentication →
 * Providers → "Enable" the provider and paste the client id/secret).
 *
 * NOTE: env keys are read statically so Next.js can inline them into the
 * client bundle — that is why `ENABLED_PROVIDERS` uses literal key access.
 */export type OAuthProviderId =
  | "google"
  | "github"
  | "microsoft"
  | "apple"
  | "discord"
  | "gitlab"
  | "bitbucket";
export const OAUTH_PROVIDERS: OAuthProviderId[] = [
  "google",
  "github",
  "microsoft",
  "apple",
  "discord",
  "gitlab",
  "bitbucket",
];
export const OAUTH_LABELS: Record<OAuthProviderId, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  apple: "Apple",
  discord: "Discord",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};
export const OAUTH_PROVIDER_LABELS: Record<OAuthProviderId, string> = OAUTH_LABELS;

export function oauthLabel(provider: OAuthProviderId): string {
  return OAUTH_LABELS[provider];
}

const ENABLED_PROVIDERS: Record<OAuthProviderId, boolean> = {
  google: Boolean(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID),
  github: Boolean(process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID),
  microsoft: Boolean(process.env.NEXT_PUBLIC_MICROSOFT_CLIENT_ID),
  apple: Boolean(process.env.NEXT_PUBLIC_APPLE_CLIENT_ID),
  discord: Boolean(process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID),
  gitlab: Boolean(process.env.NEXT_PUBLIC_GITLAB_CLIENT_ID),
  bitbucket: Boolean(process.env.NEXT_PUBLIC_BITBUCKET_CLIENT_ID),
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
    const parsed = JSON.parse(text) as Record<string, boolean>;
    return (Object.keys(parsed) as OAuthProviderId[]).filter(
      (p) => Boolean(parsed[p]) && p in OAUTH_LABELS
    );
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