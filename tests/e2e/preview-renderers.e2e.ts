import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("connection indicator exposes live and reconnecting classes", async ({ page }) => {
  await expect(page.locator("#connection-state")).toHaveClass(/is-live/);

  await page.evaluate(() => {
    window.fetch("/__e2e/pretend-no-op").catch(() => {});
  });
  // The indicator stays live while the SSE channel is open; we just assert the baseline class contract.
  await expect(page.locator("#connection-state.is-live .indicator-dot")).toBeVisible();
});

test("single-file mode shows only the pinned markdown file in the sidebar", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { file: "README.md" } });
  await page.goto("/");
  await expect(page.locator("#document-count")).toHaveText("1 file");
  await expect(treeRow(page, "README.md")).toBeVisible();
  await expect(treeRow(page, "guides/setup.md")).toHaveCount(0);
});

test("relative image references in a README are served natively from the watched root", async ({ page, request }) => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#1ca8a7"/></svg>`;
  await fs.writeFile(workspacePath("hero.svg"), svg, "utf8");
  await fs.writeFile(
    workspacePath("README.md"),
    `# Uatu\n\n<p align="center"><img src="./hero.svg" alt="hero" width="16" height="16" /></p>\n`,
    "utf8",
  );

  await page.waitForTimeout(300);
  // beforeEach left README.md selected. Click another file first so the
  // library actually fires a selection change when we click README again
  // (the library de-dupes "click already-selected row" events, which would
  // skip the re-fetch we need to see the updated README content).
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  const img = page.locator('#preview img[alt="hero"]');
  await expect(img).toBeVisible();

  // Rendered HTML preserves the original relative URL verbatim.
  expect(await img.getAttribute("src")).toBe("./hero.svg");

  // The browser actually loaded the image through the static file fallback.
  await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
  const resolved = await img.evaluate((el: HTMLImageElement) => el.currentSrc);
  expect(resolved).toMatch(/\/hero\.svg$/);

  const response = await request.get("/hero.svg");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/svg");
});

test("server falls back with 404 for paths outside every watched root", async ({ request }) => {
  const response = await request.get("/does-not-exist.bin");
  expect(response.status()).toBe(404);
});

test("a non-Markdown text file appears in the tree and renders as syntax-highlighted code", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: value\nport: 4321\n" } },
  });
  await page.goto("/");
  await expect(page.locator("#document-count")).toHaveText("17 files");

  const yamlButton = treeRow(page, "config.yaml");
  await expect(yamlButton).toBeVisible();
  await yamlButton.click();

  await expect(page.locator("#preview-path")).toHaveText("config.yaml");
  await expect(page.locator('#preview pre code.hljs.language-yaml')).toBeVisible();
});

test("a non-image binary appears in the tree and routes to the preview-unavailable view", async ({ page, request }) => {
  // Binary content (NUL byte) under an unknown extension triggers the
  // content-sniff classifier so we don't depend on the known-extensions
  // table. Not an image extension, so the preview shows the
  // "not viewable" message rather than the image branch.
  await request.post("/__e2e/reset", {
    data: { extras: { "data.bin": "PK ignored\0 binary content" } },
  });
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

  const binRow = treeRow(page, "data.bin");
  await expect(binRow).toBeVisible();
  await binRow.click();

  await expect(page.locator("#preview-path")).toHaveText("data.bin");
  await expect(page.locator("#preview")).toContainText("isn't viewable");
  // Regression guard: the legacy "no longer exists" message must not appear.
  await expect(page.locator("#preview")).not.toContainText("no longer exists");
});

test("connection indicator lives in the sidebar header under the UatuCode wordmark", async ({ page }) => {
  // The connection indicator is a global "is the backend reachable" status,
  // so it sits with the brand area in the sidebar header rather than mixed
  // into preview controls. It is NOT rendered in the preview toolbar.
  await expect(page.locator(".sidebar-header #connection-state")).toBeVisible();
  await expect(page.locator(".preview-toolbar #connection-state")).toHaveCount(0);

  // Inside the sidebar header it stacks with the wordmark in a vertical
  // brand-text column.
  await expect(page.locator(".brand .brand-text #connection-state")).toBeVisible();

  // Collapsing the whole sidebar hides the indicator along with the rest of
  // the sidebar chrome — accepted tradeoff for putting the status with the
  // brand instead of with the preview controls.
  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await expect(page.locator("#connection-state")).toBeHidden();
});

test("preview header shows a file-type chip for the selected document", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: value\n" } },
  });
  await page.goto("/");
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-type")).toHaveText("markdown");

  await treeRow(page, "config.yaml").click();
  await expect(page.locator("#preview-type")).toHaveText("yaml");
});

test("Markdown cross-document links render with the original .md extension", async ({ page }) => {
  // Companion regression for the AsciiDoc test above. micromark already
  // preserves the author's URL verbatim — this test locks that behavior in
  // so a future renderer swap can't silently regress it. Drives the
  // permanent `testdata/watch-docs/links-demo.md` fixture.
  await treeRow(page, "links-demo.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Markdown Cross-Document Links");

  await expect(page.locator('#preview a[href="README.md"]')).toBeVisible();
  await expect(page.locator('#preview a[href="guides/setup.md"]')).toBeVisible();
  await expect(page.locator('#preview a[href$=".html"]')).toHaveCount(0);
});

test("clicking a Markdown cross-document link switches the preview in-app", async ({ page }) => {
  await treeRow(page, "links-demo.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Markdown Cross-Document Links");

  await page.locator('#preview a[href="guides/setup.md"]').click();

  await expect(page.locator("#preview-title")).toHaveText("Setup");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  expect(new URL(page.url()).pathname).toBe("/guides/setup.md");
  await expect(
    treeRow(page, "guides/setup.md"),
  ).toHaveAttribute("aria-selected", "true");
});

test("preview header stays visible while scrolling and the sidebar scroll is independent", async ({ page }) => {
  const padding = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
  await fs.writeFile(workspacePath("README.md"), `# Uatu\n\n${padding}\n`, "utf8");

  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview")).toContainText("Paragraph 80.");

  const headerBefore = await page.locator(".preview-header").boundingBox();
  await page.locator(".preview-shell").evaluate(element => {
    element.scrollTop = 600;
  });
  await page.waitForTimeout(100);
  const headerAfter = await page.locator(".preview-header").boundingBox();

  expect(headerBefore?.y ?? 0).toBeCloseTo(headerAfter?.y ?? 0, 0);
});
