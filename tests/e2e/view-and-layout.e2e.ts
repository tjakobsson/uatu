import { expect, test } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { openTreeFile, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";
import type { StatePayload } from "../../src/shared/types";
import type { Page } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("View chooser shows three segments for Markdown / AsciiDoc and two for source files", async ({ page }) => {
  // README.md is markdown — all three segments visible.
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // Switch to a code/text file. The chooser stays visible but Rendered is
  // hidden (no separate rendered representation for source files).
  await fs.writeFile(workspacePath("settings.json"), "{\"key\": \"value\"}\n", "utf8");
  const codeFile = treeRow(page, "settings.json");
  await expect(codeFile).toBeVisible();
  await codeFile.click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // Back to README.md — all three segments visible again.
  await treeRow(page, "README.md").click();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});

test("View-mode preference persists across reload", async ({ page }) => {
  // Default is Rendered.
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  await page.locator("#view-source").click();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");

  await page.reload();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();
});

test("Layout chooser is visible for Markdown / AsciiDoc and hidden for source files", async ({ page }) => {
  // README.md is markdown — chooser is visible alongside the view toggle.
  await expect(page.locator(".uatu-layout-toolbar")).toBeVisible();

  // Switch to a code/text file: the layout chooser hides (split layouts
  // pair Source + Rendered, and source files have no separate Rendered).
  // The view chooser stays visible since the Diff segment introduced the
  // Source / Diff chooser for text files.
  await fs.writeFile(workspacePath("split-chooser.json"), "{\"key\": \"value\"}\n", "utf8");
  const codeFile = treeRow(page, "split-chooser.json");
  await expect(codeFile).toBeVisible();
  await codeFile.click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator(".uatu-layout-toolbar")).toBeHidden();

  // Back to README.md — both controls return.
  await treeRow(page, "README.md").click();
  await expect(page.locator(".uatu-layout-toolbar")).toBeVisible();
});

test("Side-by-side layout renders Source left, Rendered right, with both visible", async ({ page }) => {
  // Default is single layout; activate side-by-side.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");

  // Two panes plus a resizer between them.
  await expect(page.locator("#preview.is-split.is-split-h")).toBeVisible();
  await expect(page.locator("#preview .preview-pane-source")).toBeVisible();
  await expect(page.locator("#preview .preview-pane-rendered")).toBeVisible();
  await expect(page.locator("#preview .preview-split-resizer")).toBeVisible();

  // Source pane carries the distinguishing whole-file <pre> class,
  // mirroring single Source view.
  await expect(page.locator("#preview .preview-pane-source pre.uatu-source-pre")).toBeVisible();

  // The view chooser stays visible in split so Diff remains reachable —
  // Diff replaces both panes and would be unreachable otherwise. Clicking
  // Source or Rendered in split is a no-op visually (the persisted
  // preference updates for the next return to single).
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});

test("Stacked layout renders Source on top, Rendered below", async ({ page }) => {
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-v']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-v']")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#preview.is-split.is-split-v")).toBeVisible();

  // DOM order: source pane then resizer then rendered pane.
  const order = await page.evaluate(() => {
    const children = Array.from(document.querySelectorAll<HTMLElement>("#preview > *"));
    return children.map(child => {
      if (child.classList.contains("preview-pane-source")) return "source";
      if (child.classList.contains("preview-split-resizer")) return "resizer";
      if (child.classList.contains("preview-pane-rendered")) return "rendered";
      return child.className;
    });
  });
  expect(order).toEqual(["source", "resizer", "rendered"]);
});

test("Layout preference persists across reload and across documents", async ({ page }) => {
  // Default is single.
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='single']")).toHaveAttribute("aria-checked", "true");

  // Activate side-by-side, then open another markdown doc — layout sticks.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split-h")).toBeVisible();
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await expect(page.locator("#preview.is-split-h")).toBeVisible();

  // Reload — preference survives.
  await page.reload();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#preview.is-split-h")).toBeVisible();
});

