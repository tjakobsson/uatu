// Base-path e2e: boots the REAL CLI (`uatu serve --base-path /s/e2e/`) —
// not the e2e harness server — so the production shell relocation (Bun
// HTMLBundle chunk rewriting, meta injection) is what's under test, and
// drives the core flows through the prefix: shell boot, /api/state, document
// selection with prefixed pushState URLs, SSE live reload, terminal auth,
// and the outside-prefix 404 wall.
//
// This file deliberately imports from @playwright/test directly: it owns its
// own server child (the compiled-from-source CLI) instead of the worker
// fixture's harness server.

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { revealTreeRow, treeRow } from "./tree-helpers";

const BASE_PATH = "/s/e2e/";

let child: ChildProcess | null = null;
let workspace = "";
let sessionUrl = "";
let origin = "";

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "uatu-base-path-e2e-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "README.md"), "# Base Path\n\nhello from the prefix\n");
  await writeFile(path.join(workspace, "other.md"), "# Other\n\nsecond document\n");

  child = spawn(
    "bun",
    ["run", "src/cli.ts", "serve", workspace, "--no-open", "--no-watchdog", "--port", "0", "--base-path", BASE_PATH],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );

  sessionUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("uatu serve did not print a URL within 30s")), 30_000);
    let buffered = "";
    child!.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = buffered.match(/http:\/\/[^\s]+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    child!.on("error", reject);
    child!.on("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`uatu serve exited early (code ${code})`));
    });
  });

  origin = new URL(sessionUrl).origin;
});

test.afterAll(async () => {
  child?.kill("SIGTERM");
  if (child) {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        child?.kill("SIGKILL");
        resolve();
      }, 2_000);
      child!.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the printed session URL carries the base path", () => {
  expect(new URL(sessionUrl).pathname).toBe(BASE_PATH);
});

test("the SPA boots under the prefix and loads state", async ({ page }) => {
  await page.goto(sessionUrl);
  await expect(page.locator(".sidebar")).toBeVisible();
  // The injected boot value reached the client.
  await expect(page.locator('meta[name="uatu-base-path"]')).toHaveAttribute("content", BASE_PATH);
  // The tree rendered from /s/e2e/api/state.
  await revealTreeRow(page, "README.md");
  await expect(treeRow(page, "README.md")).toBeVisible();
});

test("selecting a document produces a prefixed pushState URL and deep links resolve", async ({ page }) => {
  await page.goto(sessionUrl);
  await revealTreeRow(page, "other.md");
  await treeRow(page, "other.md").click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}other\\.md$`));
  await expect(page.locator("#preview")).toContainText("second document");

  // Direct-link arrival at the prefixed document URL.
  await page.goto(`${origin}${BASE_PATH}README.md`);
  await expect(page.locator("#preview")).toContainText("hello from the prefix");
});

test("SSE live reload works through the prefix", async ({ page }) => {
  await page.goto(sessionUrl);
  await revealTreeRow(page, "README.md");
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview")).toContainText("hello from the prefix");

  await writeFile(path.join(workspace, "README.md"), "# Base Path\n\nlive reloaded content\n");
  await expect(page.locator("#preview")).toContainText("live reloaded content", { timeout: 15_000 });
});

test("requests outside the prefix are 404", async ({ request }) => {
  const state = await request.get(`${origin}/api/state`);
  expect(state.status()).toBe(404);
  const doc = await request.get(`${origin}/README.md`, { headers: { accept: "text/html" } });
  expect(doc.status()).toBe(404);
  // The root too: the raw HTMLBundle must not leak an unrelocated shell.
  const root = await request.get(`${origin}/`, { headers: { accept: "text/html" } });
  expect(root.status()).toBe(404);
});

test("terminal auth promotes the token to a base-path-scoped cookie", async ({ request }) => {
  const token = new URL(sessionUrl).searchParams.get("t");
  test.skip(!token, "terminal backend unavailable — no token in the session URL");

  const response = await request.post(`${origin}${BASE_PATH}api/auth`, {
    data: { token },
  });
  expect(response.status()).toBe(200);
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toContain(`Path=${BASE_PATH}`);

  // The same endpoint outside the prefix does not exist.
  const outside = await request.post(`${origin}/api/auth`, { data: { token } });
  expect(outside.status()).toBe(404);
});

test("the manifest and service worker are relocated under the prefix", async ({ request }) => {
  const manifestResponse = await request.get(`${origin}${BASE_PATH}manifest.webmanifest`);
  expect(manifestResponse.status()).toBe(200);
  const manifest = (await manifestResponse.json()) as { start_url: string; scope: string };
  expect(manifest.start_url).toBe(BASE_PATH);
  expect(manifest.scope).toBe(BASE_PATH);

  const sw = await request.get(`${origin}${BASE_PATH}sw.js`);
  expect(sw.status()).toBe(200);
  expect(sw.headers()["service-worker-allowed"]).toBe(BASE_PATH);
});
