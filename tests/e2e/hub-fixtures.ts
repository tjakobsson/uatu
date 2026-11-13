// Playwright setup for hub-served specs: a worker-scoped fixture that spawns
// tests/e2e/hub-server.ts (a real hub whose children are the e2e harness),
// a browser context signed in through the hub's /login form, and an
// EventSource ledger installed before any page script runs. Specs that go
// through a hub import `{ test, expect }` from THIS file; everything else
// keeps using ./fixtures.
//
// Ports: each worker's parallel slot gets a block of ports (the hub, then
// its children) from a range clear of the worker harness's and of real
// services; ports.ts has the allocation and why it follows the slot rather
// than workerIndex.

import { test as base, expect, type BrowserContext, type Page, type Request, type Response } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";

import type { HubE2EInfo, HubE2EWorkspace } from "./hub-server";
import { HUB_PORTS_PER_WORKER, hubPortBlock, waitForPortsFree } from "./ports";

const READY_PREFIX = "uatu-e2e-hub ";
const RESET_PREFIX = "uatu-e2e-hub-reset ";
const HUB_RESET_TIMEOUT_MS = 20_000;
const loginResetSerials = new WeakMap<HubE2EInfo, number>();

export type { HubE2EInfo, HubE2EWorkspace };

type HubProcess = {
  info: HubE2EInfo;
  // Puts the worker's hub back to its booted state (hub-server.ts
  // resetForTest) and resolves once it is.
  reset: () => Promise<void>;
  // Recreate only this disposable Hub listener and its dismissal store from disk;
  // keep child evidence/session cookies so browser restart recovery is observable.
  restartWorkerDismissals: () => Promise<void>;
};

type WorkerFixtures = {
  hubProcess: HubProcess;
  hub: HubE2EInfo;
};

type TestFixtures = {
  // A context whose cookie jar holds a hub session for `hub.user`.
  hubContext: BrowserContext;
  // Runs before every test: the hub is worker-scoped, and fullyParallel
  // orders a worker's tests differently from run to run, so nothing one
  // test leaves in it may reach the next.
  hubReset: void;
};

// Which workspaces the hub registers and starts, per spec file, through
// `test.use({ hubWorkspaces: ["alpha", "beta"] })`. Names must be
// slug-shaped ([a-z0-9-]): they are the workspace ids.
type WorkerOptions = {
  hubWorkspaces: string[];
  hubWorktrees: boolean;
  // Serve the credential API (token credentials) — see hub-server.ts.
  hubCredentials: boolean;
  // Observe the children's notification feeds and record pushes — see hub-server.ts.
  hubPush: boolean;
  // Serve Agent accounts over fake agent runtimes — see hub-server.ts.
  hubAgentAccounts: boolean;
  // Use production private child bootstrap for personal chat policy tests.
  hubChatPolicy: boolean;
  hubChatPolicyTrust: boolean;
  hubWorkerDismissals: boolean;
};

