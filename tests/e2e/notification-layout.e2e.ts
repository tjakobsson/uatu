import type { Page } from "@playwright/test";
import { expect, test } from "./hub-fixtures";
import { attachPageDiagnosticsOnFailure, launchBrowser } from "./page-diagnostics";
import { captureScreenshot } from "./evidence";

async function expectSidebarControlsFit(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const sidebar = box(".sidebar");
    const header = box(".sidebar-header");
    const wordmark = box(".sidebar-header .brand-wordmark");
    const controls = box(".sidebar-header-actions");
    const button = document.querySelector<HTMLButtonElement>(".sidebar-notifications-row button")!;
    const notification = button.getBoundingClientRect();
    const atCenter = document.elementFromPoint(notification.x + notification.width / 2, notification.y + notification.height / 2);
    return wordmark.width > 0 && wordmark.right <= controls.left + 1
      && controls.right <= sidebar.right + 1 && notification.top >= header.bottom
      && notification.left >= sidebar.left && notification.right <= sidebar.right
      && notification.height > 24 && button.contains(atCenter);
  })).toBe(true);
}

attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine} hub notification controls clear the brand at iPad sidebar widths and in touch mode`, async ({ hub, hubContext }, testInfo) => {
    const workspace = hub.workspaces[0]!;
    const browser = await launchBrowser(engine);
    const context = await browser.newContext({ storageState: await hubContext.storageState(),
      viewport: { width: 1194, height: 834 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await page.addInitScript(basePath => {
        localStorage.setItem(`uatu:presentation:v1:${encodeURIComponent(basePath)}:uatu:ui-mode`, "desktop");
      }, new URL(workspace.sessionUrl).pathname);
      await page.goto(workspace.sessionUrl);
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      await expect(page.locator(".sidebar-notifications-row button")).toBeVisible();
      await expect(page.locator(".sidebar-header .uatu-notifications-trigger")).toHaveCount(0);
      for (const width of [360, 320, 280]) {
        await page.evaluate(value => document.documentElement.style.setProperty("--sidebar-width", `${value}px`), width);
        await expectSidebarControlsFit(page);
      }
      await expect(page.locator(".sidebar-notifications-row button")).toHaveCSS("appearance", "none");
      await captureScreenshot(page, testInfo, `${engine}-notifications-sidebar`);

      await page.locator("#sidebar-collapse").click();
      const railButton = page.locator(".sidebar-rail").getByRole("button", { name: "Notifications", exact: true });
      await expect(railButton).toBeVisible();
      await expect(railButton.locator("svg")).toHaveCount(1);
      const rail = (await page.locator(".sidebar-rail").boundingBox())!;
      const control = (await railButton.boundingBox())!;
      expect(control.x).toBeGreaterThanOrEqual(rail.x);
      expect(control.x + control.width).toBeLessThanOrEqual(rail.x + rail.width);
      await railButton.click();
      await expect(page.getByRole("dialog", { name: "Notifications", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.locator("#sidebar-expand").click();
      await page.locator("#ui-mode-toggle").click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#touch-tab-files").click();
      await expectSidebarControlsFit(page);
      await captureScreenshot(page, testInfo, `${engine}-notifications-touch-files`);
      await page.locator(".sidebar-notifications-row").getByRole("button", { name: "Notifications", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Notifications", exact: true })).toBeVisible();
    } finally { await browser.close(); }
  });
}
