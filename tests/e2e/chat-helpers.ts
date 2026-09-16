// Desktop chat-panel activation for e2e suites (chat-side-panel change).
// Chat is co-visible beside Preview: a fresh context boots with the panel
// collapsed to its edge strip, and reopening after a reload is a no-op
// because the open preference persists per context.

import { expect, type Page } from "@playwright/test";

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