test("Switching to single layout preserves the Source / Rendered preference", async ({ page }) => {
  // Set Source as the active view-mode preference.
  await page.locator("#view-source").click();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");

  // Enter side-by-side; the chooser stays visible (so Diff stays
  // reachable) and the persisted Source preference is preserved.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  // Wait for the split to actually mount. Entering split fetches the missing
  // Rendered view and then rebuilds the layout toolbar; a click on Single
  // that is still in progress when that rebuild lands is dropped (mousedown
  // and mouseup hit different buttons), leaving the preview in split.
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#preview.is-split-h")).toBeVisible();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");

  // Return to single — the preference must still be Source.
  await page.locator(".uatu-layout-toolbar [data-layout-value='single']").click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
  // And the body is in source view, not rendered.
  await expect(page.locator("#preview > pre.uatu-source-pre")).toBeVisible();
});

test("A document load the server fails transiently recovers without another click", async ({ page }) => {
  // The first read of diagram.md fails the way an overloaded server does; the
  // file itself is fine. A 5xx is not "file removed", so the preview must
  // retry on its own instead of staying on the unavailable notice.
  let reads = 0;
  let releaseRetry: () => void = () => {};
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
  await page.route("**/api/document?*", async route => {
    const id = new URL(route.request().url()).searchParams.get("id") ?? "";
    if (!id.endsWith("/diagram.md")) return route.continue();
    reads += 1;
    if (reads === 1) return route.fulfill({ status: 500, json: { error: "document render failed" } });
    // Hold the retry until the interim notice has been observed.
    await retryGate;
    return route.continue();
  });

  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview")).toContainText("This file couldn't be loaded. Retrying");
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  releaseRetry();

  await expect(page.locator("#preview-title")).toHaveText("Diagram Fixture");
  await expect(page.locator("#preview")).not.toContainText("couldn't be loaded");
});

// Opens links-demo.md with its outline open, then edits it on disk so the
// live document topic reloads the render already on screen. `answer` decides
// the response to each reload of the file; earlier reads pass through.
async function reloadRenderedLinksDemo(
  page: Page,
  answer: (reload: number) => Promise<"continue" | number>,
): Promise<{ reloads: () => number }> {
  let reloading = false;
  let reloads = 0;
  await page.route("**/api/document?*", async route => {
    const id = new URL(route.request().url()).searchParams.get("id") ?? "";
    if (!reloading || !id.endsWith("/links-demo.md")) return route.continue();
    reloads += 1;
    const outcome = await answer(reloads);
    if (outcome === "continue") return route.continue();
    return route.fulfill({ status: outcome, json: { error: outcome === 404 ? "document not found" : "document render failed" } });
  });
  await openTreeFile(page, "links-demo.md");
  await expect(page.locator("#preview-title")).toHaveText("Markdown Cross-Document Links");
  await expect(page.locator("#file-facts-strip")).toBeVisible();
  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline-link")).toHaveCount(4);

  reloading = true;
  await fs.writeFile(
    workspacePath("links-demo.md"),
    "# Markdown Cross-Document Links\n\nReload landed marker.\n\n## Sibling document\n",
    "utf8",
  );
  await expect.poll(() => reloads).toBeGreaterThanOrEqual(1);
  return { reloads: () => reloads };
}

