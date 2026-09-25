// Behaviors that are specific to the @pierre/trees-backed document tree.
// Kept in its own file so a focused failure doesn't drag the broader e2e
// suite into the swap-related fallout. Targets the library's a11y attributes
// (role="treeitem", aria-expanded, aria-selected, data-item-path) which
// Playwright reaches through the shadow DOM via standard CSS selectors.

import { chromium, webkit } from "@playwright/test";
import { expect, test, type Page } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { revealTreeRow, treeRow } from "./tree-helpers";
import { DOCUMENT_SELECTION_CLEARED_KEY } from "../../src/shell/selection-storage";

// The E2E session is served at /. Match presentationStorage's workspace
// namespace; deliberate emptiness is not a Hub personal-state field.
const selectionClearedStorageKey = `uatu:presentation:v1:${encodeURIComponent("/")}:${DOCUMENT_SELECTION_CLEARED_KEY}`;

async function browserSelectionCleared(page: Page): Promise<boolean> {
  return page.evaluate(key => localStorage.getItem(key) === "true", selectionClearedStorageKey);
}

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

async function bootSession(
  page: Page,
  request: { post: (path: string, init?: { data: unknown }) => Promise<unknown> },
  body: Record<string, unknown> = {},
): Promise<void> {
  // Observe real accepted-topic delivery, without replacing the live transport
  // or importing application state. Empty preview is not a refresh barrier.
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("live", event => {
          const frame = JSON.parse((event as MessageEvent).data);
          if (frame.topic === "document" && frame.event?.kind === "data") {
            const state = frame.event.data;
            requestAnimationFrame(() => requestAnimationFrame(() => {
              (window as any).__treeDeliveredIndex = state;
            }));
          }
        });
      }
    };
  });
  await request.post("/__e2e/reset", { data: body });
  await page.goto("/");
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await page.reload();
  // Wait for the SPA to indicate the live channel is connected and the index
  // has been loaded (file count > 0). Both are reliable, library-independent
  // readiness signals.
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#document-count")).not.toHaveText("0 files", { timeout: 5_000 });
  // At least one tree row must be present in the shadow DOM. We don't assert
  // .toBeVisible() because the library virtualizes rows — in git-backed
  // sessions the workspace has 25+ files and the row we care about might
  // be scrolled out of the initial viewport. .toBeAttached() works on the
  // model presence, which is what we actually need for the test setup.
  await expect(page.locator('[role="treeitem"]').first()).toBeAttached();
}

test("manually expanding a folder, then clicking a file in it, leaves the folder expanded", async ({
  page,
  request,
}) => {
  await bootSession(page, request);

  const guidesFolder = treeRow(page, "guides/");
  await expect(guidesFolder).toBeVisible();
  await expect(guidesFolder).toHaveAttribute("aria-expanded", "false");

  await guidesFolder.click();
  await expect(guidesFolder).toHaveAttribute("aria-expanded", "true");

  const setupFile = treeRow(page, "guides/setup.md");
  await expect(setupFile).toBeVisible();
  await setupFile.click();

  // Preview switches to the clicked file.
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");

  // And — the regression we're protecting against — the folder we expanded
  // by hand must NOT collapse just because the selection changed.
  await expect(guidesFolder).toHaveAttribute("aria-expanded", "true");
  await expect(setupFile).toHaveAttribute("aria-selected", "true");
});

test("starting with follow on and a nested file as default reveals its ancestors and selects it", async ({
  page,
  request,
}) => {
  // Make `guides/setup.md` the newest non-binary file so it becomes the
  // default selection. resetE2EWorkspace bumps README's mtime 10s into the
  // future, so we have to go even fresher.
  const fresh = new Date(Date.now() + 30_000);

  // Reset first (this also bumps README's mtime by 10s), then make setup.md
  // strictly newer. The SPA takes its default from the server at boot, so
  // wait until the server itself names setup.md the default document — not
  // a watcher-sized sleep, which loses to a slow refresh under load and
  // leaves the page booting onto README.
  await request.post("/__e2e/reset", { data: { follow: true } });
  await fs.utimes(workspacePath("guides", "setup.md"), fresh, fresh);
  await expect.poll(async () => {
    const state = await request.get("/api/state").then(response => response.json());
    const docs = state.roots.flatMap((root: any) => root.docs);
    return docs.find((doc: any) => doc.id === state.defaultDocumentId)?.relativePath;
  }).toBe("guides/setup.md");

  await page.goto("/");
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await page.reload();

  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  // The server already reported setup.md as the default before the page
  // loaded, so this is the boot selection, not a watcher refresh landing.
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");

  // The tree should have revealed `guides/` on first paint and marked
  // `guides/setup.md` as selected.
  const guidesFolder = treeRow(page, "guides/");
  await expect(guidesFolder).toHaveAttribute("aria-expanded", "true");

  const setupFile = treeRow(page, "guides/setup.md");
  await expect(setupFile).toBeVisible();
  await expect(setupFile).toHaveAttribute("aria-selected", "true");
});

