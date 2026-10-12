import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { openTreeFile, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";
import { naturalWidth, recordDocumentFrames, waitForAppliedDocumentFrame } from "./sync-helpers";

test.beforeEach(async ({ page, request }) => {
  await recordDocumentFrames(page);
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("manual selection disables follow mode and keeps the current preview pinned", async ({ page }) => {
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nChanged while pinned.\n", "utf8");
  // The change has reached the page — only then does "still README" mean
  // follow stayed off rather than that the event had not arrived yet.
  await waitForAppliedDocumentFrame(page, { changed: "guides/setup.md" });

  // Selection moves synchronously with a frame (the URL follows it at once);
  // the preview path would only follow after a document load.
  expect(await page.evaluate(() => window.location.pathname)).toBe("/README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#preview-title")).toHaveText("Uatu");
});

test("follow mode switches to the latest changed markdown file", async ({ page }) => {
  const marker = `Changed by Playwright ${Date.now()}`;
  const relativePath = "guides/setup.md";

  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  await fs.writeFile(workspacePath(relativePath), `# Setup\n\n${marker}\n`, "utf8");

  await expect(page.locator("#preview-path")).toHaveText(relativePath);
  await expect(page.locator("#preview")).toContainText(marker);
});

test("follow mode switches the preview when a non-Markdown text file changes", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: original\n" } },
  });
  await page.goto("/");
  // Click a non-README file then README — this both demonstrates manual
  // navigation AND guarantees follow is off (manual selection disables it).
  // Without the intermediate click, clicking the already-selected README
  // is a no-op for the library's selection state, so the boot-time
  // follow=true wouldn't be disabled and the next follow-toggle click
  // would flip true→false instead of false→true.
  await openTreeFile(page, "diagram.md");
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await openTreeFile(page, "README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  await fs.writeFile(workspacePath("config.yaml"), "key: changed\nport: 9999\n", "utf8");

  await expect(page.locator("#preview-path")).toHaveText("config.yaml");
  await expect(page.locator('#preview pre code.hljs.language-yaml')).toBeVisible();
});