export const test = base.extend<TestFixtures, WorkerFixtures & WorkerOptions>({
  hubWorkspaces: [["alpha"], { option: true, scope: "worker" }],
  hubWorktrees: [false, { option: true, scope: "worker" }],
  hubCredentials: [false, { option: true, scope: "worker" }],
  hubPush: [false, { option: true, scope: "worker" }],
  hubAgentAccounts: [false, { option: true, scope: "worker" }],
  hubChatPolicy: [false, { option: true, scope: "worker" }],
  hubChatPolicyTrust: [true, { option: true, scope: "worker" }],
  hubWorkerDismissals: [false, { option: true, scope: "worker" }],

  hubProcess: [
    async ({ hubWorkspaces, hubWorktrees, hubCredentials, hubPush, hubAgentAccounts, hubChatPolicy, hubChatPolicyTrust, hubWorkerDismissals }, use, workerInfo) => {
      const { hubPort, end } = hubPortBlock(workerInfo.parallelIndex);
      if (hubWorkspaces.length >= HUB_PORTS_PER_WORKER) {
        throw new Error(`a hub worker serves at most ${HUB_PORTS_PER_WORKER - 1} workspaces`);
      }
      await waitForPortsFree(Array.from({ length: end - hubPort }, (_, offset) => hubPort + offset));
      const child = spawn("bun", ["run", "tests/e2e/hub-server.ts"], {
        env: {
          ...process.env,
          UATU_E2E_HUB_PORT: String(hubPort),
          UATU_E2E_HUB_CHILD_BASE_PORT: String(hubPort + 1),
          UATU_E2E_HUB_CHILD_PORT_END: String(end),
          UATU_E2E_HUB_WORKSPACES: hubWorkspaces.join(","),
          UATU_E2E_HUB_WORKTREES: hubWorktrees ? "1" : "0",
          UATU_E2E_HUB_CREDENTIALS: hubCredentials ? "1" : "0",
          UATU_E2E_HUB_AGENT_ACCOUNTS: hubAgentAccounts ? "1" : "0",
          UATU_E2E_HUB_CHAT_POLICY: hubChatPolicy ? "1" : "0",
          UATU_E2E_HUB_CHAT_POLICY_TRUST: hubChatPolicyTrust ? "1" : "0",
          UATU_E2E_HUB_WORKER_DISMISSALS: hubWorkerDismissals ? "1" : "0",
          UATU_E2E_HUB_PUSH: hubPush ? "1" : "0",
          UATU_E2E_EXIT_ON_STDIN_CLOSE: "1",
        },
        // stdin carries the per-test reset command; its close (this worker
        // gone, teardown or not) shuts the hub and its children down.
        stdio: ["pipe", "pipe", "inherit"],
      });

      const lines = new StdoutLines(child);
      const info = await new Promise<HubE2EInfo>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`hub e2e server (worker ${workerInfo.workerIndex}, port ${hubPort}) did not start within 60s`));
        }, 60_000);
        void lines.waitFor(line => line.startsWith(READY_PREFIX)).then(line => {
          clearTimeout(timeout);
          resolve(JSON.parse(line.slice(READY_PREFIX.length)) as HubE2EInfo);
        });
        child.on("error", reject);
        child.on("exit", code => {
          clearTimeout(timeout);
          reject(new Error(`hub e2e server (port ${hubPort}) exited early (code ${code}) before announcing readiness`));
        });
      });

      let serial = 0;
      loginResetSerials.set(info, serial);
      const reset = async () => {
        const id = ++serial;
        const answered = lines.waitFor(line => line.startsWith(`${RESET_PREFIX}${id} `));
        child.stdin!.write(`reset ${id}\n`);
        const line = await withTimeout(answered, HUB_RESET_TIMEOUT_MS, `hub e2e server did not reset within ${HUB_RESET_TIMEOUT_MS / 1000}s`);
        if (!line.endsWith(" ok")) throw new Error(`hub e2e reset failed: ${line}`);
        loginResetSerials.set(info, id);
      };

      const restartWorkerDismissals = async () => {
        if (!hubWorkerDismissals) throw new Error("worker dismissal fixture is not enabled");
        const id = ++serial;
        const answered = lines.waitFor(line => line.startsWith(`${RESET_PREFIX}${id} `));
        child.stdin!.write(`restart-worker-dismissals ${id}\n`);
        const line = await withTimeout(answered, HUB_RESET_TIMEOUT_MS, "disposable Hub listener/store restart timed out");
        if (!line.endsWith(" ok")) throw new Error(`disposable Hub restart failed: ${line}`);
      };
      await use({ info, reset, restartWorkerDismissals });

      await stopChild(child);
    },
    { scope: "worker" },
  ],

  hub: [
    async ({ hubProcess }, use) => {
      await use(hubProcess.info);
    },
    { scope: "worker" },
  ],

  hubReset: [
    async ({ hubProcess }, use) => {
      await hubProcess.reset();
      await use();
    },
    // Its own budget, outside the test's: restarting the children is setup,
    // and on a loaded machine it would otherwise eat the test's 30 s.
    { auto: true, timeout: HUB_RESET_TIMEOUT_MS + 5_000 },
  ],

  baseURL: async ({ hub }, use) => {
    await use(hub.origin);
  },

  hubContext: async ({ browser, hub, contextOptions }, use) => {
    const context = await browser.newContext(contextOptions);
    await installEventSourceLedger(context);
    const page = await context.newPage();
    await signIn(page, hub);
    await page.close();
    await use(context);
    await context.close();
  },
});

