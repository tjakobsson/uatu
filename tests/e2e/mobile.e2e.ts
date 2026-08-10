// Touch-mode coverage (touch-tab-navigation change): iPhone-shaped viewport
// with touch + mobile emulation so `(pointer: coarse)` matches and the UI
// boots into touch mode with the bottom tab bar. Covers the three tab
// surfaces and their switching semantics, the PTY-preserving terminal tab,
// the keybar, both size steppers, and the stacked preview header. The
// visualViewport keyboard behavior is unit-tested (visual-viewport.test.ts)
// and gated on a real device — Playwright cannot emulate the iOS software
// keyboard.

import fs from "node:fs/promises";

import { expect, test } from "./fixtures";
import { waitForPreviewToSettle } from "./fixtures";
import { treeRow } from "./tree-helpers";
import { workspacePath } from "./config";

// iPhone 13 Pro portrait. hasTouch + isMobile make Chromium report a coarse
// pointer, which is what defaults the UI mode to touch.
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

// Touch-mode variant of the standard boot: the sidebar (tree, follow chip)
// is only visible inside the Files tab, so baseline assertions that touch
// it happen there before landing back on Preview.
async function touchBeforeEach(
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
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#document-count")).toHaveText("18 files");
  await waitForPreviewToSettle(page);
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  // Normalize follow to off inside the Files tab (the chip lives in the
  // sidebar surface); see standardBeforeEach for why this is conditional.
  await page.locator("#touch-tab-files").click();
  await expect(treeRow(page, "README.md")).toBeVisible();
  const pressed = await page.locator("#follow-toggle").getAttribute("aria-pressed");
  if (pressed === "true") {
    await page.locator("#follow-toggle").click();
  }
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#touch-tab-preview").click();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
  await page.waitForTimeout(75);
}

