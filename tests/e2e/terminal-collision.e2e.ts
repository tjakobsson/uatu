import { expect, test } from "./fixtures";

// Cross-window resource behavior: pane attachments are per-window, while the
// personal last-active PTY is only an inventory hint. A session another window
// holds is never claimed automatically — only an explicit Take over moves it —
// and a saved reference that lost its session reconciles into that same
// decision rather than retrying the attach.

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

async function openAndFocusTerminal(page: import("@playwright/test").Page): Promise<void> {
  const panel = page.locator("#terminal-panel");
  if (await panel.isHidden()) {
    await page.locator("#terminal-toggle").click();
  }
  await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
    timeout: 5000,
  });
  await page.evaluate(() => {
    const host = document.querySelector(".terminal-pane-host") as HTMLElement | null;
    const helper = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    helper?.focus();
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
  // Re-focus the CURRENT pane's textarea at type time: collision recovery
  // swaps the pane element, so focus grabbed at open time can point at a
  // disposed xterm whose keystrokes go nowhere.
  await page.evaluate(() => {
    const host = document.querySelector(".terminal-pane-host") as HTMLElement | null;
    const helper = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    helper?.focus();
  });
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

test.describe("terminal collision: a second window gets its own session", () => {
  test("second window reaches a shell with no token prompt; first window unaffected", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openAndFocusTerminal(page);
    await waitForPrompt(page);
    await typeLine(page, "UATU_WIN=one");

    // Second window shares credentials and personal state but not pane
    // attachments. Opening the panel must show inventory rather than attach.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.locator("#connection-state .connection-label")).toHaveText("Connected");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await expect(page2.locator(".terminal-picker-meta")).toContainText("attached elsewhere");
    await page2.locator(".terminal-picker-fresh").click();
    await openAndFocusTerminal(page2);
    await waitForPrompt(page2);

    // No paste-token form at any point in window 2.
    await expect(page2.locator(".terminal-auth")).toHaveCount(0);

    // Window 2 is a FRESH shell (window 1's variable is unset there).
    await typeLine(page2, "echo win2_${UATU_WIN}_ok");
    await expect(page2.locator(".terminal-pane-host")).toContainText("win2__ok", {
      timeout: 5000,
    });

    // Window 1 kept its session and shell state.
    await page.bringToFront();
    await page.evaluate(() => {
      const host = document.querySelector(".terminal-pane-host") as HTMLElement | null;
      const helper = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
      helper?.focus();
    });
    await typeLine(page, "echo win1_${UATU_WIN}_ok");
    await expect(page.locator(".terminal-pane-host")).toContainText("win1_one_ok", {
      timeout: 5000,
    });

    // Window 1's per-window attachment survives its own reload.
    await page.evaluate(() => {
      window.sessionStorage.setItem("uatu:terminal-visible", "1");
    });
    await page.reload();
    await expect(page.locator("#terminal-panel")).toBeVisible({ timeout: 3000 });
    await openAndFocusTerminal(page);
    await typeLine(page, "echo again_${UATU_WIN}_ok");
    await expect(page.locator(".terminal-pane-host")).toContainText("again_one_ok", {
      timeout: 5000,
    });

    await page2.close();
  });

  test("a saved reference claimed by another window reconciles once, without re-attaching", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openAndFocusTerminal(page);
    await waitForPrompt(page);
    await typeLine(page, "UATU_WIN=one");

    // The session id window 1 holds and has persisted for its own reload.
    const sessionId = await page.evaluate(
      () => (document.querySelector(".terminal-pane") as HTMLElement).dataset.sessionId!,
    );

    // Window 2 takes it over explicitly, so window 1's saved reference now
    // points at a resource another client holds.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.locator("#connection-state .connection-label")).toHaveText("Connected");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await page2.locator(".terminal-picker-attach").first().click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });

    // Window 1 reloads onto the stale reference. The upgrade is refused, and
    // the reconcile must NOT auto-attach it back: inventory reports the
    // session as held, so it lands on the chooser as a takeover decision.
    // This is what makes the reconcile self-limiting rather than a loop.
    await page.evaluate(() => {
      window.sessionStorage.setItem("uatu:terminal-visible", "1");
    });
    await page.reload();
    await expect(page.locator(".terminal-picker")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".terminal-picker-row")).toHaveCount(1);
    await expect(page.locator(".terminal-picker-meta").first()).toContainText(
      "attached elsewhere",
    );
    await expect(page.locator(".terminal-pane-host")).toHaveCount(0);

    // Window 2 keeps the session throughout — no silent ping-pong.
    await expect(page2.locator(".terminal-taken")).toHaveCount(0);
    const inventory = await context.request.get("/api/terminal/sessions");
    const body = await inventory.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe(sessionId);
    expect(body.sessions[0].attached).toBe(true);

    await page2.close();
  });

  test("genuine auth failure still shows the paste-token form", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);

    // Strip every credential: auth cookie (context-wide) and the
    // sessionStorage token captured from the ?t= boot URL.
    await context.clearCookies();
    await page.evaluate(() => {
      try {
        window.sessionStorage.removeItem("uatu:terminal-token");
        window.sessionStorage.removeItem("uatu:terminal-visible");
      } catch {
        // best-effort
      }
    });

    // Opening the terminal now fails the upgrade with a real 401; the
    // GET /api/auth probe confirms it and the paste-token form appears.
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-auth")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-auth-heading")).toHaveText("Reconnect to uatu");
  });
});
