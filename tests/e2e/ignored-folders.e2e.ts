// Git-ignored folders follow VS Code's model: listed, muted, and read one
// level at a time when expanded; fresh renders inside them still reach Recent.
import { promises as fs } from "node:fs";
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { test as base, expect } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { workspacePath } from "./config";
import { wavFixture } from "./media-fixtures";
import { captureScreenshot, saveEvidence } from "./evidence";
import { revealTreeRow, treeRow, waitForTreeIdle } from "./tree-helpers";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);
test.afterEach(async ({ request }) => { await request.post("/__e2e/reset"); });

// The native watcher is the default outside polling mode, and the only one
// that sees writes inside folders nobody has listed.
async function seed(request: APIRequestContext, extras: Record<string, string> = {}): Promise<void> {
  await request.post("/__e2e/reset", { data: {
    git: true, follow: true, nativeWatch: true,
    extras: {
      ".gitignore": "/build*/\nnode_modules/\n",
      "build/CMakeCache.txt": "CMAKE_BUILD_TYPE:STRING=Release\n",
      "build/renders/notes.txt": "Takes for the didgeridoo comparison\n",
      "node_modules/left-pad/index.js": "module.exports = () => {};\n",
      ".env": "PREVIEW_TOKEN=visible-like-vscode\n",
      ...extras,
    },
  } });
  await expect.poll(async () => {
    const state = await request.get("/api/state").then(response => response.json());
    return state.roots.flatMap((root: any) => root.folders ?? []).map((folder: any) => folder.relativePath).sort();
  }).toEqual(["build/", "node_modules/"]);
}

// Listing is a credentialed child request; the Hub brokers that credential.
// The direct harness presents it the way the media workflow does.
async function open(page: Page, request: APIRequestContext, touch = false): Promise<void> {
  const { token } = await (await request.get("/__e2e/terminal-token")).json();
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (touch) {
    await page.evaluate(() => { document.documentElement.dataset.uiMode = "touch"; });
    await page.locator('[data-tab="files"]').tap();
  }
  await expect.poll(async () => { await revealTreeRow(page, "build/"); return treeRow(page, "build/").count(); }).toBe(1);
}

// The tree is virtualized around the selection; bring a row into the window.
async function row(page: Page, path: string) {
  await revealTreeRow(page, path);
  return treeRow(page, path);
}
async function rowAppears(page: Page, path: string) {
  await expect.poll(async () => (await row(page, path)).count(), { timeout: 10_000 }).toBe(1);
}
const count = (page: Page) => page.locator("#document-count").textContent().then(Number);
function trackListings(page: Page): string[] {
  const listings: string[] = [];
  page.on("request", outgoing => { if (outgoing.url().includes("/api/index/folder")) listings.push(JSON.parse(outgoing.postData() ?? "{}").path); });
  return listings;
}
async function showIgnored(page: Page, checked: boolean): Promise<void> {
  const options = page.locator(".files-options-content");
  if (!(await options.evaluate(el => el.matches(":popover-open")))) await page.locator(".files-options-trigger").click();
  await page.getByRole("checkbox", { name: "Show ignored files" }).setChecked(checked);
}
async function typeFilter(page: Page, value: string): Promise<void> {
  await page.getByRole("button", { name: "Files options", exact: true }).click();
  await page.getByRole("combobox", { name: "File types" }).selectOption(value);
  await page.getByRole("button", { name: "Files options", exact: true }).click();
}

async function workflow(page: Page, request: APIRequestContext, info: TestInfo, label: string, touch: boolean): Promise<void> {
  const listings = trackListings(page);
  await open(page, request, touch);
  const activate = async (path: string) => { const target = await row(page, path); if (touch) await target.tap(); else await target.click(); };
  await expect(await row(page, "node_modules/")).toBeVisible();
  await expect(await row(page, ".env")).toBeVisible();
  // Nothing is read until the user expands a folder.
  await waitForTreeIdle(page);
  expect(listings).toEqual([]);
  await expect(await row(page, "build/")).toHaveAttribute("aria-expanded", "false");
  await captureScreenshot(page, info, `${label}-ignored-folders-muted`);

  const before = await count(page);
  await activate("build/");
  await rowAppears(page, "build/CMakeCache.txt");
  await expect(await row(page, "build/renders/")).toBeVisible();
  await expect.poll(() => count(page)).toBe(before + 1);
  expect(listings).toEqual(["build/"]);
  await captureScreenshot(page, info, `${label}-ignored-folder-expanded`);

  // A render written during the session reaches Recent and the Audio filter
  // without its folder being listed, and Follow stays where it was.
  const url = page.url();
  await fs.writeFile(workspacePath("build", "renders", "take-2.wav"), wavFixture(12));
  await page.locator("#files-pane-filter-recent").click();
  await expect(page.locator('#recent-files button[data-path="build/renders/take-2.wav"]')).toBeVisible({ timeout: 10_000 });
  await typeFilter(page, "audio");
  await expect(page.locator("#document-count")).toHaveText("1");
  expect(page.url()).toBe(url);
  await captureScreenshot(page, info, `${label}-ignored-render-in-recent`);
  await page.getByRole("button", { name: "Play build/renders/take-2.wav", exact: true }).click();
  await expect.poll(() => page.locator("audio[src]").evaluate((element: HTMLAudioElement) => new URL(element.src).searchParams.get("path")))
    .toBe("build/renders/take-2.wav");
  // The persistent dock covers the lower rows on a phone; close it to go on.
  await page.locator("#media-dock").getByRole("button", { name: "Close player" }).click();
  await typeFilter(page, "all");

  // Expanding the subfolder lists the rest of that level, once.
  await page.locator("#files-pane-filter-all").click();
  await activate("build/renders/");
  await rowAppears(page, "build/renders/notes.txt");
  await expect(await row(page, "build/renders/take-2.wav")).toBeVisible();
  await activate("build/renders/");
  await activate("build/renders/");
  await waitForTreeIdle(page);
  expect(listings).toEqual(["build/", "build/renders/"]);

  // Secret-like files are ordinary files, as in VS Code.
  await activate(".env");
  await expect(page.locator("#preview")).toContainText("PREVIEW_TOKEN=visible-like-vscode");
}

