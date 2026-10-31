import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, oauthLabel, type OAuthProviderId } from "../src/lib/oauth";
import {
  cleanupTestUsers,
  createTestUser,
  loadTestEnv,
  type TestUser,
} from "../src/lib/testing/db";

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
 * through the *form*, places one real trade through the app's own HTTP API, and
 * deletes the account afterwards — the cascade takes its position and fills.
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
// chrome
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

function resolveChrome(explicit: string | undefined): string | null {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    ...CHROME_CANDIDATES,
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

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
// the DevTools Protocol
// ---------------------------------------------------------------------------

type CdpMessage = {
  id?: number;
  method?: string;
  params?: CdpParams;
  result?: Record<string, unknown>;
  error?: { message: string };
};

/**
 * Event parameters. The protocol shapes these per method, so a listener reads
 * the fields it expects and casts once, at the point it knows what arrived.
 */
type CdpParams = Record<string, unknown>;

/** A page target and the two protocol calls this check needs. */
class Page {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    (message: CdpMessage) => void
  >();
  private readonly listeners = new Map<string, (params: CdpParams) => void>();
  /** Console errors and uncaught exceptions since the last reset. */
  private errors: string[] = [];

  constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.method) {
        if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
          this.errors.push(describeArgs(message.params.args));
        }
        if (message.method === "Runtime.exceptionThrown") {
          const details = message.params?.exceptionDetails as
            | { exception?: { description?: string }; text?: string }
            | undefined;
          this.errors.push(
            details?.exception?.description ?? details?.text ?? "uncaught exception"
          );
        }
        this.listeners.get(message.method)?.(message.params ?? {});
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)!(message);
        this.pending.delete(message.id);
      }
    };
  }

  send(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result ?? {});
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: CdpParams) => void): void {
    this.listeners.set(method, handler);
  }

  off(method: string): void {
    this.listeners.delete(method);
  }

  resetErrors(): void {
    this.errors = [];
  }

  consoleErrors(): string[] {
    return [...this.errors];
  }

  /** Navigate, wait for the document, and give client effects a moment to land. */
  async load(url: string, { settleMs = 1200 } = {}): Promise<void> {
    await this.send("Page.navigate", { url });
    for (let i = 0; i < 60; i++) {
      const response = await this.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      const result = response.result as { value?: unknown } | undefined;
      if (result?.value === "complete") break;
      await sleep(250);
    }
    await sleep(settleMs);
  }

  /** `expression` must evaluate to JSON-serialisable data. */
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const result = response.result as { value?: unknown } | undefined;
    return result?.value as T;
  }

  /** Poll until `expression` is truthy, so a slow effect is not a failure. */
  async waitFor(expression: string, timeoutMs = 6000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return true;
      await sleep(200);
    }
    return false;
  }
}

