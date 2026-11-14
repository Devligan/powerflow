import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Chrome over the DevTools Protocol, with no browser framework: Chrome is
 * already on the machine, and Node has spoken the protocol's WebSocket since
 * v22. Used by the browser check (scripts/browser-check.ts).
 */

export const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

export function resolveChrome(explicit: string | undefined): string | null {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    ...CHROME_CANDIDATES,
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

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
export type CdpParams = Record<string, unknown>;

/** A page target and the two protocol calls this check needs. */
export class Page {
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

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port nothing is listening on, so two runs never collide. */
export async function freePort(): Promise<number> {
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
export async function removeProfile(profile: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      await sleep(250 * (attempt + 1));
    }
  }
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // Chrome and Next both fork; killing the launcher alone leaves the tree.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

export async function launchChrome(
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

export async function attachPage(debugPort: number): Promise<{ page: Page; socket: WebSocket }> {
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