export { expect };

// Signs the page's context in through the hub's login form — the path a
// browser takes — and lands on the dashboard.
export async function signIn(page: Page, hub: HubE2EInfo): Promise<void> {
  const started = performance.now();
  const steps: Record<string, number> = {};
  const mark = (step: string) => { steps[step] = Math.round(performance.now() - started); };
  type Category = "invalid_credentials" | "rate_limit" | "missing_fields" | "unknown";
  type Attempt = {
    pathname: "/login"; atMs: number; postedPairMatchesFixture: boolean | null;
    responseSeen: boolean; status: number | null; redirectToRoot: boolean;
    responseCategory: Category; pending: boolean; failed: boolean; responseAtMs?: number;
  };
  const requests = new WeakMap<Request, Attempt>();
  const attempts: Attempt[] = [];
  let requestCount = 0;
  let filled: { username: boolean; password: boolean } | null = null;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (request.method() !== "POST" || url.origin !== hub.origin || url.pathname !== "/login") return;
    requestCount++;
    if (attempts.length >= 4) return;
    let matches: boolean | null = null;
    try {
      const form = new URLSearchParams(request.postData() ?? "");
      matches = form.get("name") === hub.user.name && form.get("password") === hub.user.password;
    } catch { /* Observations never replace the login outcome. */ }
    const attempt: Attempt = { pathname: "/login", atMs: Math.round(performance.now() - started), postedPairMatchesFixture: matches,
      responseSeen: false, status: null, redirectToRoot: false, responseCategory: "unknown", pending: true, failed: false };
    requests.set(request, attempt);
    attempts.push(attempt);
  };
  const onResponse = (response: Response) => {
    const attempt = requests.get(response.request());
    if (!attempt) return;
    attempt.responseSeen = true;
    attempt.status = response.status();
    attempt.responseAtMs = Math.round(performance.now() - started);
    attempt.responseCategory = attempt.status === 401 ? "invalid_credentials" : attempt.status === 429 ? "rate_limit" : "unknown";
    try {
      const location = response.headers().location;
      const redirect = location ? new URL(location, hub.origin) : null;
      attempt.redirectToRoot = redirect?.origin === hub.origin && redirect.pathname === "/";
    } catch { /* Retain only the redirect comparison, never the header. */ }
  };
  const onFinished = (request: Request) => { const attempt = requests.get(request); if (attempt) attempt.pending = false; };
  const onFailed = (request: Request) => { const attempt = requests.get(request); if (attempt) { attempt.pending = false; attempt.failed = true; } };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  const detachListeners = () => {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  };
  try {
    mark("gotoStarted");
    await page.goto(`${hub.origin}/login`);
    mark("gotoFinished");
    await page.locator('input[name="name"]').fill(hub.user.name);
    mark("usernameFilled");
    await page.locator('input[name="password"]').fill(hub.user.password);
    mark("passwordFilled");
    // Immediate DOM read only: no new readiness condition or login wait.
    filled = await page.evaluate(({ name, password }) => ({
      username: document.querySelector<HTMLInputElement>('input[name="name"]')?.value === name,
      password: document.querySelector<HTMLInputElement>('input[name="password"]')?.value === password,
    }), hub.user).catch(() => null);
    mark("clickStarted");
    await page.locator('form button[type="submit"], form input[type="submit"]').first().click();
    mark("clickFinished");
    await expect(page).toHaveURL(`${hub.origin}/`);
  } catch (error) {
    mark("failed");
    detachListeners();
    try {
      const info = test.info();
      // Bounded in-memory attachment only: a stalled renderer or async attach
      // must not delay the original error or leave a late capture continuation.
      info.attachments.push({ name: "hub-login-failure", contentType: "application/json", body: Buffer.from(JSON.stringify({
        workerIndex: info.workerIndex, parallelIndex: info.parallelIndex, resetSerial: loginResetSerials.get(hub) ?? null,
        steps, filledUsernameMatchesFixture: filled?.username ?? null, filledPasswordMatchesFixture: filled?.password ?? null,
        requestCount, requests: attempts, domCategory: "unknown", currentPathname: new URL(page.url()).pathname,
        responseSeen: attempts.some(attempt => attempt.responseSeen),
        requestPending: attempts.some(attempt => attempt.pending), pageClosed: page.isClosed(),
      })) });
    } catch { /* Attachment/closed-page failures must preserve the original assertion. */ }
    throw error;
  } finally {
    detachListeners();
  }
}

