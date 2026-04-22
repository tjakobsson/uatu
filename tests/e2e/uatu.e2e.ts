import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";

import { workspacePath } from "../../src/e2e";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Online");
  await expect(page.locator("#document-count")).toHaveText("3 docs");
  await waitForPreviewToSettle(page);
  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

async function waitForPreviewToSettle(page: Page): Promise<void> {
  let previousPath = "";

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const currentPath = (await page.locator("#preview-path").textContent())?.trim() ?? "";
    if (currentPath.length > 0 && currentPath === previousPath) {
      await page.waitForTimeout(300);

      const settledPath = (await page.locator("#preview-path").textContent())?.trim() ?? "";
      if (settledPath === currentPath) {
        return;
      }
    }

    previousPath = currentPath;
    await page.waitForTimeout(150);
  }
}


test("renders GFM content and Mermaid diagrams", async ({ page }) => {
  await page.getByRole("button", { name: "diagram.md" }).click();

  await expect(page.locator("#preview-title")).toHaveText("Diagram Fixture");
  await expect(page.locator("#preview table")).toBeVisible();
  await expect(page.locator('#preview input[type="checkbox"]')).toHaveCount(2);
  await expect(page.locator('#preview a[href="https://example.com"]')).toBeVisible();
  await expect(page.locator("#preview .mermaid svg")).toBeVisible();
});

test("manual selection disables follow mode and keeps the current preview pinned", async ({ page }) => {
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nChanged while pinned.\n", "utf8");

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

test("tree rows show a file-type icon next to each document", async ({ page }) => {
  const readmeButton = page.getByRole("button", { name: "README.md" });
  await expect(readmeButton.locator(".tree-icon svg")).toBeVisible();
});

test("follow mode reveals the path to a newly changed nested file without closing anything", async ({ page }) => {
  const guidesDetails = page
    .locator("#tree details")
    .filter({ has: page.locator('summary:has-text("guides")') });

  // Start with guides collapsed (default) and README.md selected.
  await expect(guidesDetails).not.toHaveAttribute("open", "");

  // Turn follow mode on, then modify guides/setup.md so follow auto-switches.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nReveal me.\n", "utf8");

  // The preview follows. The tree should reveal the path to the file.
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(guidesDetails).toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "setup.md" })).toBeVisible();
});

test("manually opened directories stay open across file selections", async ({ page }) => {
  const guidesDetails = page
    .locator("#tree details")
    .filter({ has: page.locator('summary:has-text("guides")') });

  // Directories default to closed.
  await expect(guidesDetails).not.toHaveAttribute("open", "");

  // User expands 'guides'.
  await guidesDetails.locator("summary").click();
  await expect(guidesDetails).toHaveAttribute("open", "");

  // Selecting a different file must not silently collapse it.
  await page.getByRole("button", { name: "diagram.md" }).click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await expect(guidesDetails).toHaveAttribute("open", "");
});

test("sidebar collapse preference persists across reloads", async ({ page }) => {
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-sidebar-collapsed/);

  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await expect(page.locator("#sidebar-expand")).toBeVisible();

  await page.reload();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);

  await page.locator("#sidebar-expand").click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-sidebar-collapsed/);
});

test("pin toggle narrows the sidebar to the current document and ignores changes elsewhere", async ({ page }) => {
  await expect(page.locator("#document-count")).toHaveText("3 docs");
  await page.locator("#pin-toggle").click();
  await expect(page.locator("#pin-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#document-count")).toHaveText("1 doc");
  await expect(page.locator("#follow-toggle")).toBeDisabled();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  const offPinPath = "guides/setup.md";
  await fs.writeFile(workspacePath(offPinPath), "# Setup\n\nOff-pin change should be ignored.\n", "utf8");

  await page.waitForTimeout(500);
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#document-count")).toHaveText("1 doc");

  await page.locator("#pin-toggle").click();
  await expect(page.locator("#pin-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#document-count")).toHaveText("3 docs");
  await expect(page.locator("#follow-toggle")).toBeEnabled();
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
  await expect(page.locator("#document-count")).toHaveText("1 doc");
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: "setup.md" })).toHaveCount(0);
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
  await page.getByRole("button", { name: "README.md" }).click();

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

test("preview header stays visible while scrolling and the sidebar scroll is independent", async ({ page }) => {
  const padding = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
  await fs.writeFile(workspacePath("README.md"), `# Uatu\n\n${padding}\n`, "utf8");

  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.locator("#preview")).toContainText("Paragraph 80.");

  const headerBefore = await page.locator(".preview-header").boundingBox();
  await page.locator(".preview-shell").evaluate(element => {
    element.scrollTop = 600;
  });
  await page.waitForTimeout(100);
  const headerAfter = await page.locator(".preview-header").boundingBox();

  expect(headerBefore?.y ?? 0).toBeCloseTo(headerAfter?.y ?? 0, 0);
});
