import assert from "node:assert/strict";
import { chromium, webkit } from "@playwright/test";
import { buildWorkspaceAssets, startReviewServer, type ApprovedAsset } from "./server";

// Test launcher only: compile the ORIGINAL production entry, not another UI or
// the review coordinator, and serve it through the same isolated protocol double.
const built = await Bun.build({ entrypoints: [new URL("../../src/index.html", import.meta.url).pathname], target: "browser", define: { __UATU_BUILD__: JSON.stringify({ version: "review", branch: "synthetic", commitSha: "0000000", commitShort: "0000000", buildTime: "2026-07-02T00:00:00Z", release: false }) } });
if (!built.success) throw new AggregateError(built.logs, "Standalone product build failed");
const assets = new Map<string, ApprovedAsset>(await buildWorkspaceAssets());
for (const output of built.outputs) assets.set(`/${output.path.replace(/^.*\//, "")}`, { body: output, type: output.type });
const server = await startReviewServer({ port: 0, assets });
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const touch of [false, true]) {
        const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: touch, hasTouch: touch, serviceWorkers: "block" });
        try {
          const page = await context.newPage();
          const requests: string[] = [], errors: string[] = [];
          page.on("request", r => requests.push(new URL(r.url()).pathname));
          page.on("pageerror", e => errors.push(e.message));
          await page.goto(`${server.url}/README.md`);
          await page.locator("#preview").getByText("Synthetic review document").waitFor();
          assert.equal(await page.locator("#mobile-hub-root, .mh-coordinator-frame, iframe").count(), 0);
          assert.equal(await page.locator("html").getAttribute("data-workspace-foreground"), null);
          assert.equal(await page.locator("html").getAttribute("data-ui-mode"), touch ? "touch" : "desktop");
          assert.equal(await page.locator("#navigation-hub").isVisible(), false);
          assert(requests.includes("/api/state"));
          assert(!requests.some(path => path.startsWith("/review/") || path.startsWith("/s/") || path.startsWith("/api/hub/")));
          if (touch) {
            await page.evaluate(() => window.__uatuFind?.search());
            assert.equal(await page.locator("html").getAttribute("data-active-tab"), "files");
          } else {
            assert.equal(await page.locator("#touch-tab-bar").isVisible(), false);
            assert.equal(await page.locator("#navigation-handle").isVisible(), false);
            assert.equal(await page.locator(".app-shell").evaluate(el => getComputedStyle(el).display), "grid");
          }
          assert.deepEqual(errors, []);
          console.info(`${engine.name()} standalone ${touch ? "touch" : "desktop"}: PASS`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} finally { server.stop(); }