test("follow-mode auto-switch expands the new file's folder, selects it, and deselects the previous file", async ({
  page,
  request,
}) => {
  await bootSession(page, request);

  // bootSession returns with the server-default Follow=true. Click a tree
  // row to establish a deterministic Follow=false starting state (Rule A),
  // then click the Follow chip to flip back to Follow=true (Rule B).
  await treeRow(page, "README.md").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "false");

  // Touch a nested file — follow must auto-switch to it (Rule C).
  await fs.writeFile(
    workspacePath("guides", "setup.md"),
    "# Setup\n\nFollow me into the folder.\n",
    "utf8",
  );

  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");

  // The destination folder must now be expanded so the user can see what
  // got selected.
  await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "true");

  // The newly-active file is selected, the previously-active one is not.
  await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "true");
  await expect(treeRow(page, "README.md")).toHaveAttribute("aria-selected", "false");
});

test("clicking an image file renders an inline image preview", async ({ page, request }) => {
  // Use an SVG — its bytes are text, so they survive the e2e server's
  // JSON+utf8 file-write round-trip without any base64 dance. The
  // VIEWABLE_IMAGE_EXTENSIONS set in app.ts includes .svg.
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#1ca8a7"/></svg>`;
  await bootSession(page, request, { extras: { "hero.svg": svg } });

  const logoRow = treeRow(page, "hero.svg");
  await expect(logoRow).toBeVisible();
  await logoRow.click();

  await expect(page.locator("#preview-path")).toHaveText("hero.svg");
  // An <img> renders inside the preview, sourced from the static-file
  // fallback at /hero.svg (resolved via the per-document <base href>).
  const img = page.locator("#preview .image-preview img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "hero.svg");
  // The image actually loads (non-zero naturalWidth means the browser
  // received bytes the decoder accepts).
  await page.waitForFunction(() => {
    const el = document.querySelector("#preview .image-preview img") as HTMLImageElement | null;
    return el != null && el.complete && el.naturalWidth > 0;
  });
});

test("clicking a non-image binary shows a 'not viewable' notice, not a 'no longer exists' error", async ({
  page,
  request,
}) => {
  // A short blob with a NUL byte forces binary classification via the content sniff.
  const zipBytes = "PK\x03\x04\u0000ignored\u0000binary content";
  await bootSession(page, request, { extras: { "archive.zip": zipBytes } });

  const archiveRow = treeRow(page, "archive.zip");
  await expect(archiveRow).toBeVisible();
  await archiveRow.click();

  await expect(page.locator("#preview-path")).toHaveText("archive.zip");
  // Friendly message, not the legacy "no longer exists" wording.
  await expect(page.locator("#preview")).toContainText("isn't viewable");
  await expect(page.locator("#preview")).not.toContainText("no longer exists");
  // No image element is rendered for non-image binaries.
  await expect(page.locator("#preview .image-preview img")).toHaveCount(0);
});

test("a user-expanded folder is preserved across an unrelated filesystem refresh", async ({
  page,
  request,
}) => {
  await bootSession(page, request);

  // User expands `metadata/`.
  const metadataFolder = treeRow(page, "metadata/");
  await expect(metadataFolder).toBeVisible();
  await metadataFolder.click();
  await expect(metadataFolder).toHaveAttribute("aria-expanded", "true");

  // An unrelated file changes on disk (NOT inside metadata/). The watcher
  // refreshes the index and a resetPaths-driven re-render happens. The
  // expansion the user chose must survive.
  await fs.writeFile(workspacePath("README.md"), "# Refreshed\n\nNew content.\n", "utf8");

  // Wait for the actual refresh, not a delay that can pass before delivery.
  await expect(page.locator("#preview")).toContainText("New content.");

  await expect(metadataFolder).toHaveAttribute("aria-expanded", "true");
});

test("a user-expanded folder is preserved when a file is added", async ({ page, request }) => {
  await bootSession(page, request);
  await treeRow(page, "README.md").click();
  const metadataFolder = treeRow(page, "metadata/");
  await metadataFolder.click();
  await expect(metadataFolder).toHaveAttribute("aria-expanded", "true");

  await fs.writeFile(workspacePath("added.md"), "# Added\n", "utf8");
  await expect(treeRow(page, "added.md")).toBeAttached();
  await expect(metadataFolder).toHaveAttribute("aria-expanded", "true");
});

async function collapseSelectedAncestorAndExpandMetadata(page: Page): Promise<void> {
  const guidesFolder = treeRow(page, "guides/");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "true");
  await treeRow(page, "metadata/").click();
  await expect(treeRow(page, "metadata/")).toHaveAttribute("aria-expanded", "true");
  await guidesFolder.click();
  await expect(guidesFolder).toHaveAttribute("aria-expanded", "false");
  await expectClosedDocument(page);
}