test("A same-document reload that fails transiently keeps the render on screen while it retries", async ({ page }) => {
  // The file on screen changed on disk, and the reload hits a server that is
  // briefly failing. The reader keeps the document, its outline and its
  // facts strip; a small notice says the reload is retrying (#468).
  let releaseRetry: () => void = () => {};
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
  const reload = await reloadRenderedLinksDemo(page, async attempt => {
    if (attempt === 1) return 500;
    await retryGate;
    return "continue";
  });

  // The first reload has failed and the retry is held at the gate.
  await expect.poll(() => reload.reloads()).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#preview-title")).toHaveText("Markdown Cross-Document Links");
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");
  await expect(page.locator("#preview")).toContainText("External links are unaffected");
  await expect(page.locator("#preview")).not.toContainText("couldn't be loaded");
  await expect(page.locator(".uatu-outline-link")).toHaveCount(4);
  await expect(page.locator("#file-facts-strip")).toBeVisible();
  const notice = page.locator("#preview-reload-notice");
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("status")).toHaveText("This file couldn't be reloaded. Retrying…");
  await expect(notice.getByRole("button", { name: "Retry loading this file" })).toBeHidden();
  // Nothing was updated: the facts strip does not pulse "Updated" next to it.
  // Read once rather than with a retrying assertion, which would wait the
  // 3 s pulse out.
  expect(await page.locator("#file-facts-strip").evaluate(strip => strip.classList.contains("is-updated"))).toBe(false);
  expect(await page.locator("#preview-updated").isHidden()).toBe(true);

  releaseRetry();
  await expect(page.locator("#preview")).toContainText("Reload landed marker.");
  await expect(notice).toBeHidden();
  await expect(page.locator(".uatu-outline-link")).toHaveCount(2);
  // The edit has landed now, so now the strip says so.
  await expect(page.locator("#file-facts-strip")).toHaveClass(/is-updated/);
});

test("A reload overtaken by a newer one that fails does not pulse Updated", async ({ page }) => {
  // Two quick edits: the first reload is held, the second fails. The first
  // one's answer then arrives for a load that no longer owns the preview, so
  // nothing on screen was updated and the strip must not say otherwise.
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const reload = await reloadRenderedLinksDemo(page, async attempt => {
    if (attempt !== 1) return 500;
    await firstGate;
    return "continue";
  });
  await fs.writeFile(workspacePath("links-demo.md"), "# Markdown Cross-Document Links\n\nSecond edit.\n", "utf8");
  const notice = page.locator("#preview-reload-notice");
  await expect(notice.getByRole("status")).toHaveText("This file couldn't be reloaded. Retrying…");
  expect(reload.reloads()).toBeGreaterThanOrEqual(2);

  const firstAnswer = page.waitForResponse(response =>
    response.url().includes("links-demo.md") && response.url().includes("/api/document?") && response.status() === 200);
  releaseFirst();
  await firstAnswer;
  // Let the page handle that answer before reading the strip once.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.locator("#file-facts-strip").evaluate(strip => strip.classList.contains("is-updated"))).toBe(false);
  await expect(page.locator("#preview")).toContainText("External links are unaffected");
  await expect(notice).toBeVisible();
});

