import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  attachPage,
  freePort,
  killTree,
  launchChrome,
  removeProfile,
  resolveChrome,
  sleep,
  type Page,
} from "./lib/chrome";
import { OAUTH_PROVIDERS, oauthLabel, type OAuthProviderId } from "../src/lib/oauth";
import {
  admin,
  cleanupTestUsers,
  createTestUser,
  loadTestEnv,
  type TestUser,
} from "../src/lib/testing/db";
import { damDeadlineUtc, firstOpenOperatingDay, hourEndingStartUtc } from "../src/lib/ercot/hour-ending";

/**
 * A real-browser check of the sign-in screens: `npm run build && npm run test:browser`.
 *
 * The database suites prove the SQL; the vitest suites prove the pure logic.
 * Neither can prove that the auth pages *render* — that React hydrates the
 * client components, that the provider buttons exist and are labelled, or that
 * the console stays quiet. That is what this checks, in a real browser.
 *
 * No Playwright, no Puppeteer, no new dependency: Chrome is already on the
 * machine, and it speaks the DevTools Protocol over a WebSocket that Node has
 * had built in since v22. So the check is a few hundred lines of protocol calls
 * rather than a browser framework, an install step and a lockfile entry.
 *
 * It runs against the production build (server-rendered HTML is what a visitor
 * gets, and `next dev` overlays would pollute the console). Two kinds of
 * assertion:
 *
 *   - structural, against whatever this project's Supabase Auth is actually
 *     configured with — so it is meaningful on any checkout, and a project with
 *     every provider enabled still passes;
 *   - the provider section with a *stubbed* settings response, injected with
 *     `Fetch.fulfillRequest`, which is the only way to exercise the
 *     "providers enabled" branch without real OAuth credentials. Nothing is
 *     rebuilt: the stub replaces one response for one page load.
 *
 * The signed-in pages (`--signed-in`) are checked the same way, which needs an
 * account: the check creates one throwaway user through the admin API, signs in
 * through the *form*, and trades the way the desk does — a day-ahead bid placed
 * before the deadline, filled by the order sweep at ERCOT's clearing — through
 * the app's own HTTP API, then deletes the account; the cascade takes its book.
 * That is a write to whatever project `.env` points at, so like the database
 * suites it is opt-in. It is also the only way to see the desk with data on it:
 * cash that moved, a position row, a margin tier.
 *
 * Usage:
 *   npm run build && npm run test:browser
 *   npm run test:browser -- --signed-in                 # adds dashboard, positions, leaderboard
 *   npm run test:browser -- --url http://localhost:3000   # an already-running server
 *   CHROME_PATH=/path/to/chrome npm run test:browser
 *   npm run test:browser -- --headed                      # watch it, for debugging
 *
 * Requires Node 22+ (for the built-in `WebSocket`) and Google Chrome or
 * Chromium. When no browser is found the check reports that it skipped rather
 * than failing, because "no Chrome on this machine" is not a defect in the app.
 */

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const failures: string[] = [];
let checks = 0;

