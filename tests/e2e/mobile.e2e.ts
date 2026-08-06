// Phone-class coverage (mobile-experience change): iPhone-shaped viewport
// with touch + mobile emulation so `(pointer: coarse)` matches and the
// ≤900px stacked layout applies. Covers the fullscreen terminal promotion,
// keybar growth, the file-browser overlay, the stacked preview header, and
// both size steppers. The visualViewport keyboard behavior is unit-tested
// (visual-viewport.test.ts) and gated on a real device — Playwright cannot
// emulate the iOS software keyboard.

import fs from "node:fs/promises";

import { expect, test } from "./fixtures";
import { standardBeforeEach, waitForPreviewToSettle } from "./fixtures";
import { treeRow } from "./tree-helpers";
import { workspacePath } from "./config";

// iPhone 13 Pro portrait. hasTouch + isMobile make Chromium report a coarse
// pointer, which is what gates every phone-class style and script path.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// Persisted UI state lives in presentation storage, which namespaces keys
// with `uatu:presentation:v1:<basePath>:` — resolve by suffix.
function readStoredValue(page: import("@playwright/test").Page, suffix: string): Promise<string | null> {
  return page.evaluate(s => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)!;
      if (key.endsWith(s)) return window.localStorage.getItem(key);
    }
    return null;
  }, suffix);
}

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

// Terminal-backed tests need the cookie flow from /?t=<token>; mirrors the
// SHARED_BEFORE in terminal.e2e.ts.
async function terminalBeforeEach(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  await request.post("/__e2e/reset");
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
  await page
    .waitForFunction(
      () =>
        document.cookie.includes("uatu_term=") ||
        window.sessionStorage.getItem("uatu:terminal-token") !== null,
      undefined,
      { timeout: 5000 },
    )
    .catch(() => {
      // Cookie is HttpOnly so document.cookie won't see it — fall back.
    });
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
}

test.describe("phone terminal", () => {
  test.beforeEach(async ({ page, request }) => {
    await terminalBeforeEach(page, request);
  });

  test("opening the terminal auto-promotes to true fullscreen without touching the stored mode", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    const panel = page.locator("#terminal-panel");
    await expect(panel).toHaveAttribute("data-display", "fullscreen");
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    // Whole visual viewport: fixed, no sidebar or preview reachable.
    const box = await panel.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(389);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(700);
    await expect
      .poll(async () => page.evaluate(() => getComputedStyle(document.body).overflow))
      .toBe("hidden");

    // Geometry controls are meaningless at phone widths.
    await expect(page.locator("#terminal-split")).toBeHidden();
    await expect(page.locator("#terminal-dock-toggle")).toBeHidden();

    // The stored preference is untouched by the promotion.
    await expect
      .poll(async () => JSON.parse((await readStoredValue(page, "uatu:terminal-state")) ?? "{}").displayMode)
      .toBe("normal");
  });

  test("leaving fullscreen minimizes instead of docking a strip", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    await page.locator("#terminal-fullscreen").click();
    const panel = page.locator("#terminal-panel");
    await expect(panel).toHaveAttribute("data-display", "minimized");
    // PTY stays attached: restoring shows the same pane, no auth form.
    await page.locator("#terminal-minimize").click();
    await expect(panel).toHaveAttribute("data-display", "fullscreen");
    await expect(page.locator(".terminal-auth")).toHaveCount(0);
  });

  test("keybar shows the grown key set and the sticky Ctrl latch arms and cancels", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    const keybar = page.locator("#terminal-keybar");
    await expect(keybar).toBeVisible();
    for (const label of ["Page up", "Page down", "Home", "End", "Paste from clipboard"]) {
      await expect(keybar.getByRole("button", { name: label })).toBeVisible();
    }

    const ctrl = keybar.getByRole("button", { name: "Control modifier" });
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");
    await ctrl.dispatchEvent("pointerdown");
    await expect(ctrl).toHaveAttribute("aria-pressed", "true");
    await ctrl.dispatchEvent("pointerdown");
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  });

  test("font stepper applies live and persists a per-device override", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    const increase = page.locator("#terminal-font-increase");
    await expect(increase).toBeVisible();
    await increase.click();
    await increase.click();
    await expect
      .poll(() => readStoredValue(page, "uatu:terminal-font-size"))
      .toBe("15");
    // Live application: xterm's helper measures with the new size; assert
    // via the pane still being attached and rendering (a failed refit would
    // throw and detach).
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible();
  });
});

