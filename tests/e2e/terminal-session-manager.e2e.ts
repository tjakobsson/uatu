import { expect, test } from "./fixtures";

// Coverage for add-terminal-session-manager: the session inventory, the
// pane-spawn picker, attach-with-takeover (close code 4410 parks the losing
// pane with a take-back action), and kill-from-picker.

async function bootWithTerminalCookie(
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
}

async function openTerminal(page: import("@playwright/test").Page): Promise<void> {
  const panel = page.locator("#terminal-panel");
  if (await panel.isHidden()) {
    await page.locator("#terminal-toggle").click();
  }
  await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
    timeout: 5000,
  });
}

async function waitForPrompt(page: import("@playwright/test").Page): Promise<void> {
  const rows = page.locator(".terminal-pane-host .xterm-rows > div");
  await expect
    .poll(
      async () => {
        const texts = await rows.allTextContents();
        return texts.some(text => text.trim().length > 0);
      },
      { timeout: 5000, message: "shell prompt must render before typing" },
    )
    .toBe(true);
}

async function typeLine(page: import("@playwright/test").Page, line: string): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector(".terminal-pane-host") as HTMLElement | null;
    const helper = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    helper?.focus();
  });
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

test.describe("terminal session manager", () => {
  test("orphaned session is recoverable via the split picker; kill removes entries", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    // First open with a clean server: no picker, straight to a shell.
    await openTerminal(page);
    await expect(page.locator(".terminal-picker")).toHaveCount(0);
    await waitForPrompt(page);

    // Window 2 collides on the hinted id, recovers a fresh session, stashes
    // a marker in it, then closes for good — orphaning that session.
    const page2 = await context.newPage();
    await page2.goto("/");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });
    await expect
      .poll(
        async () => {
          const texts = await page2
            .locator(".terminal-pane-host .xterm-rows > div")
            .allTextContents();
          return texts.some(text => text.trim().length > 0);
        },
        { timeout: 5000 },
      )
      .toBe(true);
    await page2.evaluate(() => {
      const host = document.querySelector(".terminal-pane-host") as HTMLElement | null;
      const helper = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
      helper?.focus();
    });
    await page2.keyboard.type("UATU_ORPHAN=survivor");
    await page2.keyboard.press("Enter");
    // Ensure the variable landed before the abrupt close.
    await page2.keyboard.type("echo staged_${UATU_ORPHAN}_ok");
    await page2.keyboard.press("Enter");
    await expect(page2.locator(".terminal-pane-host")).toContainText("staged_survivor_ok", {
      timeout: 5000,
    });
    await page2.close();

    // Window 1 splits: the picker lists the orphaned session (its own pane
    // is filtered out).
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-picker-row")).toHaveCount(1);
    await expect(page.locator(".terminal-picker-meta")).toContainText("detached");

    // Attach: the new pane is the orphaned shell, state intact.
    await page.locator(".terminal-picker-attach").click();
    await expect(page.locator(".terminal-pane-host")).toHaveCount(2);
    const secondPane = page.locator(".terminal-pane-host").nth(1);
    await expect(secondPane.locator(".xterm")).toBeVisible({ timeout: 5000 });
    await page.evaluate(() => {
      const hosts = document.querySelectorAll(".terminal-pane-host");
      const helper = hosts[1]?.querySelector(".xterm-helper-textarea") as
        | HTMLTextAreaElement
        | null;
      helper?.focus();
    });
    await page.keyboard.type("echo got_${UATU_ORPHAN}_end");
    await page.keyboard.press("Enter");
    await expect(secondPane).toContainText("got_survivor_end", { timeout: 5000 });
  });

  test("takeover parks the losing pane; take-back reverses it", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await waitForPrompt(page);
    await typeLine(page, "UATU_OWNER=window1");
    await typeLine(page, "echo staged_${UATU_OWNER}_ok");
    await expect(page.locator(".terminal-pane-host")).toContainText("staged_window1_ok", {
      timeout: 5000,
    });

    // Window 2: fresh tab, collide → recover fresh shell, then split and
    // take over window 1's session from the picker.
    const page2 = await context.newPage();
    await page2.goto("/");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });
    await page2.locator("#terminal-split").click();
    await expect(page2.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await expect(page2.locator(".terminal-picker-meta").first()).toContainText(
      "attached elsewhere",
    );
    await page2.locator(".terminal-picker-attach").first().click();

    // Window 2 now owns the session — the marker variable proves identity.
    const takenPane = page2.locator(".terminal-pane-host").nth(1);
    await expect(takenPane.locator(".xterm")).toBeVisible({ timeout: 5000 });
    await page2.evaluate(() => {
      const hosts = document.querySelectorAll(".terminal-pane-host");
      const helper = hosts[1]?.querySelector(".xterm-helper-textarea") as
        | HTMLTextAreaElement
        | null;
      helper?.focus();
    });
    await page2.keyboard.type("echo taken_${UATU_OWNER}_ok");
    await page2.keyboard.press("Enter");
    await expect(takenPane).toContainText("taken_window1_ok", { timeout: 5000 });

    // Window 1's pane parked with the notice and take-back action.
    await expect(page.locator(".terminal-taken")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-taken-heading")).toHaveText(
      "Attached in another window",
    );

    // Take back: window 1 reattaches, window 2's pane parks.
    await page.locator(".terminal-taken-takeback").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });
    await typeLine(page, "echo back_${UATU_OWNER}_ok");
    await expect(page.locator(".terminal-pane-host")).toContainText("back_window1_ok", {
      timeout: 5000,
    });
    await expect(page2.locator(".terminal-taken")).toBeVisible({ timeout: 5000 });

    await page2.close();
  });

  test("kill from the picker removes the session; empty inventory skips the picker", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await waitForPrompt(page);

    // Orphan a second session (same recipe as above, minimal). Wait for the
    // recovered shell to render a prompt — closing before the collision
    // recovery finishes would orphan nothing.
    const page2 = await context.newPage();
    await page2.goto("/");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });
    await expect
      .poll(
        async () => {
          const texts = await page2
            .locator(".terminal-pane-host .xterm-rows > div")
            .allTextContents();
          return texts.some(text => text.trim().length > 0);
        },
        { timeout: 5000 },
      )
      .toBe(true);
    await page2.close();

    // Split → picker lists the orphan → kill it → picker falls through to a
    // fresh shell automatically (nothing left to offer).
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-picker-row")).toHaveCount(1);
    await page.locator(".terminal-picker-kill").click();
    await expect(page.locator(".terminal-picker")).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator(".terminal-pane-host")).toHaveCount(2);

    // The inventory no longer contains the killed session: only this
    // window's two panes remain. `context.request` shares the browser's
    // HttpOnly auth cookie (the standalone `request` fixture does not).
    const inventory = await context.request.get("/api/terminal/sessions");
    expect(inventory.status()).toBe(200);
    const body = await inventory.json();
    expect(body.sessions).toHaveLength(2);
  });
});
