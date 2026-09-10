// Helpers for suites that share the touch navigation bar without owning its
// behavior. `navigation-overlay.e2e.ts` owns the idle/dismissal policy and
// tests it directly; everything else just needs the bar to stay reachable.

import { expect, type Page } from "@playwright/test";

// Standalone sessions carry no `<meta name="uatu-base-path">`, so
// `appBasePath()` resolves to "/" and the preference key encodes that. Suites
// running under a Hub use a different, Hub-scoped key and must not use this.
const STANDALONE_PREFERENCE_KEY = "uatu:presentation:v1:%2F:navigation";

/**
 * Pin the navigation bar open for a suite that is not testing the idle policy.
 *
 * The bar auto-hides after seven idle seconds and becomes `inert` while
 * closed. Any suite that idles — spawning a PTY, rendering a diagram, waiting
 * on a load — would otherwise time out clicking a tab for reasons that have
 * nothing to do with what it is asserting.
 *
 * Installs an init script, so it survives reloads and must be called before
 * the first navigation. A later `localStorage.clear()` cannot undo it: the
 * preference owner caches its value in memory once read at boot.
 */
export async function keepNavigationOpen(page: Page): Promise<void> {
  await page.addInitScript(key => {
    try {
      const existing = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      window.localStorage.setItem(key, JSON.stringify({ ...existing, autoHide: false }));
    } catch {
      // Storage denied; the suite can still reopen the bar through the handle.
    }
  }, STANDALONE_PREFERENCE_KEY);
}

/**
 * Reveal a surface, reopening the bar first if it has been dismissed.
 *
 * A closed bar fades to `opacity: 0` rather than unmounting, and Playwright
 * still reports it visible, so gate the reopen on `data-open` instead.
 */
export async function showSurface(
  page: Page,
  tab: "files" | "preview" | "chat" | "terminal",
): Promise<void> {
  const bar = page.locator("#touch-tab-bar");
  if (await bar.getAttribute("data-open") !== "true") {
    await page.locator("#navigation-handle").click();
  }
  await expect(bar).toHaveAttribute("data-open", "true");
  await page.locator(`#touch-tab-${tab}`).click();
}

/**
 * Open the navigation preferences sheet.
 *
 * The approved design's bar is close + Hub + the four surfaces, with no
 * Preferences button, so the sheet is reached by holding the handle. This
 * drives the real press timer rather than dispatching the event directly.
 */
export async function openNavigationPreferences(page: Page): Promise<void> {
  // The handle is the affordance, and per the design it exists only while the
  // navigation is collapsed, so dismiss the bar first if it is up. Callers
  // that need it open again reopen it explicitly.
  const bar = page.locator("#touch-tab-bar");
  if (await bar.getAttribute("data-open") === "true") {
    await page.locator("#navigation-close").click();
    await expect(bar).toBeHidden();
  }
  const box = (await page.locator("#navigation-handle").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(page.locator("#navigation-preferences-dialog")).toBeVisible();
}
