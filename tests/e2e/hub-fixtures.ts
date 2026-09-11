// Playwright setup for hub-served specs: a worker-scoped fixture that spawns
// tests/e2e/hub-server.ts (a real hub whose children are the e2e harness),
// a browser context signed in through the hub's /login form, and an
// EventSource ledger installed before any page script runs. Specs that go
// through a hub import `{ test, expect }` from THIS file; everything else
// keeps using ./fixtures.
//
// Ports: the worker harness fixture takes 4173+workerIndex. Hubs start at
// 4300 and each worker gets a block of ten (hub + up to nine children), so
// the two families can never meet however many workers run.

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";

import type { HubE2EInfo, HubE2EWorkspace } from "./hub-server";

const HUB_BASE_PORT = Number.parseInt(process.env.UATU_E2E_HUB_BASE_PORT ?? "4300", 10);
const PORTS_PER_WORKER = 10;
const READY_PREFIX = "uatu-e2e-hub ";

export type { HubE2EInfo, HubE2EWorkspace };

type WorkerFixtures = {
  hub: HubE2EInfo;
};

type TestFixtures = {
  // A context whose cookie jar holds a hub session for `hub.user`.
  hubContext: BrowserContext;
};

// Which workspaces the hub registers and starts, per spec file, through
// `test.use({ hubWorkspaces: ["alpha", "beta"] })`. Names must be
// slug-shaped ([a-z0-9-]): they are the workspace ids.
type WorkerOptions = {
  hubWorkspaces: string[];
};

export const test = base.extend<TestFixtures, WorkerFixtures & WorkerOptions>({
  hubWorkspaces: [["alpha"], { option: true, scope: "worker" }],

  hub: [
    async ({ hubWorkspaces }, use, workerInfo) => {
      const hubPort = HUB_BASE_PORT + workerInfo.workerIndex * PORTS_PER_WORKER;
      if (hubWorkspaces.length >= PORTS_PER_WORKER) {
        throw new Error(`a hub worker serves at most ${PORTS_PER_WORKER - 1} workspaces`);
      }
      const child = spawn("bun", ["run", "tests/e2e/hub-server.ts"], {
        env: {
          ...process.env,
          UATU_E2E_HUB_PORT: String(hubPort),
          UATU_E2E_HUB_CHILD_BASE_PORT: String(hubPort + 1),
          UATU_E2E_HUB_WORKSPACES: hubWorkspaces.join(","),
        },
        stdio: ["ignore", "pipe", "inherit"],
      });

      const info = await new Promise<HubE2EInfo>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`hub e2e server (worker ${workerInfo.workerIndex}) did not start within 60s`));
        }, 60_000);
        let buffered = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          buffered += chunk.toString();
          const line = buffered.split("\n").find(candidate => candidate.startsWith(READY_PREFIX));
          if (line) {
            clearTimeout(timeout);
            resolve(JSON.parse(line.slice(READY_PREFIX.length)) as HubE2EInfo);
          }
        });
        child.on("error", reject);
        child.on("exit", code => {
          clearTimeout(timeout);
          reject(new Error(`hub e2e server exited early (code ${code}) before announcing readiness`));
        });
      });

      await use(info);

      await stopChild(child);
    },
    { scope: "worker" },
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
  await page.goto(`${hub.origin}/login`);
  await page.locator('input[name="name"]').fill(hub.user.name);
  await page.locator('input[name="password"]').fill(hub.user.password);
  await page.locator('form button[type="submit"], form input[type="submit"]').first().click();
  await expect(page).toHaveURL(`${hub.origin}/`);
}

// Records every EventSource a page constructs, as the URL it was opened
// with, and forgets it on close() — so a test can assert what a page holds
// open, not merely what it opened. Read with `openEventSources(page)`.
async function installEventSourceLedger(context: BrowserContext): Promise<void> {
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
