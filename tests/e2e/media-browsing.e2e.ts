import { promises as fs } from "node:fs";
import { expect, test as baseTest, showGitLogPane, type APIRequestContext, type Page } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { workspacePath } from "./config";
import { revealTreeRow, treeRow, waitForTreeIdle } from "./tree-helpers";
import { mp4Fixture, wavFixture } from "./media-fixtures";
import { captureScreenshot } from "./evidence";

const test = withEngineBrowsers(baseTest);
attachPageDiagnosticsOnFailure(test);
const a = "media-a.wav", b = "media-b.wav", ignored = "media-ignored.wav", video = "media-video.mp4";
const row = (page: Page, path: string) => page.locator(`#recent-files .recent-file:has(.recent-file-open[data-path="${path}"])`);
const play = (page: Page, path: string) => row(page, path).locator(".recent-file-play");
const nativeMedia = (page: Page) => page.locator("audio, video");
const activePath = (page: Page) => nativeMedia(page).evaluate((el: HTMLMediaElement) => new URL(el.currentSrc || el.src).searchParams.get("path"));

test.afterEach(async ({ request }) => { await request.post("/__e2e/reset"); });

async function seed(request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset", { data: { git: true, respectGitignore: false, follow: true,
    extras: { ".gitignore": `${ignored}\n`, "media-note.md": "# Media browsing\n" } } });
  const base = Date.now() - 60000;
  for (const [index, path] of [ignored, video, b, a].entries()) {
    await fs.writeFile(workspacePath(path), path.endsWith(".mp4") ? mp4Fixture() : wavFixture(30));
    const time = new Date(base + index * 1000);
    await fs.utimes(workspacePath(path), time, time);
  }
  await expect.poll(async () => {
    const state = await request.get("/api/state").then(r => r.json());
    const docs = state.roots.flatMap((root: any) => root.docs);
    return docs.filter((doc: any) => [a, b, ignored, video].includes(doc.relativePath)).length;
  }).toBe(4);
  await expect.poll(async () => (await request.get("/api/state").then(r => r.json())).roots.flatMap((root: any) => root.docs)
    .find((doc: any) => doc.relativePath === ignored)?.gitIgnoreStatus).toBe("ignored");
}

async function boot(page: Page): Promise<void> {
  const { token } = await page.request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#preview")).toContainText("This is a sample README");
  if (await page.locator('[data-tab="files"]').isVisible()) await page.locator('[data-tab="files"]').click();
  await page.locator("#files-query").fill("media-");
}