test("A text file that turns binary while a reload retries takes the reload notice down", async ({ page }) => {
  // An extensionless file is classified by its bytes, so the same document
  // can become binary. Its binary notice replaces the kept render.
  let reloading = false;
  await page.route("**/api/document?*", route => {
    const id = new URL(route.request().url()).searchParams.get("id") ?? "";
    if (reloading && id.endsWith("/notes")) return route.fulfill({ status: 500, json: { error: "document render failed" } });
    return route.continue();
  });
  await fs.writeFile(workspacePath("notes"), "plain notes\n", "utf8");
  await openTreeFile(page, "notes");
  await expect(page.locator("#preview")).toContainText("plain notes");

  reloading = true;
  await fs.writeFile(workspacePath("notes"), "plain notes, edited\n", "utf8");
  const notice = page.locator("#preview-reload-notice");
  await expect(notice).toBeVisible();

  await fs.writeFile(workspacePath("notes"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  await expect(page.locator("#preview")).toContainText("This file type isn't viewable in uatu.");
  await expect(notice).toBeHidden();
});

test("A same-document reload whose retries all fail keeps the render and offers Retry", async ({ page }) => {
  // The schedule (250 ms, 1 s, 3 s, 10 s) is driven by a fake clock so the
  // test does not wait 14 s of real time. Every reload fails until the server
  // "recovers"; the reader keeps the document and gets a Retry button that
  // makes one new request.
  await page.clock.install();
  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  let recovered = false;
  let releaseRetry: () => void = () => {};
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
  const reload = await reloadRenderedLinksDemo(page, async () => {
    if (!recovered) return 500;
    await retryGate;
    return "continue";
  });

  const notice = page.locator("#preview-reload-notice");
  const retry = notice.getByRole("button", { name: "Retry loading this file" });
  // The first request plus the four scheduled retries; advance the clock
  // only after each failure has scheduled its successor.
  await expect.poll(async () => {
    await page.clock.runFor(10_000);
    return reload.reloads();
  }, { timeout: 20_000 }).toBe(5);
  await expect(page.locator("#preview-title")).toHaveText("Markdown Cross-Document Links");
  await expect(page.locator("#preview")).toContainText("External links are unaffected");
  await expect(page.locator("#preview")).not.toContainText("couldn't be loaded");
  await expect(page.locator(".uatu-outline-link")).toHaveCount(4);
  await expect(page.locator("#file-facts-strip")).toBeVisible();
  await expect(notice.getByRole("status")).toHaveText("This file couldn't be reloaded.");
  await expect(retry).toBeVisible();
  await page.clock.runFor(60_000);
  expect(reload.reloads()).toBe(5);

  recovered = true;
  await retry.focus();
  await page.keyboard.press("Enter");
  // While that request is in flight the notice says so and Retry is gone,
  // so a second press cannot start a load that discards this one's answer.
  await expect.poll(() => reload.reloads()).toBe(6);
  await expect(notice.getByRole("status")).toHaveText("This file couldn't be reloaded. Retrying…");
  await expect(retry).toBeHidden();
  // The keyboard user is not dropped onto the page body when Retry hides.
  expect(await page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body)).toBe(true);
  await page.keyboard.press("Enter");

  releaseRetry();
  await expect(page.locator("#preview")).toContainText("Reload landed marker.");
  await expect(notice).toBeHidden();
  expect(reload.reloads()).toBe(6);
});

test("Switching to Diff while a failed reload retries takes the reload notice down", async ({ page }) => {
  // The notice belongs to the render it kept. Diff replaces that render
  // without going through a document load, so it must clear the notice too.
  await reloadRenderedLinksDemo(page, async attempt => attempt === 1 ? 500 : new Promise<never>(() => {}));
  const notice = page.locator("#preview-reload-notice");
  await expect(notice).toBeVisible();

  await page.locator("#view-diff").click();
  await expect(page.locator(".uatu-diff-host")).toBeVisible();
  await expect(notice).toBeHidden();
});

test("Switching to Diff takes the reload notice down before the diff arrives", async ({ page }) => {
  // The retry belongs to the Rendered view the reader just left, so the
  // notice goes as soon as Diff is chosen, while its request is in flight or
  // if it fails, and the Retry button is never left doing nothing.
  let diffRequested = false;
  await page.route("**/api/document/diff?*", () => {
    diffRequested = true;
    return new Promise<never>(() => {});
  });
  await reloadRenderedLinksDemo(page, async attempt => attempt === 1 ? 500 : new Promise<never>(() => {}));
  const notice = page.locator("#preview-reload-notice");
  await expect(notice).toBeVisible();

  await page.locator("#view-diff").click();
  await expect.poll(() => diffRequested).toBe(true);
  await expect(notice).toBeHidden();
});

// Answers every /api/document request for links-demo.md through `answer`,
// which sees the requested view; other documents pass through.
async function routeLinksDemoViews(
  page: Page,
  answer: (view: string) => Promise<"continue" | number>,
): Promise<void> {
  await page.route("**/api/document?*", async route => {
    const url = new URL(route.request().url());
    if (!(url.searchParams.get("id") ?? "").endsWith("/links-demo.md")) return route.continue();
    const outcome = await answer(url.searchParams.get("view") ?? "");
    if (outcome === "continue") return route.continue();
    return route.fulfill({ status: outcome, json: { error: "document render failed" } });
  });
}

function editLinksDemo(): Promise<void> {
  return fs.writeFile(
    workspacePath("links-demo.md"),
    "# Markdown Cross-Document Links\n\nReload landed marker.\n\n## Sibling document\n",
    "utf8",
  );
}

for (const layout of ["split-h", "split-v"] as const) {
  test(`A ${layout} reload whose second view fails transiently keeps both panes while it retries`, async ({ page }) => {
    // A split reload asks for the current view, then the other one. When only
    // the second request fails, the split on screen stays, as it does when
    // the first fails, instead of collapsing to one pane.
    let reloading = false;
    let sourceReloads = 0;
    let releaseRetry: () => void = () => {};
    const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
    await routeLinksDemoViews(page, async view => {
      if (!reloading || view !== "source") return "continue";
      sourceReloads += 1;
      if (sourceReloads === 1) return 500;
      await retryGate;
      return "continue";
    });
    await openTreeFile(page, "links-demo.md");
    await page.locator(`.uatu-layout-toolbar [data-layout-value='${layout}']`).click();
    const split = page.locator(`#preview.is-split.is-${layout}`);
    await expect(split.locator(".preview-pane-source")).toContainText("External links are unaffected");
    await expect(split.locator(".preview-pane-rendered")).toContainText("External links are unaffected");

    reloading = true;
    await editLinksDemo();
    await expect.poll(() => sourceReloads).toBeGreaterThanOrEqual(2);
    const notice = page.locator("#preview-reload-notice");
    await expect(notice.getByRole("status")).toHaveText("This file couldn't be reloaded. Retrying…");
    await expect(split.locator(".preview-pane-source")).toContainText("External links are unaffected");
    await expect(split.locator(".preview-pane-rendered")).toContainText("External links are unaffected");
    await expect(page.locator("#file-facts-strip")).toBeVisible();

    releaseRetry();
    await expect(split.locator(".preview-pane-rendered")).toContainText("Reload landed marker.");
    await expect(split.locator(".preview-pane-source")).toContainText("Reload landed marker.");
    await expect(notice).toBeHidden();
  });
}

test("A split layout that fell back to one pane keeps that pane when a later reload fails", async ({ page }) => {
  // Entering Side-by-side with the Source request failing falls back to the
  // single Rendered pane. That pane is still this document on screen, so a
  // later failed reload in Side-by-side keeps it, as it would keep the split.
  let reloading = false;
  await routeLinksDemoViews(page, async view => view === "source" || reloading ? 500 : "continue");
  await openTreeFile(page, "links-demo.md");
  await expect(page.locator("#preview")).toContainText("External links are unaffected");
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#preview")).not.toHaveClass(/is-split/);
  await expect(page.locator("#preview")).toContainText("External links are unaffected");

  reloading = true;
  await editLinksDemo();
  const notice = page.locator("#preview-reload-notice");
  await expect(notice.getByRole("status")).toHaveText("This file couldn't be reloaded. Retrying…");
  await expect(page.locator("#preview")).toContainText("External links are unaffected");
  await expect(page.locator("#preview")).not.toContainText("couldn't be loaded");
  await expect(page.locator("#preview")).not.toHaveClass(/is-split/);
});

test("Choosing a split while a single-pane reload fails keeps the pane and shows the chosen layout", async ({ page }) => {
  // The kept single pane stands in for the split that could not load, as a
  // split's own fallback pane does, so the layout toolbar shows the choice.
  let failing = false;
  await routeLinksDemoViews(page, async () => failing ? 500 : "continue");
  await openTreeFile(page, "links-demo.md");
  await expect(page.locator("#preview")).toContainText("External links are unaffected");
  failing = true;
  await editLinksDemo();
  const notice = page.locator("#preview-reload-notice");
  await expect(notice).toBeVisible();

  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='single']")).toHaveAttribute("aria-checked", "false");
  await expect(notice.getByRole("status")).toHaveText("This file couldn't be reloaded. Retrying…");
  await expect(page.locator("#preview")).toContainText("External links are unaffected");
});