function check(ok: boolean, label: string, detail = ""): void {
  checks++;
  if (ok) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function note(message: string): void {
  console.log(`  note  ${message}`);
}

// ---------------------------------------------------------------------------
// the DOM questions asked of each page
// ---------------------------------------------------------------------------

/**
 * One evaluation per page, returning everything the assertions need.
 *
 * The provider buttons are read via `visibleText`, which skips `aria-hidden`
 * subtrees: a monogram tile is aria-hidden decoration, so it must not appear in
 * the name a screen reader announces.
 */
const SNAPSHOT = `(() => {
  const visibleText = (el) => {
    let out = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.textContent;
      else if (node.nodeType === 1 && node.getAttribute("aria-hidden") !== "true") {
        out += node.textContent;
      }
    }
    return out.split(/\\s+/).filter(Boolean).join(" ");
  };
  const group = document.querySelector("[role=group]");
  const live = document.querySelector("[role=status]");
  const field = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const labels = document.querySelectorAll('label[for="' + id + '"]');
    return {
      labelled: labels.length === 1,
      autoComplete: el.getAttribute("autocomplete"),
      autoCapitalize: el.getAttribute("autocapitalize"),
      type: el.getAttribute("type"),
    };
  };
  return {
    h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.trim()),
    email: field("email"),
    password: field("password"),
    confirm: field("confirm"),
    forms: document.querySelectorAll("form").length,
    groupLabel: group ? group.getAttribute("aria-label") : null,
    groupButtons: group ? group.querySelectorAll("button").length : 0,
    buttons: group
      ? [...group.querySelectorAll("button")].map((b) => ({
          text: visibleText(b),
          rawText: b.textContent.trim(),
          type: b.getAttribute("type"),
          busy: b.getAttribute("aria-busy"),
          glyphHidden: b.querySelector("[aria-hidden=true]")?.getAttribute("aria-hidden") ?? null,
        }))
      : [],
    strayProviderButtons: [...document.querySelectorAll("button")]
      .filter((b) => !b.closest("[role=group]") && visibleText(b).startsWith("Continue with")).length,
    alerts: [...document.querySelectorAll("[role=alert]")].map((a) => a.textContent.trim()),
    liveRegion: live ? { present: true, text: live.textContent, hidden: live.className.includes("sr-only") } : { present: false, text: "", hidden: false },
  };
})()`;

interface Snapshot {
  h1: string[];
  email: FieldView | null;
  password: FieldView | null;
  confirm: FieldView | null;
  forms: number;
  groupLabel: string | null;
  groupButtons: number;
  buttons: ButtonView[];
  strayProviderButtons: number;
  alerts: string[];
  liveRegion: { present: boolean; text: string; hidden: boolean };
}

interface FieldView {
  labelled: boolean;
  autoComplete: string | null;
  autoCapitalize: string | null;
  type: string | null;
}

interface ButtonView {
  text: string;
  rawText: string;
  type: string | null;
  busy: string | null;
  glyphHidden: string | null;
}

/** The structural rules the provider section has to obey at all times. */
function checkProviderSection(snapshot: Snapshot, configured: boolean): void {
  if (snapshot.groupButtons === 0) {
    check(
      snapshot.groupLabel === null,
      "no empty provider group is left behind"
    );
    if (!configured) {
      note(
        `${OAUTH_PROVIDERS.length} providers supported; none enabled in this project, so none are shown`
      );
    }
    return;
  }

  check(snapshot.groupLabel === "Continue with a provider", "provider group is labelled", String(snapshot.groupLabel));
  check(
    snapshot.buttons.every((button) => button.type === "button"),
    "provider buttons are type=button so they cannot submit the form"
  );
  check(
    snapshot.buttons.every((button) => button.busy !== null),
    "every provider button reports aria-busy"
  );
  check(
    snapshot.buttons.every((button) => button.glyphHidden === "true"),
    "the provider mark is aria-hidden, so it is not announced twice"
  );
  // A button whose label is not the catalogue's would mean the UI invented a
  // provider name — the one thing that must never drift from the catalogue.
  const known = new Set(OAUTH_PROVIDERS.map((p) => `Continue with ${oauthLabel(p)}`));
  check(
    snapshot.buttons.every((button) => known.has(button.text)),
    "every provider button is named by the catalogue",
    JSON.stringify(snapshot.buttons.map((b) => b.text))
  );
  check(
    snapshot.liveRegion.present && snapshot.liveRegion.text === "",
    "the redirect announcement is mounted and quiet at rest"
  );
  note(`${snapshot.groupButtons} provider button(s) rendered: ${snapshot.buttons.map((b) => b.text).join(", ")}`);
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

async function checkLogin(page: Page, base: string): Promise<void> {
  console.log("\n/login — as this project is configured");
  page.resetErrors();
  await page.load(`${base}/login`);

  const snapshot = await page.evaluate<Snapshot>(SNAPSHOT);
  check(snapshot.h1.length === 1 && snapshot.h1[0] === "Sign in", "renders one h1", JSON.stringify(snapshot.h1));
  check(snapshot.forms === 1, "renders one form", String(snapshot.forms));
  check(snapshot.email?.labelled === true, "the email field is labelled", JSON.stringify(snapshot.email));
  check(
    snapshot.email?.autoComplete === "email" && snapshot.email?.autoCapitalize === "none",
    "the email field is a usable autofill target",
    JSON.stringify(snapshot.email)
  );
  check(
    snapshot.password?.autoComplete === "current-password",
    "the password field asks for the current password",
    JSON.stringify(snapshot.password)
  );
  checkProviderSection(snapshot, false);
  check(
    snapshot.strayProviderButtons === 0,
    "no provider button rendered outside the group",
    String(snapshot.strayProviderButtons)
  );
  check(page.consoleErrors().length === 0, "no console errors", page.consoleErrors().join(" | "));
}

async function checkSignup(page: Page, base: string): Promise<void> {
  console.log("\n/signup — as this project is configured");
  page.resetErrors();
  await page.load(`${base}/signup`);

  const snapshot = await page.evaluate<Snapshot>(SNAPSHOT);
  check(snapshot.h1.length === 1 && snapshot.h1[0] === "Open an account", "renders one h1", JSON.stringify(snapshot.h1));
  check(snapshot.forms === 1, "renders one form", String(snapshot.forms));
  check(snapshot.email?.labelled === true, "the email field is labelled", JSON.stringify(snapshot.email));
  check(
    snapshot.password?.autoComplete === "new-password" && snapshot.confirm?.autoComplete === "new-password",
    "both password fields ask for a new password",
    JSON.stringify([snapshot.password, snapshot.confirm])
  );
  check(snapshot.password?.type === "password", "the password is not rendered in the clear");
  checkProviderSection(snapshot, false);
  check(page.consoleErrors().length === 0, "no console errors", page.consoleErrors().join(" | "));
}

/**
 * The callback sends failures back to /login as `?error=…`, and for a long time
 * the page ignored it — a failed OAuth round trip returned the user to a screen
 * that explained nothing. It has to say something actionable, and it must not
 * hand the visitor the provider's internal wording.
 */
async function checkCallbackError(page: Page, base: string): Promise<void> {
  console.log("\n/login?error=missing_code — a failed OAuth round trip");
  page.resetErrors();
  await page.load(`${base}/login?error=missing_code`);

  const snapshot = await page.evaluate<Snapshot>(SNAPSHOT);
  const alert = snapshot.alerts.join(" ");
  check(snapshot.alerts.length === 1, "the failure is announced in an alert", JSON.stringify(snapshot.alerts));
  check(/try again/i.test(alert), "the message says what to do", alert.slice(0, 120));
  check(!alert.includes("missing_code"), "the raw parameter is not shown to the visitor");
  check(page.consoleErrors().length === 0, "no console errors", page.consoleErrors().join(" | "));
}

/**
 * The branch that cannot be reached without real OAuth credentials: providers
 * enabled. `Fetch.fulfillRequest` answers the settings request with a canned
 * payload for this navigation only, so the app, the build and the project's
 * own Auth configuration are all untouched.
 */
const STUB_PROVIDERS: OAuthProviderId[] = ["google", "github", "discord"];
const STUB_SETTINGS = JSON.stringify({
  external: {
    email: true,
    phone: false,
    anonymous_users: false,
    saml_enabled: true,
    // Enabled ones, in and out of the catalogue's order.
    discord: true,
    google: true,
    github: true,
    // Present but switched off.
    spotify: false,
    // Switched on but not offered: `workos` needs a per-call connection id, and
    // `snapchat` is not a provider this app labels.
    workos: true,
    snapchat: true,
  },
});

async function checkProvidersEnabled(page: Page, base: string): Promise<void> {
  console.log("\n/login — with google, github and discord reported as enabled (stubbed)");

  await page.send("Fetch.enable", {
    patterns: [{ urlPattern: "*/auth/v1/settings*", requestStage: "Request" }],
  });
  page.on("Fetch.requestPaused", (params) => {
    const { requestId, request } = params as unknown as {
      requestId: string;
      request: { method?: string; url?: string };
    };
    const method = request?.method ?? "GET";
    const url = request?.url ?? "";
    if (!url.includes("/auth/v1/settings")) {
      void page.send("Fetch.continueRequest", { requestId });
      return;
    }
    // The app sends `apikey`, which is not a CORS-safelisted header, so the
    // browser preflights this fetch. A synthesized response still goes through
    // the browser's CORS check, so the preflight has to be answered with the
    // headers that allow the real request — without them the promise never
    // settles and the buttons silently never appear.
    const cors = [
      { name: "access-control-allow-origin", value: "*" },
      { name: "access-control-allow-headers", value: "*" },
      { name: "access-control-allow-methods", value: "GET, OPTIONS" },
    ];
    const fulfilled =
      method === "OPTIONS"
        ? page.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 204,
            responseHeaders: cors,
          })
        : page.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [...cors, { name: "content-type", value: "application/json" }],
            body: Buffer.from(STUB_SETTINGS, "utf8").toString("base64"),
          });
    // A rejected protocol call would otherwise be an unhandled rejection and
    // the request would stay paused forever.
    fulfilled.catch((error: Error) => {
      console.error(`  note  stub could not answer ${method} ${url}: ${error.message}`);
    });
  });

  try {
    page.resetErrors();
    await page.load(`${base}/login`, { settleMs: 300 });

    // The list arrives from an effect, so wait for it rather than sleeping.
    const appeared = await page.waitFor(
      `document.querySelectorAll("[role=group] button").length === ${STUB_PROVIDERS.length}`
    );
    const snapshot = await page.evaluate<Snapshot>(SNAPSHOT);

    check(appeared, `${STUB_PROVIDERS.length} enabled providers render a button each`, String(snapshot.groupButtons));
    // Catalogue order, not the payload's order, and nothing for the providers
    // that are off, unlabelled or impossible as a bare button.
    check(
      JSON.stringify(snapshot.buttons.map((b) => b.text)) ===
        JSON.stringify(STUB_PROVIDERS.map((p) => `Continue with ${oauthLabel(p)}`)),
      "buttons are named and ordered by the catalogue",
      JSON.stringify(snapshot.buttons.map((b) => b.text))
    );
    checkProviderSection(snapshot, true);
    check(
      snapshot.buttons.every((b) => !b.rawText.includes("Continue with Continue")),
      "the mark does not duplicate the label",
      JSON.stringify(snapshot.buttons.map((b) => b.rawText))
    );
    check(snapshot.liveRegion.present && snapshot.liveRegion.hidden, "the live region is present and visually hidden");
    check(page.consoleErrors().length === 0, "no console errors", page.consoleErrors().join(" | "));
  } finally {
    page.off("Fetch.requestPaused");
    await page.send("Fetch.disable");
  }
}

