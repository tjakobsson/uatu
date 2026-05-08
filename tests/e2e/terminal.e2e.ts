import { expect, test } from "@playwright/test";

// Real-browser sanity for the terminal panel: toggle visibility from the
// sidebar entry, exercise the close-confirmation modal, minimize/fullscreen,
// dock switch, and split. Does NOT exercise PTY round-trips —
// `terminal-server.test.ts` covers stdin/stdout/disposeAll at the WS level,
// and adding a real shell to e2e would be flaky in CI.

const SHARED_BEFORE = async ({
  page,
  request,
}: {
  page: import("@playwright/test").Page;
  request: import("@playwright/test").APIRequestContext;
}) => {
  await request.post("/__e2e/reset");
  // The `request` fixture uses an isolated cookie context that doesn't
  // reach the `page` browser. Use the real user flow: hit /?t=<token> so
  // the page-side captureTerminalToken() runs and POSTs /api/auth from the
  // page context — that's what mints the cookie in the browser context.
  const tokenResp = await request.get("/__e2e/terminal-token");
  const tokenBody = await tokenResp.json();
  if (!tokenBody.enabled) {
    test.skip(true, "terminal backend unavailable on this platform");
  }
  await page.goto(`/?t=${encodeURIComponent(tokenBody.token)}`);
  // Clear any persisted UI state from a previous test so the panel starts
  // hidden and pristine.
  await page.evaluate(() => {
    try {
      window.sessionStorage.removeItem("uatu:terminal-visible");
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  // Wait for /api/auth to settle (cookie set) before any test work runs.
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
};

test.beforeEach(SHARED_BEFORE);

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test.describe("terminal entry-point: sidebar (not preview toolbar)", () => {
  test("toggle lives in the sidebar, not the preview toolbar", async ({ page }) => {
    // Sidebar row is visible when backend is enabled.
    await expect(page.locator(".sidebar-terminal-row")).toBeVisible();
    await expect(page.locator(".sidebar-terminal-row #terminal-toggle")).toBeVisible();
    // Preview toolbar must not contain a terminal toggle anymore.
    await expect(page.locator(".preview-toolbar #terminal-toggle")).toHaveCount(0);
    // The panel stays hidden until first toggle.
    await expect(page.locator("#terminal-panel")).toBeHidden();
  });

  test("clicking the sidebar toggle reveals the panel and connects xterm", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    // No auth-failure form should appear when the cookie is valid.
    await expect(page.locator(".terminal-auth")).toHaveCount(0);
  });

  test("Ctrl+` keyboard shortcut toggles the panel", async ({ page }) => {
    await page.keyboard.press("Control+`");
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    // Toggle does NOT prompt confirmation.
    await expect(page.locator("#terminal-confirm")).toBeHidden();

    await page.keyboard.press("Control+`");
    await expect(page.locator("#terminal-panel")).toBeHidden();
    await expect(page.locator("#terminal-confirm")).toBeHidden();
  });
});

test.describe("terminal close confirmation", () => {
  test("close button on attached pane prompts confirmation", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    await page.locator("#terminal-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    // Default focus is Cancel.
    await expect(page.locator("#terminal-confirm-cancel")).toBeFocused();
    await expect(page.locator("#terminal-panel")).toBeVisible();
  });

  test("cancel keeps the panel and PTY alive", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    await page.locator("#terminal-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.locator("#terminal-confirm-cancel").click();

    await expect(page.locator("#terminal-confirm")).toBeHidden();
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible();
  });

  test("Esc cancels the confirmation modal", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    await page.locator("#terminal-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#terminal-confirm")).toBeHidden();
    await expect(page.locator("#terminal-panel")).toBeVisible();
  });

  test("confirm tears down the panel", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    await page.locator("#terminal-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.locator("#terminal-confirm-accept").click();

    await expect(page.locator("#terminal-confirm")).toBeHidden();
    await expect(page.locator("#terminal-panel")).toBeHidden();
    await expect(page.locator(".terminal-pane-host .xterm")).toHaveCount(0);
  });

  test("server-initiated disconnect (exit) auto-closes the pane", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-pane")).toHaveCount(1);

    // Simulate the WebSocket dropping (shell exit / connection drop) by
    // closing it from the page side. The terminal handle's close listener
    // should treat this as server-initiated and tell the controller to
    // tear the pane down — no confirmation modal.
    await page.evaluate(() => {
      // The xterm helper-textarea's parent contains the terminal; the
      // socket itself isn't directly exposed, but dispatching a close on
      // the underlying connection is awkward in the page context. Use a
      // shortcut: type `exit` + Enter into the terminal so the real PTY
      // exits, the server sends `{type:"exit"}`, then closes the socket.
      const host = document.querySelector(".terminal-pane-host") as HTMLElement;
      const xtermHelper = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
      xtermHelper?.focus();
    });
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");

    // Pane disappears once the server's exit/close cascade completes.
    await expect(page.locator(".terminal-pane")).toHaveCount(0, { timeout: 5000 });
    // Panel hides because there are no panes left.
    await expect(page.locator("#terminal-panel")).toBeHidden();
    // No confirmation modal should ever have appeared.
    await expect(page.locator("#terminal-confirm")).toBeHidden();
  });

  test("keyboard toggle does NOT prompt confirmation", async ({ page }) => {
    await page.keyboard.press("Control+`");
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Control+`");
    // Panel hidden directly, no modal interaction.
    await expect(page.locator("#terminal-panel")).toBeHidden();
    await expect(page.locator("#terminal-confirm")).toBeHidden();
  });
});

test.describe("terminal display modes", () => {
  test("minimize collapses the panes; restore expands again", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    await page.locator("#terminal-minimize").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "minimized");
    await expect(page.locator("#terminal-panes")).toBeHidden();
    // The panel header itself stays visible.
    await expect(page.locator(".terminal-panel-header")).toBeVisible();

    await page.locator("#terminal-minimize").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "normal");
    await expect(page.locator("#terminal-panes")).toBeVisible();
  });

  test("minimize while right-docked rotates the header into a vertical strip", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    // Dock right, then minimize.
    await page.locator("#terminal-dock-toggle").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "right");
    await page.locator("#terminal-minimize").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "minimized");

    // Panel collapses to a narrow vertical strip (≤ ~40px wide).
    const panelBox = await page.locator("#terminal-panel").boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.width).toBeLessThanOrEqual(40);
    // Strip is taller than wide.
    expect(panelBox!.height).toBeGreaterThan(panelBox!.width * 4);

    // Header layout switches to column, title gets vertical writing-mode.
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".terminal-panel-header") as HTMLElement | null;
      const title = document.querySelector(".terminal-panel-title") as HTMLElement | null;
      const controls = document.querySelector(".terminal-panel-controls") as HTMLElement | null;
      if (!header || !title || !controls) return null;
      return {
        headerFlexDirection: getComputedStyle(header).flexDirection,
        titleWritingMode: getComputedStyle(title).writingMode,
        controlsFlexDirection: getComputedStyle(controls).flexDirection,
        titleTop: title.getBoundingClientRect().top,
        controlsTop: controls.getBoundingClientRect().top,
      };
    });
    expect(layout).not.toBeNull();
    expect(layout!.headerFlexDirection).toBe("column");
    expect(layout!.controlsFlexDirection).toBe("column");
    expect(layout!.titleWritingMode).toMatch(/vertical/);
    // Controls sit ABOVE the title in the rotated strip.
    expect(layout!.controlsTop).toBeLessThan(layout!.titleTop);

    // The restore-from-minimized icon points left (←), not up (^), in
    // right-dock because clicking it expands the panel leftward.
    const restoreVisibility = await page.evaluate(() => {
      const upGlyph = document.querySelector(".state-glyph-min-restore-up") as HTMLElement | null;
      const leftGlyph = document.querySelector(".state-glyph-min-restore-left") as HTMLElement | null;
      return {
        upDisplay: upGlyph ? getComputedStyle(upGlyph).display : null,
        leftDisplay: leftGlyph ? getComputedStyle(leftGlyph).display : null,
      };
    });
    expect(restoreVisibility.upDisplay).toBe("none");
    expect(restoreVisibility.leftDisplay).not.toBe("none");
  });

  test("fullscreen expands within the app; Esc exits", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    await page.locator("#terminal-fullscreen").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "fullscreen");
    // Sidebar remains visible (not a viewport-fullscreen overlay).
    await expect(page.locator(".sidebar")).toBeVisible();

    // Click into a pane so focus is in the panel, then press Esc.
    await page.locator(".terminal-pane-host").first().click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "normal");
  });
});

test.describe("terminal dock", () => {
  test("switching to right dock relocates the panel without remounting xterm", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    const sessionIdBefore = await page
      .locator(".terminal-pane")
      .first()
      .getAttribute("data-session-id");

    await page.locator("#terminal-dock-toggle").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "right");
    // The pane is the same DOM element with the same sessionId — xterm did
    // not remount.
    const sessionIdAfter = await page
      .locator(".terminal-pane")
      .first()
      .getAttribute("data-session-id");
    expect(sessionIdAfter).toBe(sessionIdBefore);
    expect(sessionIdAfter).not.toBeNull();

    // The minimize button's icon reflects the dock direction: `>` (collapse
    // rightward) when right-docked, `_` (collapse downward) when bottom.
    const rightDockGlyphs = await page.evaluate(() => {
      const down = document.querySelector(".state-glyph-min-collapse-down") as HTMLElement | null;
      const right = document.querySelector(".state-glyph-min-collapse-right") as HTMLElement | null;
      return {
        downDisplay: down ? getComputedStyle(down).display : null,
        rightDisplay: right ? getComputedStyle(right).display : null,
      };
    });
    expect(rightDockGlyphs.downDisplay).toBe("none");
    expect(rightDockGlyphs.rightDisplay).not.toBe("none");

    // Toggle back.
    await page.locator("#terminal-dock-toggle").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "bottom");

    const bottomDockGlyphs = await page.evaluate(() => {
      const down = document.querySelector(".state-glyph-min-collapse-down") as HTMLElement | null;
      const right = document.querySelector(".state-glyph-min-collapse-right") as HTMLElement | null;
      return {
        downDisplay: down ? getComputedStyle(down).display : null,
        rightDisplay: right ? getComputedStyle(right).display : null,
      };
    });
    expect(bottomDockGlyphs.rightDisplay).toBe("none");
    expect(bottomDockGlyphs.downDisplay).not.toBe("none");
  });
});

test.describe("terminal split", () => {
  test("split spawns additional panes with unique sessionIds", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-pane")).toHaveCount(1);

    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2);
    // Both panes should have their own xterm instance and a unique sessionId.
    await expect(page.locator(".terminal-pane-host .xterm")).toHaveCount(2, { timeout: 5000 });

    // Split a third time — well below the soft cap.
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(3);

    const ids = await page.locator(".terminal-pane").evaluateAll(els =>
      (els as HTMLElement[]).map(el => el.dataset.sessionId ?? ""),
    );
    expect(new Set(ids).size).toBe(3);
    // Below cap, split stays enabled.
    await expect(page.locator("#terminal-split")).toBeEnabled();
  });

  test("split control disables once the soft cap is reached", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });

    // Cap is 8 panes. We start at 1 and split until we hit it.
    for (let i = 1; i < 8; i += 1) {
      await page.locator("#terminal-split").click();
    }
    await expect(page.locator(".terminal-pane")).toHaveCount(8);
    await expect(page.locator("#terminal-split")).toBeDisabled();
  });

  test("a freshly-spawned pane becomes the active pane", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-pane[data-active='true']")).toHaveCount(1);
    const firstId = await page.locator(".terminal-pane[data-active='true']").getAttribute("data-session-id");

    // Split a new pane — it must take over as active.
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2);
    const activeAfterSplit = page.locator(".terminal-pane[data-active='true']");
    await expect(activeAfterSplit).toHaveCount(1);
    const newId = await activeAfterSplit.getAttribute("data-session-id");
    expect(newId).not.toBe(firstId);
    expect(newId).not.toBeNull();
  });

  test("closing the active pane activates the next visual neighbor", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    await page.locator("#terminal-split").click();
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(3);

    const idsBefore = await page.locator(".terminal-pane").evaluateAll(els =>
      (els as HTMLElement[]).map(el => el.dataset.sessionId ?? ""),
    );
    // After two splits, the third pane (rightmost) is active. Click into the
    // middle pane to make it active, then close it.
    await page.locator(".terminal-pane").nth(1).click();
    await expect(page.locator(".terminal-pane[data-active='true']")).toHaveAttribute("data-session-id", idsBefore[1]!);

    // Close middle. Successor is the next pane (rightmost), idsBefore[2].
    await page.locator(".terminal-pane").nth(1).locator(".terminal-pane-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.locator("#terminal-confirm-accept").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2);
    await expect(page.locator(".terminal-pane[data-active='true']")).toHaveAttribute("data-session-id", idsBefore[2]!);

    // Now close the active (rightmost) pane. Successor is the predecessor:
    // idsBefore[0] — only one left.
    await page.locator(".terminal-pane").nth(1).locator(".terminal-pane-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.locator("#terminal-confirm-accept").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(1);
    await expect(page.locator(".terminal-pane[data-active='true']")).toHaveAttribute("data-session-id", idsBefore[0]!);
  });

  test("split orientation matches dock", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2);

    // Bottom-dock → horizontal orientation.
    await expect(page.locator("#terminal-panes")).toHaveAttribute("data-orientation", "horizontal");

    await page.locator("#terminal-dock-toggle").click();
    await expect(page.locator("#terminal-panes")).toHaveAttribute("data-orientation", "vertical");
  });

  test("after resizing, closing a pane refills the panel without leaving a gap", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    await page.locator("#terminal-split").click();
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(3);
    await page.waitForTimeout(50);

    // Resize the FIRST resizer so panes A and B get inline flex:0 1 <px>
    // and pane C remains the absorber. This sets up the regressed case
    // where closing C used to leave panes A+B at locked widths and the
    // panel's leftover space stayed empty.
    const firstResizerBox = await page.locator(".terminal-pane-resizer").first().boundingBox();
    if (!firstResizerBox) throw new Error("first resizer not visible");
    await page.mouse.move(firstResizerBox.x + firstResizerBox.width / 2, firstResizerBox.y + firstResizerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstResizerBox.x + firstResizerBox.width / 2 - 60, firstResizerBox.y + firstResizerBox.height / 2, { steps: 5 });
    await page.mouse.up();

    // Close the absorber (last pane). This must trigger the panel-level
    // confirmation modal? No — per-pane close. Click the C pane's close.
    const lastPane = page.locator(".terminal-pane").nth(2);
    await lastPane.locator(".terminal-pane-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.locator("#terminal-confirm-accept").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2);

    // Sum of pane widths + resizer width must equal panes-container width
    // (within sub-pixel rounding). If the bug regresses, the surviving
    // panes keep their locked basis and the sum falls short.
    const layout = await page.evaluate(() => {
      const container = document.getElementById("terminal-panes")!;
      const panes = Array.from(document.querySelectorAll(".terminal-pane")) as HTMLElement[];
      const resizers = Array.from(document.querySelectorAll(".terminal-pane-resizer")) as HTMLElement[];
      return {
        containerWidth: container.getBoundingClientRect().width,
        paneWidthSum: panes.reduce((s, p) => s + p.getBoundingClientRect().width, 0),
        resizerWidthSum: resizers.reduce((s, r) => s + r.getBoundingClientRect().width, 0),
      };
    });
    expect(layout.paneWidthSum + layout.resizerWidthSum).toBeGreaterThan(layout.containerWidth - 2);

    // Close the second-to-last pane too. The last surviving pane must now
    // fill the container by itself.
    const newLastPane = page.locator(".terminal-pane").nth(1);
    await newLastPane.locator(".terminal-pane-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.locator("#terminal-confirm-accept").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(1);

    const finalLayout = await page.evaluate(() => {
      const container = document.getElementById("terminal-panes")!;
      const pane = document.querySelector(".terminal-pane") as HTMLElement;
      return {
        containerWidth: container.getBoundingClientRect().width,
        paneWidth: pane.getBoundingClientRect().width,
      };
    });
    expect(finalLayout.paneWidth).toBeGreaterThan(finalLayout.containerWidth - 2);
  });

  test("dragging the last resizer in 3-pane split moves only its two adjacent panes", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    // Build a 3-pane split — A | B | C in bottom-dock (horizontal).
    await page.locator("#terminal-split").click();
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(3);
    // Wait one tick so flex layout has settled before we measure.
    await page.waitForTimeout(50);

    const widthsBefore = await page.locator(".terminal-pane").evaluateAll(els =>
      (els as HTMLElement[]).map(el => el.getBoundingClientRect().width),
    );

    // Drag the LAST resizer (between B and C). Without the per-drag freeze
    // of non-adjacent panes, A would also shrink because flex:1 1 0 lets
    // the absorber and A share leftover space proportionally.
    const resizers = await page.locator(".terminal-pane-resizer").all();
    expect(resizers.length).toBe(2);
    const lastResizerBox = await resizers[1]!.boundingBox();
    if (!lastResizerBox) throw new Error("last resizer not visible");
    await page.mouse.move(lastResizerBox.x + lastResizerBox.width / 2, lastResizerBox.y + lastResizerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(lastResizerBox.x + lastResizerBox.width / 2 - 80, lastResizerBox.y + lastResizerBox.height / 2, { steps: 5 });
    await page.mouse.up();

    const widthsAfter = await page.locator(".terminal-pane").evaluateAll(els =>
      (els as HTMLElement[]).map(el => el.getBoundingClientRect().width),
    );

    // First pane (A) must NOT have moved; the user only touched B-C.
    expect(Math.abs(widthsAfter[0]! - widthsBefore[0]!)).toBeLessThan(2);
    // B (the second pane, `first` in the dragged pair) shrank by ~80px.
    expect(widthsAfter[1]!).toBeLessThan(widthsBefore[1]! - 50);
    // C (the third pane, the absorber) grew correspondingly.
    expect(widthsAfter[2]!).toBeGreaterThan(widthsBefore[2]! + 50);
  });

  test("inter-pane resizer adjusts pane sizes in both dock orientations", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2);

    // ---- Bottom-dock: horizontal split (panes side by side, drag X axis). ----
    const beforeBottom = await page.locator(".terminal-pane").evaluateAll(els =>
      (els as HTMLElement[]).map(el => el.getBoundingClientRect().width),
    );
    const rBoxBottom = await page.locator(".terminal-pane-resizer").first().boundingBox();
    if (!rBoxBottom) throw new Error("inter-pane resizer not visible (bottom dock)");
    await page.mouse.move(rBoxBottom.x + rBoxBottom.width / 2, rBoxBottom.y + rBoxBottom.height / 2);
    await page.mouse.down();
    await page.mouse.move(rBoxBottom.x + rBoxBottom.width / 2 + 100, rBoxBottom.y + rBoxBottom.height / 2, { steps: 5 });
    await page.mouse.up();
    const afterBottom = await page.locator(".terminal-pane").evaluateAll(els =>
      (els as HTMLElement[]).map(el => el.getBoundingClientRect().width),
    );
    expect(afterBottom[0]!).toBeGreaterThan(beforeBottom[0]! + 50);

    // ---- Right-dock: vertical split (panes stacked, drag Y axis). ----
    await page.locator("#terminal-dock-toggle").click();
    await expect(page.locator("#terminal-panes")).toHaveAttribute("data-orientation", "vertical");
    // Wait for layout to settle after dock change resets pane sizes.
    await page.waitForTimeout(100);
    const beforeRight = await page.locator(".terminal-pane").evaluateAll(els =>
      (els as HTMLElement[]).map(el => el.getBoundingClientRect().height),
    );
    const rBoxRight = await page.locator(".terminal-pane-resizer").first().boundingBox();
    if (!rBoxRight) throw new Error("inter-pane resizer not visible (right dock)");
    await page.mouse.move(rBoxRight.x + rBoxRight.width / 2, rBoxRight.y + rBoxRight.height / 2);
    await page.mouse.down();
    await page.mouse.move(rBoxRight.x + rBoxRight.width / 2, rBoxRight.y + rBoxRight.height / 2 + 60, { steps: 5 });
    await page.mouse.up();
    const afterRight = await page.locator(".terminal-pane").evaluateAll(els =>
      (els as HTMLElement[]).map(el => el.getBoundingClientRect().height),
    );
    expect(afterRight[0]!).toBeGreaterThan(beforeRight[0]! + 30);
  });
});
