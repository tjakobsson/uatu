import { expect, test, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test.skip(process.env.UATU_VISUAL_SPIKE !== "1", "navbar visual spike is opt-in");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const prototypePath = resolve(root, "tests/prototypes/navbar-visual-spike/index.html");
const screenshotDir = resolve(root, "openspec/changes/navbar-visual-spike/screenshots");
const indexPath = resolve(screenshotDir, "README.md");
const desktop = { width: 1440, height: 900 };
const constrained = { width: 980, height: 720 };

const images = [
  ["01-default.png", "Load prototype", "Workspace and Preview visible; Follow enabled"],
  ["02-chat-opened.png", "Chat", "Workspace, Preview, and Chat visible; Chat active"],
  ["03-preview-hidden.png", "Chat → Preview", "Workspace and Chat visible; Preview hidden"],
  ["04-terminal-opened.png", "Terminal", "Workspace and Preview visible; Terminal open and active"],
  ["05-changes-since-base.png", "Changes", "Since base active; repository facts show vs main"],
  ["06-changes-since-last-commit.png", "Changes → Since last commit", "Base evidence remains; Changes anchor shows vs HEAD"],
  ["07-workspace-history.png", "Workspace panel: History", "History shares the active workspace context"],
  ["08-settings.png", "Settings", "Centered Settings modal overlays the workspace"],
  ["09-workspace-search.png", "Workspace panel: Search", "Search shares the active workspace context"],
  ["10-workspace-switcher.png", "Open workspace switcher", "Three live fixture worktree sessions remain visible"],
  ["11-alternate-worktree.png", "Switcher → navbar-study", "Alternate worktree updates panel and preview identity"],
  ["12-no-primary-surface.png", "Workspace → Preview", "All primary surfaces hidden; quiet launcher visible"],
  ["13-constrained-default.png", "Load prototype at 980 × 720", "Default chrome at constrained desktop width"],
] as const;

async function writeReviewIndex(): Promise<void> {
  const rows = images.map(([file, sequence, state], index) => `| ${index + 1} | [${file}](./${file}) | ${sequence} | ${state} |`).join("\n");
  await writeFile(indexPath, `# Navbar Visual Spike

Disposable visual evidence only. These screenshots do not establish product requirements.

## Screenshot Sequence

| # | Screenshot | Click sequence | Captured state |
|---:|---|---|---|
${rows}

## Observations

The statements below describe the captured evidence, not recommendations.

- **All primary surfaces hidden:** Screenshot 12 shows the accepted quiet launcher and revised copy.
- **Workspace panel relationship:** Screenshots 05-07 and 09 place Changes, History, and Search beside Files in one context-scoped region.
- **Comparison lenses:** Screenshots 05 and 06 preserve Since base and Since last commit with current repository facts and anchors; arbitrary commit selection is not modeled.
- **Worktree sessions:** Screenshots 10 and 11 show several visibly open fixture sessions with one displayed at a time. Creation, hosting, persistence, synchronization, and split views remain undefined.
- **Selected versus active:** Screenshots 02 and 04 use the accepted neutral pressed tiles and dots with a stronger monochrome active marker.
- **Settings capacity:** Screenshot 08 shows the accepted centered modal direction.
- **Documentation-only wording:** Scope, persistence, and final wording remain unresolved.

## Review Dispositions

| Reviewed direction | Disposition | Review note |
|---|---|---|
| Permit all primary surfaces to be hidden and show a quiet launcher | **Accepted** | Keep the behavior with the revised “Choose a surface” wording. |
| Use neutral pressed tiles and dots plus a monochrome active marker | **Accepted** | Carry this visual grammar into a later production proposal. |
| Use the centered Settings modal shown in screenshot 08 | **Accepted** | Carry this modal direction into a later production proposal. |
| Place Files, Search, Changes, and History in one Workspace panel | **Still open** | Awaiting review of the revised comparison presentation. |
| Preserve Since base and Since last commit in the unified Changes view | **Still open** | Awaiting review of screenshots 05 and 06. |
| Keep several worktree sessions open behind a one-at-a-time switcher | **Accepted** | Carry this switcher direction into a later production proposal. |
| Use “Documentation files only” wording and undefined semantics | **Still open** | Reassess wording, scope, and persistence in a later product proposal. |
`, "utf8");
}

test.afterEach(async ({}, testInfo) => {
  if (testInfo.title === "captures the ordered desktop review matrix" && testInfo.status === "passed") await writeReviewIndex();
});

async function installGuards(page: Page): Promise<{ requests: string[]; errors: string[] }> {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", request => requests.push(request.url()));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "__storageWrites", { value: [], configurable: false });
    const record = (kind: string, key?: string): void => {
      (window as unknown as { __storageWrites: string[] }).__storageWrites.push(`${kind}:${key ?? "*"}`);
    };
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    const clear = Storage.prototype.clear;
    Storage.prototype.setItem = function(key: string, value: string): void {
      record("set", key);
      setItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key: string): void {
      record("remove", key);
      removeItem.call(this, key);
    };
    Storage.prototype.clear = function(): void {
      record("clear");
      clear.call(this);
    };
  });
  await page.goto("about:blank");
  return { requests, errors };
}