async function expectClosedDocument(page: Page): Promise<void> {
  await expect(page.locator("#preview")).toHaveClass(/\bempty\b/);
  await expect(page.locator("#preview-path")).not.toHaveText(/guides\/.*\.(md|adoc)/);
  await expect(page.locator("#preview-title")).not.toHaveText(/^(Setup|Nested|Closed document)$/);
  await expect(page.locator("#preview h1, #preview h2, #preview img, #preview pre, #preview .diff-view")).toHaveCount(0);
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.locator("#tree").evaluate(element =>
    (element as HTMLElement & { __pierreFileTree: { getSelectedPaths(): string[] } }).__pierreFileTree.getSelectedPaths()
      .filter(path => !path.endsWith("/")))).toEqual([]);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
}

async function refreshClosedContent(page: Page, path = "guides/setup.md"): Promise<void> {
  const before = await page.evaluate(() => (window as any).__treeDeliveredIndex?.generatedAt ?? 0);
  const mtime = new Date(Date.now() + 60_000);
  await fs.writeFile(workspacePath(...path.split("/")), "# Closed document\n\nMust not remount.\n", "utf8");
  await fs.utimes(workspacePath(...path.split("/")), mtime, mtime);
  await expect.poll(() => page.evaluate(({ before, path, mtime }) => {
    const state = (window as any).__treeDeliveredIndex;
    return state?.generatedAt > before && state.roots.some((root: any) =>
      root.docs.some((doc: any) => doc.relativePath === path && Math.abs(doc.mtimeMs - mtime) < 2));
  }, { before, path, mtime: mtime.getTime() })).toBe(true);
}

async function expectPreservedFolderState(page: Page): Promise<void> {
  await expectClosedDocument(page);
  await expect(treeRow(page, "metadata/")).toHaveAttribute("aria-expanded", "true");
  const guidesFolder = treeRow(page, "guides/");
  await expect(guidesFolder).toHaveAttribute("aria-expanded", "false");

  await guidesFolder.click();
  await expect(guidesFolder).toHaveAttribute("aria-expanded", "true");
  await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "false");
  await expectClosedDocument(page);
}

test("a user-collapsed active folder stays collapsed when its file is updated", async ({ page, request }) => {
  await bootSession(page, request);
  await treeRow(page, "guides/").click();
  await treeRow(page, "guides/setup.md").click();
  await collapseSelectedAncestorAndExpandMetadata(page);
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  await refreshClosedContent(page);
  await expectPreservedFolderState(page);
});

test("a user-collapsed active folder stays collapsed when an unrelated file is added", async ({ page, request }) => {
  await bootSession(page, request);
  await treeRow(page, "guides/").click();
  await treeRow(page, "guides/setup.md").click();
  await collapseSelectedAncestorAndExpandMetadata(page);
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  await fs.writeFile(workspacePath("added.md"), "# Added\n", "utf8");
  await expect(treeRow(page, "added.md")).toBeAttached();
  await expectPreservedFolderState(page);
});

for (const operation of ["removed", "renamed"] as const) {
  test(`a user-collapsed active folder stays collapsed when an unrelated file is ${operation}`, async ({ page, request }) => {
    await bootSession(page, request, { extras: { "unrelated.md": "# Unrelated\n" } });
    await treeRow(page, "guides/").click();
    await treeRow(page, "guides/setup.md").click();
    await collapseSelectedAncestorAndExpandMetadata(page);
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
    // Establish presence before removal so absence cannot pass before delivery.
    await expect(treeRow(page, "unrelated.md")).toBeAttached();
    if (operation === "removed") {
      await fs.unlink(workspacePath("unrelated.md"));
    } else {
      await fs.rename(workspacePath("unrelated.md"), workspacePath("renamed.md"));
      await expect(treeRow(page, "renamed.md")).toBeAttached();
    }
    await expect(treeRow(page, "unrelated.md")).not.toBeAttached();
    await expectPreservedFolderState(page);
  });
}

