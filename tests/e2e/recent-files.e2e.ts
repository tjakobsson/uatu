import { expect, test as baseTest, type Page, type APIRequestContext } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { promises as fs } from "node:fs";
import { workspacePath } from "./config";
import { treeRow } from "./tree-helpers";

const test = withEngineBrowsers(baseTest);
attachPageDiagnosticsOnFailure(test);
test.afterEach(async ({ request }) => { await request.post("/__e2e/reset"); });

async function boot(page: Page, request: APIRequestContext, git = false): Promise<void> {
  await request.post("/__e2e/reset", { data: { follow: false, git } });
  await page.addInitScript(() => {
    const Native = window.EventSource;
    (window as any).__recentWrites = {};
    (window as any).__recentRemovals = [];
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("live", event => {
          const frame = JSON.parse((event as MessageEvent).data);
          if (frame.topic !== "document" || frame.event?.kind !== "data") return;
          const update = frame.event.data;
          for (const doc of update.upserts ?? []) (window as any).__recentWrites[doc.relativePath] = doc.mtimeMs;
          for (const ref of update.removals ?? []) (window as any).__recentRemovals.push(ref.id);
        });
      }
    };
  });
  await page.goto("/");
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#document-count")).not.toHaveText("0");
}
const recentRow = (page: Page, path: string) => page.locator(`#recent-files button[data-path="${path}"]`);

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: Files switches retain the Pierre instance, expansion, query, and empty selection`, async ({ launchBrowser, serverPort, request }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await boot(page, request);
    const initialCount = await page.locator("#document-count").textContent();
    await treeRow(page, "guides/").click();
    await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#document-count")).toHaveText(initialCount!);
    await page.evaluate(() => { (window as any).__originalTree = (document.querySelector("#tree") as any).__pierreFileTree; });
    await page.locator("#files-pane-filter-recent").click();
    await page.locator("#files-query").fill(" GUIDES\\SETUP ");
    await expect(page.locator("#document-count")).toHaveAttribute("aria-label", "1 file");
    await expect(page.locator("#document-count")).toHaveAccessibleName("1 file");
    await expect(page.locator("#recent-files button")).toHaveCount(1);
    await expect(recentRow(page, "guides/setup.md")).toHaveAccessibleName(/last written .*T/);
    await page.locator("#files-pane-filter-all").click();
    await expect(treeRow(page, "guides/setup.md")).toBeVisible();
    await expect(page.locator("#document-count")).toHaveText("1");
    await page.locator("#files-query-clear").click();
    await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "true");
    await treeRow(page, "guides/setup.md").click();
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await treeRow(page, "guides/").click();
    await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "false");
    const emptyUrl = page.url();
    await page.locator("#files-pane-filter-recent").click();
    await page.locator("#files-pane-filter-changed").click();
    await expect(page.locator("#tree-empty-message")).toBeVisible();
    await page.locator("#files-pane-filter-all").click();
    await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "false");
    expect(page.url()).toBe(emptyUrl);
    expect(await page.evaluate(() => (window as any).__originalTree === (document.querySelector("#tree") as any).__pierreFileTree)).toBe(true);
    await expect(page.locator('[data-item-selected="true"]')).toHaveCount(0);
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
    await browser.close();
  });

  test(`${engine}: a write or deletion between press and release cannot activate a replacement row`, async ({ launchBrowser, serverPort, request }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await boot(page, request);
    await page.locator("#files-pane-filter-recent").click();
    const original = recentRow(page, "README.md");
    await expect(original).toBeVisible();
    const box = await original.boundingBox(); expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 80, box!.y + 20); await page.mouse.down();
    const fresh = new Date(Date.now() + 60000);
    await fs.utimes(workspacePath("guides", "setup.md"), fresh, fresh);
    await expect.poll(() => page.evaluate(() => (window as any).__recentWrites["guides/setup.md"] ?? 0)).toBeGreaterThan(Date.now() + 30000);
    expect((await original.boundingBox())!.y).toBe(box!.y);
    await page.mouse.up();
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expect(page.locator("#recent-files button").first()).toHaveAttribute("data-path", "guides/setup.md");

    const before = page.url();
    const deleted = recentRow(page, "guides/setup.md");
    const deletedBox = await deleted.boundingBox();
    await page.mouse.move(deletedBox!.x + 80, deletedBox!.y + 20); await page.mouse.down();
    await fs.rm(workspacePath("guides", "setup.md"));
    await expect.poll(() => page.evaluate(() => (window as any).__recentRemovals.some((id: string) => id.endsWith("/guides/setup.md")))).toBe(true);
    await page.mouse.up();
    await expect(deleted).toHaveCount(0);
    expect(page.url()).toBe(before);
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await browser.close();
  });

  test(`${engine}: touch pointer holds the file mapping and navigation opens Preview`, async ({ launchBrowser, serverPort, request }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}`, hasTouch: true, viewport: { width: 375, height: 812 } });
    await boot(page, request);
    await page.evaluate(() => { document.documentElement.dataset.uiMode = "touch"; });
    await page.locator('[data-tab="files"]').click();
    await page.locator("#files-pane-filter-recent").tap();
    const original = recentRow(page, "README.md");
    await expect(original).toBeVisible();
    await original.dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true });
    const fresh = new Date(Date.now() + 60000);
    await fs.utimes(workspacePath("guides", "setup.md"), fresh, fresh);
    await expect.poll(() => page.evaluate(() => (window as any).__recentWrites["guides/setup.md"] ?? 0)).toBeGreaterThan(Date.now() + 30000);
    await expect(page.locator("#recent-files button").first()).toHaveAttribute("data-path", "README.md");
    // Dispatch the touch compatibility click in the same activation task.
    await original.evaluate(el => {
      el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, pointerType: "touch", bubbles: true }));
      (el as HTMLButtonElement).click();
    });
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expect(page.locator('[data-tab="preview"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
    await browser.close();
  });

  test(`${engine}: Changed query counts eligible files and the temporary active inclusion`, async ({ launchBrowser, serverPort, request }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await boot(page, request, true);
    await page.locator("#files-query").fill("setup.md");
    await treeRow(page, "guides/setup.md").click();
    await page.locator("#files-pane-filter-changed").click();
    await expect(page.locator("#document-count")).toHaveText("1");
    await expect(treeRow(page, "guides/setup.md")).toBeVisible();
    await page.locator("#files-query").fill("not-a-file");
    await expect(page.locator("#document-count")).toHaveAttribute("aria-label", "0 files");
    await page.locator("#files-query-clear").click();
    await expect(page.locator("#document-count")).not.toHaveText("0");
    expect(await page.locator("#document-count").textContent()).toMatch(/^\d+$/);
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await browser.close();
  });

  test(`${engine}: windowed results retain a lower scroll anchor and file focus after live reorder`, async ({ launchBrowser, serverPort, request }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await boot(page, request);
    await Promise.all(Array.from({ length: 250 }, (_, index) => fs.writeFile(workspacePath(`recent-${String(index).padStart(3, "0")}.txt`), "recent fixture\n")));
    await page.locator("#files-query").fill("recent-");
    await expect(page.locator("#document-count")).toHaveText("250");
    await page.locator("#files-pane-filter-recent").click();
    expect(await page.locator("#recent-files button").count()).toBeLessThan(40);
    await page.locator("#recent-files").evaluate(el => { el.scrollTop = 5600; });
    await expect.poll(() => page.locator("#recent-files .recent-file").first().evaluate(el => parseFloat((el as HTMLElement).style.top))).toBeGreaterThan(5000);
    const anchor = page.locator("#recent-files button").nth(5);
    const path = await anchor.getAttribute("data-path");
    await anchor.focus();
    const y = (await anchor.boundingBox())!.y;
    await fs.writeFile(workspacePath("recent-new.txt"), "new render\n");
    await expect(page.locator("#document-count")).toHaveText("251");
    const retained = recentRow(page, path!);
    await expect(retained).toBeFocused();
    expect(Math.abs((await retained.boundingBox())!.y - y)).toBeLessThan(2);
    expect(await page.locator("#recent-files").evaluate(el => el.scrollTop)).toBeGreaterThan(5000);
    // Even when a focused file moves outside the rendered window, focus
    // remains file-keyed without pulling the reader back to the top.
    const moved = new Date(Date.now() + 120000);
    await fs.utimes(workspacePath(path!), moved, moved);
    await expect.poll(() => page.evaluate(path => (window as any).__recentWrites[path] ?? 0, path!)).toBeGreaterThan(Date.now() + 60000);
    await expect(retained).toBeFocused();
    expect(await page.locator("#recent-files").evaluate(el => el.scrollTop)).toBeGreaterThan(5000);
    await retained.press("End");
    await expect(page.locator("#recent-files button").last()).toBeFocused();
    expect(await page.locator("#recent-files button").count()).toBeLessThan(40);
    await browser.close();
  });

  test(`${engine}: metadata search and visible age refresh do not fetch contents or reset the tree`, async ({ launchBrowser, serverPort, request }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await page.clock.install();
    await boot(page, request);
    await treeRow(page, "guides/").click();
    const now = await page.evaluate(() => Date.now());
    const written = new Date(now - 59000);
    await fs.utimes(workspacePath("guides", "setup.md"), written, written);
    await expect.poll(() => page.evaluate(() => (window as any).__recentWrites["guides/setup.md"] ?? 0)).toBeCloseTo(written.getTime(), -1);
    await page.locator("#files-query").fill("setup");
    await expect(treeRow(page, "guides/setup.md")).toBeVisible();
    await expect(page.locator('#tree [title^="Latest write."]')).toBeAttached();
    const requests: string[] = [];
    page.on("request", req => { if (/\/api\/(document|media|state|search)(?:\?|$)/.test(req.url())) requests.push(req.url()); });
    await page.clock.fastForward(30000);
    await expect(page.locator('#tree [title^="Latest write."]')).toHaveText(/1m/);
    await page.locator("#files-pane-filter-recent").click();
    await expect(recentRow(page, "guides/setup.md").locator("time")).toHaveText("1m");
    await page.clock.fastForward(86400000);
    await expect(recentRow(page, "guides/setup.md").locator("time")).toHaveText("1d");
    await page.locator("#files-pane-filter-all").click();
    await expect(page.locator('#tree [title^="Latest write."]')).toHaveText("◷");
    await page.locator("#files-query").fill("does not exist");
    await expect(page.locator("#document-count")).toHaveText("0");
    await expect(page.locator("#tree-empty-message")).toHaveText("No matching files.");
    await page.locator("#files-query-clear").click();
    expect(requests).toEqual([]);
    await browser.close();
  });

  test(`${engine}: Files controls fit 320px and phone widths`, async ({ launchBrowser, serverPort, request }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await boot(page, request);
    await page.evaluate(() => { document.documentElement.style.setProperty("--sidebar-width", "320px"); });
    expect(await page.locator('[data-pane-id="files"] > .pane-header').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 812 });
      await page.evaluate(() => { document.documentElement.dataset.uiMode = "touch"; });
      await page.locator('[data-tab="files"]').click();
      const header = page.locator('[data-pane-id="files"] > .pane-header');
      // Use the actual Files surface when touch mode is active.
      await page.locator("#files-pane-filter-recent").scrollIntoViewIfNeeded();
      const bounds = await header.boundingBox(); expect(bounds).not.toBeNull();
      for (const selector of ["#document-count", "#files-pane-filter-all", "#files-pane-filter-recent", "#files-pane-filter-changed", '[data-pane-hide="files"]']) {
        const box = await page.locator(selector).boundingBox(); expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
      }
    }
    await browser.close();
  });
}
