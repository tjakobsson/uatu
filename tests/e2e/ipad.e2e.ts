// iPad-viewport coverage (touch-tab-navigation change): coarse pointer AND
// wide (1024×768) — the combination mobile-experience used to exclude from
// phone-class. Touch mode now extends here by default, with the tab bar's
// Desktop escape flipping the device to the full desktop rendering and the
// desktop chrome's touch-mode return flipping back, both persisted per
// device. A fine-pointer guard describe pins that desktop browsers never
// see any of this chrome.

import { expect, test } from "./fixtures";
import { treeRow } from "./tree-helpers";

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

test.describe("iPad mermaid viewer", () => {
  // Coarse pointer AND wide. The viewer's touch affordances key on the
  // pointer type, not on the persisted UI mode, so they must be present in
  // both — an iPad in desktop mode still has fingers.
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  async function openDiagramViewer(page: import("@playwright/test").Page): Promise<void> {
    const trigger = page.locator("#preview .mermaid-trigger");
    await expect(trigger).toBeVisible();
    await trigger.tap();
    await expect(page.locator("dialog.mermaid-viewer")).toHaveAttribute("open", "");
    await page.waitForTimeout(120);
  }

  async function toolbarGeometry(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>(".mermaid-viewer-toolbar");
      const dialog = document.querySelector<HTMLElement>("dialog.mermaid-viewer");
      if (!toolbar || !dialog) return null;
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(".mermaid-viewer-button"),
      ).map(button => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      });
      const rect = toolbar.getBoundingClientRect();
      return {
        toolbar: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        buttons,
        dialogHeight: dialog.getBoundingClientRect().height,
        visualHeight: window.visualViewport?.height ?? window.innerHeight,
        visualWidth: window.visualViewport?.width ?? window.innerWidth,
      };
    });
  }

  test("in touch mode the toolbar is reachable with 44px targets", async ({ page, request }) => {
    await bootClean(page, request);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-files").click();
    await treeRow(page, "diagram.md").click();
    await page.locator("#touch-tab-preview").click();
    await openDiagramViewer(page);

    const geometry = await toolbarGeometry(page);
    expect(geometry).not.toBeNull();
    expect(geometry!.buttons.length).toBe(4);
    for (const button of geometry!.buttons) {
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.width).toBeGreaterThanOrEqual(44);
      // Every control inside the visible viewport, in both axes.
      expect(button.top).toBeGreaterThanOrEqual(0);
      expect(button.bottom).toBeLessThanOrEqual(geometry!.visualHeight);
      expect(button.left).toBeGreaterThanOrEqual(0);
      expect(button.right).toBeLessThanOrEqual(geometry!.visualWidth);
    }
    expect(geometry!.dialogHeight).toBeLessThanOrEqual(geometry!.visualHeight + 1);
  });

  test("the touch targets survive the flip to desktop mode", async ({ page, request }) => {
    // The affordance follows the input device, not the persisted mode. An
    // iPad in desktop mode gets the desktop layout but keeps 44px controls.
    await bootClean(page, request);
    await page.locator("#touch-tab-files").click();
    await page.locator("#ui-mode-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");

    await treeRow(page, "diagram.md").click();
    await openDiagramViewer(page);

    const geometry = await toolbarGeometry(page);
    expect(geometry).not.toBeNull();
    for (const button of geometry!.buttons) {
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.width).toBeGreaterThanOrEqual(44);
    }
  });

  test("pinch zoom and double-tap fit work on iPad", async ({ page, request }) => {
    await bootClean(page, request);
    await page.locator("#touch-tab-files").click();
    await treeRow(page, "diagram.md").click();
    await page.locator("#touch-tab-preview").click();
    await openDiagramViewer(page);

    const send = async (
      type: "pointerdown" | "pointermove" | "pointerup",
      pointerId: number,
      x: number,
      y: number,
    ) => {
      await page.evaluate(
        ({ type, pointerId, x, y }) => {
          document.querySelector<HTMLElement>(".mermaid-viewer-viewport")!.dispatchEvent(
            new PointerEvent(type, {
              pointerId,
              pointerType: "touch",
              isPrimary: pointerId === 1,
              clientX: x,
              clientY: y,
              button: 0,
              buttons: type === "pointerup" ? 0 : 1,
              bubbles: true,
              cancelable: true,
            }),
          );
        },
        { type, pointerId, x, y },
      );
    };
    const scale = () =>
      page.evaluate(() => {
        const match = document
          .querySelector<HTMLElement>(".mermaid-viewer-stage")!
          .style.transform.match(/scale\(([\d.]+)\)/);
        return match ? Number.parseFloat(match[1]!) : Number.NaN;
      });
    const transform = () =>
      page.locator(".mermaid-viewer-stage").evaluate(el => (el as HTMLElement).style.transform);

    const fitted = await transform();
    const before = await scale();

    await send("pointerdown", 1, 470, 380);
    await send("pointerdown", 2, 530, 380);
    await send("pointermove", 1, 380, 380);
    await send("pointermove", 2, 620, 380);
    expect(await scale()).toBeGreaterThan(before * 2);
    await send("pointerup", 1, 380, 380);
    await send("pointerup", 2, 620, 380);

    // Double-tap returns to the fitted view.
    for (const id of [3, 4]) {
      await send("pointerdown", id, 500, 380);
      await send("pointerup", id, 500, 380);
    }
    await expect.poll(transform).toBe(fitted);
  });
});