test("a user-collapsed active folder turns Follow off and stays empty when the same document updates", async ({ page, request }) => {
  await bootSession(page, request);
  await treeRow(page, "README.md").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nFollow setup.\n", "utf8");
  await expect(page.locator("#preview")).toContainText("Follow setup.");
  await collapseSelectedAncestorAndExpandMetadata(page);
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await refreshClosedContent(page);
  await expectPreservedFolderState(page);
});

for (const input of ["pointer", "touch", "Enter", "Space", "ArrowLeft"] as const) {
  test.describe(`ancestor collapse via ${input}`, () => {
    test.use(input === "touch" ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {});
    test("closes the document, retains directory focus, and reopening stays empty", async ({ page, request }) => {
      await bootSession(page, request);
      if (input === "touch") await page.locator("#touch-tab-files").click();
      await treeRow(page, "README.md").click();
      if (input === "touch") await page.locator("#touch-tab-files").click();
      await page.locator("#follow-toggle").click();
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
      await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nNative collapse fixture.\n", "utf8");
      await expect(page.locator("#preview")).toContainText("Native collapse fixture.");
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
      if (input === "touch") await page.locator("#touch-tab-files").click();
      const folder = treeRow(page, "guides/");
      await expect(folder).toHaveAttribute("aria-expanded", "true");
      if (input === "pointer") await folder.click();
      else if (input === "touch") await folder.tap();
      else { await folder.focus(); await page.keyboard.press(input); }
      await expect(folder).toHaveAttribute("aria-expanded", "false");
      await expect(folder).toBeFocused();
      await expectClosedDocument(page);
      if (input === "touch") {
        await expect(page.locator("#touch-tab-files")).toHaveAttribute("aria-selected", "true");
        await page.locator("#touch-tab-preview").tap();
        await expect(page.locator("#preview.empty")).toBeVisible();
        await page.locator("#touch-tab-files").tap();
      }
      await folder.click();
      await expect(folder).toHaveAttribute("aria-expanded", "true");
      await expectClosedDocument(page);
      // Native keyboard navigation remains usable after the deselection.
      await folder.focus();
      await page.keyboard.press("ArrowRight");
      await expect(treeRow(page, "guides/notes.adoc")).toBeFocused();
      await expectClosedDocument(page);
    });
  });
}

test("opening, unrelated prefix-folder collapse, and ArrowLeft focus-only preserve selection and Follow", async ({ page, request }) => {
  await bootSession(page, request, { extras: { "guides-extra/control.md": "# Control\n" } });
  await treeRow(page, "README.md").click();
  await page.locator("#follow-toggle").click();
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nControl document.\n", "utf8");
  await expect(page.locator("#preview")).toContainText("Control document.");
  const unrelated = treeRow(page, "guides-extra/");
  await unrelated.click();
  await expect(unrelated).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await unrelated.click();
  await expect(unrelated).toHaveAttribute("aria-expanded", "false");
  await treeRow(page, "guides/setup.md").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(treeRow(page, "guides/")).toBeFocused();
  await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(page.locator("#preview")).toContainText("Control document.");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
});

for (const ancestor of ["guides/", "guides/deep/"]) {
  test(`nested active document closes at ${ancestor} and preserves expanded descendants through rebuild`, async ({ page, request }) => {
    await bootSession(page, request, { extras: { "guides/deep/nested.md": "# Nested\n" } });
    await treeRow(page, "guides/").click();
    await treeRow(page, "guides/deep/").click();
    await treeRow(page, "guides/deep/nested.md").click();
    await treeRow(page, "metadata/").click();
    await treeRow(page, ancestor).click();
    await expect(treeRow(page, ancestor)).toHaveAttribute("aria-expanded", "false");
    await expectClosedDocument(page);
    await fs.writeFile(workspacePath("added.md"), "# Added\n", "utf8");
    await expect(treeRow(page, "added.md")).toBeAttached();
    await expect(treeRow(page, ancestor)).toHaveAttribute("aria-expanded", "false");
    await expect(treeRow(page, "metadata/")).toHaveAttribute("aria-expanded", "true");
    await treeRow(page, ancestor).click();
    await expect(treeRow(page, "guides/deep/")).toHaveAttribute("aria-expanded", "true");
    await expect(treeRow(page, "guides/deep/nested.md")).toHaveAttribute("aria-selected", "false");
    await expectClosedDocument(page);
    // A subsequent collapse with no active file is expansion only.
    await treeRow(page, "metadata/").click();
    await expect(treeRow(page, "metadata/")).toHaveAttribute("aria-expanded", "false");
    await expectClosedDocument(page);
  });
}

