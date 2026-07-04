import { expect, test } from "./fixtures";

// Coverage for persist-detached-pty-sessions: a disconnect (reload, tab
// close, sleep) detaches the PTY but leaves it running for a later
// reattach; only the confirmed pane close (WebSocket close code 4001)
// kills the shell. Shell-state probes distinguish the two: a variable set
// before the disconnect is still set after a reattach (same shell) and
// gone after a confirmed close (fresh shell).
//
// Setup parity with terminal.e2e.ts / terminal-lifecycle.e2e.ts: hit
// /?t=<token> so the page-side captureTerminalToken() POSTs /api/auth and
// the cookie is minted. Skip when the PTY backend is unavailable.

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

// Open the panel (if hidden), wait for xterm, and focus its hidden textarea
// so keyboard.type() reaches the PTY.
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

// Type a probe that expands a shell variable and assert on the expansion.
// `echo got_${NAME}_end` prints `got_<value>_end` in the same shell and
// `got__end` in a fresh one — no knowledge of the prompt required.
async function typeLine(page: import("@playwright/test").Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

// Wait for the shell to draw its prompt before typing. Keystrokes sent while
// the shell is still initializing (e.g. zsh instant-prompt) can be consumed
// or echoed garbled, so a freshly-spawned pane isn't type-safe until some
// non-whitespace content has rendered.
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

test.describe("terminal persistence: detached PTYs survive, confirmed close kills", () => {
  test("reload reattaches to the same still-running shell", async ({ page, request }) => {
    await bootWithTerminalCookie(page, request);
    await openAndFocusTerminal(page);
    await waitForPrompt(page);

    // Prove the round-trip works, then stash state in the shell process.
    await typeLine(page, "echo pre_reload_marker");
    await expect(page.locator(".terminal-pane-host")).toContainText("pre_reload_marker", {
      timeout: 5000,
    });
    await typeLine(page, "UATU_PERSIST=alive_across_reload");

    // Auto-restore the panel on reload (production storage + value).
    await page.evaluate(() => {
      window.sessionStorage.setItem("uatu:terminal-visible", "1");
    });
    await page.reload();

    await expect(page.locator("#terminal-panel")).toBeVisible({ timeout: 3000 });
    await openAndFocusTerminal(page);

    // Same shell process → the variable survives the reload.
    await typeLine(page, "echo got_${UATU_PERSIST}_end");
    await expect(page.locator(".terminal-pane-host")).toContainText(
      "got_alive_across_reload_end",
      { timeout: 5000 },
    );
  });

  test("confirmed close kills the shell; the next open gets a fresh one", async ({
    page,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openAndFocusTerminal(page);
    await waitForPrompt(page);

    await typeLine(page, "echo pre_close_marker");
    await expect(page.locator(".terminal-pane-host")).toContainText("pre_close_marker", {
      timeout: 5000,
    });
    await typeLine(page, "UATU_PERSIST=should_not_survive");

    // Confirmed close: × → modal → accept. This is the ONLY user path that
    // terminates the PTY (close code 4001).
    await page.locator("#terminal-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.locator("#terminal-confirm-accept").click();
    await expect(page.locator("#terminal-panel")).toBeHidden();

    // Reopen: a fresh pane, a fresh shell — the variable must be gone.
    await openAndFocusTerminal(page);
    await waitForPrompt(page);
    await typeLine(page, "echo got_${UATU_PERSIST}_end");
    await expect(page.locator(".terminal-pane-host")).toContainText("got__end", {
      timeout: 5000,
    });
  });
});