test("desktop Chromium: ignored folders are muted, listed on expansion, and fresh renders reach Recent without stealing Follow", async ({ page, request }, info) => {
  await seed(request);
  await workflow(page, request, info, "chromium-desktop", false);
});

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine} touch: ignored folders are listed by tap and renders reach Recent`, async ({ launchBrowser, request, serverPort }, info) => {
    test.setTimeout(60_000);
    await seed(request);
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}`, viewport: { width: 390, height: 844 }, hasTouch: true });
      await workflow(page, request, info, `${engine}-touch`, true);
    } finally { await browser.close(); }
  });
}

test("webkit desktop: an ignored folder lists by click", async ({ launchBrowser, request, serverPort }) => {
  await seed(request);
  const browser = await launchBrowser("webkit");
  try {
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    const listings = trackListings(page);
    await open(page, request);
    await (await row(page, "node_modules/")).click();
    await rowAppears(page, "node_modules/left-pad/");
    expect(listings).toEqual(["node_modules/"]);
  } finally { await browser.close(); }
});

test("keyboard expansion lists a folder, keeps focus on its row, and a failed listing can be retried", async ({ page, request }, info) => {
  await seed(request);
  const listings = trackListings(page);
  let fail = true;
  await page.route("**/api/index/folder", route => fail ? route.fulfill({ status: 500, body: "{}" }) : route.fallback());
  await open(page, request);
  // Mounting, filter changes and visibility toggles never list anything.
  await page.locator("#files-pane-filter-changed").click();
  await page.locator("#files-pane-filter-all").click();
  await showIgnored(page, false);
  await expect(treeRow(page, "build/")).toHaveCount(0);
  await showIgnored(page, true);
  await page.keyboard.press("Escape");
  await waitForTreeIdle(page);
  expect(listings).toEqual([]);

  const build = await row(page, "build/");
  await build.focus();
  await build.press("ArrowRight");
  await expect(build).toHaveAttribute("aria-expanded", "true");
  await expect(build).toContainText("Couldn't list");
  await expect(build).toBeFocused();
  await captureScreenshot(page, info, "ignored-folder-listing-failed");
  fail = false;
  // The row's menu offers the retry; collapsing and expanding works as well.
  await build.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Retry listing" }).click();
  await rowAppears(page, "build/CMakeCache.txt");
  await expect(await row(page, "build/")).not.toContainText("Couldn't list");
  expect(listings).toEqual(["build/", "build/"]);
  // A listed level is never requested again.
  const listed = await row(page, "build/");
  await listed.focus();
  await listed.press("ArrowLeft");
  await listed.press("ArrowRight");
  await expect(listed).toBeFocused();
  await waitForTreeIdle(page);
  expect(listings).toEqual(["build/", "build/"]);
});

test("an opened ignored file refreshes in place when a rebuild rewrites it", async ({ page, request }) => {
  await seed(request, { "build/report.md": "# Report\n\nFirst build.\n" });
  await open(page, request);
  await (await row(page, "build/")).click();
  await rowAppears(page, "build/report.md");
  await (await row(page, "build/report.md")).click();
  await expect(page.locator("#preview")).toContainText("First build.");
  await fs.writeFile(workspacePath("build", "report.md"), "# Report\n\nSecond build.\n");
  await expect(page.locator("#preview")).toContainText("Second build.", { timeout: 10_000 });
  await expect(page).toHaveURL(/build\/report\.md/);
});