async function reset(page: Page, html: string, viewport = desktop): Promise<void> {
  await page.setViewportSize(viewport);
  await page.setContent(html, { waitUntil: "load" });
  await expect(page.locator(".watermark")).toContainText("Visual spike");
  await page.evaluate(() => document.fonts.ready);
}

function control(page: Page, name: string) {
  return page.locator(`[data-control="${name}"]`);
}

async function expectSurface(page: Page, name: string, visible: boolean, active = false): Promise<void> {
  const button = control(page, name);
  await expect(button).toHaveAttribute("aria-pressed", String(visible));
  await expect(button).toHaveAttribute("data-selected", String(visible));
  await expect(button).toHaveAttribute("data-active", String(active));
  if (visible) await expect(page.locator(`[data-surface="${name}"]`)).toBeVisible();
  else await expect(page.locator(`[data-surface="${name}"]`)).toBeHidden();
}

async function expectPanel(page: Page, name: string, open: boolean): Promise<void> {
  await expect(control(page, name)).toHaveAttribute("aria-expanded", String(open));
  if (open) await expect(page.locator(`[data-panel="${name}"]`)).toBeVisible();
  else await expect(page.locator(`[data-panel="${name}"]`)).toBeHidden();
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: resolve(screenshotDir, name),
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
}

test("keeps every prototype control reversible and isolated", async ({ page }) => {
  const html = await readFile(prototypePath, "utf8");
  const guard = await installGuards(page);
  await reset(page, html);

  await expectSurface(page, "files", true);
  await expectSurface(page, "preview", true, true);
  await expectSurface(page, "chat", false);
  await expectSurface(page, "terminal", false);
  await expect(control(page, "follow")).toHaveAttribute("aria-pressed", "true");

  for (const name of ["files", "preview", "chat", "terminal"]) {
    const wasSelected = await control(page, name).getAttribute("aria-pressed") === "true";
    await control(page, name).click();
    await expect(control(page, name)).toHaveAttribute("aria-pressed", String(!wasSelected));
    await control(page, name).click();
    await expect(control(page, name)).toHaveAttribute("aria-pressed", String(wasSelected));
  }

  await control(page, "follow").click();
  await expect(control(page, "follow")).toHaveAttribute("aria-pressed", "false");
  await control(page, "follow").click();
  await expect(control(page, "follow")).toHaveAttribute("aria-pressed", "true");

  await expect(page.locator('[data-control="changes"], [data-control="git"]')).toHaveCount(0);

  await control(page, "settings").click();
  await expectPanel(page, "settings", true);
  const docsOnly = page.locator("[data-docs-only]");
  await docsOnly.click();
  await expect(docsOnly).toHaveAttribute("aria-checked", "true");
  await docsOnly.click();
  await expect(docsOnly).toHaveAttribute("aria-checked", "false");
  await page.locator("[data-settings-close]").click();
  await expectPanel(page, "settings", false);
  await control(page, "settings").click();
  await expectPanel(page, "settings", true);
  await control(page, "settings").click();
  await expectPanel(page, "settings", false);

  for (const view of ["search", "changes", "history"]) {
    const tab = page.locator(`[data-files-view="${view}"]`);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`[data-files-content="${view}"]`)).toBeVisible();
  }
  await page.locator('[data-files-view="files"]').click();
  await expect(page.locator('[data-files-content="files"]')).toBeVisible();

  await page.locator('[data-files-view="changes"]').click();
  const sinceBase = page.locator('[data-compare-target="base"]');
  const sinceLastCommit = page.locator('[data-compare-target="last-commit"]');
  await expect(sinceBase).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-changes-anchor]")).toHaveText("vs main");
  await sinceLastCommit.click();
  await expect(sinceLastCommit).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-changes-anchor]")).toHaveText("vs HEAD");
  await sinceBase.click();
  await expect(sinceBase).toHaveAttribute("aria-pressed", "true");

  const switcherToggle = page.locator("[data-workspace-switcher-toggle]");
  await switcherToggle.click();
  await expect(page.locator("[data-workspace-switcher]")).toBeVisible();
  await expect(page.locator("[data-worktree]")).toHaveCount(3);
  await page.locator('[data-worktree="navbar-study"]').click();
  await expect(switcherToggle).toContainText("navbar-study");
  await expect(page.locator("[data-preview-path]")).toHaveText("openspec/changes/navbar-visual-spike/design.md");
  await expect(page.locator("[data-preview-title]")).toHaveText("A workspace can hold more than one line of work");
  await expect(sinceBase).toHaveAttribute("aria-pressed", "true");
  await sinceLastCommit.click();
  await expect(page.locator("[data-changes-anchor]")).toHaveText("vs HEAD");
  await switcherToggle.click();
  await expect(page.locator('[data-worktree="navbar-study"]')).toHaveAttribute("aria-selected", "true");
  await page.locator('[data-worktree="main"]').click();
  await expect(page.locator("[data-preview-path]")).toHaveText("docs/workspace-navigation.md");
  await expect(sinceBase).toHaveAttribute("aria-pressed", "true");

  expect(guard.requests).toEqual([]);
  expect(guard.errors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __storageWrites: string[] }).__storageWrites)).toEqual([]);
});