function describeArgs(args: unknown): string {
  if (!Array.isArray(args)) return "console.error";
  return args
    .map((arg) => {
      const value = arg as { value?: unknown; description?: string };
      if (value?.description) return value.description;
      if (value?.value !== undefined) return String(value.value);
      return "?";
    })
    .join(" ");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port nothing is listening on, so two runs never collide. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Remove Chrome's throwaway profile.
 *
 * On Windows the profile directory stays locked for a moment after the process
 * tree is killed, so this retries and — importantly — never throws: the
 * directory lives in the temp folder, and a leftover one is untidy rather than
 * a reason to report a failing check.
 */
async function removeProfile(profile: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      await sleep(250 * (attempt + 1));
    }
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // Chrome and Next both fork; killing the launcher alone leaves the tree.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
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
    firstRowCells: (() => {
      const row = document.querySelector("table tbody tr");
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
 * One market with a future, priced interval — the shape a trade needs.
 *
 * Discovered through the app's own read APIs rather than by querying the
 * database, so the check exercises the same series the trade panel shows.
 * The DAY-AHEAD series is the one that reaches forward: under the actual-ERCOT
 * publication model the real-time series only print after delivery, and 0025
 * made them non-tradable — a check pinned to the API's RTM_HOURLY default
 * would find no future interval ever, and a ticket left on that default is
 * refused as PRODUCT_NOT_TRADABLE. Both tickets below therefore name the
 * instrument and the series the interval was found on. Both timestamps are
 * normalised to `Z`: the price API returns Postgres' `+00:00`, and the trade
 * route validates a strict ISO datetime.
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
    const interval = (prices.series ?? []).find(
      (row) => new Date(row.deliveryEnd).getTime() > Date.now()
    );
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
  return { ok: false, reason: "no market has a future-priced day-ahead interval" };
})()`;

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

    // 4. one real trade, through the app's own authenticated API
    const interval = await page.evaluate<Interval>(FIND_INTERVAL);
    if (!interval.ok) {
      note(`skipped the trade: ${interval.reason}`);
    } else {
      const quantity = "10";
      const placed = await page.evaluate<{ status: number; body: Record<string, unknown> }>(`
        fetch("/api/trades", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            marketId: ${JSON.stringify(interval.marketId)},
            instrument: "ENERGY_SPOT",
            product: ${JSON.stringify(interval.product)},
            side: "BUY",
            quantityMwh: ${JSON.stringify(quantity)},
            deliveryStart: ${JSON.stringify(interval.deliveryStart)},
            deliveryEnd: ${JSON.stringify(interval.deliveryEnd)},
            clientOrderId: "browser-check-" + Date.now()
          })
        }).then(async (res) => ({ status: res.status, body: await res.json() }))
      `);
      check(
        placed.status === 200,
        `a ${quantity} MWh buy executes against ${interval.settlementPoint}`,
        JSON.stringify(placed.body).slice(0, 200)
      );

      if (placed.status === 200) {
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
        check(
          withPosition.sectionCaptions.includes("1 position"),
          "the open book is counted as one position",
          JSON.stringify(withPosition.sectionCaptions)
        );
        checkNoRenderingNoise(withPosition, page, "positions with a book");

        // and the money moved: the desk's cash is no longer the starting figure
        await page.load(`${base}/dashboard`, { settleMs: 1500 });
        const afterTrade = await page.evaluate<ShellSnapshot>(SHELL_SNAPSHOT);
        check(isMoney(afterTrade.stats.cash), "cash still reads as money", String(afterTrade.stats.cash));
        check(
          afterTrade.stats.cash !== startingCash,
          "the fill moved cash on the desk",
          `${startingCash} -> ${afterTrade.stats.cash}`
        );
        check(
          !afterTrade.bodyText.includes("No open positions"),
          "the desk now shows the open book"
        );
        checkNoRenderingNoise(afterTrade, page, "the desk with a book");
      }

      // 5b. a working limit order: placed, seen on the book, cancelled. This
      // is the order route end to end through the app's own API — placement
      // commits to a price, not a fill, so nothing here depends on where the
      // feed head is; no sweep runs in this check, so the order stays open
      // until it is cancelled.
      const placedOrder = await page.evaluate<{ status: number; body: Record<string, unknown> }>(`
        fetch("/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            marketId: ${JSON.stringify(interval.marketId)},
            instrument: "ENERGY_SPOT",
            product: ${JSON.stringify(interval.product)},
            side: "BUY",
            quantityMwh: "10",
            limitPrice: "34.56",
            deliveryStart: ${JSON.stringify(interval.deliveryStart)},
            deliveryEnd: ${JSON.stringify(interval.deliveryEnd)}
          })
        }).then(async (res) => ({ status: res.status, body: await res.json() }))
      `);
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
      check(
        orderBook.bodyText.includes("Working (1)"),
        "the resting order appears on the book as open",
        JSON.stringify(orderBook.sectionCaptions)
      );
      check(
        orderBook.bodyText.includes("BUY") &&
          orderBook.bodyText.includes("10.00 MWh") &&
          orderBook.bodyText.includes("$34.56"),
        "the book's open row carries its side, size and limit",
        JSON.stringify({
          buy: orderBook.bodyText.includes("BUY"),
          size: orderBook.bodyText.includes("10.00 MWh"),
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
          !afterCancel.bodyText.includes("Working ("),
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

async function launchChrome(
  chromePath: string,
  debugPort: number,
  headed: boolean
): Promise<{ child: ChildProcess; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), "powerflow-browser-check-"));
  const child = spawn(
    chromePath,
    [
      "about:blank", // the URL is driven over the protocol, not the command line
      headed ? "--new-window" : "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
    ],
    { stdio: "ignore" }
  );

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (res.ok) return { child, profile };
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`Chrome did not open a debugging port at ${debugPort}`);
}

async function attachPage(debugPort: number): Promise<{ page: Page; socket: WebSocket }> {
  const targets = (await (
    await fetch(`http://127.0.0.1:${debugPort}/json/list`)
  ).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("Chrome exposed no page target");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("could not attach to the page target"));
  });

  const page = new Page(socket);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  return { page, socket };
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
