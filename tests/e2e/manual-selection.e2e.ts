import type { Page } from "@playwright/test";
import type { StatePayload } from "../../src/shared/types";
import { expect, test, showGitLogPane } from "./fixtures";
import { revealTreeRow, treeRow } from "./tree-helpers";

// Drive real shell/tree reducers with complete, ordered snapshots. File reads
// still use the server; only delivery timing and index membership are controlled.
async function installStream(page: Page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    class Controlled extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1;
      constructor(url: string | URL, options?: EventSourceInit) {
        super();
        if (!String(url).includes("/api/events")) return new Native(url, options) as unknown as Controlled;
        (window as any).__documentStream = this;
      }
      close() { this.readyState = 2; }
    }
    window.EventSource = Controlled as unknown as typeof EventSource;
  });
}
async function deliver(page: Page, state: StatePayload) {
  await page.waitForFunction(() => Boolean((window as any).__documentStream));
  await page.evaluate(state => {
    state.generatedAt = Math.max(Date.now(), ((window as any).__stamp ?? 0) + 1);
    (window as any).__stamp = state.generatedAt;
    (window as any).__documentStream.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(state) }));
  }, state);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function files(page: Page, touch: boolean) {
  if (touch) await page.locator("#touch-tab-files").click();
}
async function identity(page: Page, path: string, url: string) {
  await expect(page).toHaveURL(url);
  await expect(page.locator("#preview-path")).toHaveText(path);
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
}
for (const touch of [false, true]) {
  test.describe(touch ? "touch manual selection" : "desktop manual selection", () => {
    test.use(touch ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {});
    test.beforeEach(async ({ page, request }, testInfo) => {
      await request.post("/__e2e/reset", { data: { git: testInfo.title.includes("commit selection"), extras: { "a-selected.txt": "Selected text contents\n", "hero.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' } } });
      await installStream(page);
      await page.goto("/");
      const state = await request.get("/api/state").then(r => r.json());
      await deliver(page, state);
    });
    for (const path of ["a-selected.txt", "diagram.md", "hero.svg"]) {
      test(`${path} keeps its destination through an index gap and return`, async ({ page, request }) => {
        await files(page, touch);
        await treeRow(page, path).click();
        await expect(page.locator("#preview-path")).toHaveText(path);
        const url = page.url();
        const state: StatePayload = await request.get("/api/state").then(r => r.json());
        const selected = state.roots.flatMap(r => r.docs).find(d => d.relativePath === path)!;
        const missing = structuredClone(state);
        missing.roots.forEach(r => { r.docs = r.docs.filter(d => d.id !== selected.id); });
        // Keep focus on another control and the Files tab throughout background work.
        await files(page, touch);
        await page.locator("#follow-toggle").focus();
        const unrelated = structuredClone(state);
        unrelated.changedId = state.roots.flatMap(r => r.docs).find(d => d.relativePath === "README.md")!.id;
        await deliver(page, unrelated);
        await identity(page, path, url);
        await deliver(page, missing);
        await identity(page, path, url);
        await expect(page.locator("#preview")).toContainText("unavailable");
        await expect(treeRow(page, path)).toHaveCount(0);
        await expect(page.locator("#follow-toggle")).toBeFocused();
        if (touch) await expect(page.locator("#touch-tab-files")).toHaveAttribute("aria-selected", "true");
        // Unchanged mtime and no changedId must still restore the preview.
        await deliver(page, state);
        await identity(page, path, url);
        await expect(page.locator("#preview")).not.toContainText("File unavailable");
        if (path === "a-selected.txt") await expect(page.locator("#preview")).toContainText("Selected text contents");
        if (path === "hero.svg") await expect(page.locator("#preview img")).toHaveAttribute("alt", "hero.svg");
        await expect(treeRow(page, path)).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#follow-toggle")).toBeFocused();
        await treeRow(page, "README.md").click();
        await expect(page.locator("#preview-path")).toHaveText("README.md");
      });
    }
    test("empty and excluded indexes never read retained content or revive an abandoned destination", async ({ page, request }) => {
      await files(page, touch);
      await treeRow(page, "a-selected.txt").click();
      await expect(page.locator("#preview")).toContainText("Selected text contents");
      const url = page.url();
      const state: StatePayload = await request.get("/api/state").then(r => r.json());
      let reads = 0;
      await page.route("**/api/document?*", route => { ++reads; return route.continue(); });
      await files(page, touch);
      await deliver(page, { ...state, roots: [] });
      await identity(page, "a-selected.txt", url);
      await expect(page.locator("#preview")).toContainText("File unavailable");
      await expect(page.locator("#preview")).not.toContainText("Selected text contents");
      const excluded = structuredClone(state);
      excluded.roots.forEach(r => { r.docs = r.docs.filter(d => d.relativePath !== "a-selected.txt"); });
      await deliver(page, excluded);
      await identity(page, "a-selected.txt", url);
      expect(reads).toBe(0);
      await treeRow(page, "diagram.md").click();
      await expect(page.locator("#preview-path")).toHaveText("diagram.md");
      const newerUrl = page.url();
      await deliver(page, state);
      await identity(page, "diagram.md", newerUrl);
    });
    test("tree refresh and filter keep selection, then keyboard and pointer activation work", async ({ page, request }) => {
      await files(page, touch);
      await treeRow(page, "a-selected.txt").click();
      await expect(page.locator("#preview-path")).toHaveText("a-selected.txt");
      const url = page.url();
      const state: StatePayload = await request.get("/api/state").then(r => r.json());
      await files(page, touch);
      await page.locator("#files-pane-filter-changed").click();
      await deliver(page, state);
      await identity(page, "a-selected.txt", url);
      await page.locator("#files-pane-filter-all").click();
      await identity(page, "a-selected.txt", url);
      await treeRow(page, "diagram.md").focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#preview-path")).toHaveText("diagram.md");
      await files(page, touch);
      await treeRow(page, "a-selected.txt").click();
      await identity(page, "a-selected.txt", url);
    });
    test("resume via HTTP preserves an unavailable selection and restores it without changedId", async ({ page, request }) => {
      await files(page, touch);
      await treeRow(page, "a-selected.txt").click();
      await expect(page.locator("#preview")).toContainText("Selected text contents");
      const url = page.url();
      const original: StatePayload = await request.get("/api/state").then(r => r.json());
      let snapshot = structuredClone(original);
      snapshot.roots.forEach(r => { r.docs = r.docs.filter(d => d.relativePath !== "a-selected.txt"); });
      let stamp = Date.now() + 1000;
      await page.route("**/api/state*", route => route.fulfill({ json: { ...snapshot, changedId: null, generatedAt: ++stamp } }));
      const resume = () => page.evaluate(() => {
        const event = new Event("pageshow");
        Object.defineProperty(event, "persisted", { value: true });
        window.dispatchEvent(event);
      });
      await files(page, touch);
      await resume();
      await expect(page.locator("#preview")).toContainText("File unavailable");
      await identity(page, "a-selected.txt", url);
      snapshot = original;
      await resume();
      await expect(page.locator("#preview")).toContainText("Selected text contents");
      await identity(page, "a-selected.txt", url);
      if (touch) await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
    });
    test("two clients retain independent selections during removal and return", async ({ page, context, request }) => {
      const other = await context.newPage();
      try {
        await installStream(other);
        await other.goto("/");
        const state: StatePayload = await request.get("/api/state").then(r => r.json());
        await deliver(other, state);
        await files(other, touch);
        await treeRow(other, "diagram.md").click();
        await files(page, touch);
        await treeRow(page, "a-selected.txt").click();
        await expect(page.locator("#preview-path")).toHaveText("a-selected.txt");
        const urls = [page.url(), other.url()];
        const missing = structuredClone(state);
        missing.roots.forEach(r => { r.docs = r.docs.filter(d => d.relativePath !== "a-selected.txt"); });
        for (const snapshot of [missing, state]) {
          await Promise.all([deliver(page, snapshot), deliver(other, snapshot)]);
          await identity(page, "a-selected.txt", urls[0]!);
          await identity(other, "diagram.md", urls[1]!);
        }
        await expect(page.locator("#preview")).toContainText("Selected text contents");
      } finally { await other.close(); }
    });
    test("older diff response cannot replace a newer refresh of the same file", async ({ page, request }) => {
      await files(page, touch);
      await treeRow(page, "a-selected.txt").click();
      await expect(page.locator("#preview-path")).toHaveText("a-selected.txt");
      const state: StatePayload = await request.get("/api/state").then(r => r.json());
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let started!: () => void;
      const waiting = new Promise<void>(resolve => { started = resolve; });
      let finished!: () => void;
      const completed = new Promise<void>(resolve => { finished = resolve; });
      let requests = 0;
      await page.route("**/api/document/diff?*", async route => {
        const first = ++requests === 1;
        if (first) { started(); await gate; }
        await route.fulfill({ json: { kind: "unchanged", baseRef: first ? "OLD" : "NEW" } });
        if (first) finished();
      });
      await page.locator("#view-diff").click();
      await waiting;
      state.changedId = state.roots.flatMap(r => r.docs).find(d => d.relativePath === "a-selected.txt")!.id;
      await deliver(page, state);
      await expect(page.locator("#preview")).toContainText("No changes against NEW.");
      release();
      await completed;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator("#preview")).toContainText("No changes against NEW.");
      await expect(page.locator("#preview")).not.toContainText("OLD");
      await expect(page.locator("#preview-path")).toHaveText("a-selected.txt");
    });
    for (const destination of ["document", "commit"] as const) test(`late text response cannot replace a newer ${destination} selection`, async ({ page, request }) => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let started!: () => void;
      const waiting = new Promise<void>(resolve => { started = resolve; });
      let finished!: () => void;
      const completed = new Promise<void>(resolve => { finished = resolve; });
      await page.route("**/api/document?*", async route => {
        if (!new URL(route.request().url()).searchParams.get("id")?.endsWith("a-selected.txt")) return route.continue();
        const response = await route.fetch();
        started();
        await gate;
        await route.fulfill({ response });
        finished();
      });
      await files(page, touch);
      await revealTreeRow(page, "a-selected.txt");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (touch) await treeRow(page, "a-selected.txt").tap();
      else await treeRow(page, "a-selected.txt").click();
      await expect(page).toHaveURL(/\/a-selected\.txt$/);
      await waiting;
      await files(page, touch);
      if (destination === "document") {
        await treeRow(page, "diagram.md").click();
        await expect(page.locator("#preview-path")).toHaveText("diagram.md");
      } else {
        await showGitLogPane(page);
        await page.locator("#git-log .commit-log a", { hasText: "add feature doc" }).click();
        await expect(page.locator("#preview-title")).toHaveText("add feature doc");
      }
      const path = await page.locator("#preview-path").textContent();
      const title = await page.locator("#preview-title").textContent();
      const url = page.url();
      release();
      await completed;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await identity(page, path!, url);
      await expect(page.locator("#preview-title")).toHaveText(title!);
      await expect(page.locator("#preview")).not.toContainText("Selected text contents");
    });
  });
}