// ---------------------------------------------------------------------------
// signed-in pages (opt-in: they create a real account in the configured project)
// ---------------------------------------------------------------------------

/**
 * The DOM questions asked of the shell and the desk pages.
 *
 * `stat()` finds a labelled readout by its caption and returns the figure
 * beside it, which is how the dashboard's bank of numbers is read back. `leaks`
 * collects every white-space-separated token on the page that looks like a UUID,
 * so a page can be asked whether it is handing out raw identifiers.
 */
const SHELL_SNAPSHOT = `(() => {
  const caption = (label) =>
    [...document.querySelectorAll("div.caption")].find((c) => c.textContent.trim() === label) ?? null;
  const stat = (label) => {
    const el = caption(label);
    if (!el) return null;
    const figure = el.parentElement ? el.parentElement.querySelector("div.mono") : null;
    return figure ? figure.textContent.trim() : null;
  };
  const current = [...document.querySelectorAll("[aria-current=page]")];
  const looksLikeUuid = (token) =>
    token.length === 36 && token[8] === "-" && token[13] === "-" && token[18] === "-" && token[23] === "-";
  const text = document.body.innerText;
  return {
    path: location.pathname,
    h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.trim()),
    navLabel: [...document.querySelectorAll("nav a")].map((a) => a.textContent.trim()),
    currentHrefs: current.map((a) => a.getAttribute("href")),
    signOut: [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign out"),
    stats: {
      equity: stat("Equity"),
      cash: stat("Cash"),
      totalPnl: stat("Total P&L"),
      ret: stat("Return"),
      gross: stat("Gross exposure"),
    },
    marginBadges: (() => {
      const section = [...document.querySelectorAll("section")].find(
        (s) => s.querySelector("h2") && s.querySelector("h2").textContent.trim() === "Margin"
      );
      return section ? [...section.querySelectorAll(".badge")].map((b) => b.textContent.trim()) : [];
    })(),
    sectionCaptions: [...document.querySelectorAll("section span.caption")].map((c) => c.textContent.trim()),
    // The first row of the book itself (the table with an "Avg entry" column),
    // not of whatever table renders above it, such as the risk ladder.
    firstRowCells: (() => {
      const book = [...document.querySelectorAll("table")].find((t) =>
        [...t.querySelectorAll("thead th")].some((th) => th.textContent.trim() === "Avg entry")
      ) ?? document.querySelector("table");
      const row = book ? book.querySelector("tbody tr") : null;
      return row ? [...row.querySelectorAll("td")].map((td) => td.textContent.trim()) : [];
    })(),
    bodyText: text,
    hasNaN: text.includes("NaN"),
    hasUndefined: text.includes("undefined"),

    tableRows: document.querySelectorAll("table tbody tr").length,
    tableHeaders: [...document.querySelectorAll("table thead th")].map((th) => th.textContent.trim()),
    tableText: [...document.querySelectorAll("table")].map((t) => t.innerText).join("\\n"),
    uuidTokensInTables: [...document.querySelectorAll("table")]
      .map((t) => t.innerText)
      .join(" ")
      .split(/\\s+/)
      .filter(looksLikeUuid),
  };
})()`;

