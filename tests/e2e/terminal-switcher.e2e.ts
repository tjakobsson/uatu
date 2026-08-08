// Touch terminal switcher (add-terminal-auto-attach-switcher): touch mode
// renders exactly one pane at a time, so the keybar's switch action is the
// only way to reach the others, attach a detached session, take one over, or
// create a new terminal. iPad viewport — coarse pointer, wide — because the
// keybar is coarse-pointer-gated and the single-pane rule is UI-mode-gated.

import { expect, test } from "./fixtures";

async function bootTouchTerminal(
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
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
}

// Stage detached PTYs server-side: resources with no client holding them,
// exactly what a closed window leaves behind. Created from inside the page so
// the request carries the browser's Origin and auth cookie — the session REST
// surface refuses anything else.
async function stageSessions(
  page: import("@playwright/test").Page,
  count: number,
): Promise<string[]> {
  return page.evaluate(async total => {
    const ids: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const response = await fetch("/api/terminal/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      });
      if (!response.ok) throw new Error(`session create failed: ${response.status}`);
      ids.push(((await response.json()) as { id: string }).id);
      // Keep `createdAt` values distinct so attach order and the "newest
      // wins" active-pane rule are never decided by a tie.
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return ids;
  }, count);
}

const switchKey = "#terminal-keybar .terminal-keybar-switch";

test.describe("touch terminal switcher", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test("shows one pane at a time and switches between attached terminals", async ({
    page,
    context,
    request,
  }) => {
    await bootTouchTerminal(page, request);
    const staged = await stageSessions(page, 3);

    // Opening the Terminal tab auto-attaches all three, but only the active
    // one is on screen — three slivers on a tablet would be unusable.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
    await expect(page.locator(".terminal-pane[data-active]")).toHaveAttribute(
      "data-session-id",
      staged[2]!,
    );

    // The switcher lists every terminal: the visible one plus the two held
    // behind it.
    await page.locator(switchKey).click();
    await expect(page.locator("#terminal-switcher")).toBeVisible();
    await expect(page.locator(switchKey)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".terminal-switcher-row")).toHaveCount(3);
    await expect(
      page.locator('.terminal-switcher-row[data-state="visible"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('.terminal-switcher-row[data-state="attached-here"]'),
    ).toHaveCount(2);

    // Selecting a hidden terminal makes it the visible one; the sheet closes.
    await page
      .locator(`.terminal-switcher-row[data-session-id="${staged[0]!}"]`)
      .locator(".terminal-switcher-select")
      .click();
    await expect(page.locator("#terminal-switcher")).toBeHidden();
    await expect(page.locator(switchKey)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".terminal-pane[data-active]")).toHaveAttribute(
      "data-session-id",
      staged[0]!,
    );
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);

    // Still three panes: switching reveals, it never detaches.
    await expect(page.locator(".terminal-pane")).toHaveCount(3);
  });

  test("creates a new terminal from the switcher", async ({ page, context, request }) => {
    await bootTouchTerminal(page, request);
    await stageSessions(page, 1);

    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(1, { timeout: 10000 });

    await page.locator(switchKey).click();
    await page.locator(".terminal-switcher-new").click();
    await expect(page.locator("#terminal-switcher")).toBeHidden();
    await expect(page.locator(".terminal-pane")).toHaveCount(2, { timeout: 10000 });
    // The new terminal is the visible one, and it is the only visible one.
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
    await expect(page.locator(".terminal-pane-host").last()).toHaveAttribute(
      "data-terminal-ready",
      "true",
      { timeout: 10000 },
    );
  });

  test("a session held by another window needs an explicit Take over", async ({
    page,
    context,
    request,
  }) => {
    await bootTouchTerminal(page, request);

    // A second window holds a session — it stays open, so the session stays
    // attached and can never be auto-claimed.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.locator("#connection-state .connection-label")).toHaveText("Connected");
    await page2.locator("#touch-tab-terminal").click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 10000,
    });

    // Window 1 opens its terminal: nothing detached to claim, so the touch
    // decision surface is the switcher — never the desktop chooser.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator("#terminal-switcher")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".terminal-picker")).toHaveCount(0);
    await expect(page.locator(".terminal-pane")).toHaveCount(0);

    const row = page.locator('.terminal-switcher-row[data-state="attached-elsewhere"]');
    await expect(row).toHaveCount(1);
    // The row itself does nothing: transfer is the Take over action alone.
    await expect(row.locator(".terminal-switcher-select")).toBeDisabled();

    await row.locator(".terminal-switcher-takeover").click();
    await expect(page.locator("#terminal-switcher")).toBeHidden();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 10000,
    });

    // Window 2 parked with the take-back affordance — the ordinary takeover
    // contract, reached from the switcher.
    await expect(page2.locator(".terminal-taken")).toBeVisible({ timeout: 10000 });

    await page2.close();
  });

  test("Escape closes the switcher before it leaves the fullscreen terminal", async ({
    page,
    context,
    request,
  }) => {
    await bootTouchTerminal(page, request);
    await stageSessions(page, 1);

    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(1, { timeout: 10000 });

    await page.locator(switchKey).click();
    await expect(page.locator("#terminal-switcher")).toBeVisible();

    // First Escape: the sheet only. The terminal is still the active surface.
    await page.keyboard.press("Escape");
    await expect(page.locator("#terminal-switcher")).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "terminal");

    // Second Escape: now it means "leave the fullscreen terminal".
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
  });

  test("desktop mode renders every pane again", async ({ page, context, request }) => {
    await bootTouchTerminal(page, request);
    await stageSessions(page, 2);

    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2, { timeout: 10000 });
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);

    // Single-pane rendering is presentation only: the stored panes are all
    // still attached and desktop mode shows the split.
    await page.locator("#touch-tab-files").click();
    await page.locator("#ui-mode-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    await expect(page.locator(".terminal-pane")).toHaveCount(2);
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(2);
  });
});
