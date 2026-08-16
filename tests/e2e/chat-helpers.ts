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