test("a direct link to a file inside unlisted ignored folders lists the levels revealed around it", async ({ page, request }) => {
  await seed(request);
  const listings = trackListings(page);
  const { token } = await (await request.get("/__e2e/terminal-token")).json();
  await page.goto(`/build/renders/notes.txt?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#preview")).toContainText("Takes for the didgeridoo comparison");
  await expect.poll(() => listings.slice().sort()).toEqual(["build/", "build/renders/"]);
  await rowAppears(page, "build/CMakeCache.txt");
  await expect(await row(page, "build/renders/notes.txt")).toHaveAttribute("aria-selected", "true");
});

test("a 40,000-file ignored node_modules costs one entry, and an 80,000-write install stays bounded and never steals Follow @perf", { tag: "@perf" }, async ({ page, request }, info) => {
  test.setTimeout(300_000);
  const extras: Record<string, string> = { ".gitignore": "node_modules/\n" };
  for (let i = 0; i < 40_000; i++) extras[`node_modules/pkg-${i % 800}/file-${i}.js`] = "module.exports = 1;\n";
  const startedReset = performance.now();
  const reset = await request.post("/__e2e/reset", { data: { git: true, follow: true, nativeWatch: true, extras }, timeout: 240_000 });
  expect(reset.ok()).toBe(true);
  const discoveryMs = performance.now() - startedReset;
  const initial = await request.get("/api/state").then(response => response.json());
  const docs = initial.roots.flatMap((root: any) => root.docs);
  // Discovery: one folder entry, nothing read beneath it.
  expect(initial.roots.flatMap((root: any) => root.folders ?? []).map((folder: any) => folder.relativePath)).toEqual(["node_modules/"]);
  expect(docs.filter((doc: any) => doc.relativePath.startsWith("node_modules/"))).toHaveLength(0);

  await page.addInitScript(() => {
    const Native = window.EventSource;
    (window as any).__patches = [];
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("live", event => {
          const envelope = JSON.parse((event as MessageEvent).data);
          const patch = envelope.event?.data;
          if (envelope.topic !== "document" || patch?.kind !== "patch") return;
          const paths = [...patch.upserts.map((doc: any) => doc.relativePath), ...patch.removals.map((doc: any) => doc.id)];
          (window as any).__patches.push({ at: Date.now(), entries: patch.upserts.length + patch.removals.length,
            install: paths.filter((value: string) => value.includes("node_modules/")).length, changedId: patch.changedId, paths: paths.slice(0, 3) });
        });
      }
    };
  });
  const { token } = await (await request.get("/__e2e/terminal-token")).json();
  const mountStarted = performance.now();
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect.poll(async () => { await revealTreeRow(page, "node_modules/"); return treeRow(page, "node_modules/").count(); }).toBe(1);
  const treeMountMs = performance.now() - mountStarted;
  const selected = page.url();

  // An install writes 80,000 files into the unlisted folder, and a document
  // is saved in the middle of it.
  const installStarted = performance.now();
  let editAt = 0;
  for (let batch = 0; batch < 80; batch++) {
    await Promise.all(Array.from({ length: 1000 }, async (_, i) => {
      const directory = workspacePath("node_modules", `new-${batch}`);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(`${directory}/f-${i}.js`, "x");
    }));
    if (batch === 40) {
      editAt = Date.now();
      await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nSaved during an install.\n");
    }
  }
  const installMs = performance.now() - installStarted;
  await expect(page.locator("#preview")).toContainText("Saved during an install.", { timeout: 15_000 });
  const editVisibleMs = Date.now() - editAt;
  // Let the lane drain.
  await expect.poll(async () => {
    const state = await request.get("/api/state").then(response => response.json());
    return state.roots.flatMap((root: any) => root.docs).filter((doc: any) => doc.relativePath.startsWith("node_modules/")).length;
  }, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(6000);
  const after = await request.get("/api/state").then(response => response.json());
  const installDocs = after.roots.flatMap((root: any) => root.docs).filter((doc: any) => doc.relativePath.startsWith("node_modules/"));
  const patches: { at: number; entries: number; install: number; changedId: string | null; paths: string[] }[] = await page.evaluate(() => (window as any).__patches);
  const editPatchMs = (patches.find(patch => patch.paths.includes("guides/setup.md"))?.at ?? Infinity) - editAt;
  const lanePatches = patches.filter(patch => patch.install > 0);
  // Deterministic counters: the window bound, the lane's patch size, a
  // separate document patch, and no Follow into the install.
  expect(installDocs.length).toBeLessThanOrEqual(2000);
  expect(lanePatches.every(patch => patch.entries <= 1024)).toBe(true);
  expect(patches.some(patch => patch.install === 0 && patch.paths.includes("guides/setup.md"))).toBe(true);
  expect(patches.filter(patch => patch.changedId?.includes("node_modules"))).toEqual([]);
  // A loose wall-clock guard on the 2 s publication bound (recorded below).
  expect(editPatchMs).toBeLessThan(4000);
  expect(page.url()).not.toContain("node_modules");
  void selected;
  await saveEvidence(info, "ignored-install-perf.json", JSON.stringify({
    fixture: { ignoredFiles: 40_000, installWrites: 80_000 },
    discoveryMs: Math.round(discoveryMs), treeMountMs: Math.round(treeMountMs), installMs: Math.round(installMs),
    editVisibleMs: Math.round(editVisibleMs), editPatchMs: Math.round(editPatchMs), installDocsAfter: installDocs.length,
    lanePatches: lanePatches.length, largestLanePatch: Math.max(0, ...lanePatches.map(patch => patch.entries)),
    lanePatchEntries: lanePatches.reduce((n, patch) => n + patch.entries, 0),
  }, null, 2));
});
