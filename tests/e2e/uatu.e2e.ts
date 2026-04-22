import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";

import { workspacePath } from "../../src/e2e";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await expect(page.locator("#connection-state")).toHaveText("Live");
  await expect(page.locator("#document-count")).toHaveText("3 docs");
  await waitForPreviewToSettle(page);
  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.locator("#follow-toggle")).toHaveText("Follow off");
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
  await expect(page.locator("#follow-toggle")).toHaveText("Follow off");
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nChanged while pinned.\n", "utf8");

  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#preview-title")).toHaveText("Uatu");
});

test("follow mode switches to the latest changed markdown file", async ({ page }) => {
  const marker = `Changed by Playwright ${Date.now()}`;
  const relativePath = "guides/setup.md";

  await page.getByRole("button", { name: "Follow off" }).click();
  await expect(page.locator("#follow-toggle")).toHaveText("Follow on");

  await fs.writeFile(workspacePath(relativePath), `# Setup\n\n${marker}\n`, "utf8");

  await expect(page.locator("#preview-path")).toHaveText(relativePath);
  await expect(page.locator("#preview")).toContainText(marker);
});