test("captures the ordered desktop review matrix", async ({ page }) => {
  const html = await readFile(prototypePath, "utf8");
  const guard = await installGuards(page);
  await mkdir(screenshotDir, { recursive: true });
  for (const entry of await readdir(screenshotDir)) {
    if (entry.endsWith(".png")) await unlink(resolve(screenshotDir, entry));
  }

  await reset(page, html);
  await expectSurface(page, "files", true);
  await expectSurface(page, "preview", true, true);
  await expect(control(page, "follow")).toHaveAttribute("aria-pressed", "true");
  await capture(page, images[0][0]);

  await reset(page, html);
  await control(page, "chat").click();
  await expectSurface(page, "files", true);
  await expectSurface(page, "preview", true);
  await expectSurface(page, "chat", true, true);
  await capture(page, images[1][0]);

  await reset(page, html);
  await control(page, "chat").click();
  await control(page, "preview").click();
  await expectSurface(page, "preview", false);
  await expectSurface(page, "chat", true, true);
  await capture(page, images[2][0]);

  await reset(page, html);
  await control(page, "terminal").click();
  await expectSurface(page, "terminal", true, true);
  await expectSurface(page, "preview", true);
  await capture(page, images[3][0]);

  await reset(page, html);
  await page.locator('[data-files-view="changes"]').click();
  await expect(page.locator('[data-files-view="changes"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-files-content="changes"]')).toBeVisible();
  await expect(page.locator('[data-files-content="files"]')).toBeHidden();
  await expect(page.locator('[data-compare-target="base"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-compare-target="last-commit"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-changes-anchor]")).toHaveText("vs main");
  await expect(page.locator(".overview-fact").filter({ hasText: "Base" })).toContainText("main (fallback base) · 42b8a0f");
  await capture(page, images[4][0]);

  await reset(page, html);
  await page.locator('[data-files-view="changes"]').click();
  await page.locator('[data-compare-target="last-commit"]').click();
  await expect(page.locator('[data-compare-target="last-commit"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-compare-target="base"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-changes-anchor]")).toHaveText("vs HEAD");
  await expect(page.locator(".overview-fact").filter({ hasText: "Base" })).toContainText("main (fallback base) · 42b8a0f");
  await capture(page, images[5][0]);

  await reset(page, html);
  await page.locator('[data-files-view="history"]').click();
  await expect(page.locator('[data-files-view="history"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-files-content="history"]')).toBeVisible();
  await capture(page, images[6][0]);

  await reset(page, html);
  await control(page, "settings").click();
  await expectPanel(page, "settings", true);
  await expect(page.locator("[data-settings-modal]")).toBeVisible();
  await expect(page.locator(".settings-category")).toHaveCount(4);
  await expect(page.locator("[data-settings-close]")).toBeVisible();
  await expect(page.locator("[data-docs-only]")).toHaveAttribute("aria-checked", "false");
  await capture(page, images[7][0]);

  await reset(page, html);
  await page.locator('[data-files-view="search"]').click();
  await expect(page.locator('[data-files-content="search"]')).toBeVisible();
  await expect(page.locator('[data-files-view="search"]')).toHaveAttribute("aria-selected", "true");
  await capture(page, images[8][0]);

  await reset(page, html);
  await page.locator("[data-workspace-switcher-toggle]").click();
  await expect(page.locator("[data-workspace-switcher]")).toBeVisible();
  await expect(page.locator("[data-worktree]")).toHaveCount(3);
  await expect(page.locator('[data-worktree="main"]')).toHaveAttribute("aria-selected", "true");
  await capture(page, images[9][0]);

  await reset(page, html);
  await page.locator("[data-workspace-switcher-toggle]").click();
  await page.locator('[data-worktree="navbar-study"]').click();
  await expect(page.locator("[data-workspace-switcher]")).toBeHidden();
  await expect(page.locator("[data-workspace-branch]").first()).toHaveText("navbar-study");
  await expect(page.locator("[data-preview-path]")).toHaveText("openspec/changes/navbar-visual-spike/design.md");
  await expect(page.locator("[data-tree-active-file]")).toHaveText("design.md");
  await capture(page, images[10][0]);

  await reset(page, html);
  await control(page, "files").click();
  await control(page, "preview").click();
  await expectSurface(page, "files", false);
  await expectSurface(page, "preview", false);
  await expect(page.locator("[data-empty-launcher]")).toBeVisible();
  await capture(page, images[11][0]);

  await reset(page, html, constrained);
  await expectSurface(page, "files", true);
  await expectSurface(page, "preview", true, true);
  await capture(page, images[12][0]);

  expect(guard.requests).toEqual([]);
  expect(guard.errors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __storageWrites: string[] }).__storageWrites)).toEqual([]);

  const rows = images.map(([file, sequence, state], index) => `| ${index + 1} | [${file}](./${file}) | ${sequence} | ${state} |`).join("\n");
  await writeFile(indexPath, `# Navbar Visual Spike\n\nDisposable visual evidence only. These screenshots do not establish product requirements.\n\n## Screenshot Sequence\n\n| # | Screenshot | Click sequence | Captured state |\n|---:|---|---|---|\n${rows}\n\n## Observations\n\nThe statements below describe the captured evidence, not recommendations.\n\n- **All primary surfaces hidden:** Screenshot 09 shows a centered quiet launcher.\n- **Files/Search relationship:** Screenshot 08 places Search within the persistent Files side-panel region.\n- **Selected versus active:** Screenshots 02 and 04 use neutral pressed tiles and dots for visible surfaces with one stronger monochrome active marker.\n- **Repository context:** Screenshots 05-06 isolate changes and history. Review identified a broader relationship among Files, repositories, history, and future simultaneous worktrees that this matrix does not model.\n- **Settings capacity:** Screenshot 07 replaces the rejected compact popover with a centered modal, category rail, and representative room for additional settings.\n- **Documentation-only wording:** Screenshot 07 says “Documentation files only” and explicitly labels its semantics as illustrative. Scope, persistence, and final wording remain unresolved.\n\n## Review Dispositions\n\n| Reviewed direction | Disposition | Review note |\n|---|---|---|\n| Permit all primary surfaces to be hidden and show a quiet launcher | **Accepted** | Keep the behavior with the revised “Choose a surface” wording. |\n| Place Search in the persistent Files side-panel region | **Accepted** | Carry this relationship into a later production proposal. |\n| Use blue selected fill plus a teal active marker | **Rejected** | Color was too dominant for an open-state indicator. |\n| Use teal selected fill plus a navy active marker | **Rejected** | Review preferred a non-color visibility indicator. |\n| Use neutral pressed tiles and dots plus a monochrome active marker | **Accepted** | Carry this visual grammar into a later production proposal. |\n| Treat Change Overview and Git Log as isolated anchored overlays | **Still open** | Revisit with Files, repositories, and simultaneous-worktree navigation as one broader model. |\n| Use a compact anchored popover for Settings | **Rejected** | It does not leave enough room for future settings. |\n| Use the centered Settings modal shown in screenshot 07 | **Still open** | Awaiting visual review of the revised fixture. |\n| Use “Documentation files only” wording and undefined semantics | **Still open** | Reassess wording, scope, and persistence in a later product proposal. |\n`, "utf8");
});