// Records every EventSource a page constructs, as the URL it was opened
// with, and forgets it on close() — so a test can assert what a page holds
// open, not merely what it opened. Read with `openEventSources(page)`.
export async function installEventSourceLedger(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const open = new Map<EventSource, string>();
    const Native = window.EventSource;
    const Wrapped = function (this: EventSource, url: string | URL, init?: EventSourceInit) {
      const source = new Native(url, init);
      open.set(source, String(url));
      const close = source.close.bind(source);
      source.close = () => {
        open.delete(source);
        close();
      };
      return source;
    } as unknown as typeof EventSource;
    Wrapped.prototype = Native.prototype;
    Object.defineProperty(Wrapped, "CONNECTING", { value: Native.CONNECTING });
    Object.defineProperty(Wrapped, "OPEN", { value: Native.OPEN });
    Object.defineProperty(Wrapped, "CLOSED", { value: Native.CLOSED });
    window.EventSource = Wrapped;
    (window as unknown as { __uatuOpenEventSources: () => string[] }).__uatuOpenEventSources = () => [...open.values()];
  });
}

export function openEventSources(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __uatuOpenEventSources?: () => string[] }).__uatuOpenEventSources?.() ?? []);
}

// Drives a workspace's fake chat through the child's own control route.
export async function childChatControl(workspace: HubE2EWorkspace, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${workspace.childOrigin}/s/${encodeURIComponent(workspace.id)}/__e2e/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`chat control ${JSON.stringify(body)} failed for '${workspace.id}': ${response.status}`);
  }
  return response.json();
}

// Opens a session tab and waits for the shell to be live: tree mounted,
// the brokered stream confirmed, the default document rendered.
export async function openSessionTab(context: BrowserContext, workspace: HubE2EWorkspace): Promise<Page> {
  const page = await context.newPage();
  await page.goto(workspace.sessionUrl);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  return page;
}

// Opens the workspace switcher and waits until it has settled. Opening
// renders the menu at once and refreshes the hub list in the background,
// re-rendering on the answer; acting on an entry before that answer races
// the re-render. `tap` opens it the way a touch user does.
export async function openHubMenu(page: Page, options: { tap?: boolean } = {}): Promise<void> {
  const menu = page.locator("#hub-menu");
  if (await menu.isVisible()) return;
  const toggle = page.locator("#hub-toggle");
  await expect(toggle).toBeVisible();
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/hub/state");
  if (options.tap) await toggle.tap();
  else await toggle.click();
  await refreshed;
  await expect(menu).toBeVisible();
}

// The hub's stdout, split into lines, each delivered to the first waiter
// whose predicate it satisfies.
class StdoutLines {
  private buffered = "";
  private readonly waiters: { match: (line: string) => boolean; resolve: (line: string) => void }[] = [];

  constructor(child: ChildProcess) {
    child.stdout!.on("data", (chunk: Buffer) => {
      this.buffered += chunk.toString();
      let newline = this.buffered.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        newline = this.buffered.indexOf("\n");
        const index = this.waiters.findIndex(waiter => waiter.match(line));
        if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(line);
      }
    });
  }

  waitFor(match: (line: string) => boolean): Promise<string> {
    return new Promise(resolve => this.waiters.push({ match, resolve }));
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