interface ShellSnapshot {
  path: string;
  h1: string[];
  navLabel: string[];
  currentHrefs: string[];
  signOut: boolean;
  stats: {
    equity: string | null;
    cash: string | null;
    totalPnl: string | null;
    ret: string | null;
    gross: string | null;
  };
  marginBadges: string[];
  sectionCaptions: string[];
  firstRowCells: string[];
  bodyText: string;
  hasNaN: boolean;
  hasUndefined: boolean;
  uuidTokens: string[];
  tableRows: number;
  tableHeaders: string[];
  tableText: string;
  uuidTokensInTables: string[];
}

const NAV_SECTIONS = ["Desk", "Markets", "Portfolio", "Positions", "Blotter", "Analytics", "Rank"];
const MARGIN_TIERS = ["OK", "Warning", "Margin call", "Deficit"];

/** The desk's bank of readouts, by snapshot key and the label shown on screen. */
const READOUTS: Array<[keyof ShellSnapshot["stats"], string]> = [
  ["equity", "Equity"],
  ["cash", "Cash"],
  ["totalPnl", "Total P&L"],
  ["ret", "Return"],
  ["gross", "Gross exposure"],
];

/**
 * A dollar figure the formatter produced, not a placeholder or a broken number.
 *
 * The app's formatter trims trailing zeros — an untouched account reads
 * `$100,000`, a fill reads `$99,750.1` — so this deliberately does not require
 * a decimal point, only that the figure is a dollar amount and nothing else.
 */
function isMoney(value: string | null): boolean {
  if (value === null || !value.startsWith("$")) return false;
  const body = value.slice(1);
  return (
    body.length > 0 &&
    body.split("").every((character) => "0123456789,.".includes(character)) &&
    body.split(".").length <= 2
  );
}

/** The shell is on every signed-in page, so it is checked before the pages are. */
function checkShell(snapshot: ShellSnapshot, href: string): void {
  check(snapshot.path === href, `landed on ${href}`, snapshot.path);
  check(snapshot.h1.length === 1, "the page has exactly one h1", JSON.stringify(snapshot.h1));
  check(snapshot.signOut, "the shell knows there is a session (Sign out is offered)");

  const labels = new Set(snapshot.navLabel);
  const missing = NAV_SECTIONS.filter((label) => !labels.has(label));
  check(missing.length === 0, "every section is reachable from the nav", JSON.stringify(snapshot.navLabel));

  // Both the desktop and the mobile bar mark the current section, so this asks
  // that every marker agrees — one pointing at the wrong section is a bug even
  // when the other is right.
  check(snapshot.currentHrefs.length > 0, "the current section is marked for assistive tech");
  check(
    snapshot.currentHrefs.every((value) => value === href),
    `aria-current=page points at ${href}`,
    JSON.stringify(snapshot.currentHrefs)
  );
}