test("A same-document reload that fails for good still shows the unavailable notice", async ({ page }) => {
  // A 404 is final: the file is gone, so keeping its old render would mislead.
  await reloadRenderedLinksDemo(page, async () => 404);

  await expect(page.locator("#preview")).toContainText(
    "File unavailable. It may have been removed or excluded from this workspace.",
  );
  await expect(page.locator("#preview-reload-notice")).toBeHidden();
  await expect(page.locator(".uatu-outline-link")).toHaveCount(0);
  await expect(page.locator("#file-facts-strip")).toBeHidden();
});

const permissionNoticeTitle = "A document the server cannot read shows the permission notice once and loads on the next selection";
for (const subMillisecondMtime of [false, true]) {
  test(`${permissionNoticeTitle}${subMillisecondMtime ? " (sub-millisecond mtime)" : ""}`, async ({ page }) => {
    await checkUnreadableDocument(page, subMillisecondMtime);
  });
}

async function checkUnreadableDocument(page: Page, subMillisecondMtime: boolean): Promise<void> {
  test.skip(process.getuid?.() === 0, "chmod cannot deny root a read");
  // Permission denied will not clear on its own, so the server answers a final
  // 403 and the preview must neither retry nor say "Retrying". The denying
  // chmod changes ctime, but a polling watcher need not report that alone.
  // Advance mtime too and await that indexed update in the browser before
  // selection, so setup cannot reload the file while we measure its reads.
  // The restoring chmod runs while the file
  // is selected, and a watcher that reports a pure mode change (chokidar in
  // fs.watch mode can) may reload it on its own, so the recovery check below
  // does not count reads exactly.
  const filePath = workspacePath("diagram.md");
  const originalStat = await fs.stat(filePath);
  const setupMtime = new Date(Math.ceil(originalStat.mtimeMs) + 1_000);
  let reads = 0;
  await page.route("**/api/document?*", route => {
    const id = new URL(route.request().url()).searchParams.get("id") ?? "";
    if (id.endsWith("/diagram.md")) reads += 1;
    return route.continue();
  });

  await fs.chmod(filePath, 0o000);
  try {
    // Exercise filesystems that round a requested millisecond down to the
    // preceding microsecond, as observed in the Linux CI failure trace.
    const observedMtime = subMillisecondMtime ? setupMtime.getTime() / 1_000 - 0.000001 : setupMtime;
    await fs.utimes(filePath, originalStat.atime, observedMtime);
    await expect.poll(async () => {
      const state: StatePayload = await page.request.get("/api/state").then(response => response.json());
      const indexedDocument = state.roots.flatMap(root => root.docs).find(doc => doc.id === filePath);
      // Filesystems can round utimes' millisecond target slightly; as in the
      // Linux CI failure trace, the stored mtime can keep the preceding
      // microsecond (for example, 8437.999 instead of 8438), so an exact
      // comparison would wait forever on that fractional timestamp. The
      // requested Date is whole-millisecond (Math.ceil + 1000), so comparing
      // with Math.round at that precision accepts such rounding — a tighter
      // window than the upstream ±2 ms tolerance, which addressed the same
      // mismatch — while still rejecting the prior timestamp, which is a
      // full second older.
      if (!indexedDocument || Math.round(indexedDocument.mtimeMs) !== setupMtime.getTime()) return false;
      return page.evaluate(
        generatedAt => Number(document.body.dataset.stateGeneratedAt ?? 0) >= generatedAt,
        state.generatedAt,
      );
    }, { message: "permission setup's document update applied before selection" }).toBe(true);
    await treeRow(page, "diagram.md").click();
    await expect(page.locator("#preview")).toContainText(
      "Uatu doesn't have permission to read this file. Change its permissions, then select it again.",
    );
    await expect(page.locator("#preview")).not.toContainText("Retrying");
    // Settled: one read, still one past the first two retry delays (250 ms,
    // 1 s). Any further read keeps the poll from passing.
    const settledFrom = Date.now();
    await expect.poll(() => {
      if (reads !== 1) throw new Error(`expected one read, saw ${reads}`);
      return Date.now() - settledFrom;
    }, { timeout: 5_000, intervals: [100] }).toBeGreaterThanOrEqual(1_500);
    expect(reads).toBe(1);
    await expect(page.locator("#preview")).not.toContainText("Retrying");
  } finally {
    await fs.chmod(filePath, 0o644);
  }

  const readsBeforeReselect = reads;
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Diagram Fixture");
  await expect(page.locator("#preview")).not.toContainText("permission");
  expect(reads).toBeGreaterThan(readsBeforeReselect);
}

