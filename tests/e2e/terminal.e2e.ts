import { expect, test } from "@playwright/test";

// Light real-browser sanity for the terminal pane: toggle visibility,
// xterm renders, the WebSocket connects (i.e. the auth cookie reaches the
// server). Does NOT exercise PTY round-trips — `terminal-server.test.ts`
// covers stdin / stdout / disposeAll at the WS level, and adding a real
// shell to the e2e flow would be flaky in CI.

const SHARED_BEFORE = async ({ page, request }: { page: import("@playwright/test").Page; request: import("@playwright/test").APIRequestContext }) => {
  await request.post("/__e2e/reset");
  // The `request` fixture uses an isolated cookie context that doesn't
  // reach the `page` browser. Use the real user flow instead: hit the
  // /?t=<token> URL so app.ts's captureTerminalToken() runs and POSTs
  // /api/auth from the page context — that's what mints the cookie in
  // the browser context the rest of the test uses.
  const tokenResp = await request.get("/__e2e/terminal-token");
  const tokenBody = await tokenResp.json();
  if (!tokenBody.enabled) {
    test.skip(true, "terminal backend unavailable on this platform");
  }
  await page.goto(`/?t=${encodeURIComponent(tokenBody.token)}`);
  // Clear any persisted UI state from a previous test so the panel starts
  // hidden. Visibility lives in sessionStorage; we keep the URL-derived
  // token entry that captureTerminalToken just stashed (separate key) so
  // the WS path can use it as a fallback if the cookie isn't ready.
  await page.evaluate(() => {
    try {
      window.sessionStorage.removeItem("uatu:terminal-visible");
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  // Wait for /api/auth to settle (cookie set) before any test work runs.
  await page.waitForFunction(
    () =>
      document.cookie.includes("uatu_term=") || window.sessionStorage.getItem("uatu:terminal-token") !== null,
    undefined,
    { timeout: 5000 },
  ).catch(() => {
    // The cookie is HttpOnly so document.cookie won't see it — fall back to
    // sessionStorage check, which captureTerminalToken populates synchronously.
  });
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
};

test.beforeEach(SHARED_BEFORE);

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test.describe("terminal panel toggle", () => {
  test("toggle is visible only when the backend is enabled", async ({ page }) => {
    const toggle = page.locator("#terminal-toggle");
    await expect(toggle).toBeVisible();
    // The panel stays hidden until first toggle.
    await expect(page.locator("#terminal-panel")).toBeHidden();
  });

  test("clicking the toggle reveals the panel and connects xterm", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator("#terminal-panel")).toBeVisible();

    // xterm.js renders a `.xterm` element inside our host container as soon
    // as the panel attaches. Wait for it to appear.
    await expect(page.locator("#terminal-host .xterm")).toBeVisible({ timeout: 5000 });

    // The auth-failure form (#terminal-host .terminal-auth) must NOT appear:
    // its presence would mean the WebSocket upgrade was rejected and we
    // fell back to paste-token. With the cookie set by beforeEach, auth
    // should succeed silently.
    await expect(page.locator(".terminal-auth")).toHaveCount(0);
  });

  test("clicking close hides the panel and disposes xterm", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator("#terminal-host .xterm")).toBeVisible({ timeout: 5000 });

    await page.locator("#terminal-close").click();
    await expect(page.locator("#terminal-panel")).toBeHidden();
    // Detach() empties the host container; the .xterm element should be gone.
    await expect(page.locator("#terminal-host .xterm")).toHaveCount(0);
  });

  test("Ctrl+` keyboard shortcut toggles the panel", async ({ page }) => {
    // Bind hits the document-level keydown handler in app.ts.
    await page.keyboard.press("Control+`");
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await expect(page.locator("#terminal-host .xterm")).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Control+`");
    await expect(page.locator("#terminal-panel")).toBeHidden();
  });
});