async function options(page: Page): Promise<void> {
  if (!(await page.locator("#files-options-popover").evaluate(el => el.matches(":popover-open")))) await page.locator(".files-options-trigger").click();
}
async function type(page: Page, value: "all" | "audio" | "video"): Promise<void> {
  await options(page);
  await page.getByLabel("File types", { exact: true }).selectOption(value);
  await page.locator(".files-options-trigger").click();
}
async function showIgnored(page: Page, checked: boolean): Promise<void> {
  await options(page);
  await page.getByRole("checkbox", { name: "Show ignored files" }).setChecked(checked);
}
async function expectPlaying(page: Page, path: string): Promise<void> {
  await expect(nativeMedia(page)).toHaveCount(1);
  await expect.poll(() => activePath(page)).toBe(path);
  try {
    await expect.poll(() => nativeMedia(page).evaluate((el: HTMLMediaElement) => ({ paused: el.paused, hasData: el.readyState >= 2,
      advanced: el.currentTime > 0, duration: el.duration, error: el.error?.message ?? null }))).toMatchObject({ paused: false, hasData: true, advanced: true, error: null });
  } catch (error) {
    const url = await nativeMedia(page).evaluate((el: HTMLMediaElement) => el.currentSrc || el.src);
    const response = await page.request.get(url, { headers: { Range: "bytes=0-43" } });
    throw new Error(`Media response ${response.status()} ${response.headers()["content-type"]}: ${(await response.body()).subarray(0, 44).toString("hex")}`, { cause: error });
  }
}

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: filename selection and menu intent remain distinct after commit/back and intentional emptiness`, async ({ launchBrowser, serverPort, request }, info) => {
    await request.post("/__e2e/reset", { data: { git: true, follow: false } });
    await fs.mkdir(workspacePath("audition"), { recursive: true });
    await fs.writeFile(workspacePath("audition", "tone.wav"), wavFixture(60));
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    let failed = true;
    try {
      const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
      await page.goto(`/audition/tone.wav?t=${encodeURIComponent(token)}`);
      await expect(page.locator(".media-preview")).toBeVisible();
      await expect.poll(() => nativeMedia(page).evaluate((el: HTMLMediaElement) => el.duration)).toBeGreaterThan(50);
      await page.locator("#media-dock").getByRole("button", { name: "Play", exact: true }).click();
      await expectPlaying(page, "audition/tone.wav");
      const source = await nativeMedia(page).getAttribute("src");
      await showGitLogPane(page);
      await page.locator("#git-log .commit-log a", { hasText: "add feature doc" }).click();
      await expect(page.locator(".commit-preview")).toBeVisible();
      await page.goBack();
      await expect(page.locator("#preview-path")).toHaveText("audition/tone.wav");
      await treeRow(page, "audition/").click();
      await expect(page.locator("#preview")).toHaveClass(/empty/);
      await revealTreeRow(page, "README.md"); await waitForTreeIdle(page);
      await expect(page.locator("#tree [data-is-scrolling]")).toHaveCount(0);
      await page.locator("#tree").evaluate(host => {
        const tree = (host as any).__pierreFileTree;
        const entries: unknown[] = [];
        (window as any).__sidebarNavigationEvents = entries;
        for (const type of ["pointerdown", "mousedown", "click", "contextmenu"]) host.shadowRoot!.addEventListener(type, event => {
          const target = event.composedPath()[0] as HTMLElement;
          entries.push({ type, target: target.outerHTML.slice(0, 500), row: target.closest("[data-item-path]")?.getAttribute("data-item-path"),
            x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY });
        }, true);
        tree.subscribe(() => entries.push({ selected: tree.getSelectedPaths(), focused: tree.getFocusedPath() }));
      });
      const geometry = await treeRow(page, "README.md").evaluate(row => {
        const bounds = row.getBoundingClientRect();
        const shadow = row.getRootNode() as ShadowRoot;
        return { row: bounds.toJSON(), filename: row.querySelector('[data-item-section="content"]')!.getBoundingClientRect().toJSON(),
          centerTarget: shadow.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.outerHTML.slice(0, 600),
          centerPath: shadow.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest("[data-item-path]")?.getAttribute("data-item-path") };
      });
      await treeRow(page, "README.md").click();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const selected = await treeRow(page, "README.md").getAttribute("aria-selected");
      const menu = page.getByRole("menuitem", { name: "Open preview", exact: true });
      const menuOpen = await menu.isVisible();
      const observation = await page.locator("#tree").evaluate(host => ({ events: (window as any).__sidebarNavigationEvents,
        selectedPaths: (host as any).__pierreFileTree.getSelectedPaths() }));
      const diagnostics = info.outputPath("row-center-hit-diagnostics.json");
      await fs.writeFile(diagnostics, JSON.stringify({ geometry, selected, menuOpen, ...observation }, null, 2));
      await info.attach("row-center-hit-diagnostics", { contentType: "application/json", path: diagnostics });
      const clickedPath = observation.events.findLast((entry: any) => entry.type === "click")?.row;
      if (!menuOpen) expect(observation.selectedPaths).toEqual([clickedPath]);
      if (menuOpen) {
        await expect(page.locator("#preview")).toHaveClass(/empty/);
        await menu.press("Escape");
      }
      // Select the visible filename, not the independent menu action lane.
      await revealTreeRow(page, "README.md");
      await expect(page.locator("#tree [data-is-scrolling]")).toHaveCount(0);
      await treeRow(page, "README.md").locator('[data-item-section="content"]').click({ timeout: 5000 });
      await expect(treeRow(page, "README.md")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#preview-path")).toHaveText("README.md");
      expect(await page.locator("#tree").evaluate(host => (host as any).__pierreFileTree.getItem("audition/").isExpanded())).toBe(false);
      await expectPlaying(page, "audition/tone.wav");
      expect(await nativeMedia(page).getAttribute("src")).toBe(source);
      await treeRow(page, "README.md").focus(); await treeRow(page, "README.md").press("Shift+F10");
      await expect(page.getByRole("menu", { name: "Actions for README.md", exact: true })).toBeVisible();
      await expect(page.locator("#preview-path")).toHaveText("README.md");
      await expect(treeRow(page, "README.md")).toHaveAttribute("aria-selected", "true");
      await menu.press("Escape");
      await fs.writeFile(workspacePath("README.md"), "# Document refresh during audition\n");
      await expect(page.locator("#preview")).toContainText("Document refresh during audition");
      expect(await page.locator("#tree").evaluate(host => (host as any).__pierreFileTree.getItem("audition/").isExpanded())).toBe(false);
      await expectPlaying(page, "audition/tone.wav");
      failed = false;
    } finally {
      if (failed && !page.isClosed()) {
        await page.screenshot({ timeout: 2000 }).then(body => info.attach("navigation-before-close", { body, contentType: "image/png" })).catch(() => undefined);
        const path = info.outputPath("navigation-before-close.zip");
        await page.context().tracing.stop({ path }).then(() => info.attach("navigation-trace", { path, contentType: "application/zip" })).catch(() => undefined);
      } else await page.context().tracing.stop();
      await browser.close();
    }
  });

  test(`${engine}: types compose with views/query/ignored visibility and never preload the list`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    const mediaRequests: string[] = [];
    page.on("request", req => { if (new URL(req.url()).pathname.endsWith("/api/media")) mediaRequests.push(req.url()); });
    await boot(page);
    const url = page.url();
    await expect(page.locator("#document-count")).toHaveText("5");
    await type(page, "audio"); await expect(page.locator("#document-count")).toHaveText("3");
    await page.locator("#files-pane-filter-recent").click();
    await expect(play(page, ignored)).toBeVisible();
    await type(page, "video"); await expect(page.locator("#document-count")).toHaveText("1");
    await expect(row(page, video)).toBeVisible();
    await page.locator("#files-pane-filter-changed").click();
    await expect(page.locator("#document-count")).toHaveText("1");
    await type(page, "audio"); await expect(page.locator("#document-count")).toHaveText("2");
    await expect(treeRow(page, ignored)).toHaveCount(0);
    await page.locator("#files-pane-filter-all").click();
    await expect(page.locator("#document-count")).toHaveText("3");
    await showIgnored(page, false); await expect(page.locator("#document-count")).toHaveText("2");
    await page.locator("#files-query").fill(b); await expect(page.locator("#document-count")).toHaveText("1");
    await page.locator("#files-pane-filter-recent").click();
    await expect(page.locator("#files-query")).toHaveValue(b);
    await expect(row(page, b)).toBeVisible();
    expect(page.url()).toBe(url); expect(mediaRequests).toEqual([]);
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
    await page.reload(); await options(page);
    await expect(page.getByLabel("File types", { exact: true })).toHaveValue("all");
    await browser.close();
  });

  test(`${engine}: filename selection opens a paused preview without document-render requests`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await boot(page); await type(page, "audio"); await page.locator("#files-pane-filter-recent").click();
    const documentRequests: string[] = [];
    page.on("request", req => { if (new URL(req.url()).pathname.endsWith("/api/document")) documentRequests.push(req.url()); });
    await row(page, a).locator(".recent-file-open").click();
    await expect(page.locator("#preview-path")).toHaveText(a);
    await expect(nativeMedia(page)).toHaveCount(1);
    expect(await nativeMedia(page).evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
    await expect(row(page, a).getByRole("img", { name: "Playing" })).toBeHidden();
    expect(documentRequests).toEqual([]);
    await browser.close();
  });

  test(`${engine}: Recent audition captures order once and type/query/new files do not change it`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await boot(page); await type(page, "audio"); await page.locator("#files-pane-filter-recent").click();
    const url = page.url();
    const requestedPaths: string[] = [];
    page.on("request", req => {
      const url = new URL(req.url());
      if (url.pathname.endsWith("/api/media")) requestedPaths.push(url.searchParams.get("path")!);
    });
    await play(page, a).click(); await expectPlaying(page, a);
    const element = await nativeMedia(page).elementHandle();
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
    await type(page, "video"); await page.locator("#files-query").fill("media-video");
    await fs.writeFile(workspacePath("media-new.wav"), wavFixture(30));
    await expect.poll(async () => (await request.get("/api/state").then(r => r.json())).roots.flatMap((root: any) => root.docs)
      .some((doc: any) => doc.relativePath === "media-new.wav")).toBe(true);
    expect(await nativeMedia(page).evaluate((el, original) => el === original, element)).toBe(true);
    await expectPlaying(page, a); expect(page.url()).toBe(url);
    expect(requestedPaths.length).toBeGreaterThan(0);
    expect([...new Set(requestedPaths)]).toEqual([a]);
    await page.getByRole("button", { name: "Next clip", exact: true }).click(); await expectPlaying(page, b);
    await page.getByRole("button", { name: "Next clip", exact: true }).click(); await expectPlaying(page, ignored);
    await expect(page.getByRole("button", { name: "Next clip", exact: true })).toBeDisabled();
    expect(page.url()).toBe(url);
    await browser.close();
  });

  test(`${engine}: Pierre public actions open without navigation and capture deterministic tree order`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await boot(page); await type(page, "audio");
    const url = page.url();
    await treeRow(page, a).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Play", exact: true })).toBeVisible();
    expect(page.url()).toBe(url);
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(nativeMedia(page)).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Play", exact: true }).press("Enter"); await expectPlaying(page, a);
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(page.url()).toBe(url);
    await page.getByRole("button", { name: "Next clip", exact: true }).click(); await expectPlaying(page, b);
    await expect(treeRow(page, b).locator('[data-item-section="decoration"]')).toContainText("▶");
    await expect(treeRow(page, b).locator('[data-item-section="decoration"] button')).toHaveCount(0);
    await page.getByRole("button", { name: "Close player", exact: true }).click();
    await treeRow(page, a).focus(); await treeRow(page, a).press("Shift+F10");
    await page.getByRole("menuitem", { name: "Open preview", exact: true }).click();
    await expect(page.locator("#preview-path")).toHaveText(a);
    expect(await nativeMedia(page).evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
    await browser.close();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`${engine} ${colorScheme}: actual ignored playback retains selection, recency and keyboard focus cues`, async ({ launchBrowser, serverPort, request }, info) => {
      await seed(request);
      const browser = await launchBrowser(engine);
      const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}`, colorScheme });
      await boot(page); await type(page, "audio"); await page.locator("#files-pane-filter-recent").click();
      await row(page, ignored).locator(".recent-file-open").click();
      const url = page.url();
      await play(page, ignored).press("Enter"); await expectPlaying(page, ignored);
      await expect(play(page, ignored)).toBeFocused();
      await expect(row(page, ignored).locator(".recent-file-open")).toHaveClass(/is-ignored/);
      await expect(row(page, ignored).locator(".recent-file-open")).toHaveAttribute("aria-current", "true");
      await expect(row(page, ignored).getByRole("img", { name: "Playing" })).toBeVisible();
      await expect(row(page, ignored).locator("time")).toHaveAttribute("aria-label", /Last written/);
      await expect(play(page, ignored)).toHaveCSS("outline-style", "solid");
      await page.locator("#files-pane-filter-all").click();
      const item = treeRow(page, ignored);
      await expect(item).toHaveAttribute("data-item-git-status", "ignored");
      await expect(item).toHaveAttribute("aria-selected", "true");
      await expect(item.locator('[title^="Playing."]')).toContainText("▶");
      await expect(item.locator('[data-item-section="git"]')).toHaveText("");
      await expect(item.locator('[data-item-section="icon"]')).toHaveCSS("opacity", "0.5");
      await item.focus(); await item.press("Shift+F10");
      await page.getByRole("menuitem", { name: "Play", exact: true }).press("Escape");
      await expect(item).toBeFocused();
      expect(await item.evaluate(el => getComputedStyle(el, "::before").outlineStyle)).toBe("solid");
      await expectPlaying(page, ignored); expect(page.url()).toBe(url);
      await captureScreenshot(page, info, `${engine}-${colorScheme}-ignored-media-playing`);
      await showIgnored(page, false);
      await expect(treeRow(page, ignored)).toHaveCount(0);
      await expectPlaying(page, ignored); expect(page.url()).toBe(url);
      await showIgnored(page, true);
      await expect(item).toHaveAttribute("aria-selected", "true");
      await expect(item.locator('[title^="Playing."]')).toContainText("▶");
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(item.locator('[title^="Playing."]')).toHaveCount(0);
      await browser.close();
    });
  }

  test(`${engine}: touch audition stays in Files while real video decodes and a second clip replaces it`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}`, hasTouch: true, viewport: { width: 375, height: 812 } });
    await boot(page); await page.locator("#files-pane-filter-recent").tap();
    const url = page.url();
    await play(page, video).tap(); await expectPlaying(page, video);
    await expect(page.locator('[data-tab="files"]')).toHaveAttribute("aria-selected", "true");
    expect(page.url()).toBe(url);
    await play(page, a).tap(); await expectPlaying(page, a);
    await expect(page.locator('[data-tab="files"]')).toHaveAttribute("aria-selected", "true");
    expect(page.url()).toBe(url);
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
    await browser.close();
  });

  test(`${engine}: live writes and deletion during Play press retain exact targets`, async ({ launchBrowser, serverPort, request }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await boot(page); await type(page, "audio"); await page.locator("#files-pane-filter-recent").click();
    const target = play(page, a); await expect(target).toBeVisible();
    await target.click({ trial: true });
    const bounds = (await target.boundingBox())!;
    await page.mouse.move(bounds.x + 15, bounds.y + 15); await page.mouse.down();
    await fs.writeFile(workspacePath("media-new.wav"), wavFixture(30));
    await expect(page.locator("#document-count")).toHaveText("4");
    expect((await target.boundingBox())!.y).toBe(bounds.y);
    await page.mouse.up(); await expectPlaying(page, a); await expect(target).toBeFocused();
    const removed = play(page, b); await removed.click({ trial: true }); const removedBounds = (await removed.boundingBox())!;
    await page.mouse.move(removedBounds.x + 15, removedBounds.y + 15); await page.mouse.down();
    await fs.rm(workspacePath(b));
    await expect(page.locator("#document-count")).toHaveText("3");
    await page.mouse.up(); await expect(play(page, b)).toHaveCount(0);
    await expectPlaying(page, a);
    await browser.close();
  });
}