function checkNoRenderingNoise(snapshot: ShellSnapshot, page: Page, what: string): void {
  check(!snapshot.hasNaN, `${what} renders no NaN`, "");
  check(!snapshot.hasUndefined, `${what} renders no undefined`, "");
  check(page.consoleErrors().length === 0, `${what} logs no console errors`, page.consoleErrors().join(" | "));
}

/** Fills a React-controlled input, which needs the native setter, not `.value`. */
const SET_AND_SUBMIT = `(async (email, password) => {
  const setValue = (el, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor.set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  setValue(document.getElementById("email"), email);
  setValue(document.getElementById("password"), password);
  await new Promise((r) => setTimeout(r, 60));
  const submit = document.querySelector("form button[type=submit]");
  if (!submit) return "no submit button";
  submit.click();
  return "submitted";
})`;

async function signInThroughTheForm(page: Page, base: string, user: TestUser): Promise<boolean> {
  await page.load(`${base}/login`, { settleMs: 800 });
  const started = await page.evaluate<string>(
    `(${SET_AND_SUBMIT})(${JSON.stringify(user.email)}, ${JSON.stringify(user.password)})`
  );
  if (started !== "submitted") {
    check(false, "the sign-in form submits", started);
    return false;
  }
  return page.waitFor(`location.pathname === "/dashboard"`, 20_000);
}

/**
 * One market with a day-ahead hour ERCOT has cleared and delivered — the shape
 * a fill needs.
 *
 * Positions open only as day-ahead bids placed before 10:00 Central the day
 * before, and the order sweep fills them at the clearing (0038). So the check
 * finds an hour that cleared and finished delivering at least an hour ago, bids
 * on it from a replay clock set before its deadline, and moves the clock past
 * delivery, which sweeps the account. Discovered through the app's own read
 * APIs, so the check exercises the same series the trade panel shows. Times
 * are normalised to `Z`: the price API returns Postgres' `+00:00`, and the
 * order route validates a strict ISO datetime.
 */
const FIND_INTERVAL = `(async () => {
  const markets = await (await fetch("/api/markets")).json();
  for (const market of markets.markets ?? []) {
    const prices = await (
      await fetch(
        "/api/markets/" +
          encodeURIComponent(market.settlementPoint) +
          "/prices?product=DAM_HOURLY"
      )
    ).json();
    const interval = (prices.series ?? [])
      .filter((row) => new Date(row.deliveryEnd).getTime() < Date.now() - 3600000)
      .pop();
    if (interval) {
      return {
        ok: true,
        marketId: market.id,
        settlementPoint: market.settlementPoint,
        deliveryStart: new Date(interval.deliveryTimestamp).toISOString(),
        deliveryEnd: new Date(interval.deliveryEnd).toISOString(),
        price: interval.price,
        product: interval.product,
      };
    }
  }
  return { ok: false, reason: "no market has a cleared, delivered day-ahead hour" };
})()`;

