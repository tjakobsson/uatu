// iPad-viewport coverage (touch-tab-navigation change): coarse pointer AND
// wide (1024×768) — the combination mobile-experience used to exclude from
// phone-class. Touch mode now extends here by default, with the tab bar's
// Desktop escape flipping the device to the full desktop rendering and the
// desktop chrome's touch-mode return flipping back, both persisted per
// device. A fine-pointer guard describe pins that desktop browsers never
// see any of this chrome.

import { expect, test } from "./fixtures";

function readStoredValue(page: import("@playwright/test").Page, suffix: string): Promise<string | null> {
  return page.evaluate(s => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)!;
      if (key.endsWith(s)) return window.localStorage.getItem(key);
    }
    return null;
  }, suffix);
}

async function bootClean(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  await request.post("/__e2e/reset");
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
}

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test.describe("iPad touch mode", () => {
  // iPad landscape-ish: coarse pointer via hasTouch + isMobile, but WIDE —
  // above the 900px stacking breakpoint.
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page, request }) => {
    await bootClean(page, request);
  });

  test("defaults to touch mode with the tab bar and the mode toggle in the Files tab", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await expect(page.locator("#touch-tab-bar")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
    // The bar carries only the three surface tabs; the mode switch lives
    // in the sidebar header, i.e. the Files tab's surface.
    await expect(page.locator("#touch-tab-bar button")).toHaveCount(3);
    // One surface at a time applies on iPad exactly as on phones.
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".preview-shell")).toBeVisible();
    await page.locator("#touch-tab-files").click();
    await expect(page.locator("#ui-mode-toggle")).toBeVisible();
  });

  test("the mode toggle round-trips to the full desktop rendering, persisted", async ({ page }) => {
    await page.locator("#touch-tab-files").click();
    await page.locator("#ui-mode-toggle").click();

    // The full desktop layout: mode stamped, bar gone, sidebar + preview
    // side by side, the same toggle still present in the chrome.
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    await expect(page.locator("#touch-tab-bar")).toBeHidden();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".preview-shell")).toBeVisible();
    await expect(page.locator("#ui-mode-toggle")).toBeVisible();
    const sidebarBox = await page.locator(".sidebar").boundingBox();
    const previewBox = await page.locator(".preview-shell").boundingBox();
    expect((sidebarBox?.x ?? 0) + (sidebarBox?.width ?? 0)).toBeLessThanOrEqual(previewBox?.x ?? 0);
    await expect.poll(() => readStoredValue(page, "uatu:ui-mode")).toBe("desktop");

    // The mode survives a reload.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    await expect(page.locator("#touch-tab-bar")).toBeHidden();

    // And the same control flips back to touch, live.
    await page.locator("#ui-mode-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await expect(page.locator("#touch-tab-bar")).toBeVisible();
    await expect.poll(() => readStoredValue(page, "uatu:ui-mode")).toBe("touch");
  });

  test("desktop mode is never a trap: the toggle survives rotation and sidebar collapse", async ({ page }) => {
    await page.locator("#touch-tab-files").click();
    await page.locator("#ui-mode-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    await expect(page.locator("#ui-mode-toggle")).toBeVisible();

    // Rotate to portrait (below the 900px stacking breakpoint): the toggle
    // MUST stay reachable or the device is stranded in desktop mode.
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.locator("#ui-mode-toggle")).toBeVisible();

    // Collapsing the sidebar takes the header control with it — the rail
    // carries the same toggle.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.locator("#sidebar-collapse").click();
    await expect(page.locator("#ui-mode-toggle")).toBeHidden();
    await expect(page.locator("#rail-ui-mode-toggle")).toBeVisible();
    await page.locator("#rail-ui-mode-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await expect(page.locator("#touch-tab-bar")).toBeVisible();
  });

  test("mode flips restore the terminal's stored dock and display", async ({ page, request }) => {
    const tokenResp = await request.get("/__e2e/terminal-token");
    const tokenBody = await tokenResp.json();
    if (!tokenBody.enabled) {
      test.skip(true, "terminal backend unavailable on this platform");
    }
    await page.goto(`/?t=${encodeURIComponent(tokenBody.token)}`);
    await page.evaluate(() => {
      try {
        window.sessionStorage.removeItem("uatu:terminal-visible");
        window.localStorage.clear();
      } catch {
        // best-effort
      }
    });
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    // Touch: the Terminal tab promotes to fullscreen.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "fullscreen");
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    // Desktop (via the Files tab's mode toggle): the stored mode (normal,
    // bottom dock) comes back — the promotion never overwrote it — with
    // the same pane still attached.
    await page.locator("#touch-tab-files").click();
    await page.locator("#ui-mode-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "normal");
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "bottom");
    await expect(page.locator(".terminal-pane")).toHaveCount(1);
    await expect(page.locator(".terminal-auth")).toHaveCount(0);

    // Back to touch (lands on the Files tab the toggle lives in); the
    // Terminal tab re-promotes the SAME pane, PTY intact.
    await page.locator("#ui-mode-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "fullscreen");
    await expect(page.locator(".terminal-pane")).toHaveCount(1);
    await expect(page.locator(".terminal-auth")).toHaveCount(0);
  });
});

test.describe("desktop guards", () => {
  // Fine pointer, no touch: an ordinary desktop browser. It must never see
  // the tab bar or either mode control.
  test.use({ viewport: { width: 1280, height: 800 } });

  test("fine-pointer viewports render no touch chrome", async ({ page, request }) => {
    await bootClean(page, request);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    await expect(page.locator("#touch-tab-bar")).toBeHidden();
    // The mode toggle is coarse-pointer-gated — absent on a fine-pointer
    // desktop even in desktop mode at full width, in both placements.
    await expect(page.locator("#ui-mode-toggle")).toBeHidden();
    await expect(page.locator("#rail-ui-mode-toggle")).toBeHidden();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".preview-shell")).toBeVisible();
  });
});
