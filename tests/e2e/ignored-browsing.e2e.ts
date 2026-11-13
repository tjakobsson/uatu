import { promises as fs } from "node:fs";
import { expect, test as baseTest, type APIRequestContext, type Page } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { workspacePath } from "./config";
import { treeRow } from "./tree-helpers";

const test = withEngineBrowsers(baseTest);
attachPageDiagnosticsOnFailure(test);
const ignoredPath = "aa-local-export.md";
const visiblePath = "aa-visible.md";
const exceptionPath = "aa-exception.md";
const deniedPath = "aa-exposure-denied.md";
const recentRow = (page: Page, path: string) => page.locator(`#recent-files button[data-path="${path}"]`);

test.afterEach(async ({ request }) => { await request.post("/__e2e/reset"); });

async function seed(request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset", { data: {
    git: true, respectGitignore: false, follow: false,
    extras: {
      ".gitignore": `${ignoredPath}\n${exceptionPath}\n${deniedPath}\n`,
      [ignoredPath]: "# Local export\n\nPermitted ignored contents.\nSearchVisibilityProbe\n",
      [visiblePath]: "# Visible file\n",
      [exceptionPath]: "# Visibility exception\n",
      [deniedPath]: "Never exposed\n",
    },
    dirty: { [visiblePath]: "# Visible file\n\nWorking tree edit.\nSearchVisibilityProbe\n" },
    uatuConfig: { ignore: { exclude: [`!${exceptionPath}`, deniedPath] } },
  } });
  // Require real indexed classification, not a mocked state response or Git
  // repository badge. The UI must work before/independently of Git refresh.
  await expect.poll(async () => {
    const state = await request.get("/api/state").then(response => response.json());
    return state.roots.flatMap((root: any) => root.docs).find((doc: any) => doc.relativePath === ignoredPath)?.gitIgnoreStatus;
  }).toBe("ignored");
}

async function open(page: Page, path = "/"): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    (window as any).__ignoredStreams = 0;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        (window as any).__ignoredStreams++;
      }
    };
  });
  await page.goto(path);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#document-count")).not.toHaveText("0");
}

async function showIgnored(page: Page, checked: boolean): Promise<void> {
  const options = page.locator(".files-options-content");
  if (!(await options.evaluate(el => el.matches(":popover-open")))) await page.locator(".files-options-trigger").click();
  await page.getByRole("checkbox", { name: "Show ignored files" }).setChecked(checked);
}

async function search(page: Page, query: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await expect(page.locator("#search-query")).toBeVisible();
  await page.locator("#search-query").fill(query);
}

