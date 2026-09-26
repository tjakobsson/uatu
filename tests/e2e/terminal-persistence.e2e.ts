import { expect, test } from "./fixtures";
import { openTerminal, paneHost, typeInTerminal, waitForShell } from "./terminal-helpers";

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

// `echo got_${NAME}_end` prints `got_<value>_end` in the same shell and
// `got__end` in a fresh one — no knowledge of the prompt required.

test.describe("terminal persistence: detached PTYs survive, confirmed close kills", () => {
  test("reload reattaches to the same still-running shell", async ({ page, request }) => {
    await bootWithTerminalCookie(page, request);
    // Proves the round trip works, then stash state in the shell process.
    await openTerminal(page);
    await typeInTerminal(page, "UATU_PERSIST=alive_across_reload");

    // Auto-restore the panel on reload (production storage + value).
    await page.evaluate(() => {
      window.sessionStorage.setItem("uatu:terminal-visible", "1");
    });
    await page.reload();

    await expect(page.locator("#terminal-panel")).toBeVisible();
    // The restored pane paints its old screen before the reattached socket
    // is live; typing before then would be dropped.
    await waitForShell(page);

    // Same shell process → the variable survives the reload.
    await typeInTerminal(page, "echo got_${UATU_PERSIST}_end");
    await expect(paneHost(page)).toContainText("got_alive_across_reload_end");
  });

  test("confirmed close kills the shell; the next open gets a fresh one", async ({
    page,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await typeInTerminal(page, "UATU_PERSIST=should_not_survive");

    // Confirmed close: × → modal → accept. This is the ONLY user path that
    // terminates the PTY (close code 4001).
    await page.locator("#terminal-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.locator("#terminal-confirm-accept").click();
    await expect(page.locator("#terminal-panel")).toBeHidden();

    // Reopen: a fresh pane, a fresh shell — the variable must be gone.
    await openTerminal(page);
    await typeInTerminal(page, "echo got_${UATU_PERSIST}_end");
    await expect(paneHost(page)).toContainText("got__end");
  });
});
