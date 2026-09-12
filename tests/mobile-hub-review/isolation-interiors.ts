import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "@playwright/test";
import { buildWorkspaceAssets, startReviewServer, type ApprovedAsset } from "./server";
import { evidence, buildIdentity } from "./isolation-audit";
import { pixels } from "./isolation-browser";

await mkdir(evidence, { recursive: true });
const integratedAssets = await buildWorkspaceAssets();
const original = await Bun.build({ entrypoints: [new URL("../../src/index.html", import.meta.url).pathname], target: "browser", define: { __UATU_BUILD__: JSON.stringify(buildIdentity) } });
assert(original.success, original.logs.map(String).join("\n"));
const standaloneAssets = new Map<string, ApprovedAsset>(integratedAssets);
for (const asset of original.outputs) standaloneAssets.set(`/${asset.path.replace(/^.*\//, "")}`, { body: asset, type: asset.type });
const servers: Awaited<ReturnType<typeof startReviewServer>>[] = [];
const results: unknown[] = [];
try {
  servers.push(await startReviewServer({ port: 0, assets: standaloneAssets }));
  servers.push(await startReviewServer({ port: 0, assets: integratedAssets }));
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const captures: Buffer[] = [], signatures: unknown[] = [];
      for (const [i, variant] of ["standalone", "integrated"].entries()) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: "light", reducedMotion: "reduce", serviceWorkers: "block" });
        try {
          const page = await context.newPage(); page.setDefaultTimeout(10000);
          const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
          await page.goto(`${servers[i]!.url}${i ? "/s/atlas" : ""}/README.md`);
          await page.locator("#preview").getByText("Synthetic review document").waitFor();
          await page.evaluate(() => document.fonts.ready);
          // Compare only the actual document interior. Selector/handle/pill are
          // intentional overlay changes and are not removed or restyled here.
          const interior = page.locator("#preview .markdown-body");
          const target = await interior.count() ? interior : page.locator("#preview");
          signatures.push(await target.evaluate(el => {
            const style = getComputedStyle(el), box = el.getBoundingClientRect();
            return { text: el.textContent, tag: el.tagName, className: el.className, width: box.width, height: box.height, font: style.font, color: style.color, background: style.backgroundColor, padding: style.padding, border: style.border, children: [...el.children].map(child => ({ tag: child.tagName, text: child.textContent, font: getComputedStyle(child).font })) };
          }));
          const capture = await target.screenshot({ animations: "disabled" }); captures.push(capture);
          await writeFile(new URL(`${engine.name()}-${variant}-interior.png`, evidence), capture);
          await writeFile(new URL(`${engine.name()}-${variant}-workspace.png`, evidence), await page.screenshot({ animations: "disabled" }));
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
      assert.deepEqual(signatures[0], signatures[1], "Coordinator changed synthetic document interior structure/style/geometry");
      const page = await browser.newPage();
      try {
        const comparison = await pixels(page, captures[0]!, captures[1]!);
        assert.equal(comparison.changedPixels, 0, "Coordinator changed current standalone interior pixels");
        results.push({ browser: engine.name(), version: browser.version(), comparison, signatures, scope: "Preview document interior, same current source/data/font/viewport; not prechange pixel equivalence or Chat/Terminal interior coverage" });
      } finally { await page.close(); }
    } finally { await browser.close(); }
  }
} finally { for (const server of servers) server.stop(); }
await writeFile(new URL("interior-results.json", evidence), JSON.stringify(results, null, 2) + "\n");
console.info("PASS: current standalone versus integrated Preview interior exact style/structure/geometry/pixels in Chromium and WebKit; ephemeral listeners stopped.");