test.describe("phone file navigation", () => {
  test.beforeEach(async ({ page, request }) => {
    await standardBeforeEach(page, request);
  });

  test("the stacked tree shows real rows, not a one-row sliver", async ({ page }) => {
    const treeBox = await page.locator("#tree").boundingBox();
    expect(treeBox?.height ?? 0).toBeGreaterThan(200);
    await expect(treeRow(page, "README.md")).toBeVisible();
    await expect(treeRow(page, "diagram.md")).toBeVisible();
  });

  test("browse opens a full-screen overlay; directory taps and file events keep it open; a pick dismisses to the preview", async ({ page }) => {
    const pane = page.locator('[data-pane-id="files"]');
    await page.locator("#files-browse-open").click();
    await expect(pane).toHaveAttribute("data-overlay", "open");
    const box = await pane.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(389);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(800);

    // Directory expand keeps the browser open.
    await treeRow(page, "guides/").click();
    await expect(pane).toHaveAttribute("data-overlay", "open");

    // A watched-file event (programmatic tree update) must not steal it.
    await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nTouched while browsing.\n", "utf8");
    await page.waitForTimeout(600);
    await expect(pane).toHaveAttribute("data-overlay", "open");

    // Picking a document dismisses to the preview showing that document.
    await treeRow(page, "diagram.md").click();
    await expect(pane).not.toHaveAttribute("data-overlay", "open");
    await waitForPreviewToSettle(page);
    await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  });

  test("browsing from a collapsed Files pane still shows the tree", async ({ page }) => {
    const pane = page.locator('[data-pane-id="files"]');
    await pane.getByRole("button", { name: "Collapse Files" }).click();
    await expect(pane).toHaveClass(/is-collapsed/);

    await page.locator("#files-browse-open").click();
    await expect(pane).toHaveAttribute("data-overlay", "open");
    await expect(treeRow(page, "README.md")).toBeVisible();

    // Dismissing restores the collapsed stacked state untouched.
    await page.locator("#files-browse-close").click();
    await expect(pane).not.toHaveAttribute("data-overlay", "open");
    await expect(pane).toHaveClass(/is-collapsed/);
  });

  test("closing without picking restores the stacked layout unchanged", async ({ page }) => {
    const pane = page.locator('[data-pane-id="files"]');
    await page.locator("#files-browse-open").click();
    await expect(pane).toHaveAttribute("data-overlay", "open");
    await page.locator("#files-browse-close").click();
    await expect(pane).not.toHaveAttribute("data-overlay", "open");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
  });
});

test.describe("phone preview chrome", () => {
  test.beforeEach(async ({ page, request }) => {
    await standardBeforeEach(page, request);
  });

  test("the header stacks: toolbar below the heading, no horizontal overflow", async ({ page }) => {
    const direction = await page
      .locator(".preview-header")
      .evaluate(el => getComputedStyle(el).flexDirection);
    expect(direction).toBe("column");

    const heading = await page.locator(".preview-heading").boundingBox();
    const toolbar = await page.locator(".preview-toolbar").boundingBox();
    expect((toolbar?.y ?? 0)).toBeGreaterThan((heading?.y ?? 0) + (heading?.height ?? 0) - 1);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("text-size steps reflow the document, persist, and stop at the bounds", async ({ page }) => {
    const increase = page.locator("#preview-text-increase");
    const decrease = page.locator("#preview-text-decrease");
    await expect(increase).toBeVisible();

    const sizeOf = () =>
      page.locator("#preview").evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize));
    const initial = await sizeOf();
    expect(initial).toBeCloseTo(16, 0);

    await increase.click();
    await increase.click();
    expect(await sizeOf()).toBeGreaterThan(initial + 2);

    await page.reload();
    await waitForPreviewToSettle(page);
    expect(await sizeOf()).toBeGreaterThan(initial + 2);

    // Ride to the ceiling: the control disables at the bound.
    for (let i = 0; i < 6; i += 1) {
      if (await increase.isDisabled()) break;
      await increase.click();
    }
    await expect(increase).toBeDisabled();
    await expect(decrease).toBeEnabled();
  });
});
