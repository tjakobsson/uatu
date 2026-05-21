import { expect, test } from "./fixtures";

// Regression coverage for fix-terminal-lifecycle-resilience. Each test
// exercises one of the three bugs the change addresses:
//   #1 click-to-404 must not tear down the SPA's WebSockets
//   #2 refresh on a deep-linked URL must not throw on the WebSocket builder
//   #3 first paint after refresh must render buffered output without resize
//
// Setup parity with terminal.e2e.ts: hit /?t=<token> so the page-side
// captureTerminalToken() POSTs /api/auth and the cookie is minted in the
// browser context. Skip the suite if the terminal backend is unavailable
// on this platform.

async function bootWithTerminalCookie(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  resetBody?: Record<string, unknown>,
): Promise<void> {
  await request.post("/__e2e/reset", resetBody ? { data: resetBody } : undefined);
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

test.describe("terminal lifecycle: SPA-level navigation survives", () => {
  test("clicking a same-origin link with no matching doc keeps the terminal alive", async ({
    page,
    request,
  }) => {
    // Seed an extra fixture file that contains a markdown link to a path
    // we know is not in the index. The cross-doc anchor handler must
    // intercept that click and route it through the in-app empty state
    // rather than letting the browser navigate to a hard 404 (which would
    // tear down the SPA and every WebSocket the SPA owns).
    await bootWithTerminalCookie(page, request, {
      extras: {
        "linker.md": "# Linker\n\nSee [the missing one](really-not-a-doc.md).\n",
      },
    });

    // Wait for the seeded file to appear in the tree. The tree renders
    // inside a shadow DOM; Playwright's CSS locator pierces it but raw
    // document.querySelector does not — use the locator API.
    await expect(page.locator('[data-item-path="linker.md"]')).toBeVisible({
      timeout: 5000,
    });

    // Show the terminal and capture the host element so we can verify it
    // survives the click without being torn down.
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });
    const xtermHandle = await page
      .locator(".terminal-pane-host .xterm")
      .first()
      .elementHandle();

    // Navigate to the linker doc via the tree (no full-page navigation,
    // so the terminal stays attached).
    await page.locator('[data-item-path="linker.md"]').click();
    await expect(page.locator("#preview-path")).toHaveText("linker.md");

    // Click the in-preview anchor with the missing target. Before the
    // fix this triggered a real browser navigation → server 404 → SPA
    // tear-down → all WebSockets dropped. After the fix the click is
    // intercepted and routes through the in-app empty state.
    await page.locator("#preview a", { hasText: "the missing one" }).click();

    // The in-app empty state is shown and the URL bar reflects the
    // unresolved path.
    await expect(page.locator("#preview-title")).toHaveText("Document not found");
    await expect(page).toHaveURL(/really-not-a-doc\.md$/);

    // The terminal is still attached. Same xterm node in DOM, panel
    // still visible — no SPA reboot occurred.
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible();
    const stillAttached = await page.evaluate(
      el => document.body.contains(el),
      xtermHandle,
    );
    expect(stillAttached).toBe(true);
  });

  test("deep-link refresh with a URL fragment does not throw on WebSocket construction", async ({
    page,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);

    // Open the terminal so visibility is genuinely persisted by the
    // production write path (setVisible → writeTerminalVisiblePreference).
    // We then reload to exercise the auto-attach path.
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });

    // Get the URL into the deep-link shape (path + fragment) WITHOUT a
    // full page navigation. replaceState updates the URL bar; page.reload()
    // then re-fetches that URL — triggering the auto-restore path with a
    // fragment in window.location.href, which is the exact regression site.
    await page.evaluate(() => {
      window.history.replaceState(null, "", "/README.md#user-content-some-fragment");
    });

    // Capture unhandled rejections + console errors during the reload.
    // Bug #3 surfaced as "Unhandled Promise Rejection: SyntaxError ...
    // Fragment identifiers are not allowed in WebSocket URLs."
    const consoleErrors: string[] = [];
    page.on("console", message => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    const pageErrors: string[] = [];
    page.on("pageerror", error => {
      pageErrors.push(error.message);
    });

    await page.reload();

    // Wait for the new page to settle: SSE connection up means the SPA has
    // booted, fetched /api/state, and invoked setupTerminalPanel. That's
    // when the auto-restore path runs.
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected", {
      timeout: 10000,
    });

    // The terminal auto-restores via setVisible(true) on boot. Without the
    // fix this never happened because the WebSocket constructor threw
    // SyntaxError on the fragment-bearing URL, which surfaced as an
    // unhandled promise rejection during boot.
    await expect(page.locator("#terminal-panel")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });

    const offendingConsole = consoleErrors.filter(message =>
      /WebSocket|Fragment identifier|fragment/i.test(message),
    );
    const offendingPage = pageErrors.filter(message =>
      /WebSocket|Fragment identifier|fragment/i.test(message),
    );
    expect(offendingConsole).toEqual([]);
    expect(offendingPage).toEqual([]);
  });

  test("first paint after refresh shows a fitted terminal grid without a user-initiated resize", async ({
    page,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);

    // Open the terminal and type a marker so we know the PTY round-trip
    // is working before the reload.
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });
    await page.evaluate(() => {
      const host = document.querySelector(".terminal-pane-host") as HTMLElement | null;
      const xtermHelper = host?.querySelector(".xterm-helper-textarea") as
        | HTMLTextAreaElement
        | null;
      xtermHelper?.focus();
    });
    const marker = "echoed_marker_uatu_terminal_lifecycle";
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".terminal-pane-host")).toContainText(marker, {
      timeout: 5000,
    });

    // Seed visibility so the panel auto-restores on reload. Use the
    // production storage and value (sessionStorage, "1").
    await page.evaluate(() => {
      window.sessionStorage.setItem("uatu:terminal-visible", "1");
    });

    // Reload. Without the deferred-fit fix the panel restored with a
    // 0-cell xterm measurement and stayed visually empty until a manual
    // resize.
    await page.reload();

    // The terminal panel auto-restores. Pane host + xterm are present
    // promptly, without any resize event being fired by the test.
    await expect(page.locator("#terminal-panel")).toBeVisible({ timeout: 3000 });
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 3000,
    });

    // Visual-rendering assertion (the actual user-visible bug): xterm's
    // `.xterm-rows` DOM mirrors the canvas. If xterm initialized with a
    // degenerate cell measurement, the rows DOM ends up empty (zero rows
    // or all rows blank) until a manual resize forces a re-measure. Wait
    // for the rows to contain SOME visible content — either a shell
    // prompt from a freshly-spawned PTY, or replayed scrollback from a
    // reattached PTY. Without the fix the row text would stay empty.
    const rowsLocator = page.locator(".terminal-pane-host .xterm-rows > div");
    await expect
      .poll(
        async () => {
          const texts = await rowsLocator.allTextContents();
          // Any non-whitespace character across any row counts as
          // "rendered". This catches both fresh-prompt and replayed cases
          // without requiring the test to know what the prompt looks like.
          return texts.some(text => text.trim().length > 0);
        },
        { timeout: 5000, message: "xterm rows must contain rendered content after refresh" },
      )
      .toBe(true);

    // Also assert the grid was sized to the panel, not the degenerate 1-row
    // measurement the bug produces.
    const rowCount = await rowsLocator.count();
    expect(rowCount).toBeGreaterThan(5);
  });
});
