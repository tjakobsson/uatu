import type { Page } from "@playwright/test";
import type { StatePayload } from "../../src/shared/types";
import type { DocumentPatch, DocumentSnapshot, DocumentUpdate } from "../../src/shared/document-updates";
import { expect, test, showGitLogPane } from "./fixtures";
import { openTreeFile, revealTreeRow, treeRow, waitForTreeIdle } from "./tree-helpers";

// Drive real shell/tree reducers with complete, ordered snapshots. File reads
// still use the server; only delivery timing and index membership are controlled.
// The page's one live stream (`/api/hub/live`) is replaced with a controllable
// source that delivers `document` topic envelopes for the key the page
// subscribed with; every other request goes to the real server.
async function installStream(page: Page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    class Controlled extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1;
      documentKey = "";
      constructor(url: string | URL, options?: EventSourceInit) {
        super();
        if (!String(url).includes("/api/hub/live")) return new Native(url, options) as unknown as Controlled;
        const subs = JSON.parse(new URL(String(url), location.origin).searchParams.get("subs") ?? "[]") as { topic: string; key?: string }[];
        this.documentKey = subs.find(sub => sub.topic === "document")?.key ?? "";
        (window as any).__documentStream = this;
      }
      close() { this.readyState = 2; }
    }
    window.EventSource = Controlled as unknown as typeof EventSource;
  });
}
async function deliver(page: Page, state: StatePayload | DocumentUpdate) {
  await page.waitForFunction(() => Boolean((window as any).__documentStream));
  await page.evaluate(state => {
    state.generatedAt = Math.max(Date.now(), ((window as any).__stamp ?? 0) + 1);
    (window as any).__stamp = state.generatedAt;
    const stream = (window as any).__documentStream;
    const envelope = { ws: "e2e", topic: "document", key: stream.documentKey, cursor: String(state.generatedAt), event: { kind: "data", data: state } };
    stream.dispatchEvent(new MessageEvent("live", { data: JSON.stringify(envelope) }));
  }, state);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// A Git-only change as the server publishes it: a commit moves HEAD, and
// the repository generation advances. (An identical result is never
// republished, so a bare generation bump does not occur.)
function repositoryPatch(state: DocumentSnapshot): DocumentPatch {
  const previousRevision = state.revision++;
  state.repositoryState = { status: "ready", generation: state.repositoryState.generation + 1 };
  state.repositories = state.repositories.map(repository => ({
    ...repository,
    metadata: { ...repository.metadata, commitShort: `commit-${state.repositoryState.generation}` },
  }));
  state.changedId = null;
  return {
    kind: "patch", epoch: state.epoch, previousRevision, revision: state.revision,
    generatedAt: state.generatedAt, scope: state.scope, compareTarget: state.compareTarget,
    unscopedFingerprint: state.unscopedFingerprint!, upserts: [], removals: [], changedId: null,
    repositories: state.repositories, repositoryState: state.repositoryState,
  };
}

test.describe("repository preview updates", () => {
  test.use({ serviceWorkers: "block" });
  test.beforeEach(async ({ page, request }) => {
    await request.post("/__e2e/reset", { data: { git: true } });
    await expect.poll(async () => (await request.get("/api/state").then(r => r.json())).repositoryState.status).toBe("ready");
    await installStream(page);
  });
  test.afterEach(async ({ page, request }) => {
    await page.close();
    await request.post("/__e2e/reset");
  });

  for (const delivery of ["patch", "snapshot", "resume"] as const) {
    test(`${delivery} refreshes an active diff after a Git-only change`, async ({ page, request }) => {
      let baseRef = "before-commit";
      await page.route("**/api/document/diff?*", route => route.fulfill({ json: { kind: "unchanged", baseRef } }));
      await page.goto("/README.md");
      await expect(page.locator("#preview-path")).toHaveText("README.md");
      const state: DocumentSnapshot = await request.get("/api/state").then(r => r.json());
      await deliver(page, state);
      await page.locator("#view-diff").click();
      await expect(page.locator(".uatu-diff-state")).toContainText("before-commit");
      await page.locator("#follow-toggle").focus();
      baseRef = "after-commit";
      const patch = repositoryPatch(state);
      if (delivery === "resume") {
        await page.route("**/api/state*", route => route.fulfill({ json: state }));
        await page.evaluate(() => {
          const event = new Event("pageshow");
          Object.defineProperty(event, "persisted", { value: true });
          window.dispatchEvent(event);
        });
      } else await deliver(page, delivery === "patch" ? patch : state);
      await expect(page.locator(".uatu-diff-state")).toContainText("after-commit");
      await expect(page.locator("#preview-path")).toHaveText("README.md");
      await expect(page).toHaveURL(/\/README\.md$/);
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator("#follow-toggle")).toBeFocused();
    });
  }

  test("a snapshot carrying a changed .gitattributes re-fetches the open diff", async ({ page, request }) => {
    let baseRef = "before-attributes";
    await page.route("**/api/document/diff?*", route => route.fulfill({ json: { kind: "unchanged", baseRef } }));
    await page.goto("/README.md");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    const state: DocumentSnapshot = await request.get("/api/state").then(r => r.json());
    // An attributes file in the corpus, as the content index lists it.
    const root = state.roots[0]!;
    const attributes = { id: `${root.id}/.gitattributes`, name: ".gitattributes", relativePath: ".gitattributes", mtimeMs: Date.now(), rootId: root.id, kind: "text" as const, revision: 1 };
    root.docs.push(attributes as never);
    state.revision++;
    await deliver(page, state);
    await page.locator("#view-diff").click();
    await expect(page.locator(".uatu-diff-state")).toContainText("before-attributes");
    baseRef = "after-attributes";
    // Reconnecting after a missed .gitattributes edit delivers a snapshot,
    // not the patch; nothing else about the repository changed.
    attributes.revision = 2;
    state.revision++;
    await deliver(page, state);
    await expect(page.locator(".uatu-diff-state")).toContainText("after-attributes");
  });

  test("a repository update invalidates a cached diff while Rendered stays visible", async ({ page, request }) => {
    let baseRef = "cached-before-commit";
    let documentReads = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/document") documentReads++; });
    await page.route("**/api/document/diff?*", route => route.fulfill({ json: { kind: "unchanged", baseRef } }));
    await page.goto("/README.md");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    const state: DocumentSnapshot = await request.get("/api/state").then(r => r.json());
    await deliver(page, state);
    await page.locator("#view-diff").click();
    await expect(page.locator(".uatu-diff-state")).toContainText("cached-before-commit");
    await page.locator("#view-rendered").click();
    await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
    const content = await page.locator("#preview").textContent();
    const reads = documentReads;
    baseRef = "fresh-after-commit";
    await deliver(page, repositoryPatch(state));
    await expect(page.locator("#preview")).toHaveText(content!);
    expect(documentReads).toBe(reads);
    await page.locator("#view-diff").click();
    await expect(page.locator(".uatu-diff-state")).toContainText("fresh-after-commit");
  });

  test("a late diff response cannot restore an older repository generation", async ({ page, request }) => {
    let requests = 0;
    let held = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/document/diff?*", async route => {
      if (++requests === 1) {
        held = true;
        await gate;
        await route.fulfill({ json: { kind: "unchanged", baseRef: "obsolete-repository" } });
      } else await route.fulfill({ json: { kind: "unchanged", baseRef: "current-repository" } });
    });
    try {
      await page.goto("/README.md");
      await expect(page.locator("#preview-path")).toHaveText("README.md");
      const state: DocumentSnapshot = await request.get("/api/state").then(r => r.json());
      await deliver(page, state);
      await page.locator("#view-diff").click();
      await expect.poll(() => held).toBe(true);
      await deliver(page, repositoryPatch(state));
      await expect(page.locator(".uatu-diff-state")).toContainText("current-repository");
      const finished = responseDelivered(page, "/api/document/diff?");
      release();
      await finished;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator(".uatu-diff-state")).toContainText("current-repository");
      await page.locator("#view-rendered").click();
      await page.locator("#view-diff").click();
      await expect(page.locator(".uatu-diff-state")).toContainText("current-repository");
    } finally { release(); }
  });

  test("repository patches re-resolve a commit removed from and restored to the log", async ({ page, request }) => {
    await page.goto("/README.md");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    const state: DocumentSnapshot = await request.get("/api/state").then(r => r.json());
    await deliver(page, state);
    await showGitLogPane(page);
    await page.locator("#git-log .commit-log a", { hasText: "add feature doc" }).click();
    await expect(page.locator("#preview-title")).toHaveText("add feature doc");
    const url = page.url();
    const sha = new URL(url).searchParams.get("commit")!;
    const repositories = structuredClone(state.repositories);
    state.repositories = state.repositories.map(repository => ({ ...repository, commitLog: repository.commitLog.filter(commit => commit.sha !== sha) }));
    await deliver(page, repositoryPatch(state));
    await expect(page.locator("#preview-title")).toHaveText("Commit preview unavailable");
    await expect(page.locator("#preview")).not.toContainText("Full commit message body");
    await expect(page).toHaveURL(url);
    state.repositories = repositories;
    await deliver(page, repositoryPatch(state));
    await expect(page.locator("#preview-title")).toHaveText("add feature doc");
    await expect(page.locator("#preview")).toContainText("Full commit message body");
    await expect(page).toHaveURL(url);
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  });
});
// The late response is not merely fulfilled but in the page: the browser has
// its whole body. What the page does with it runs in the tasks right after,
// which the two frames the callers then wait out cover.
function responseDelivered(page: Page, urlPart: string, idSuffix?: string) {
  return page.waitForEvent("requestfinished", request =>
    request.url().includes(urlPart)
    && (idSuffix === undefined || new URL(request.url()).searchParams.get("id")?.endsWith(idSuffix) === true));
}
async function files(page: Page, touch: boolean) {
  if (touch) await page.locator("#touch-tab-files").click();
}
// Expand or collapse a directory row, and prove the click landed on it.
// The tree is virtualized and keys its row buttons by position in the
// rendered window: when Playwright has to scroll a row into view itself, the
// re-render that scroll triggers can hand the button it resolved to another
// row, and the click opens whatever file now sits there (in touch mode that
// also leaves the Files tab). So the library brings the row into its window,
// the tree settles, the point to click is hit-tested to be this row, and that
// point is clicked with no scrolling at all.
async function toggleDirectory(page: Page, path: string, expanded: boolean) {
  const row = treeRow(page, path);
  await expect(row).toHaveAttribute("aria-expanded", String(!expanded));
  let point = { x: 0, y: 0 };
  await expect(async () => {
    await revealTreeRow(page, path);
    await expect(row).toBeVisible({ timeout: 2_000 });
    await waitForTreeIdle(page);
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    const hit = await page.locator("#tree").evaluate((host, { x, y }) =>
      host.shadowRoot?.elementFromPoint(x, y)?.closest("[data-item-path]")?.getAttribute("data-item-path") ?? null, point);
    expect(hit).toBe(path);
  }, `settle ${path} under the pointer`).toPass({ timeout: 10_000 });
  await page.mouse.click(point.x, point.y);
  await expect(row).toHaveAttribute("aria-expanded", String(expanded));
}
async function identity(page: Page, path: string, url: string) {
  await expect(page).toHaveURL(url);
  await expect(page.locator("#preview-path")).toHaveText(path);
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
}
async function closedDocument(page: Page) {
  await expect(page.locator("#preview")).toHaveClass(/\bempty\b/);
  await expect(page.locator("#preview-path")).not.toHaveText("guides/setup.md");
  await expect(page.locator("#preview-title")).not.toHaveText("Setup");
  await expect(page.locator("#preview h1, #preview h2, #preview img, #preview pre, #preview .diff-view")).toHaveCount(0);
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[role="treeitem"][data-item-type="file"][aria-selected="true"]')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
}
for (const touch of [false, true]) {
  test.describe(touch ? "touch manual selection" : "desktop manual selection", () => {
    test.use(touch ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {});
    test.beforeEach(async ({ page, request }, testInfo) => {
      await request.post("/__e2e/reset", { data: { git: testInfo.title.includes("commit selection"), extras: { "a-selected.txt": "Selected text contents\n", "hero.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' } } });
      // This suite replaces live delivery with controlled snapshots, so wait
      // for the repository baseline it will otherwise never receive.
      if (testInfo.title.includes("commit selection")) {
        await expect.poll(async () => (await request.get("/api/state").then(r => r.json())).repositoryState.status).toBe("ready");
      }
      await installStream(page);
      await page.goto("/");
      const state = await request.get("/api/state").then(r => r.json());
      await deliver(page, state);
    });
    for (const path of ["a-selected.txt", "diagram.md", "hero.svg", "guides/setup.md"]) {
      test(`${path} keeps its destination through an index gap and return`, async ({ page, request }) => {
        await files(page, touch);
        await openTreeFile(page, path);
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
        await openTreeFile(page, "README.md");
        await expect(page.locator("#preview-path")).toHaveText("README.md");
      });
    }
    test("empty and excluded indexes never read retained content or revive an abandoned destination", async ({ page, request }) => {
      await files(page, touch);
      await openTreeFile(page, "a-selected.txt");
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
      await openTreeFile(page, "diagram.md");
      await expect(page.locator("#preview-path")).toHaveText("diagram.md");
      const newerUrl = page.url();
      await deliver(page, state);
      await identity(page, "diagram.md", newerUrl);
    });
    for (const destination of ["return to A", "make B available"] as const) {
      test(`navigation through unavailable B then ${destination} preserves requested identity`, async ({ page, request }) => {
        await files(page, touch);
        await openTreeFile(page, "guides/setup.md");
        await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
        await files(page, touch);
        await toggleDirectory(page, "metadata/", true);
        await revealTreeRow(page, "metadata/markdown-yaml.md");
        await openTreeFile(page, "metadata/markdown-yaml.md");
        await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-yaml.md");
        const state: StatePayload = await request.get("/api/state").then(r => r.json());
        const missing = structuredClone(state);
        missing.roots.forEach(root => { root.docs = root.docs.filter(doc => doc.relativePath !== "metadata/markdown-yaml.md"); });
        await deliver(page, missing);
        // B is retained across the index gap. Collapsing A now is unrelated
        // navigation, not the obsolete hidden-active-A setup.
        await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-yaml.md");
        await expect(page.locator("#preview")).toContainText("unavailable");
        await files(page, touch);
        await toggleDirectory(page, "guides/", false);
        await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-yaml.md");
        if (destination === "return to A") {
          await page.goBack();
          await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
          await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "true");
          await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "true");
        } else {
          await deliver(page, state);
          await expect(page.locator("#preview")).not.toContainText("File unavailable");
          await expect(treeRow(page, "metadata/markdown-yaml.md")).toHaveAttribute("aria-selected", "true");
          await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "false");
        }
        await expect(treeRow(page, "metadata/")).toHaveAttribute("aria-expanded", "true");
      });
    }
    test("tree refresh and filter keep selection, then keyboard and pointer activation work", async ({ page, request }) => {
      await files(page, touch);
      await openTreeFile(page, "a-selected.txt");
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
      await openTreeFile(page, "a-selected.txt");
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
    for (const recovery of ["stream", "resume", "reconnect"] as const) {
      test(`ancestor-close intentional emptiness survives ${recovery} reconciliation`, async ({ page, request }) => {
        await files(page, touch);
        await openTreeFile(page, "guides/setup.md");
        await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
        await files(page, touch);
        await toggleDirectory(page, "guides/", false);
        await closedDocument(page);
        const state: StatePayload = await request.get("/api/state").then(r => r.json());
        state.changedId = state.roots.flatMap(root => root.docs).find(doc => doc.relativePath === "guides/setup.md")!.id;
        // Observable model change proves reconciliation completed independently
        // of the empty preview. Reads for actual documents still hit the server.
        state.roots[0]!.docs = state.roots[0]!.docs.filter(doc => doc.relativePath !== "diagram.md");
        await expect(treeRow(page, "diagram.md")).toBeAttached();
        if (recovery === "stream") await deliver(page, state);
        else {
          await page.route("**/api/state*", route => route.fulfill({ json: { ...state, generatedAt: Date.now() + 10_000 } }));
          await page.evaluate(recovery => {
            if (recovery === "resume") {
              const event = new Event("pageshow");
              Object.defineProperty(event, "persisted", { value: true });
              window.dispatchEvent(event);
            } else {
              window.dispatchEvent(new Event("offline"));
              window.dispatchEvent(new Event("online"));
            }
          }, recovery);
        }
        await expect(treeRow(page, "diagram.md")).not.toBeAttached();
        await closedDocument(page);
        if (touch) await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
        await toggleDirectory(page, "guides/", true);
        await closedDocument(page);
        await openTreeFile(page, "guides/setup.md");
        await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
      });
    }
    test("multi-root ancestor matching distinguishes same relative folder in another root", async ({ page, request }) => {
      const state: StatePayload = await request.get("/api/state").then(r => r.json());
      const root = state.roots[0]!;
      root.label = "primary";
      state.roots.push({ ...root, id: `${root.id}-other`, label: "primary-extra", docs: root.docs.map(doc => ({ ...doc, id: `${doc.id}-other`, rootId: `${root.id}-other` })) });
      await deliver(page, state);
      await files(page, touch);
      await openTreeFile(page, "primary/guides/setup.md", { previewPath: "guides/setup.md" });
      await expect(treeRow(page, "primary/guides/setup.md")).toHaveAttribute("aria-selected", "true");
      await files(page, touch);
      await toggleDirectory(page, "primary-extra/", true);
      await expect.poll(() => page.locator("#tree").evaluate(element =>
        (element as HTMLElement & { __pierreFileTree: { getSelectedPaths(): string[] } }).__pierreFileTree.getSelectedPaths()
          .filter(path => !path.endsWith("/"))))
        .toEqual(["primary/guides/setup.md"]);
      await toggleDirectory(page, "primary-extra/guides/", true);
      await toggleDirectory(page, "primary-extra/guides/", false);
      await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
      await revealTreeRow(page, "primary/guides/setup.md");
      await expect(treeRow(page, "primary/guides/setup.md")).toHaveAttribute("aria-selected", "true");
      await toggleDirectory(page, "primary/", false);
      await closedDocument(page);
    });
    for (const follow of [false, true]) {
      test(`collapse with no active document leaves Follow ${follow ? "on" : "off"}`, async ({ page, request }) => {
        const state: StatePayload = await request.get("/api/state").then(r => r.json());
        const nested = state.roots[0]!.docs.find(doc => doc.relativePath === "guides/setup.md")!;
        state.roots[0]!.docs = [{ ...nested, kind: "binary" }];
        state.defaultDocumentId = null;
        state.changedId = null;
        state.initialFollow = follow;
        await page.route("**/api/personal-state", route => route.fulfill({ json: { version: 1, follow } }));
        await page.route("**/api/state*", route => route.fulfill({ json: state }));
        await page.evaluate(() => localStorage.clear());
        await page.goto("/");
        await deliver(page, state);
        await files(page, touch);
        await expect(page.locator("#preview")).toHaveClass(/\bempty\b/);
        await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", String(follow));
        await toggleDirectory(page, "guides/", true);
        await toggleDirectory(page, "guides/", false);
        await expect(page.locator("#preview")).toHaveClass(/\bempty\b/);
        await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", String(follow));
      });
    }
    for (const mode of ["rendered", "source", "diff"] as const) {
      for (const reselect of [false, true]) {
        test(`late ${mode} response cannot undo ancestor close${reselect ? " and reselect" : ""}`, async ({ page, request }) => {
          await files(page, touch);
          await openTreeFile(page, "guides/setup.md");
          await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
          if (mode === "source") await page.locator("#view-source").click();
          const state: StatePayload = await request.get("/api/state").then(r => r.json());
          let release!: () => void;
          const gate = new Promise<void>(resolve => { release = resolve; });
          let started!: () => void;
          const waiting = new Promise<void>(resolve => { started = resolve; });
          let finished!: () => void;
          const completed = new Promise<void>(resolve => { finished = resolve; });
          await page.route(mode === "diff" ? "**/api/document/diff?*" : "**/api/document?*", async route => {
            if (!new URL(route.request().url()).searchParams.get("id")?.endsWith("guides/setup.md")) return route.continue();
            const response = await route.fetch();
            started();
            await gate;
            await route.fulfill({ response });
            finished();
          });
          try {
            if (mode === "diff") await page.locator("#view-diff").click();
            else {
              state.changedId = state.roots.flatMap(root => root.docs).find(doc => doc.relativePath === "guides/setup.md")!.id;
              await deliver(page, state);
            }
            await waiting;
            await files(page, touch);
            await toggleDirectory(page, "guides/", false);
            await closedDocument(page);
            if (reselect) {
              await openTreeFile(page, "README.md");
              await expect(page.locator("#preview-path")).toHaveText("README.md");
              await expect(page.locator("#preview")).not.toHaveClass(/\bempty\b/);
            }
            const before = await page.locator("#preview").innerHTML();
            const title = await page.locator("#preview-title").textContent();
            const delivered = responseDelivered(page, mode === "diff" ? "/api/document/diff?" : "/api/document?", "guides/setup.md");
            release();
            await completed;
            await delivered;
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            expect(await page.locator("#preview").innerHTML()).toBe(before);
            await expect(page.locator("#preview-title")).toHaveText(title!);
            if (reselect) await identity(page, "README.md", new URL("/README.md", page.url()).href);
            else await closedDocument(page);
          } finally { release(); }
        });
      }
    }
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
        await openTreeFile(page, "a-selected.txt");
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
      await openTreeFile(page, "a-selected.txt");
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
      const delivered = responseDelivered(page, "/api/document/diff?");
      release();
      await completed;
      await delivered;
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
        await openTreeFile(page, "diagram.md");
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
