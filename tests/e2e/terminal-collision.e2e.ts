import { expect, test } from "./fixtures";
import { openTerminal, paneHost, typeInTerminal, waitForShell, waitForTerminalReady } from "./terminal-helpers";

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

test.describe("terminal collision: a second window gets its own session", () => {
  test("second window reaches a shell with no token prompt; first window unaffected", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await typeInTerminal(page, "UATU_WIN=one");

    // Second window shares credentials and personal state but not pane
    // attachments. Opening the panel must show inventory rather than attach.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.locator("#connection-state .connection-label")).toHaveText("Connected");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-picker")).toBeVisible();
    await expect(page2.locator(".terminal-picker-meta")).toContainText("attached elsewhere");
    await page2.locator(".terminal-picker-fresh").click();
    await waitForShell(page2);

    // No paste-token form at any point in window 2.
    await expect(page2.locator(".terminal-auth")).toHaveCount(0);

    // Window 2 is a FRESH shell (window 1's variable is unset there).
    await typeInTerminal(page2, "echo win2_${UATU_WIN}_ok");
    await expect(paneHost(page2)).toContainText("win2__ok");

    // Window 1 kept its session and shell state.
    await page.bringToFront();
    await typeInTerminal(page, "echo win1_${UATU_WIN}_ok");
    await expect(paneHost(page)).toContainText("win1_one_ok");

    // Window 1's per-window attachment survives its own reload.
    await page.evaluate(() => {
      window.sessionStorage.setItem("uatu:terminal-visible", "1");
    });
    await page.reload();
    await expect(page.locator("#terminal-panel")).toBeVisible();
    // The restored pane paints before its socket is live; wait for the shell.
    await waitForShell(page);
    await typeInTerminal(page, "echo again_${UATU_WIN}_ok");
    await expect(paneHost(page)).toContainText("again_one_ok");

    await page2.close();
  });

  test("a saved reference claimed by another window reconciles once, without re-attaching", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await typeInTerminal(page, "UATU_WIN=one");

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
    await expect(page2.locator(".terminal-picker")).toBeVisible();
    await page2.locator(".terminal-picker-attach").first().click();
    await waitForTerminalReady(page2);

    // Window 1 reloads onto the stale reference. The upgrade is refused, and
    // recovery must NOT auto-attach it back: inventory reports the session as
    // held for the whole recovery window, so the pane parks on an explicit
    // takeover decision, visible in place. This is what makes recovery
    // self-limiting rather than a loop.
    await page.evaluate(() => {
      window.sessionStorage.setItem("uatu:terminal-visible", "1");
    });
    await page.reload();
    await expect(page.locator("#terminal-panel")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".terminal-occupied")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".terminal-occupied-takeover")).toBeVisible();
    await expect(page.locator(".terminal-pane-host .xterm")).toHaveCount(0);

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
    await expect(page.locator(".terminal-auth")).toBeVisible();
    await expect(page.locator(".terminal-auth-heading")).toHaveText("Reconnect to uatu");
  });
});