for (const changed of [false, true]) {
  test(`intentional emptiness survives both filter directions after manual collapse in ${changed ? "Changed" : "All"}`, async ({ page, request }) => {
    await bootSession(page, request, { git: true, dirty: { "guides/setup.md": "# Setup\n\nDirty fixture.\n" } });
    if (changed) await page.locator("#files-pane-filter-changed").click();
    const folder = treeRow(page, "guides/");
    await revealTreeRow(page, "guides/");
    if (await folder.getAttribute("aria-expanded") !== "true") await folder.click();
    await treeRow(page, "guides/setup.md").click();
    await folder.click();
    await expectClosedDocument(page);
    for (const filter of changed ? ["all", "changed", "all"] : ["changed", "all", "changed"]) {
      await page.locator(`#files-pane-filter-${filter}`).click();
      await expect(page.locator(`#files-pane-filter-${filter}`)).toHaveAttribute("aria-checked", "true");
      await expectClosedDocument(page);
    }
    await refreshClosedContent(page);
    await expectClosedDocument(page);
  });
}

test("programmatic filter transitions and rebuilds preserve an active document and Follow", async ({ page, request }) => {
  await bootSession(page, request, { git: true });
  await treeRow(page, "README.md").click();
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  for (const filter of ["changed", "all"]) {
    await page.locator(`#files-pane-filter-${filter}`).click();
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  }
  // Also exercise the independent real-index completion barrier on a green
  // control, rather than first discovering a broken barrier after the fix.
  await refreshClosedContent(page, "README.md");
  await expect(page.locator("#preview")).toContainText("Must not remount.");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
});

test("Changed active-only ancestor collapse moves keyboard focus to the next visible row", async ({ page, request }) => {
  await bootSession(page, request, { git: true, dirty: { "other/changed.md": "# Changed elsewhere\n" } });
  await revealTreeRow(page, "guides/");
  const folder = treeRow(page, "guides/");
  if (await folder.getAttribute("aria-expanded") !== "true") await folder.click();
  await treeRow(page, "guides/setup.md").click();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await page.locator("#files-pane-filter-changed").click();
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "true");
  await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "true");
  await expect(treeRow(page, "guides/setup.md")).not.toHaveAttribute("data-item-git-status", /.+/);
  await expect(treeRow(page, "other/changed.md")).toBeAttached();
  await folder.click();
  await expectClosedDocument(page);
  // Closing the document drops the active-only override, so Changed filtering
  // removes the operated directory. Focus is not pinned to a filtered-out row:
  // it continues on a remaining visible row instead.
  const focusEvidence = await page.locator("#tree").evaluate(element => {
    const tree = (element as HTMLElement & { __pierreFileTree: {
      getItem(path: string): unknown;
      getFocusedPath(): string | null;
    } }).__pierreFileTree;
    return {
      operatedDirectoryInModel: Boolean(tree.getItem("guides/")),
      libraryFocusedPath: tree.getFocusedPath(),
      activeTreePath: element.shadowRoot?.activeElement?.getAttribute("data-item-path") ?? null,
    };
  });
  await test.info().attach("changed-active-only-collapse-focus", {
    body: JSON.stringify(focusEvidence, null, 2), contentType: "application/json",
  });
  expect(focusEvidence.operatedDirectoryInModel, JSON.stringify(focusEvidence)).toBe(false);
  await expect(folder).not.toBeAttached();
  expect(focusEvidence.libraryFocusedPath, JSON.stringify(focusEvidence)).not.toBeNull();
  expect(focusEvidence.libraryFocusedPath!.startsWith("guides/")).toBe(false);
  await expect(treeRow(page, focusEvidence.libraryFocusedPath!)).toBeAttached();
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "true");
});

