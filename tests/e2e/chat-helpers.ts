// Desktop chat-panel activation for e2e suites (chat-side-panel change).
// Chat is co-visible beside Preview: a fresh context boots with the panel
// collapsed to its edge strip, and reopening after a reload is a no-op
// because the open preference persists per context.

import { existsSync } from "node:fs";
import path from "node:path";

import { expect, type Page, type TestInfo } from "@playwright/test";

/** Saves a screenshot into a change's screenshots folder when that folder
 *  exists (review reads the folder instead of running a session), else into
 *  the test's output directory, and attaches it to the report either way. */
export async function captureScreenshot(page: Page, testInfo: TestInfo, screenshotsDir: string, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const target = existsSync(screenshotsDir) ? path.join(screenshotsDir, `${name}.png`) : testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: target, animations: "disabled", caret: "hide" });
  await testInfo.attach(name, { path: target, contentType: "image/png" });
}

/** Expand the desktop chat panel if it is collapsed (the fresh-context
 *  default) and wait for its content to present. */
export async function openChatPanel(page: Page): Promise<void> {
  const strip = page.locator("#chat-expand");
  if (await strip.isVisible()) {
    await strip.click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "open");
  await expect(page.locator("#chat-timeline")).toBeVisible();
}

export async function openChatConfiguration(page: Page): Promise<void> {
  const dialog = page.locator("#chat-configuration-dialog");
  if (!await dialog.isVisible()) await page.locator("#chat-configuration-trigger").click();
  await expect(dialog).toBeVisible();
}

export async function chooseChatModel(page: Page, name: string): Promise<void> {
  await openChatConfiguration(page);
  await page.locator(".chat-configuration-model", {
    has: page.locator(".chat-configuration-model-name", { hasText: name }),
  }).click();
}

export async function installClipboardMock(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.e2eClipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => { document.documentElement.dataset.e2eClipboard = value; },
        readText: async () => document.documentElement.dataset.e2eClipboard ?? "",
      },
    });
  });
}

export async function readClipboardMock(page: Page): Promise<string> {
  return page.locator("html").getAttribute("data-e2e-clipboard").then(value => value ?? "");
}
