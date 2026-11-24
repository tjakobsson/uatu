import type { Page } from "@playwright/test";
import { expect, test as baseTest } from "./hub-fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { captureScreenshot } from "./evidence";

const test = withEngineBrowsers(baseTest);

// The brand keeps clear of the header's controls (in touch mode those include
// the Follow menu), and the controls stay inside the sidebar.
async function expectSidebarHeaderFits(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const sidebar = box(".sidebar");
    const wordmark = box(".sidebar-header .brand-wordmark");
    const controls = box(".sidebar-header-actions");
    return wordmark.width > 0 && wordmark.right <= controls.left + 1 && controls.right <= sidebar.right + 1;
  })).toBe(true);
}

attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine} a workspace offers no notification control in any layout; the Hub's Settings does`, async ({ launchBrowser, hub, hubContext }, testInfo) => {
    const workspace = hub.workspaces[0]!;
    const browser = await launchBrowser(engine);
    const context = await browser.newContext({ storageState: await hubContext.storageState(),
      viewport: { width: 1194, height: 834 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const notifications = page.getByRole("button", { name: "Notifications", exact: true });
    try {
      await page.addInitScript(basePath => {
        localStorage.setItem(`uatu:presentation:v1:${encodeURIComponent(basePath)}:uatu:ui-mode`, "desktop");
      }, new URL(workspace.sessionUrl).pathname);
      await page.goto(workspace.sessionUrl);
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      await expect(notifications).toHaveCount(0);
      for (const width of [360, 320, 280]) {
        await page.evaluate(value => document.documentElement.style.setProperty("--sidebar-width", `${value}px`), width);
        await expectSidebarHeaderFits(page);
      }
      await captureScreenshot(page, testInfo, `${engine}-sidebar-without-notifications`);

      await page.locator("#sidebar-collapse").click();
      await expect(page.locator(".sidebar-rail")).toBeVisible();
      await expect(notifications).toHaveCount(0);
      await page.locator("#sidebar-expand").click();
      await page.locator("#ui-mode-toggle").click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#touch-tab-files").click();
      await expectSidebarHeaderFits(page);
      await expect(notifications).toHaveCount(0);
      await captureScreenshot(page, testInfo, `${engine}-touch-files-without-notifications`);

      await page.goto(`${new URL(workspace.sessionUrl).origin}/settings`);
      await notifications.click();
      await expect(page.getByRole("dialog", { name: "Notifications", exact: true })).toBeVisible();
    } finally { await browser.close(); }
  });
}