test("An OK document answer that does not parse is final, not retried", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/document?*", route => {
    const id = new URL(route.request().url()).searchParams.get("id") ?? "";
    if (!id.endsWith("/diagram.md")) return route.continue();
    reads += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: "not json" });
  });

  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview")).toContainText("This file couldn't be loaded. Select it again to retry.");
  await expect(page.locator("#preview")).not.toContainText("Retrying");
  const settledFrom = Date.now();
  await expect.poll(() => {
    if (reads !== 1) throw new Error(`expected one read, saw ${reads}`);
    return Date.now() - settledFrom;
  }, { timeout: 5_000, intervals: [100] }).toBeGreaterThanOrEqual(1_500);
  expect(reads).toBe(1);
});

test("A layout click survives a render that lands between mousedown and mouseup", async ({ page }) => {
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  // Hold the Source fetch that entering side-by-side needs, so the render it
  // triggers can be released at a chosen moment inside the next click.
  let releaseSource: () => void = () => {};
  const sourceHeld = new Promise<void>(resolve => {
    void page.route("**/api/document?*", async route => {
      if (new URL(route.request().url()).searchParams.get("view") !== "source") return route.continue();
      releaseSource = () => void route.continue();
      resolve();
    });
  });

  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await sourceHeld;

  // Press on Single, let the split render land, then release. The render
  // must not replace the button under the pointer, or the browser fires no
  // click and the switch back to single is lost.
  const single = page.locator(".uatu-layout-toolbar [data-layout-value='single']");
  const box = await single.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  releaseSource();
  await expect(page.locator("#preview.is-split-h")).toBeVisible();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");
  await page.mouse.up();

  await expect(single).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#preview")).not.toHaveClass(/is-split/);
});