for (const cleared of [false, true]) {
  test(`startup ${cleared ? "honors intentional emptiness over a stale remembered destination" : "restores a legacy remembered destination without an empty marker"}`, async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const response = await request.patch("/api/personal-state", {
      data: { documentPath: "guides/setup.md", follow: false },
    });
    expect(response.ok()).toBe(true);
    if (cleared) await page.addInitScript(key => localStorage.setItem(key, "true"), selectionClearedStorageKey);
    await page.goto("/");
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect(page.locator('[role="treeitem"]').first()).toBeAttached();
    if (cleared) await expectClosedDocument(page);
    else {
      await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
      await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
    }
  });
}

for (const resume of ["file", "Follow", "history", "deep-link"] as const) {
  test(`reload remembers a closed document until explicit ${resume} navigation`, async ({ page, request }) => {
    await bootSession(page, request);
    // No stored deliberate-empty marker: legacy/first visit still defaults.
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await treeRow(page, "guides/").click();
    await treeRow(page, "guides/setup.md").click();
    const selectedUrl = page.url();
    await collapseSelectedAncestorAndExpandMetadata(page);
    await expect.poll(() => browserSelectionCleared(page)).toBe(true);
    await page.reload();
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect(page.locator('[role="treeitem"]').first()).toBeAttached();
    await expectClosedDocument(page);
    if (resume === "file") {
      const folder = treeRow(page, "guides/");
      if (await folder.getAttribute("aria-expanded") !== "true") await folder.click();
      await expectClosedDocument(page);
      await treeRow(page, "guides/setup.md").click();
    } else if (resume === "Follow") {
      await refreshClosedContent(page);
      await expectClosedDocument(page);
      await page.locator("#follow-toggle").click();
    } else if (resume === "deep-link") await page.goto(selectedUrl);
    else {
      // Closing may replace or push a history entry. Put an explicit document
      // destination behind the empty entry, then exercise the native popstate.
      await page.evaluate(url => {
        history.replaceState(null, "", url);
        history.pushState(null, "", "/");
      }, selectedUrl);
      await page.goBack();
    }
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "true");
    await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#preview")).not.toHaveClass(/\bempty\b/);
    await expect.poll(() => request.get("/api/personal-state").then(response => response.json()).then(state => state.documentPath)).toBe("guides/setup.md");
    await expect.poll(() => browserSelectionCleared(page)).toBe(false);
    await page.reload();
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  });
}

for (const activation of ["pointer", "Enter", "Space", "touch"] as const) {
  test.describe(`same-file ${activation} activation`, () => {
    test.use(activation === "touch" ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {});
    test("visible selected file performs manual navigation exactly once", async ({ page, request }) => {
      await bootSession(page, request);
      if (activation === "touch") await page.locator("#touch-tab-files").click();
      await treeRow(page, "README.md").click();
      if (activation === "touch") await page.locator("#touch-tab-files").click();
      await page.locator("#follow-toggle").click();
      await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nActivation fixture.\n", "utf8");
      await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
      if (activation === "touch") await page.locator("#touch-tab-files").click();
      // No collapse/reopen setup: ancestor collapse now closes the document.
      await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
      let reads = 0;
      await page.route("**/api/document?*", route => { reads += 1; return route.continue(); });
      const row = treeRow(page, "guides/setup.md");
      if (activation === "touch") await row.tap();
      else if (activation === "pointer") await row.click();
      else { await row.focus(); await page.keyboard.press(activation); }
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
      await expect.poll(() => reads).toBe(1);
      await expect(page.locator("#preview")).toContainText("Activation fixture.");
      if (activation === "touch") await expect(page.locator("#touch-tab-preview")).toHaveAttribute("aria-selected", "true");
      // A different-file activation stays library-driven, without a second read.
      if (activation === "touch") await page.locator("#touch-tab-files").click();
      if (activation === "Enter" || activation === "Space") {
        await treeRow(page, "guides/notes.adoc").focus();
        await page.keyboard.press(activation);
      } else if (activation === "touch") await treeRow(page, "guides/notes.adoc").tap();
      else await treeRow(page, "guides/notes.adoc").click();
      await expect(page.locator("#preview-path")).toHaveText("guides/notes.adoc");
      expect(reads).toBe(2);
    });
  });
}