// Terminal-backed tests need the cookie flow from /?t=<token>; mirrors the
// SHARED_BEFORE in terminal.e2e.ts.
async function terminalBeforeEach(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  context: import("@playwright/test").BrowserContext,
): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test.describe("touch tab navigation", () => {
  test.beforeEach(async ({ page, request }) => {
    await touchBeforeEach(page, request);
  });

  test("boot lands on Preview with the tab bar visible and no phone escape control", async ({ page }) => {
    await expect(page.locator("#touch-tab-bar")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
    await expect(page.locator("#touch-tab-preview")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#touch-tab-files")).toHaveAttribute("aria-selected", "false");
    await expect(page.locator(".preview-shell")).toBeVisible();
    // One surface at a time: the sidebar is not rendered on the Preview tab.
    await expect(page.locator(".sidebar")).toBeHidden();
    // The bar sits at the viewport's bottom edge.
    const barBox = await page.locator("#touch-tab-bar").boundingBox();
    expect(barBox?.width ?? 0).toBeGreaterThanOrEqual(389);
    expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeGreaterThanOrEqual(843);
    // The bar carries only the three surface tabs — no mode control.
    await expect(page.locator("#touch-tab-bar button")).toHaveCount(3);
    // Desktop-only chrome stays gone in touch mode.
    await expect(page.locator("#terminal-toggle")).toBeHidden();
  });

  test("tab switching swaps fullscreen surfaces", async ({ page }) => {
    await page.locator("#touch-tab-files").click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
    await expect(page.locator("#touch-tab-files")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".preview-shell")).toBeHidden();
    // The Files surface fills the viewport above the bar.
    const sidebarBox = await page.locator(".sidebar").boundingBox();
    expect(sidebarBox?.width ?? 0).toBeGreaterThanOrEqual(389);
    expect(sidebarBox?.height ?? 0).toBeGreaterThan(700);
    // The tree gets real rows, not a one-row sliver.
    const treeBox = await page.locator("#tree").boundingBox();
    expect(treeBox?.height ?? 0).toBeGreaterThan(200);
    await expect(treeRow(page, "README.md")).toBeVisible();
    // The mode toggle lives in this surface's header, at any width.
    await expect(page.locator("#ui-mode-toggle")).toBeVisible();

    await page.locator("#touch-tab-preview").click();
    await expect(page.locator(".preview-shell")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeHidden();
  });

  test("a document pick switches to Preview; directory taps and file events do not", async ({ page }) => {
    await page.locator("#touch-tab-files").click();
    await expect(treeRow(page, "guides/")).toBeVisible();

    // Directory expand keeps the Files tab active.
    await treeRow(page, "guides/").click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");

    // A watched-file event (programmatic tree update) must not steal it.
    await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nTouched while browsing.\n", "utf8");
    await page.waitForTimeout(600);
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
    await expect(page.locator(".sidebar")).toBeVisible();

    // Picking a document lands on the Preview tab showing that document.
    await treeRow(page, "diagram.md").click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
    await waitForPreviewToSettle(page);
    await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  });

  test("a search-result click lands on the Preview tab showing the document", async ({ page }) => {
    await page.locator("#touch-tab-files").click();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await expect(page.locator("#search-query")).toBeVisible();
    await page.locator("#search-query").fill("Save this file");
    await expect(page.locator(".search-hit")).toHaveCount(1, { timeout: 10_000 });

    // Opening a result is a Rule A navigation: the Preview surface comes
    // forward with the picked document — no manual tab switch needed.
    await page.locator(".search-hit").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
    await expect(page.locator(".preview-shell")).toBeVisible();
    await waitForPreviewToSettle(page);
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  });

  test("tree state is continuous across tab switches", async ({ page }) => {
    await page.locator("#touch-tab-files").click();
    await treeRow(page, "guides/").click();
    await expect(treeRow(page, "guides/setup.md")).toBeVisible();

    await page.locator("#touch-tab-preview").click();
    await page.locator("#touch-tab-files").click();
    // Expansion survived the round-trip — same tree DOM, not a rebuild.
    await expect(treeRow(page, "guides/setup.md")).toBeVisible();
  });

  test("dragging a pane header resizes the boundary above it", async ({ page }) => {
    await page.locator("#touch-tab-files").click();
    await expect(treeRow(page, "README.md")).toBeVisible();

    const overviewPane = page.locator('[data-pane-id="change-overview"]');
    const filesHeader = page.locator('[data-pane-id="files"] .pane-header');
    const startOverview = (await overviewPane.boundingBox())?.height ?? 0;
    expect(startOverview).toBeGreaterThan(100);

    // Drag the Files header upward: Change Overview shrinks, Files grows.
    const headerBox = await filesHeader.boundingBox();
    const startX = (headerBox?.x ?? 0) + 60;
    const startY = (headerBox?.y ?? 0) + (headerBox?.height ?? 0) / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY - 100, { steps: 8 });
    await page.mouse.up();

    const endOverview = (await overviewPane.boundingBox())?.height ?? 0;
    expect(endOverview).toBeLessThan(startOverview - 60);

    // The new allocation persists like a desktop resizer drag.
    const stored = JSON.parse((await readStoredValue(page, "uatu:sidebar-panes")) ?? "{}");
    expect(stored["change-overview"]?.height).toBeLessThan(startOverview - 60);

    // Taps on header controls still work despite the drag wiring.
    await overviewPane.getByRole("button", { name: "Collapse Change Overview" }).click();
    await expect(overviewPane).toHaveClass(/is-collapsed/);
    await overviewPane.getByRole("button", { name: "Expand Change Overview" }).click();
    await expect(overviewPane).not.toHaveClass(/is-collapsed/);
  });

  test("double-tapping a pane header toggles its collapse", async ({ page }) => {
    await page.locator("#touch-tab-files").click();
    await expect(treeRow(page, "README.md")).toBeVisible();

    const overviewPane = page.locator('[data-pane-id="change-overview"]');
    const header = overviewPane.locator(".pane-header");

    // A single tap changes nothing; wait out the double-tap window so it
    // cannot pair with the next gesture.
    await header.click({ position: { x: 60, y: 15 } });
    await page.waitForTimeout(450);
    await expect(overviewPane).not.toHaveClass(/is-collapsed/);

    // Double-tap collapses, persisted like the − button.
    await header.dblclick({ position: { x: 60, y: 15 } });
    await expect(overviewPane).toHaveClass(/is-collapsed/);
    const stored = JSON.parse((await readStoredValue(page, "uatu:sidebar-panes")) ?? "{}");
    expect(stored["change-overview"]?.collapsed).toBe(true);

    // Double-tap again expands.
    await header.dblclick({ position: { x: 60, y: 15 } });
    await expect(overviewPane).not.toHaveClass(/is-collapsed/);
  });

  test("the active tab persists across reload", async ({ page }) => {
    await page.locator("#touch-tab-files").click();
    await expect.poll(() => readStoredValue(page, "uatu:active-tab")).toBe("files");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(treeRow(page, "README.md")).toBeVisible();
  });
});

test.describe("touch terminal tab", () => {
  test.beforeEach(async ({ page, request, context }) => {
    await terminalBeforeEach(page, request, context);
  });

  test("activating the Terminal tab lands in true fullscreen without touching the stored mode", async ({ page }) => {
    await page.locator("#touch-tab-terminal").click();
    const panel = page.locator("#terminal-panel");
    await expect(panel).toHaveAttribute("data-display", "fullscreen");
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    // Whole viewport above the tab bar: no sidebar or preview reachable.
    const box = await panel.boundingBox();
    const barBox = await page.locator("#touch-tab-bar").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(389);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(700);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((barBox?.y ?? 0) + 1);
    await expect(page.locator(".preview-shell")).toBeHidden();
    await expect
      .poll(async () => page.evaluate(() => getComputedStyle(document.body).overflow))
      .toBe("hidden");

    // Geometry controls (and minimize — tabs supersede it) are hidden.
    await expect(page.locator("#terminal-split")).toBeHidden();
    await expect(page.locator("#terminal-dock-toggle")).toBeHidden();
    await expect(page.locator("#terminal-minimize")).toBeHidden();

    // The stored preference is untouched by the promotion.
    await expect
      .poll(async () => JSON.parse((await readStoredValue(page, "uatu:terminal-state")) ?? "{}").displayMode)
      .toBe("normal");
  });

  test("the terminal survives tab round-trips with its PTY attached and output intact", async ({ page }) => {
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    // Touch emulation doesn't reliably deliver the show-path's deferred
    // focus; land it explicitly before typing (same recipe as terminal.e2e).
    await page.evaluate(() => {
      document.querySelector<HTMLTextAreaElement>(".terminal-pane-host .xterm-helper-textarea")?.focus();
    });
    await page.keyboard.type('echo "tab-roundtrip-$((6*7))"');
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const rows = await page.locator(".terminal-pane-host .xterm-rows > div").allTextContents();
      return rows.some(text => text.includes("tab-roundtrip-42"));
    }, { timeout: 5000 }).toBe(true);

    // Switch away: the surface hides, the panel is NOT torn down (no hidden
    // attribute — minimize semantics), the PTY stays attached.
    await page.locator("#touch-tab-preview").click();
    await expect(page.locator("#terminal-panel")).not.toBeVisible();
    await expect(page.locator("#terminal-panel")).not.toHaveAttribute("hidden", "");
    await expect(page.locator(".terminal-pane")).toHaveCount(1);

    // Return: same session, accumulated output visible, no auth form.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "fullscreen");
    await expect(page.locator(".terminal-auth")).toHaveCount(0);
    await expect.poll(async () => {
      const rows = await page.locator(".terminal-pane-host .xterm-rows > div").allTextContents();
      return rows.some(text => text.includes("tab-roundtrip-42"));
    }, { timeout: 5000 }).toBe(true);
  });

  test("leaving fullscreen routes to the Preview tab, never a minimized strip", async ({ page }) => {
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    await page.locator("#terminal-fullscreen").click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
    // No strip: the panel is simply not rendered on the Preview tab.
    await expect(page.locator("#terminal-panel")).not.toBeVisible();
    await expect(page.locator(".terminal-panel-header")).not.toBeVisible();

    // The PTY survived; the tab is the return affordance.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "fullscreen");
    await expect(page.locator(".terminal-auth")).toHaveCount(0);
  });

  test("PTY output while another tab is active badges the Terminal tab", async ({ page }) => {
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    // Kick off delayed output, then leave before it arrives.
    await page.evaluate(() => {
      document.querySelector<HTMLTextAreaElement>(".terminal-pane-host .xterm-helper-textarea")?.focus();
    });
    await page.keyboard.type("sleep 1 && echo badge-ping");
    await page.keyboard.press("Enter");
    await page.locator("#touch-tab-preview").click();

    await expect(page.locator("#touch-tab-terminal")).toHaveAttribute("data-badge", "", { timeout: 5000 });

    // Activating the tab clears the dot.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator("#touch-tab-terminal")).not.toHaveAttribute("data-badge", "");
  });

  test("keybar shows the grown key set and the sticky Ctrl latch arms and cancels", async ({ page }) => {
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    const keybar = page.locator("#terminal-keybar");
    await expect(keybar).toBeVisible();
    for (const label of [
      "Page up",
      "Page down",
      "Home",
      "End",
      "Paste from clipboard",
      "Select terminal text",
    ]) {
      await expect(keybar.getByRole("button", { name: label })).toBeVisible();
    }

    const ctrl = keybar.getByRole("button", { name: "Control modifier" });
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");
    await ctrl.dispatchEvent("pointerdown");
    await expect(ctrl).toHaveAttribute("aria-pressed", "true");
    await ctrl.dispatchEvent("pointerdown");
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  });

  test("Select opens a document-level transcript with native text selection and Done restores terminal", async ({ page }) => {
    await page.locator("#touch-tab-terminal").click();
    const host = page.locator(".terminal-pane-host").first();
    const terminal = host.locator(".xterm");
    await expect(terminal).toBeVisible({ timeout: 5000 });
    await expect(host).toHaveAttribute("data-terminal-ready", "true", { timeout: 10_000 });
    await page.evaluate(() => {
      document.querySelector<HTMLTextAreaElement>(".terminal-pane-host .xterm-helper-textarea")?.focus();
    });
    await page.keyboard.type("seq 1 80; printf '%0500d\\n' 0; printf 'snapshot-%s-ready\\n' sheet; sleep 1 && printf 'sheet-%s-marker\\n' later");
    await page.keyboard.press("Enter");
    await expect.poll(() => host.locator(".xterm").textContent()).toContain("snapshot-sheet-ready");

    await page.getByRole("button", { name: "Select terminal text" }).click();
    const transcript = page.locator("body > .terminal-transcript");
    const text = transcript.locator(".terminal-transcript-text");
    await expect(transcript).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/terminal-transcript-open/);
    await expect(page.locator(".app-shell")).toHaveCSS("visibility", "hidden");
    await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
    await expect(terminal).toHaveAttribute("inert", "");
    await expect(transcript.locator(".terminal-transcript-header")).toContainText("Long-press text to select and copy");
    const transcriptNav = transcript.locator(".terminal-transcript-nav");
    const done = transcript.getByRole("button", { name: "Done selecting terminal text and return to Terminal" });
    await expect(transcriptNav).toHaveCSS("position", "fixed");
    await expect(done).toBeVisible();
    const snapshot = await text.textContent();
    expect(snapshot).toContain("snapshot-sheet-ready");
    expect(snapshot).not.toContain("sheet-later-marker");
    await expect.poll(() => host.locator(".xterm").textContent()).toContain("sheet-later-marker");
    expect(await text.textContent()).toBe(snapshot);
    await expect.poll(() => page.evaluate(() => (
      Math.abs(document.documentElement.scrollHeight - window.innerHeight - window.scrollY) <= 2
    ))).toBe(true);

    const selected = await transcript.locator(".terminal-transcript-line", { hasText: "snapshot-sheet-ready" }).evaluate(element => {
      const marker = "snapshot-sheet-ready";
      const start = element.textContent!.indexOf(marker);
      const range = document.createRange();
      range.setStart(element.firstChild!, start);
      range.setEnd(element.firstChild!, start + marker.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return {
        text: selection.toString(),
        bodyLevel: element.closest(".terminal-transcript")?.parentElement === document.body,
      };
    });
    expect(selected).toEqual({ text: "snapshot-sheet-ready", bodyLevel: true });

    await page.keyboard.press("Escape");
    await expect(transcript).toHaveCount(0);
    await expect(page.locator("#touch-tab-terminal")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("body")).not.toHaveClass(/terminal-transcript-open/);
    await expect(terminal).not.toHaveAttribute("inert", "");

    await page.getByRole("button", { name: "Select terminal text" }).click();
    await expect(transcript).toBeVisible();
    await done.click();
    await expect(transcript).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/terminal-transcript-open/);
    await expect(terminal).not.toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: "Select terminal text" })).toHaveAttribute("aria-pressed", "false");
  });

  test("keybar Paste sends multiline clipboard text exactly once through bracketed paste", async ({ page }) => {
    await page.locator("#touch-tab-terminal").click();
    const host = page.locator(".terminal-pane-host").first();
    await expect(host.locator(".xterm")).toBeVisible({ timeout: 5000 });
    await expect(host).toHaveAttribute("data-terminal-ready", "true", { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      document.querySelector<HTMLTextAreaElement>(".terminal-pane-host .xterm-helper-textarea")?.focus();
    });

    // Explicitly enable the terminal mode so this assertion does not depend
    // on which interactive shell the E2E host happens to use.
    await page.keyboard.type("printf '\\033[?2004h'; echo bracket-mode-ready");
    await page.keyboard.press("Enter");
    await expect(host).toContainText("bracket-mode-ready", { timeout: 5000 });

    const markerName = ".keybar-paste-marker";
    const markerPath = workspacePath(markerName);
    const clipboardText =
      `printf 'first\\n' >> ${markerName}\n` +
      `printf 'second\\n' >> ${markerName}`;
    await page.evaluate(text => navigator.clipboard.writeText(text), clipboardText);

    await page.getByRole("button", { name: "Paste from clipboard" }).click();
    // Bracketed paste holds embedded newlines in the editor until the user
    // submits. A raw socket write would have created the marker already.
    await page.waitForTimeout(200);
    expect(await fs.readFile(markerPath, "utf8").catch(() => null)).toBeNull();

    await page.keyboard.press("Enter");
    await expect.poll(
      () => fs.readFile(markerPath, "utf8").catch(() => null),
      { timeout: 5000 },
    ).toBe("first\nsecond\n");
  });

  test("font stepper applies live and persists a per-device override", async ({ page }) => {
    await page.locator("#touch-tab-terminal").click();
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

test.describe("touch preview chrome", () => {
  test.beforeEach(async ({ page, request }) => {
    await touchBeforeEach(page, request);
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

    // Split layouts nest their own .markdown-body panes that re-pin 16px —
    // the scale must reach them too.
    await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
    const paneSize = await page
      .locator(".preview-pane-rendered")
      .evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(paneSize).toBeGreaterThan(initial + 2);
    await page.locator(".uatu-layout-toolbar [data-layout-value='single']").click();

    // Ride to the ceiling: the control disables at the bound.
    for (let i = 0; i < 6; i += 1) {
      if (await increase.isDisabled()) break;
      await increase.click();
    }
    await expect(increase).toBeDisabled();
    await expect(decrease).toBeEnabled();
  });
});

test.describe("touch mermaid viewer", () => {
  test.beforeEach(async ({ page, request }) => {
    await touchBeforeEach(page, request);
  });

  // Open `diagram.md` and its rendered diagram in the fullscreen viewer.
  async function openViewer(page: import("@playwright/test").Page): Promise<void> {
    await page.locator("#touch-tab-files").click();
    await treeRow(page, "diagram.md").click();
    await page.locator("#touch-tab-preview").click();
    const trigger = page.locator("#preview .mermaid-trigger");
    await expect(trigger).toBeVisible();
    await trigger.tap();
    await expect(page.locator("dialog.mermaid-viewer")).toHaveAttribute("open", "");
    // Let the deferred fit-to-viewport RAF settle before measuring.
    await page.waitForTimeout(120);
  }

  function stageTransform(page: import("@playwright/test").Page): Promise<string> {
    return page.locator(".mermaid-viewer-stage").evaluate(el => (el as HTMLElement).style.transform);
  }

  function stageScale(page: import("@playwright/test").Page): Promise<number> {
    return page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".mermaid-viewer-stage");
      const match = stage?.style.transform.match(/scale\(([\d.]+)\)/);
      return match ? Number.parseFloat(match[1]!) : Number.NaN;
    });
  }

  // Playwright has no pinch primitive; drive the pointer events the viewer
  // actually listens to. `isPrimary` matters — the second finger is not.
  async function dispatchPointer(
    page: import("@playwright/test").Page,
    type: "pointerdown" | "pointermove" | "pointerup",
    pointerId: number,
    x: number,
    y: number,
  ): Promise<void> {
    await page.evaluate(
      ({ type, pointerId, x, y }) => {
        const viewport = document.querySelector<HTMLElement>(".mermaid-viewer-viewport");
        if (!viewport) throw new Error("no viewer viewport");
        viewport.dispatchEvent(
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
  }

  test("the close control sits inside the visible viewport and closes by touch", async ({ page }) => {
    // #187: the dialog was sized in `100vh`, which on iOS is the viewport with
    // browser chrome retracted — the toolbar, and with it the only close
    // control, sat below the visible fold behind the URL bar.
    await openViewer(page);

    const geometry = await page.evaluate(() => {
      const close = document.querySelector<HTMLElement>(".mermaid-viewer-close");
      const dialog = document.querySelector<HTMLElement>("dialog.mermaid-viewer");
      if (!close || !dialog) return null;
      const rect = close.getBoundingClientRect();
      return {
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height },
        visualHeight: window.visualViewport?.height ?? window.innerHeight,
        visualWidth: window.visualViewport?.width ?? window.innerWidth,
        dialogHeight: dialog.getBoundingClientRect().height,
      };
    });
    expect(geometry).not.toBeNull();

    // Fully within the visible viewport on both axes.
    expect(geometry!.rect.top).toBeGreaterThanOrEqual(0);
    expect(geometry!.rect.bottom).toBeLessThanOrEqual(geometry!.visualHeight);
    expect(geometry!.rect.left).toBeGreaterThanOrEqual(0);
    expect(geometry!.rect.right).toBeLessThanOrEqual(geometry!.visualWidth);
    // The dialog itself is sized to the visible viewport, not beyond it.
    expect(geometry!.dialogHeight).toBeLessThanOrEqual(geometry!.visualHeight + 1);
    // 44px minimum touch target under a coarse pointer.
    expect(geometry!.rect.height).toBeGreaterThanOrEqual(44);
    expect(geometry!.rect.width).toBeGreaterThanOrEqual(44);

    await page.locator(".mermaid-viewer-close").tap();
    await expect(page.locator("dialog.mermaid-viewer")).not.toHaveAttribute("open", "");
  });

  test("two-finger pinch zooms the diagram", async ({ page }) => {
    await openViewer(page);
    const before = await stageScale(page);
    expect(Number.isFinite(before)).toBe(true);

    // Two fingers land 60px apart and spread to 240px: a 4x separation ratio.
    await dispatchPointer(page, "pointerdown", 1, 165, 400);
    await dispatchPointer(page, "pointerdown", 2, 225, 400);
    await dispatchPointer(page, "pointermove", 1, 75, 400);
    await dispatchPointer(page, "pointermove", 2, 315, 400);

    const zoomed = await stageScale(page);
    expect(zoomed).toBeGreaterThan(before * 2);

    // Pinching back in shrinks it again — the gesture is measured against the
    // separation the fingers started at, not accumulated per move.
    await dispatchPointer(page, "pointermove", 1, 180, 400);
    await dispatchPointer(page, "pointermove", 2, 210, 400);
    expect(await stageScale(page)).toBeLessThan(zoomed);

    await dispatchPointer(page, "pointerup", 1, 180, 400);
    await dispatchPointer(page, "pointerup", 2, 210, 400);
  });

  test("a second finger landing and lifting does not displace the diagram", async ({ page }) => {
    // The bug the pointer Map replaced: unconditional pointerdown bookkeeping
    // overwrote the pan origin, so a finger arriving mid-pan (or leaving
    // mid-pinch) jumped the diagram by the distance between the fingers.
    await openViewer(page);

    await dispatchPointer(page, "pointerdown", 1, 200, 400);
    await dispatchPointer(page, "pointermove", 1, 230, 430);
    const afterPan = await stageTransform(page);

    // Second finger lands — no movement of either finger, so nothing should move.
    await dispatchPointer(page, "pointerdown", 2, 300, 500);
    expect(await stageTransform(page)).toBe(afterPan);

    // …and lifts again. Still nothing should move.
    await dispatchPointer(page, "pointerup", 2, 300, 500);
    expect(await stageTransform(page)).toBe(afterPan);

    // The surviving finger resumes panning from where it is, not from where
    // the pan originally started.
    await dispatchPointer(page, "pointermove", 1, 240, 440);
    const resumed = await stageTransform(page);
    expect(resumed).not.toBe(afterPan);

    const delta = await page.evaluate(
      ({ before, after }) => {
        const parse = (t: string) => {
          const m = t.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
          return m ? { x: Number.parseFloat(m[1]!), y: Number.parseFloat(m[2]!) } : null;
        };
        const a = parse(before);
        const b = parse(after);
        if (!a || !b) return null;
        return { dx: b.x - a.x, dy: b.y - a.y };
      },
      { before: afterPan, after: resumed },
    );
    // Exactly the 10px the finger moved — no jump folded in.
    expect(delta).not.toBeNull();
    expect(Math.abs(delta!.dx - 10)).toBeLessThan(1.5);
    expect(Math.abs(delta!.dy - 10)).toBeLessThan(1.5);

    await dispatchPointer(page, "pointerup", 1, 240, 440);
  });

  test("double-tap fits the diagram to the screen", async ({ page }) => {
    await openViewer(page);
    const fitted = await stageTransform(page);

    // Move it away from the fitted position.
    await dispatchPointer(page, "pointerdown", 1, 200, 400);
    await dispatchPointer(page, "pointermove", 1, 260, 460);
    await dispatchPointer(page, "pointerup", 1, 260, 460);
    expect(await stageTransform(page)).not.toBe(fitted);

    // Two quick taps in the same place: back to fit.
    for (const id of [2, 3]) {
      await dispatchPointer(page, "pointerdown", id, 200, 400);
      await dispatchPointer(page, "pointerup", id, 200, 400);
    }
    await expect.poll(() => stageTransform(page)).toBe(fitted);
  });

  test("a drag that returns near its start is not a tap", async ({ page }) => {
    // Tap eligibility is decided by the FURTHEST the pointer travelled, not by
    // where it happened to be released. Classifying on the release point alone
    // makes two out-and-back pans read as a double-tap, snapping the diagram
    // back to fit and discarding the position the user panned to.
    await openViewer(page);
    const fitted = await stageTransform(page);

    // Move away from the fitted view so a spurious fit is detectable.
    await dispatchPointer(page, "pointerdown", 40, 195, 400);
    await dispatchPointer(page, "pointermove", 40, 255, 460);
    await dispatchPointer(page, "pointerup", 40, 255, 460);
    const moved = await stageTransform(page);
    expect(moved).not.toBe(fitted);

    // Two drags that each wander far out and return to within the tap slop of
    // where they began.
    for (const id of [41, 42]) {
      await dispatchPointer(page, "pointerdown", id, 195, 400);
      await dispatchPointer(page, "pointermove", id, 340, 400);
      await dispatchPointer(page, "pointermove", id, 195, 400);
      await dispatchPointer(page, "pointerup", id, 197, 401);
    }

    // Neither counted as a tap, so no fit fired — the diagram is wherever the
    // pans left it, not back at the fitted transform.
    expect(await stageTransform(page)).not.toBe(fitted);
  });

  test("panning cannot move the diagram entirely off-screen", async ({ page }) => {
    await openViewer(page);

    // Fling far past the edge in one direction, repeatedly.
    for (let pass = 0; pass < 4; pass += 1) {
      await dispatchPointer(page, "pointerdown", 10 + pass, 200, 400);
      await dispatchPointer(page, "pointermove", 10 + pass, 2000, 3000);
      await dispatchPointer(page, "pointerup", 10 + pass, 2000, 3000);
    }

    const overlap = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".mermaid-viewer-stage");
      const viewport = document.querySelector<HTMLElement>(".mermaid-viewer-viewport");
      if (!stage || !viewport) return null;
      const s = stage.getBoundingClientRect();
      const v = viewport.getBoundingClientRect();
      return {
        x: Math.min(s.right, v.right) - Math.max(s.left, v.left),
        y: Math.min(s.bottom, v.bottom) - Math.max(s.top, v.top),
      };
    });
    expect(overlap).not.toBeNull();
    // Part of the diagram is still on screen on both axes — no recovery
    // control needed, which matters because that control used to be the
    // unreachable one.
    expect(overlap!.x).toBeGreaterThan(0);
    expect(overlap!.y).toBeGreaterThan(0);

    // …and the same in the opposite direction.
    for (let pass = 0; pass < 4; pass += 1) {
      await dispatchPointer(page, "pointerdown", 20 + pass, 200, 400);
      await dispatchPointer(page, "pointermove", 20 + pass, -2000, -3000);
      await dispatchPointer(page, "pointerup", 20 + pass, -2000, -3000);
    }
    const reverse = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".mermaid-viewer-stage");
      const viewport = document.querySelector<HTMLElement>(".mermaid-viewer-viewport");
      if (!stage || !viewport) return null;
      const s = stage.getBoundingClientRect();
      const v = viewport.getBoundingClientRect();
      return {
        x: Math.min(s.right, v.right) - Math.max(s.left, v.left),
        y: Math.min(s.bottom, v.bottom) - Math.max(s.top, v.top),
      };
    });
    expect(reverse!.x).toBeGreaterThan(0);
    expect(reverse!.y).toBeGreaterThan(0);
  });

  test("a downward pan never dismisses the viewer", async ({ page }) => {
    // Dismissal is exactly the close button and Escape. The whole surface is
    // a one-finger pan target, so a downward drag already means "move the
    // diagram up" — no swipe-to-dismiss is layered on top of it.
    await openViewer(page);
    const dialog = page.locator("dialog.mermaid-viewer");

    for (const speed of [40, 400]) {
      await dispatchPointer(page, "pointerdown", 30 + speed, 195, 200);
      await dispatchPointer(page, "pointermove", 30 + speed, 195, 200 + speed);
      await dispatchPointer(page, "pointermove", 30 + speed, 195, 200 + speed * 2);
      await dispatchPointer(page, "pointerup", 30 + speed, 195, 200 + speed * 2);
      await expect(dialog).toHaveAttribute("open", "");
    }
  });
});