async function holdSearchStream(page: Page, request: APIRequestContext): Promise<void> {
  const state = await request.get("/api/state").then(response => response.json());
  const doc = state.roots.flatMap((root: any) => root.docs).find((doc: any) => doc.relativePath === ignoredPath);
  expect(doc).toBeDefined();
  await page.evaluate(doc => {
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== "/api/search" || url.searchParams.get("q") !== "HeldVisibilityProbe") return native(input, init);
      const encoder = new TextEncoder();
      const event = (line: number) => ({ kind: "file", result: { documentId: doc.id, rootId: doc.rootId, relativePath: doc.relativePath,
        matches: [{ line, text: "HeldVisibilityProbe", start: 0, end: 19, ordinal: line - 1, literalTotal: 2 }] } });
      // Deliberately ignores the AbortSignal, so ownership checks must also
      // reject chunks already queued/resolving when cancellation happens.
      init?.signal?.addEventListener("abort", () => { (window as any).__heldSearchAborted = true; });
      (window as any).__heldSearchAborted = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event(1))}\n`));
          (window as any).__releaseHeldSearch = () => {
            controller.enqueue(encoder.encode(`${JSON.stringify(event(2))}\n${JSON.stringify({ kind: "done", truncated: false })}\n`));
          };
        },
        cancel() { (window as any).__heldSearchCancelled = true; },
      });
      return Promise.resolve(new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } }));
    };
  }, doc);
}

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: content-search verdict follows ignored visibility without starting a new sweep from filename filtering`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page);
    const requests: URL[] = [];
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname === "/api/search") requests.push(url); });
    await search(page, "SearchVisibilityProbe");
    await expect(page.locator("#search-summary")).toHaveText("2 results · 2 files");
    await expect(page.locator("#search-results")).toContainText(ignoredPath);
    expect(requests[0]?.searchParams.get("showIgnored")).toBe("1");
    await showIgnored(page, false);
    await expect(page.locator("#search-results .search-hit")).toHaveCount(0);
    await expect(page.locator("#search-notice [data-search-rerun]")).toBeVisible();
    expect(requests).toHaveLength(1);
    await page.locator("#search-notice [data-search-rerun]").click();
    await expect(page.locator("#search-summary")).toHaveText("1 result · 1 file");
    await expect(page.locator("#search-results")).toContainText(visiblePath);
    await expect(page.locator("#search-results")).not.toContainText(ignoredPath);
    expect(requests[1]?.searchParams.get("showIgnored")).toBe("0");
    await page.locator("#files-query").fill("no-filenames-match");
    await expect(page.locator("#document-count")).toHaveText("0");
    await expect(page.locator("#search-summary")).toHaveText("1 result · 1 file");
    expect(requests).toHaveLength(2);
    await showIgnored(page, true);
    await expect(page.locator("#search-results .search-hit")).toHaveCount(0);
    expect(requests).toHaveLength(2);
    await browser.close();
  });

  test(`${engine}: visibility change cancels in-flight content search and rejects late old-context chunks`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page);
    await holdSearchStream(page, request);
    await search(page, "HeldVisibilityProbe");
    await expect(page.locator("#search-results .search-hit")).toHaveCount(1);
    await showIgnored(page, false);
    await expect(page.locator("#search-results .search-hit")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__heldSearchAborted)).toBe(true);
    await page.evaluate(() => (window as any).__releaseHeldSearch());
    await expect.poll(() => page.evaluate(() => (window as any).__heldSearchCancelled)).toBe(true);
    await expect(page.locator("#search-results .search-hit")).toHaveCount(0);
    await expect(page.locator("#search-notice")).toContainText("Files changed since this search");
    await browser.close();
  });

  test(`${engine}: metadata-only ignore reclassification removes stale results and revokes the streaming owner`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    await fs.writeFile(workspacePath(".gitignore"), `${exceptionPath}\n${deniedPath}\n`);
    await expect.poll(async () => (await request.get("/api/state").then(r => r.json())).roots.flatMap((root: any) => root.docs)
      .find((doc: any) => doc.relativePath === ignoredPath)?.gitIgnoreStatus).toBe("not-ignored");
    const before = await fs.stat(workspacePath(ignoredPath));
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page);
    await showIgnored(page, false);
    await page.locator("#files-query").fill(ignoredPath);
    await expect(page.locator("#document-count")).toHaveText("1");
    await holdSearchStream(page, request);
    await search(page, "HeldVisibilityProbe");
    await expect(page.locator("#search-results .search-hit")).toHaveCount(1);
    // Only ignore policy changes. The result file's write time/content do not.
    await fs.writeFile(workspacePath(".gitignore"), `${ignoredPath}\n${exceptionPath}\n${deniedPath}\n`);
    await expect(page.locator("#document-count")).toHaveText("0");
    await expect(page.locator("#search-results .search-hit")).toHaveCount(0);
    expect((await fs.stat(workspacePath(ignoredPath))).mtimeMs).toBe(before.mtimeMs);
    expect(await page.evaluate(() => (window as any).__heldSearchAborted)).toBe(true);
    await page.evaluate(() => (window as any).__releaseHeldSearch());
    await expect.poll(() => page.evaluate(() => (window as any).__heldSearchCancelled)).toBe(true);
    await expect(page.locator("#search-results .search-hit")).toHaveCount(0);
    await expect(page.locator("#search-notice [data-search-rerun]")).toBeVisible();
    await browser.close();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`${engine} ${colorScheme}: ignored rows use native muted styling without badges and remain selected/focused/readable`, async ({ launchBrowser, serverPort, request }) => {
      await seed(request);
      const browser = await launchBrowser(engine);
      const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}`, colorScheme });
      await open(page);
      await page.locator(".files-options-trigger").click();
      await expect(page.getByRole("checkbox", { name: "Show ignored files" })).toBeChecked();
      await page.locator(".files-options-trigger").click();
      await page.locator("#files-query").fill("aa-");
      await expect(page.locator("#document-count")).toHaveAccessibleName("3 files");
      const ignored = treeRow(page, ignoredPath);
      const visible = treeRow(page, visiblePath);
      await expect(ignored).toHaveAttribute("data-item-git-status", "ignored");
      await expect(visible).toHaveAttribute("data-item-git-status", "modified");
      await expect(ignored.locator('[data-item-section="git"]')).toHaveText("");
      await expect(ignored.locator('[data-item-section="icon"]')).toHaveCSS("opacity", "0.5");
      const ignoredColor = await ignored.locator('[data-item-section="content"]').evaluate(el => getComputedStyle(el).color);
      const visibleColor = await visible.locator('[data-item-section="content"]').evaluate(el => getComputedStyle(el).color);
      expect(ignoredColor).not.toBe(visibleColor);
      await ignored.focus();
      await expect(ignored).toBeFocused();
      await ignored.press("Enter");
      await expect(ignored).toHaveAttribute("aria-selected", "true");
      expect(await ignored.evaluate(el => getComputedStyle(el, "::before").outlineStyle)).toBe("solid");
      await expect(page.locator("#preview")).toContainText("Permitted ignored contents.");
      await expect(ignored.locator('[data-item-section="decoration"]')).not.toHaveText("");
      await page.locator("#files-pane-filter-recent").click();
      const recent = recentRow(page, ignoredPath);
      await expect(recent).toHaveClass(/is-ignored/);
      await expect(recent).toHaveAttribute("aria-current", "true");
      await recent.press("Home");
      await recent.focus();
      await expect(recent).toBeFocused();
      await expect(recent).toHaveCSS("outline-style", "solid");
      await expect(recent.locator(".recent-file-icon")).toHaveCSS("opacity", "0.55");
      await expect(recent.locator("time")).toHaveAttribute("aria-label", /Last written .*T/);
      await expect(recent).not.toHaveText(/ignored/i);
      const focus = await recent.evaluate(el => ({ color: getComputedStyle(el.querySelector(".recent-file-name")!).color,
        background: getComputedStyle(el).backgroundColor, outline: getComputedStyle(el).outlineColor }));
      expect(focus.color).not.toBe(focus.background);
      expect(focus.outline).not.toBe("rgba(0, 0, 0, 0)");
      await showIgnored(page, false);
      await expect(page.locator("#document-count")).toHaveAccessibleName("2 files");
      await expect(recentRow(page, ignoredPath)).toHaveCount(0);
      await expect(recentRow(page, exceptionPath)).toBeVisible();
      await expect(page.locator("#preview-path")).toHaveText(ignoredPath);
      await expect(page.locator("#preview")).toContainText("Permitted ignored contents.");
      await expect(page.locator("#files-query")).toHaveValue("aa-");
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
      for (const view of ["all", "changed", "recent"]) {
        await page.locator(`#files-pane-filter-${view}`).click();
        if (view === "recent") await expect(recentRow(page, ignoredPath)).toHaveCount(0);
        else await expect(treeRow(page, ignoredPath)).toHaveCount(0);
        await expect(page.locator("#preview-path")).toHaveText(ignoredPath);
      }
      expect(await page.evaluate(() => (window as any).__ignoredStreams)).toBe(1);
      await browser.close();
    });
  }

  test(`${engine}: hiding an open ignored file preserves direct access and rejects exposure exclusions`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page, `/${ignoredPath}`);
    await expect(page.locator("#preview-path")).toHaveText(ignoredPath);
    const url = page.url();
    const previewNode = await page.locator("#preview").evaluateHandle(el => el.firstElementChild);
    await showIgnored(page, false);
    await expect(treeRow(page, ignoredPath)).toHaveCount(0);
    expect(page.url()).toBe(url);
    expect(await page.locator("#preview").evaluate((el, child) => el.firstElementChild === child, previewNode)).toBe(true);
    const response = await request.get(`/${ignoredPath}`, { headers: { Accept: "*/*" } });
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain("Permitted ignored contents.");
    const denied = await request.get(`/${deniedPath}`, { headers: { Accept: "*/*" } });
    expect(denied.status()).toBe(404);
    await expect.poll(async () => (await request.get("/api/personal-state").then(r => r.json())).showIgnored).toBe(false);
    await page.reload();
    await expect(page.locator("#preview-path")).toHaveText(ignoredPath);
    await expect(treeRow(page, ignoredPath)).toHaveCount(0);
    await page.locator(".files-options-trigger").click();
    await expect(page.getByRole("checkbox", { name: "Show ignored files" })).not.toBeChecked();
    await showIgnored(page, true);
    await expect(treeRow(page, ignoredPath)).toHaveAttribute("aria-selected", "true");
    await browser.close();
  });

  test(`${engine}: Files options work by keyboard and at 320px touch width without navigation`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}`, hasTouch: true });
    await open(page);
    const url = page.url();
    await page.evaluate(() => {
      document.documentElement.dataset.uiMode = "desktop";
      document.documentElement.style.setProperty("--sidebar-width", "320px");
    });
    const summary = page.locator(".files-options-trigger");
    await summary.focus(); await summary.press("Enter");
    const checkbox = page.getByRole("checkbox", { name: "Show ignored files" });
    await expect(checkbox).toBeVisible();
    await checkbox.focus(); await checkbox.press("Escape");
    await expect(checkbox).toBeHidden(); await expect(summary).toBeFocused();
    await summary.press("Enter");
    await checkbox.focus(); await checkbox.press("Space");
    await expect(summary).toBeFocused();
    await expect(treeRow(page, ignoredPath)).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 812 });
    await page.evaluate(() => { document.documentElement.dataset.uiMode = "touch"; });
    await page.locator('[data-tab="files"]').tap();
    await summary.tap();
    const bounds = await page.locator(".files-options-content").boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await checkbox.tap();
    await expect(treeRow(page, ignoredPath)).toBeVisible();
    await expect(page.locator('[data-tab="files"]')).toHaveAttribute("aria-selected", "true");
    expect(page.url()).toBe(url);
    await browser.close();
  });

  test(`${engine}: two open clients retain independent visibility through live writes and later resume`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const first = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    const second = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(first); await open(second);
    await first.locator("#files-query").fill("aa-");
    await second.locator("#files-query").fill("aa-");
    await first.locator("#files-pane-filter-recent").click();
    await second.locator("#files-pane-filter-recent").click();
    await showIgnored(first, false);
    await expect(first.locator("#document-count")).toHaveText("2");
    await expect(second.locator("#document-count")).toHaveText("3");
    await expect(recentRow(second, ignoredPath)).toBeVisible();
    const previousWrite = await recentRow(second, ignoredPath).locator("time").getAttribute("datetime");
    await fs.writeFile(workspacePath(ignoredPath), "# Local export\n\nA newer ignored revision.\n");
    await expect.poll(async () => {
      const state = await request.get("/api/state").then(r => r.json());
      return state.roots.flatMap((root: any) => root.docs).find((doc: any) => doc.relativePath === ignoredPath)?.gitIgnoreStatus;
    }).toBe("ignored");
    await expect(recentRow(second, ignoredPath).locator("time")).not.toHaveAttribute("datetime", previousWrite!);
    await expect(recentRow(second, ignoredPath)).toHaveClass(/is-ignored/);
    await expect(recentRow(first, ignoredPath)).toHaveCount(0);
    await second.locator(".files-options-trigger").click();
    await expect(second.getByRole("checkbox", { name: "Show ignored files" })).toBeChecked();
    await expect.poll(async () => (await request.get("/api/personal-state").then(r => r.json())).showIgnored).toBe(false);
    const later = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(later, `/${ignoredPath}`);
    await later.locator(".files-options-trigger").click();
    await expect(later.getByRole("checkbox", { name: "Show ignored files" })).not.toBeChecked();
    await expect(later.locator("#preview")).toContainText("A newer ignored revision.");
    await expect(treeRow(later, ignoredPath)).toHaveCount(0);
    for (const page of [first, second]) expect(await page.evaluate(() => (window as any).__ignoredStreams)).toBe(1);
    await browser.close();
  });
}