/** A JSON request through the signed-in page, so it carries the session. */
const fetchJson = (path: string, method: string, body?: unknown) => `
  fetch(${JSON.stringify(path)}, {
    method: ${JSON.stringify(method)},
    headers: { "content-type": "application/json" },
    ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`}
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }))
`;

interface Interval {
  ok: boolean;
  reason?: string;
  marketId?: string;
  settlementPoint?: string;
  deliveryStart?: string;
  deliveryEnd?: string;
  price?: string;
  product?: string;
}

async function checkSignedIn(page: Page, base: string): Promise<void> {
  console.log("\nsigned-in pages — a real throwaway account");
  loadTestEnv();
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    note("skipped: this project has no Supabase credentials in .env to create an account with");
    return;
  }

  let user: TestUser;
  try {
    user = await createTestUser("browser-check");
  } catch (error) {
    note(
      `skipped: could not create a throwaway account (${error instanceof Error ? error.message : String(error)})`
    );
    return;
  }

  try {
    // A new account names itself on /welcome before the desk opens; this one
    // has nothing to choose, so it starts onboarded.
    const { error: onboardError } = await admin()
      .from("profiles")
      .update({ onboarded_at: new Date().toISOString() })
      .eq("id", user.id);
    check(!onboardError, "the throwaway account is onboarded", onboardError?.message ?? "");

    // 1. sign in the way a person does
    page.resetErrors();
    const signedIn = await signInThroughTheForm(page, base, user);
    check(signedIn, "signing in through the form reaches the desk", await page.evaluate<string>("location.pathname"));
    if (!signedIn) {
      note(`the sign-in form's own error: ${(await page.evaluate<string>("document.body.innerText")).slice(0, 200)}`);
      return;
    }

    // 2. the shell, and the desk
    await page.load(`${base}/dashboard`, { settleMs: 1500 });
    const dashboard = await page.evaluate<ShellSnapshot>(SHELL_SNAPSHOT);
    checkShell(dashboard, "/dashboard");
    check(dashboard.h1[0] === "Desk", "the desk is titled", JSON.stringify(dashboard.h1));
    for (const [key, label] of READOUTS) {
      check(dashboard.stats[key] !== null, `the ${label} readout renders`);
    }
    // A fresh account is exactly its starting cash: a placeholder here means the
    // portfolio snapshot failed to compute, which no HTTP status would show.
    const startingCash = dashboard.stats.cash;
    check(isMoney(startingCash), "cash reads as money, not as a placeholder", String(startingCash));
    check(isMoney(dashboard.stats.equity), "equity reads as money", String(dashboard.stats.equity));
    check(
      dashboard.stats.cash === dashboard.stats.equity,
      "a fresh account's equity equals its cash (nothing is marked yet)",
      `${dashboard.stats.cash} vs ${dashboard.stats.equity}`
    );
    check(
      dashboard.marginBadges.some((badge) => MARGIN_TIERS.includes(badge)),
      "the margin state renders one of the known tiers",
      JSON.stringify(dashboard.marginBadges)
    );
    check(
      dashboard.bodyText.includes("No open positions"),
      "the desk says so honestly when there is no book yet"
    );
    checkNoRenderingNoise(dashboard, page, "the desk");

    // 3. positions, before any trade
    await page.load(`${base}/positions`, { settleMs: 1200 });
    const emptyPositions = await page.evaluate<ShellSnapshot>(SHELL_SNAPSHOT);
    checkShell(emptyPositions, "/positions");
    check(emptyPositions.h1[0] === "Positions", "positions is titled", JSON.stringify(emptyPositions.h1));
    check(
      emptyPositions.bodyText.includes("No open positions"),
      "an empty book is an empty state, not a blank table"
    );
    checkNoRenderingNoise(emptyPositions, page, "positions");

    // 4. one real fill, the way the desk makes one: a day-ahead bid placed
    // before the deadline on a replay clock, filled by the sweep when the
    // clock moves past delivery. Replay runs on the practice desk — the live
    // account's clock is always live (0053) — so the live clock refuses first.
    // A virtual is margined, so cash does not move; the book does.
    type Reply = { status: number; body: Record<string, unknown> };
    const interval = await page.evaluate<Interval>(FIND_INTERVAL);
    if (!interval.ok) {
      note(`skipped the trade: ${interval.reason}`);
    } else {
      const refused = await page.evaluate<Reply>(
        fetchJson("/api/clock", "PUT", { to: new Date(Date.now() - 86_400_000).toISOString() })
      );
      check(refused.status === 422, "the live account's clock will not leave live", JSON.stringify(refused.body));
      const practice = await page.evaluate<Reply>(fetchJson("/api/desk", "PUT", { desk: "PRACTICE" }));
      check(practice.status === 200, "the practice desk opens", JSON.stringify(practice.body).slice(0, 200));
      const quantity = "10";
      const startMs = Date.parse(interval.deliveryStart!);
      const before = new Date(damDeadlineUtc(startMs)! - 3_600_000).toISOString();
      const rewound = await page.evaluate<Reply>(fetchJson("/api/clock", "PUT", { to: before }));
      check(rewound.status === 200, "the replay clock rewinds before the day's deadline", JSON.stringify(rewound.body));

      const bid = await page.evaluate<Reply>(
        fetchJson("/api/orders", "POST", {
          marketId: interval.marketId,
          instrument: "VIRTUAL",
          product: "DAM_HOURLY",
          side: "BUY",
          quantityMwh: quantity,
          deliveryStart: interval.deliveryStart,
          deliveryEnd: interval.deliveryEnd,
        })
      );
      check(bid.status === 201, `a ${quantity} MW DEC bids on ${interval.settlementPoint}`, JSON.stringify(bid.body).slice(0, 200));

      const after = new Date(Date.parse(interval.deliveryEnd!) + 600_000).toISOString();
      const advanced = await page.evaluate<Reply>(fetchJson("/api/clock", "PUT", { to: after }));
      check(advanced.status === 200, "the clock moves past delivery", JSON.stringify(advanced.body));
      const orders = await page.evaluate<Reply>(fetchJson("/api/orders", "GET"));
      const filled = (orders.body.orders as Array<{ status: string }> | undefined)?.[0]?.status === "FILLED";
      check(filled, "the sweep fills the bid at the clearing", JSON.stringify(orders.body).slice(0, 200));

      if (filled) {
        // 5. the position shows up, with the figures the fill returned
        await page.load(`${base}/positions`, { settleMs: 1200 });
        const withPosition = await page.evaluate<ShellSnapshot>(SHELL_SNAPSHOT);
        check(withPosition.tableRows >= 1, "the position appears as a row", String(withPosition.tableRows));
        check(
          withPosition.tableText.includes(String(interval.settlementPoint)),
          "the row names the market that was traded",
          String(interval.settlementPoint)
        );
        // The quantity column is the fifth; the unit is rendered beside the
        // figure, so this reads the cell rather than searching the page for a
        // number that occurs in half a dozen other places.
        check(
          withPosition.firstRowCells[4] === `${quantity} MWh`,
          `the row's quantity cell reads ${quantity} MWh`,
          JSON.stringify(withPosition.firstRowCells[4])
        );
        // Delivered and priced, but not settled until ERCOT's price is final
        // (0044) — or already settled, for an hour old enough.
        check(
          /Final |Settled|Settles next run/.test(withPosition.firstRowCells[3] ?? ""),
          "the row says where it stands against ERCOT's settlement",
          JSON.stringify(withPosition.firstRowCells[3])
        );
        check(
          withPosition.sectionCaptions.includes("1 position"),
          "the open book is counted as one position",
          JSON.stringify(withPosition.sectionCaptions)
        );
        checkNoRenderingNoise(withPosition, page, "positions with a book");

        // and the desk shows the book: a virtual is margined, so cash holds
        // and equity carries the position's P&L
        await page.load(`${base}/dashboard`, { settleMs: 1500 });
        const afterTrade = await page.evaluate<ShellSnapshot>(SHELL_SNAPSHOT);
        check(isMoney(afterTrade.stats.cash), "cash still reads as money", String(afterTrade.stats.cash));
        check(
          afterTrade.stats.cash === startingCash,
          "a margined fill leaves cash where it was",
          `${startingCash} -> ${afterTrade.stats.cash}`
        );
        check(
          !afterTrade.bodyText.includes("No open positions"),
          "the desk now shows the open book"
        );
        checkNoRenderingNoise(afterTrade, page, "the desk with a book");
      }

      // 5b. a working limit bid on the live desk: placed for the first day
      // still open, seen on the book, withdrawn before its deadline. Nothing
      // clears before the deadline, so it rests until it is cancelled.
      const live = await page.evaluate<Reply>(fetchJson("/api/desk", "PUT", { desk: "LIVE" }));
      check(live.status === 200, "back on the live desk", JSON.stringify(live.body));
      const he18 = hourEndingStartUtc(firstOpenOperatingDay(Date.now()), 18)!;
      const placedOrder = await page.evaluate<Reply>(
        fetchJson("/api/orders", "POST", {
          marketId: interval.marketId,
          instrument: "VIRTUAL",
          product: "DAM_HOURLY",
          side: "BUY",
          quantityMwh: "10",
          limitPrice: "34.56",
          deliveryStart: new Date(he18).toISOString(),
          deliveryEnd: new Date(he18 + 3_600_000).toISOString(),
        })
      );
      check(
        placedOrder.status === 201,
        "a working limit order places through the order API",
        JSON.stringify(placedOrder.body).slice(0, 200)
      );
      const orderId =
        placedOrder.status === 201 ? String(placedOrder.body.orderId) : null;

      await page.load(`${base}/orders`, { settleMs: 1200 });
      const orderBook = await page.evaluate<ShellSnapshot>(SHELL_SNAPSHOT);
      checkShell(orderBook, "/orders");
      check(
        orderBook.h1[0] === "Orders",
        "the order book is titled",
        JSON.stringify(orderBook.h1)
      );
      // innerText follows CSS text-transform, and card titles are upper-cased.
      check(
        /Working \(1\)/i.test(orderBook.bodyText),
        "the resting order appears on the book as open",
        (/Working \(\d+\)/i.exec(orderBook.bodyText) ?? ["no working section"])[0]
      );
      // A bought virtual is a DEC, sized in MW per hour.
      const size = /\b10(\.0+)? MW\b/.test(orderBook.bodyText);
      check(
        orderBook.bodyText.includes("DEC") && size && orderBook.bodyText.includes("$34.56"),
        "the book's open row carries its side, size and limit",
        JSON.stringify({
          dec: orderBook.bodyText.includes("DEC"),
          size,
          limit: orderBook.bodyText.includes("$34.56"),
        })
      );

      if (orderId) {
        const cancelled = await page.evaluate<{ status: number; body: Record<string, unknown> }>(`
          fetch("/api/orders/" + ${JSON.stringify(orderId)}, {
            method: "DELETE"
          }).then(async (res) => ({ status: res.status, body: await res.json() }))
        `);
        check(
          cancelled.status === 200 && cancelled.body.cancelled === true,
          "the open order cancels through the cancel API",
          JSON.stringify(cancelled.body).slice(0, 200)
        );

        await page.load(`${base}/orders`, { settleMs: 1200 });
        const afterCancel = await page.evaluate<ShellSnapshot>(SHELL_SNAPSHOT);
        check(
          !/Working \(/i.test(afterCancel.bodyText),
          "the cancelled order leaves the working set"
        );
        check(
          afterCancel.bodyText.includes("CANCELLED"),
          "the book's history records the cancellation"
        );
      }
    }

    // 6. the standings, which must not leak who anyone is
    await page.load(`${base}/leaderboard`, { settleMs: 1200 });
    const board = await page.evaluate<ShellSnapshot>(SHELL_SNAPSHOT);
    checkShell(board, "/leaderboard");
    check(board.h1[0] === "Rank", "the leaderboard is titled", JSON.stringify(board.h1));
    check(
      ["Rank", "Trader", "Equity", "Return", "Positions", "Trades"].every((header) =>
        board.tableHeaders.includes(header)
      ),
      "the standings carry their columns",
      JSON.stringify(board.tableHeaders)
    );
    check(
      board.tableRows > 0 || board.bodyText.includes("Nobody has joined the standings yet"),
      "the standings are either populated or say so"
    );
    // What must not leak is inside the table, so these read the table and not
    // the whole page — the signed-in user's own address is on their own screen
    // by design (the nav shows it), which is not a leak.
    //
    // `get_leaderboard` returns a raw `user_id` per row and the page uses it
    // only as a React key, so the check is asserted by value rather than by
    // pattern, with a shape scan to catch any *other* account's id.
    check(!board.tableText.includes(user.email), "no account email is rendered in the standings");
    check(!board.tableText.includes(user.id), "no raw user id is rendered in the standings");
    check(
      board.uuidTokensInTables.length === 0,
      "no UUID is rendered anywhere in the standings",
      JSON.stringify(board.uuidTokensInTables.slice(0, 3))
    );
    checkNoRenderingNoise(board, page, "the standings");
  } finally {
    // A leaked account is a real problem, so a failure to delete is reported as
    // one rather than logged and forgotten.
    try {
      await cleanupTestUsers();
      check(true, "the throwaway account was deleted");
    } catch (error) {
      check(false, "the throwaway account was deleted", error instanceof Error ? error.message : String(error));
    }
  }
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

