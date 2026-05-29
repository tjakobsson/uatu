// Shared Playwright setup, worker-scoped server fixture, and feature-test
// helpers. Tests import `{ test, expect }` from THIS file (not from
// `@playwright/test`) so each Playwright worker gets its own server on a
// distinct port + workspace path. `playwright.config.ts` therefore omits the
// global `webServer` config — the fixture below handles spawn/teardown.

import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { treeRow } from "./tree-helpers";

// Workers index 0..N-1; we offset off a base port so concurrent runs in the
// same shell don't fight each other.
const BASE_PORT = Number.parseInt(process.env.UATU_E2E_BASE_PORT ?? "4173", 10);

type WorkerFixtures = {
  /** The port the worker's dedicated server is listening on. */
  serverPort: number;
};

export const test = base.extend<{}, WorkerFixtures>({
  serverPort: [
    async ({}, use, workerInfo) => {
      const port = BASE_PORT + workerInfo.workerIndex;
      const workspace = path.resolve(
        process.cwd(),
        ".e2e",
        `watch-docs-w${workerInfo.workerIndex}`,
      );

      // CRITICAL: set env on the WORKER PROCESS too. `workspacePath()` is
      // called from test code (worker process), not the server child. If
      // only the server sees the env, the worker writes files to the
      // default `.e2e/watch-docs` while the server watches the per-worker
      // path — writes never reach the watcher.
      process.env.UATU_E2E_PORT = String(port);
      process.env.UATU_E2E_WORKSPACE = workspace;

      const child = spawn("bun", ["run", "tests/e2e/server.ts"], {
        env: {
          ...process.env,
          UATU_E2E_PORT: String(port),
          UATU_E2E_WORKSPACE: workspace,
        },
        stdio: ["ignore", "pipe", "inherit"],
      });

      // Wait for the "http://127.0.0.1:<port>" announce line on stdout.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`e2e server (worker ${workerInfo.workerIndex}) did not start within 30s`));
        }, 30_000);
        child.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes(`127.0.0.1:${port}`)) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.on("error", reject);
        child.on("exit", code => {
          clearTimeout(timeout);
          reject(new Error(`e2e server exited early (code ${code}) before announcing readiness`));
        });
      });

      await use(port);

      // Teardown. SIGTERM first; if it doesn't exit, SIGKILL.
      child.kill("SIGTERM");
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
    { scope: "worker", auto: true },
  ],

  // Pin `baseURL` to the worker's server so every page.goto / request hits
  // the right port without test code having to think about it.
  baseURL: async ({ serverPort }, use) => {
    await use(`http://127.0.0.1:${serverPort}`);
  },
});

export { expect };

// Standard per-test boot used by the vast majority of feature suites: reset
// the workspace, clear browser-side persisted preferences, wait for the tree
// to mount, and establish a clean baseline (README.md selected, follow off).
//
// Follow's boot state is non-deterministic because @pierre/trees can fire
// `onSelectionChange` asynchronously after our synchronous programmatic-
// update guard closes, occasionally flipping follow to false via Rule A.
// Rather than assert a specific boot state, normalize to follow=false by
// clicking the chip if and only if it's currently `aria-pressed="true"`.
// Either way the assertion below locks the deterministic post-state in.
export async function standardBeforeEach(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  await page.goto("/");
  // Clear browser-side persisted preferences so a prior test cannot leak
  // state into this one. localStorage persists across tests within the same
  // Playwright worker; the workspace reset above does not touch the browser.
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await page.reload();
  // Tree rows are rendered inside `@pierre/trees`' shadow DOM with
  // `role="treeitem"` and `data-item-path` — Playwright pierces the shadow
  // root automatically when given a CSS selector.
  await expect(treeRow(page, "README.md")).toBeVisible();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#document-count")).toHaveText("18 files");
  await waitForPreviewToSettle(page);
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  // Normalize follow to off — click the chip iff it's currently on.
  const pressed = await page.locator("#follow-toggle").getAttribute("aria-pressed");
  if (pressed === "true") {
    await page.locator("#follow-toggle").click();
  }
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
}

export async function waitForPreviewToSettle(page: Page): Promise<void> {
  let previousPath = "";

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const currentPath = (await page.locator("#preview-path").textContent())?.trim() ?? "";
    if (currentPath.length > 0 && currentPath === previousPath) {
      await page.waitForTimeout(300);

      const settledPath = (await page.locator("#preview-path").textContent())?.trim() ?? "";
      if (settledPath === currentPath) {
        return;
      }
    }

    previousPath = currentPath;
    await page.waitForTimeout(150);
  }
}

export function sidebarPanesFitVisibleHeight(page: Page): () => Promise<boolean> {
  return async () =>
    page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".sidebar-body");
      const panes = Array.from(document.querySelectorAll<HTMLElement>(".sidebar-pane:not([hidden])"));
      if (!body || panes.length === 0) {
        return false;
      }
      const bodyBox = body.getBoundingClientRect();
      const lastPaneBox = panes.at(-1)?.getBoundingClientRect();
      return Boolean(lastPaneBox && lastPaneBox.bottom <= bodyBox.bottom + 1);
    });
}