test("follow mode switches the preview to a changed image", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "hero.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>` } },
  });
  await page.goto("/");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await turnFollowOn(page);

  await fs.writeFile(
    workspacePath("hero.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48"/></svg>`,
    "utf8",
  );

  await expect(page.locator("#preview-path")).toHaveText("hero.svg");
  await expect.poll(() => naturalWidth(page, "#preview .image-preview img")).toBe(48);
  expect(await page.evaluate(() => window.location.pathname)).toBe("/hero.svg");
});

test("follow mode stays on a document whose embedded image changed and refreshes it in place", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "hero.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>`,
        // README stays the newest document, so Follow's catch-up keeps it.
        "README.md": `# Uatu\n\n<img src="./hero.svg" alt="hero" />\n`,
      },
    },
  });
  await page.goto("/");
  await turnFollowOn(page);
  const selector = '#preview img[alt="hero"]';
  await expect.poll(() => naturalWidth(page, selector)).toBe(16);
  // Neither switched nor reloaded: the marked heading must survive.
  await page.locator("#preview h1").evaluate(el => { el.dataset.e2eMounted = "1"; });

  await fs.writeFile(
    workspacePath("hero.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48"/></svg>`,
    "utf8",
  );

  // The new bytes are on screen, so the change has been applied — and the
  // preview, URL, and Follow are still where they were.
  await expect.poll(() => naturalWidth(page, selector)).toBe(48);
  await waitForAppliedDocumentFrame(page, { changed: "hero.svg" });
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  expect(await page.evaluate(() => window.location.pathname)).toBe("/README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview h1")).toHaveAttribute("data-e2e-mounted", "1");
});

test("follow mode stays on a document shown as Source when its embedded image changes", async ({ page, request }) => {
  // Source view renders no <img>, so the exception cannot be read off the
  // preview: it comes from the document's rendered payload, which the page
  // fetches in the background for a document shown only as Source.
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "hero.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>`,
        "README.md": `# Uatu\n\n<img src="./hero.svg" alt="hero" />\n`,
      },
    },
  });
  await page.goto("/");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await page.locator("#view-source").click();
  await expect(page.locator("#preview pre.uatu-source-pre")).toBeVisible();
  await openTreeFile(page, "diagram.md");
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  // Arm before the click that loads README as Source: the rendered payload
  // is fetched only to learn which images README embeds.
  const learned = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/document" && url.searchParams.get("view") === "rendered"
      && (url.searchParams.get("id") ?? "").endsWith("README.md");
  });
  await openTreeFile(page, "README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#preview pre.uatu-source-pre")).toBeVisible();
  await learned;
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await fs.writeFile(
    workspacePath("hero.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48"/></svg>`,
    "utf8",
  );
  // The change has been applied — only then does "still README" mean Follow
  // passed over it rather than that the event had not arrived yet.
  await waitForAppliedDocumentFrame(page, { changed: "hero.svg" });

  expect(await page.evaluate(() => window.location.pathname)).toBe("/README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#preview pre.uatu-source-pre")).toBeVisible();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
});

// Which images README embeds is unknown until its rendered payload, looked up
// in the background for a document shown as Source or Diff, has answered.
// Meanwhile an image change must neither navigate nor be dropped: the decision
// waits for the lookup, and a failed lookup follows the image.
test.describe("an image change while the shown document's images are unknown", () => {
  // The pass-through PWA service worker proxies page fetches, and page.route
  // cannot intercept SW-mediated requests.
  test.use({ serviceWorkers: "block" });

  const isReadmeLookup = (url: URL) => url.pathname === "/api/document" && url.searchParams.get("view") === "rendered"
    && (url.searchParams.get("id") ?? "").endsWith("README.md");

  // Boots straight into README shown as `view` (the saved view) with Follow
  // off, every README rendered lookup routed through `handle`.
  async function bootInto(page: Page, view: "source" | "diff", handle: Parameters<Page["route"]>[1]): Promise<void> {
    await openTreeFile(page, "README.md");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await page.locator(`#view-${view}`).click();
    await expect(page.locator(`#view-${view}`)).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
    // The saved view and document are persisted before the reload reads them.
    await expect.poll(async () => (await (await page.request.get("/api/personal-state")).json()))
      .toMatchObject({ documentPath: "README.md", previewMode: view, follow: false });
    await page.route(url => isReadmeLookup(url), handle);
    await page.reload();
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expect(page.locator(`#view-${view}`)).toHaveAttribute("aria-checked", "true");
  }

  async function resetWithEmbeddedImage(request: Parameters<Parameters<typeof test>[1]>[0]["request"], view: "source" | "diff") {
    await request.post("/__e2e/reset", {
      data: {
        ...(view === "diff" ? { git: true } : {}),
        extras: {
          "hero.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>`,
          // README stays the newest document, so Follow's catch-up keeps it.
          "README.md": `# Uatu\n\n<img src="./hero.svg" alt="hero" />\n`,
        },
      },
    });
  }

  async function rewriteHero(page: Page): Promise<void> {
    await fs.writeFile(
      workspacePath("hero.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48"/></svg>`,
      "utf8",
    );
    // The change has been applied — only then does "still README" mean the
    // decision was held rather than that the event had not arrived yet.
    await waitForAppliedDocumentFrame(page, { changed: "hero.svg" });
  }

  for (const view of ["source", "diff"] as const) {
    test(`a delayed lookup in ${view} view keeps the document while it is pending and after it answers`, async ({ page, request }) => {
      await resetWithEmbeddedImage(request, view);
      await page.goto("/");
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let held!: () => void;
      const lookupHeld = new Promise<void>(resolve => { held = resolve; });
      await bootInto(page, view, async route => {
        held();
        await released;
        await route.continue();
      });
      await lookupHeld;

      await page.locator("#follow-toggle").click();
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#preview-path")).toHaveText("README.md");

      await rewriteHero(page);
      expect(await page.evaluate(() => window.location.pathname)).toBe("/README.md");
      await expect(page.locator("#preview-path")).toHaveText("README.md");
      await expect(page.locator(`#view-${view}`)).toHaveAttribute("aria-checked", "true");

      // The lookup answers: README embeds hero.svg, so the held decision stays.
      const answered = page.waitForResponse(response => isReadmeLookup(new URL(response.url())));
      release();
      await (await answered).finished();
      // Rendered view shows the refreshed image in the document that embeds it.
      await page.locator("#view-rendered").click();
      await expect.poll(() => naturalWidth(page, '#preview img[alt="hero"]')).toBe(48);
      await expect(page.locator("#preview-path")).toHaveText("README.md");
      expect(await page.evaluate(() => window.location.pathname)).toBe("/README.md");
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
    });
  }

  test("a failed lookup follows the image", async ({ page, request }) => {
    await resetWithEmbeddedImage(request, "source");
    await page.goto("/");
    await bootInto(page, "source", route => route.abort());

    await page.locator("#follow-toggle").click();
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#preview-path")).toHaveText("README.md");

    await fs.writeFile(
      workspacePath("hero.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48"/></svg>`,
      "utf8",
    );
    await expect(page.locator("#preview-path")).toHaveText("hero.svg");
    await expect.poll(() => naturalWidth(page, "#preview .image-preview img")).toBe(48);
    expect(await page.evaluate(() => window.location.pathname)).toBe("/hero.svg");
  });
});

test("an image Follow switched to survives a reload, a workspace-root resume, and Back", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "hero.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>` } },
  });
  await page.goto("/");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await turnFollowOn(page);

  await fs.writeFile(
    workspacePath("hero.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48"/></svg>`,
    "utf8",
  );
  await expect(page.locator("#preview-path")).toHaveText("hero.svg");
  expect(await page.evaluate(() => window.location.pathname)).toBe("/hero.svg");

  // Reload: the image's URL is a direct link to it.
  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("hero.svg");
  await expect.poll(() => naturalWidth(page, "#preview .image-preview img")).toBe(48);

  // Workspace root: the image is the saved document and is resumed.
  await expect.poll(async () => (await (await request.get("/api/personal-state")).json()).documentPath)
    .toBe("hero.svg");
  await page.goto("/");
  await expect(page.locator("#preview-path")).toHaveText("hero.svg");

  // Back: leave the image by a click, then return to it through history.
  await openTreeFile(page, "guides/setup.md");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await page.goBack();
  await expect(page.locator("#preview-path")).toHaveText("hero.svg");
  await expect.poll(() => naturalWidth(page, "#preview .image-preview img")).toBe(48);
  await expect(page.locator("#preview")).not.toContainText("Document not found");
});

test("follow mode ignores a change to a binary the preview cannot show", async ({ page }) => {
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await turnFollowOn(page);

  await fs.writeFile(workspacePath("bundle.zip"), "PK\u0003\u0004\u0000archive", "utf8");
  // The archive has reached the page — only then does "still README" mean
  // Follow passed over it rather than that the event had not arrived yet.
  await waitForAppliedDocumentFrame(page, { includes: "bundle.zip" });

  expect(await page.evaluate(() => window.location.pathname)).toBe("/README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
});

// Rule A turns Follow off on the first click into the tree, so the reliable
// starting point is "pinned by a click", then the chip turns it back on.
async function turnFollowOn(page: Page): Promise<void> {
  await openTreeFile(page, "diagram.md");
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await openTreeFile(page, "README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  // The chip's catch-up may land on the newest document; the tests below
  // assert against README, so pin the starting point there.
  await expect(page.locator("#preview-path")).toHaveText("README.md");
}

test("enabling follow jumps to the most recently modified file", async ({ page }) => {
  // beforeEach lands on README.md (its mtime is bumped 10s into the future by
  // resetE2EWorkspace, so it's the current default selection). Make setup.md
  // strictly newer so the catch-up has an unambiguous target.
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nFreshly touched.\n", "utf8");
  const fresher = new Date(Date.now() + 30_000);
  await fs.utimes(workspacePath("guides", "setup.md"), fresher, fresher);

  // The catch-up below reads the page's own index, so the bumped mtime must
  // have reached it: wait until the page has applied a frame naming setup.md
  // the newest document.
  await waitForAppliedDocumentFrame(page, { defaultPath: "guides/setup.md" });

  // Manually re-select README to ensure follow is OFF and selection is README.
  await openTreeFile(page, "README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  // Enable follow — preview must catch up to setup.md.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
});