test("Dragging the split resizer reallocates space between panes", async ({ page }) => {
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split-h")).toBeVisible();

  // Measure the source pane's initial width, then drag the resizer right.
  const sourcePane = page.locator("#preview .preview-pane-source");
  const initialBox = await sourcePane.boundingBox();
  expect(initialBox).not.toBeNull();
  const resizer = page.locator("#preview .preview-split-resizer");
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  if (!initialBox || !resizerBox) return;

  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2 + 80, resizerBox.y + resizerBox.height / 2, {
    steps: 8,
  });
  await page.mouse.up();

  const finalBox = await sourcePane.boundingBox();
  expect(finalBox).not.toBeNull();
  if (!finalBox) return;
  // Source pane has grown by approximately the drag distance (allowing some
  // tolerance for clamping and rounding).
  expect(finalBox.width).toBeGreaterThan(initialBox.width + 30);
});

test("Dragging the stacked split resizer reallocates vertical space", async ({ page }) => {
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-v']").click();
  await expect(page.locator("#preview.is-split-v")).toBeVisible();

  const sourcePane = page.locator("#preview .preview-pane-source");
  const initialBox = await sourcePane.boundingBox();
  expect(initialBox).not.toBeNull();
  const resizer = page.locator("#preview .preview-split-resizer");
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  if (!initialBox || !resizerBox) return;

  // Source pane must actually occupy a meaningful share of the preview body
  // up front (regression guard: in stacked mode the pane previously collapsed
  // to content-height because the container had no resolved height).
  expect(initialBox.height).toBeGreaterThan(100);

  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2 + 80, {
    steps: 8,
  });
  await page.mouse.up();

  const finalBox = await sourcePane.boundingBox();
  expect(finalBox).not.toBeNull();
  if (!finalBox) return;
  // Source pane has grown vertically by approximately the drag distance.
  expect(finalBox.height).toBeGreaterThan(initialBox.height + 30);
});