async function waitForServer(base: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/login`);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

async function startServer(port: number): Promise<ChildProcess> {
  // Node runs Next's own entry point rather than the `node_modules/.bin` shim:
  // the shim is a `.cmd` on Windows, so it goes through cmd.exe and re-splits
  // the command on the space in a path like "ERCOT paper trading".
  const next = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [next, "start", "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (chunk) => (log += chunk));
  child.stderr?.on("data", (chunk) => (log += chunk));
  return child;
}


function parseFlags(argv: string[]) {
  const flags = {
    url: undefined as string | undefined,
    headed: false,
    chrome: undefined as string | undefined,
    signedIn: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") flags.url = argv[++i];
    else if (argv[i] === "--headed") flags.headed = true;
    else if (argv[i] === "--signed-in") flags.signedIn = true;
    else if (argv[i] === "--chrome") flags.chrome = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  if (typeof WebSocket !== "function") {
    console.error(
      `this check needs Node 22+ for the built-in WebSocket (running ${process.version}).`
    );
    process.exit(1);
  }

  const chromePath = resolveChrome(flags.chrome);
  if (!chromePath) {
    console.log(
      "SKIPPED: no Chrome or Chromium found. Set CHROME_PATH to the browser binary to run\n" +
        "         the sign-in screen check (tried the usual Windows, macOS, Linux paths)."
    );
    return;
  }

  let server: ChildProcess | null = null;
  let chrome: ChildProcess | null = null;
  let profile = "";
  let socket: WebSocket | null = null;

  try {
    let base = flags.url?.replace(/\/+$/, "");
    if (!base) {
      if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
        console.error(
          "no production build to check. Run `npm run build` first, or point the check at a\n" +
            "running server with `npm run test:browser -- --url http://localhost:3000`."
        );
        process.exit(1);
      }
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      console.log(`starting the production server on ${base}`);
      server = await startServer(port);
      if (!(await waitForServer(base))) throw new Error(`the server never answered on ${base}`);
    } else {
      console.log(`using the server already running at ${base}`);
      if (!(await waitForServer(base, 5_000))) {
        throw new Error(`nothing is answering at ${base}`);
      }
    }

    console.log(`driving ${chromePath}`);
    const debugPort = await freePort();
    const launched = await launchChrome(chromePath, debugPort, flags.headed);
    chrome = launched.child;
    profile = launched.profile;
    const attached = await attachPage(debugPort);
    socket = attached.socket;

    await checkLogin(attached.page, base);
    await checkSignup(attached.page, base);
    await checkCallbackError(attached.page, base);
    await checkProvidersEnabled(attached.page, base);
    if (flags.signedIn) {
      await checkSignedIn(attached.page, base);
    } else {
      console.log(
        "\nnote  the signed-in pages (dashboard, positions, leaderboard) need an account:\n" +
          "      run with --signed-in to create a throwaway one, place a trade and check them."
      );
    }
  } catch (error) {
    failures.push("the check itself failed to run");
    console.error(`\ncheck error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      socket?.close();
      if (chrome) killTree(chrome);
      if (server) killTree(server);
      if (profile) await removeProfile(profile);
    } catch (cleanupError) {
      // Never let tidying up change the verdict on the checks themselves.
      console.error(
        `note: could not clean up (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`
      );
    }
  }

  const passed = checks - failures.length;
  console.log(`\n${passed}/${checks} checks passed`);
  if (failures.length > 0) {
    console.log("failed:");
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("browser check failed to run:", error);
  process.exit(1);
});
