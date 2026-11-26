// Dev-bundle e2e: boots the REAL CLI from source WITHOUT NODE_ENV=production,
// so the session serves Bun's dev bundle — what `bun run dev` and every
// source-run hub serve. Every other suite runs the production bundle
// (`development: false` in tests/e2e/server.ts, NODE_ENV=production in
// base-path.e2e.ts), which scope-hoists modules: there an import cycle is
// harmless as long as module-scope code only reads hoisted function
// declarations. Bun's dev runtime instead hands each module its imports as
// objects, and an import still evaluating higher up a cycle is `null` until
// it finishes. A module-scope read of such an import (`lookup: fn` rather than
// `lookup: id => fn(id)`) then throws during evaluation and the shell never
// boots — which only this suite can see.
//
// Like base-path.e2e.ts, this file owns its server child, so it imports from
// @playwright/test directly instead of the worker fixture.

import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createReadyLineScanner } from "../../src/session-contract/spawn";
import { revealTreeRow, treeRow } from "./tree-helpers";

let child: ChildProcess | null = null;
let workspace = "";
let sessionUrl = "";

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "uatu-dev-bundle-e2e-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "README.md"), "# Dev Bundle\n\nhello from the dev bundle\n");

  const env = { ...process.env };
  delete env.NODE_ENV;
  child = spawn("bun", ["run", "src/cli.ts", "serve", workspace, "--no-open", "--no-watchdog", "--port", "0"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  sessionUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("uatu serve did not print a URL within 30s")), 30_000);
    const scanner = createReadyLineScanner();
    child!.stdout!.on("data", (chunk: Buffer) => {
      const ready = scanner.push(chunk.toString());
      if (ready) {
        clearTimeout(timeout);
        resolve(ready.text);
      }
    });
    child!.on("error", reject);
    child!.on("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`uatu serve exited early (code ${code})`));
    });
  });
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

test("the dev bundle evaluates every module and boots the shell", async ({ page }) => {
  // Bun's dev runtime catches a module-evaluation error and reports it to the
  // console (and its <bun-hmr> overlay) rather than as an uncaught page error.
  const evaluationErrors: string[] = [];
  page.on("pageerror", error => evaluationErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /\b(?:TypeError|ReferenceError)\b/.test(message.text())) {
      evaluationErrors.push(message.text());
    }
  });

  await page.goto(sessionUrl);
  // The dev bundle is what is under test, not the production chunks.
  await expect(page.locator('script[src*="/_bun/client/"]')).toHaveCount(1);
  try {
    await revealTreeRow(page, "README.md");
    await treeRow(page, "README.md").click({ timeout: 15_000 });
    await expect(page.locator("#preview")).toContainText("hello from the dev bundle");
  } finally {
    // A shell that never booted fails on the error that stopped it, not on
    // the timeout it causes.
    expect(evaluationErrors).toEqual([]);
  }
});