test("pointer and keyboard navigation retain folder focus after a collapsed active leaf refresh", async ({ page, request }) => {
  await bootSession(page, request);
  await treeRow(page, "README.md").click();
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nNavigation before refresh.\n", "utf8");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  const folder = treeRow(page, "guides/");
  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expectClosedDocument(page);
  await refreshClosedContent(page);
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "false");
  const focusedPath = () => page.locator("#tree").evaluate(element =>
    (element as HTMLElement & { __pierreFileTree: { getFocusedPath(): string | null } }).__pierreFileTree.getFocusedPath());
  await expect.poll(focusedPath).toBe("guides/");
  await expect(folder).toBeFocused();
  await expectClosedDocument(page);

  // The fixture has exactly notes.adoc then setup.md in guides/. Right from
  // the open folder focuses its first child; arrows move focus independently
  // of the active document until Enter activates the focused file.
  await page.keyboard.press("ArrowRight");
  await expect.poll(focusedPath).toBe("guides/notes.adoc");
  await page.keyboard.press("ArrowDown");
  await expect.poll(focusedPath).toBe("guides/setup.md");
  await page.keyboard.press("ArrowUp");
  await expect.poll(focusedPath).toBe("guides/notes.adoc");
  await expectClosedDocument(page);
  await page.keyboard.press("Enter");
  await expect(page.locator("#preview-path")).toHaveText("guides/notes.adoc");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/guides/notes.adoc");
  await expect(treeRow(page, "guides/notes.adoc")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await treeRow(page, "guides/setup.md").click();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "true");
});

// Spec coverage for the `document-tree` capability's "Render the document
// tree through `@pierre/trees`" requirement — verifies that uatu hands the
// Files-pane DOM ownership over to the library and no longer emits its
// hand-rolled `<details>`/`<summary>` tree markup.
test("the Files pane does not render uatu's legacy <details>/<summary> tree markup", async ({
  page,
  request,
}) => {
  await bootSession(page, request);

  // Legacy markup is fully retired from app.ts; the only summary/details
  // nodes in #tree would be from a manual render, which we no longer do.
  const filesPane = page.locator('[data-pane-id="files"]');
  await expect(filesPane.locator("details")).toHaveCount(0);
  await expect(filesPane.locator("summary")).toHaveCount(0);
});

// Spec coverage for `document-tree` "Render the document tree" — selection
// scenario: clicking a non-binary row loads the preview and disables follow.
test("clicking a non-binary tree row loads its preview and disables follow mode", async ({
  page,
  request,
}) => {
  await bootSession(page, request);

  // Normalize follow to ON so we can observe it being disabled by a manual
  // click. Boot state is non-deterministic (the library may async-fire
  // onSelectionChange after the synchronous programmatic-update guard), so
  // we toggle the chip iff it's currently off.
  const pressed = await page.locator("#follow-toggle").getAttribute("aria-pressed");
  if (pressed !== "true") {
    await page.locator("#follow-toggle").click();
  }
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  await treeRow(page, "diagram.md").click();

  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
});

// Spec coverage for `document-tree` "Display file-type icons via the library's
// built-in 'standard' icon set" — verifies the library's icon decoration
// resolves for a Markdown row.
test("tree rows render an icon via the library's built-in icon set", async ({
  page,
  request,
}) => {
  await bootSession(page, request);

  // The library renders icons via `<svg>` (sprite) or `<use>` references
  // inside the row. We just assert one is present — exact sprite identity
  // is an internal contract we don't pin in spec.
  const readmeRow = treeRow(page, "README.md");
  await expect(readmeRow.locator("svg")).toHaveCount(await readmeRow.locator("svg").count());
  // Stronger assertion: at least one SVG-shaped child is present.
  expect(await readmeRow.locator("svg").count()).toBeGreaterThan(0);
});

// Spec coverage for `document-tree` "Surface git status as row annotations".
// A working-tree modification on a git-backed repo MUST surface as a row
// annotation (the library exposes git status via `data-item-git-status`).
test("modified files show a git-status annotation; clean rows do not", async ({
  page,
  request,
}) => {
  // Boot a git-backed session with README dirty so review-load reports it
  // as a changed file. The git-init helper also pre-commits the fixture and
  // adds branch + history commits, so the workspace has many tracked files
  // — useful for exercising the library's annotation API at scale.
  await bootSession(page, request, {
    git: true,
    dirty: { "README.md": "# Modified for review-load\n" },
  });

  // The library renders rows with `data-item-git-status="<status>"` for any
  // path the SPA fed into `setGitStatus(...)`. With README dirty, at least
  // one row in the (virtualized) tree must surface a status annotation.
  // We don't pin the exact status string (added vs modified vs untracked
  // depending on review-load behavior) — only that one is present.
  await expect(page.locator("[data-item-git-status]").first()).toBeAttached({ timeout: 5_000 });

  // The number of annotated rows should be strictly smaller than the total
  // file count — a tree where EVERY row was annotated would mean review-load
  // is over-reporting (or our adapter is feeding it the whole path list).
  const annotatedCount = await page.locator("[data-item-git-status]").count();
  const totalRows = await page.locator('[role="treeitem"][data-item-type="file"]').count();
  expect(annotatedCount).toBeLessThan(totalRows);
});

