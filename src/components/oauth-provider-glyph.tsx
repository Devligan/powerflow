import type { ReactNode } from "react";
import { OAUTH_PROVIDER_LABELS, type OAuthProviderId } from "@/lib/oauth";

/**
 * The mark shown inside a provider button.
 *
 * Three providers have their real mark because it is short, exact and
 * recognisable at 16px. Everything else gets a monogram rather than a
 * hand-drawn approximation of a trademark — the button already names the
 * provider in words, so the tile is decoration, and a wrong-looking logo is
 * worse than a plain one that matches the desk's faceplate style.
 *
 * Every mark is `aria-hidden`: the accessible name is the button's own text,
 * so a screen reader announces "Continue with Google", not "Google Google".
 */
const BRAND_MARKS: Partial<Record<OAuthProviderId, ReactNode>> = {
  google: (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C28.8 35.2 26.5 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.7l6.2 5.2C36.9 40.2 44 35 44 24c0-1.3-.1-2.6-.4-3.9z"
      />
    </svg>
  ),
  github: (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
  apple: (
    <svg viewBox="0 0 21 21" className="h-4 w-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M15.1 3.1c-.1.3-.4.4-.7.2-1.9-.8-4.1-.9-6.2-.3-.3 0-.5 0-.7-.2-.1-.3-.1-.5-.2-.7C8.1 2.1 7.9 1.8 7.9 1.8c0 0-3.7.5-5.2 3.1-.2.3-.1.6.2.7 0 0 0 .1.1.1.1.1.2.1.3.1.5.1.9.2 1.4.4 1.9.8 4.2.9 10.7.3.6-.6 1.2-.9 1.9-.9.1 0 .2.0.3.0zM12.9 20.1c-.1.1-.2.1-.2.1-.4.2-.8.3-1.3.3-.1 0-.1 0-.2-.1-.1-.1-.1-.1-.1-.2 0 0-1.8-1.3-4.3-1.3-1.1 0-2.2.4-3.1 1.1 0 0-.2-.1-.3-.1-.1 0-.1 0-.1.1-.1.1-.1.3-.1.4 0 0-.2.4-.3.9-.2.8-.2 1.7-.2 2.5 0 1.3.5 2.5 1.3 3.4.1.1.1.2.1.3 0 0 .1.1.1.1.1.1.1.1.2.1.3.1.6.1.9.1h.2c.1 0 .2.0.3-.1l.1-.1c.3-.2.6-.5.7-.8.1-.3.1-.6.1-.8 0-.7-.2-1.4-.7-1.9z"
      />
    </svg>
  ),
  discord: (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#fff" d="M20.3 5.7a9.8 9.8 0 0 1-2.7 5.7L12 16.9l-5.6-5.5a9.8 9.8 0 0 1-2.7-5.7 9.9 9.9 0 0 1 2.7-5.8l.9-.8a10 10 0 0 1 12.6 0l.9.8a9.9 9.9 0 0 1 2.7 5.8z" />
    </svg>
  ),
  gitlab: (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#fff" d="M12 2C6.48 2 2 6.48 2 12c0 2.24.8 4.25 2.11 5.66.54-.98 1.8-5.04 2.11-5.66C4.48 14.48 8.96 12 12 12s7.52 2.48 7.52 7.52c0 1.42-.46 2.74-1.28 3.77A7.94 7.94 0 0 1 12 20.96c-4.42 0-8.08-3.6-8.08-8.04C3.92 6.58 7.58 3 12 3z" />
    </svg>
  ),
  bitbucket: (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#fff" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.92h-2v-5.92l5.08-3 5.08 3v5.92h-2v-8l-6-3.82v5.92h-2z" />
    </svg>
  ),
  /*
  // Microsoft Entra ID: the four-square mark.
  azure: (
    <svg viewBox="0 0 21 21" className="h-4 w-4" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  ),
  */
};

/** The first two letters of the provider's name, as a faceplate tile. */
function Monogram({ label }: { label: string }) {
  const initials = label.slice(0, 2);
  return (
    <span
      aria-hidden="true"
      className="grid h-4 w-4 flex-none place-items-center border border-[var(--line-bright)] font-display text-[9px] leading-none font-semibold t-mute"
    >
      {initials}
    </span>
  );
}

export function OAuthProviderGlyph({
  provider,
}: {
  provider: OAuthProviderId;
}) {
  return BRAND_MARKS[provider] ?? (
    <Monogram label={OAUTH_PROVIDER_LABELS[provider]} />
  );
}
