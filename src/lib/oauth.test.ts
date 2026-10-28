import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAUTH_PROVIDERS,
  describeCallbackError,
  oauthLabel,
  oauthScopes,
  parseEnabledProviders,
  type OAuthProviderId,
} from "@/lib/oauth";

/** A settings payload shaped the way GoTrue answers it. */
const settings = (external: Record<string, unknown>) => ({ external });

describe("provider catalog", () => {
  it("labels every provider it can offer", () => {
    // A catalogued provider with no label would render as a blank button.
    for (const provider of OAUTH_PROVIDERS) {
      expect(oauthLabel(provider), `no label for ${provider}`).not.toHaveLength(0);
    }
  });

  it("omits the providers a bare button cannot drive", () => {
    // `workos` needs a connection id passed per call; `linkedin` is the legacy
    // provider Supabase replaced with `linkedin_oidc`. Offering either gives a
    // button whose click cannot complete.
    expect(OAUTH_PROVIDERS).not.toContain("workos");
    expect(OAUTH_PROVIDERS).not.toContain("linkedin");
  });

  it("names the scopes the defaults do not cover", () => {
    // Azure has to return a verified email, and LinkedIn's OIDC scopes are not
    // granted unless they are asked for.
    expect(oauthScopes("azure")).toBe("email");
    expect(oauthScopes("linkedin_oidc")).toContain("email");
    // Everything else is fine with GoTrue's own defaults.
    expect(oauthScopes("google")).toBeUndefined();
    expect(oauthScopes("github")).toBeUndefined();
  });
});

describe("parseEnabledProviders", () => {
  it("keeps the enabled providers in display order", () => {
    expect(
      parseEnabledProviders(settings({ discord: true, github: true, google: true }))
    ).toEqual(["google", "github", "discord"]);
  });

  it("ignores the switches that are not OAuth providers", () => {
    expect(
      parseEnabledProviders(
        settings({
          email: true,
          phone: true,
          anonymous_users: true,
          saml_enabled: true,
          snapchat: true, // a provider this catalog does not label
          workos: true, // labelled nowhere: it needs a connection id
        })
      )
    ).toEqual([]);
  });

  it("requires a strict true, not a truthy value", () => {
    expect(parseEnabledProviders(settings({ google: "true", github: 1 }))).toEqual([]);
  });

  it("answers with nothing rather than guessing at a malformed payload", () => {
    for (const payload of [
      null,
      undefined,
      {},
      "nope",
      { external: null },
      { external: "google" },
      { external: ["google"] },
    ]) {
      expect(parseEnabledProviders(payload)).toEqual([]);
    }
  });
});

describe("live discovery", () => {
  const freshImport = async () => {
    vi.resetModules();
    return import("@/lib/oauth");
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("asks the project's own settings endpoint with the public key", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify(settings({ google: true, github: true, spotify: false })),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchEnabledProviders } = await freshImport();
    expect(await fetchEnabledProviders()).toEqual<OAuthProviderId[]>([
      "google",
      "github",
    ]);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0];
    expect(url).toBe("https://demo.supabase.co/auth/v1/settings");
    expect(init.headers).toMatchObject({ apikey: "anon-key" });
    // The answer changes when a developer enables a provider; a stale cached
    // response would keep a button hidden after it was switched on.
    expect(init.cache).toBe("no-store");
  });

  it("asks once, so sign-in and sign-up do not both pay for it", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(settings({ google: true })), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchEnabledProviders } = await freshImport();
    await Promise.all([fetchEnabledProviders(), fetchEnabledProviders()]);
    await fetchEnabledProviders();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows no buttons rather than a broken one when the project cannot be asked", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    let mod = await freshImport();
    expect(await mod.fetchEnabledProviders()).toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    mod = await freshImport();
    expect(await mod.fetchEnabledProviders()).toEqual([]);
  });

  it("does not call out at all when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchEnabledProviders } = await freshImport();
    expect(await fetchEnabledProviders()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("describeCallbackError", () => {
  it("says what the user can do, not what GoTrue logged", () => {
    expect(describeCallbackError(null)).toBeNull();
    expect(describeCallbackError("")).toBeNull();
    expect(describeCallbackError("missing_code")).toContain("try again");
    // A provider's own message is written for whoever configured it.
    expect(describeCallbackError("invalid flow state, no valid flow exists")).not.toContain(
      "flow state"
    );
  });
});