// Spec coverage for `document-watch-index` "Detect binary files and route
// them to the right preview" — the image branch.
// (We already have an SVG-based image-preview test above. This is the
// negative-case sibling: a non-image binary routes to the "not viewable"
// message rather than to the legacy "no longer exists" error.)
test("a binary tree row routes to the preview-unavailable view, not 'no longer exists'", async ({
  page,
  request,
}) => {
  await bootSession(page, request, {
    extras: { "data.bin": "PK ignored binary content with NUL \0 byte" },
  });

  const binRow = treeRow(page, "data.bin");
  await expect(binRow).toBeVisible();
  await binRow.click();

  await expect(page.locator("#preview-path")).toHaveText("data.bin");
  await expect(page.locator("#preview")).toContainText("isn't viewable");
  await expect(page.locator("#preview")).not.toContainText("no longer exists");
});

test("folder clicks only toggle: no folder looks selected, and the focus ring is keyboard-only", async ({ page, request }) => {
  await bootSession(page, request);
  const ring = (path: string) => treeRow(page, path).evaluate(element =>
    getComputedStyle(element, "::before").outlineStyle);
  const selectedFolders = () => page.locator('[role="treeitem"][aria-expanded][aria-selected="true"]');
  // With an active document: open and close an unrelated folder.
  await treeRow(page, "guides/").click();
  await treeRow(page, "guides/setup.md").click();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  for (let i = 0; i < 2; i += 1) {
    await treeRow(page, "metadata/").click();
    await expect(selectedFolders()).toHaveCount(0);
    await expect(treeRow(page, "guides/setup.md")).toHaveAttribute("aria-selected", "true");
    await expect(treeRow(page, "metadata/")).toBeFocused();
    expect(await ring("metadata/")).toBe("none");
  }
  // Collapsing the active file's ancestor closes it; reopening selects nothing.
  await treeRow(page, "guides/").click();
  await expect(page.locator("#preview")).toHaveClass(/\bempty\b/);
  await treeRow(page, "guides/").click();
  await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(0);
  expect(await ring("guides/")).toBe("none");
  // Keyboard navigation still shows where focus is.
  await page.keyboard.press("ArrowDown");
  const focused = await page.locator("#tree").evaluate(element =>
    (element as HTMLElement & { __pierreFileTree: { getFocusedPath(): string | null } }).__pierreFileTree.getFocusedPath());
  expect(focused).not.toBe("guides/");
  await expect.poll(() => ring(focused!)).not.toBe("none");
  await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(0);
});

for (const browserName of ["chromium", "webkit"] as const) {
  test(`${browserName} touch: a tapped folder keeps the plain row background even while :hover sticks`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[browserName].launch();
    try {
      const page = await browser.newPage({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
      await bootSession(page, request);
      await page.locator("#touch-tab-files").click();
      expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
      const background = (path: string) => treeRow(page, path).evaluate(element => getComputedStyle(element).backgroundColor);
      await expect(treeRow(page, "diagram.md")).toHaveAttribute("aria-selected", "false");
      const plain = await background("diagram.md");
      const folder = treeRow(page, "metadata/");
      await folder.tap();
      await expect(folder).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator('[role="treeitem"][aria-expanded][aria-selected="true"]')).toHaveCount(0);
      // iOS Safari leaves :hover on the tapped row; force it the same way.
      await folder.hover();
      expect(await folder.evaluate(element => element.matches(":hover"))).toBe(true);
      expect(await background("metadata/")).toBe(plain);
      // A selected file still shows its selection color.
      await treeRow(page, "metadata/").tap();
      await treeRow(page, "diagram.md").tap();
      await expect(page.locator("#preview-path")).toHaveText("diagram.md");
      await page.locator("#touch-tab-files").click();
      await expect(treeRow(page, "diagram.md")).toHaveAttribute("aria-selected", "true");
      expect(await background("diagram.md")).not.toBe(plain);
    } finally {
      await browser.close();
    }
  });
}
