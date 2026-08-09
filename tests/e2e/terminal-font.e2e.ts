import { expect, test } from "./fixtures";

// Real-browser checks for the bundled-font behavior: the Hack Nerd Font
// Mono WOFF2 is served by /assets/fonts/ and the @font-face declaration in
// styles.css resolves to it (no local install required — Playwright's
// Chromium ships without Nerd Fonts). `.uatu.json` carries no font
// configuration; a legacy `terminal` block must leave the payload and the
// panel untouched.
//
// The first three tests are decoupled from the PTY backend so they exercise
// the static asset infrastructure even on hosts where Bun's PTY probe is
// unavailable. The legacy-block test does need the backend (it opens the
// panel after a /__e2e/reset that injects a `.uatu.json`).

test.describe("bundled-font infrastructure (no PTY needed)", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await page.goto("/");
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  });

  test.afterEach(async ({ request }) => {
    await request.post("/__e2e/reset");
  });

  test("the WOFF2 is reachable at the documented route", async ({ request }) => {
    const response = await request.get("/assets/fonts/HackNerdFontMono-Regular.woff2");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("font/woff2");
    expect(response.headers()["cache-control"] ?? "").toContain("immutable");
    const buffer = await response.body();
    // WOFF2 magic: 'wOF2' = 0x77 0x4F 0x46 0x32
    expect(buffer[0]).toBe(0x77);
    expect(buffer[1]).toBe(0x4f);
    expect(buffer[2]).toBe(0x46);
    expect(buffer[3]).toBe(0x32);
  });

  test("FontFace loads in the browser and document.fonts.check returns true", async ({ page }) => {
    await page.evaluate(async () => {
      // Force the font to be requested even when no terminal is open. The
      // @font-face is registered but only fetched when first used —
      // document.fonts.load() pulls it eagerly so the assertion is reliable.
      await document.fonts.load('14px "Hack Nerd Font Mono"');
      await document.fonts.ready;
    });
    const loaded = await page.evaluate(() =>
      document.fonts.check('14px "Hack Nerd Font Mono"'),
    );
    expect(loaded).toBe(true);
  });

  test("--terminal-font-family CSS variable leads with the bundled face", async ({ page }) => {
    // The xterm renderer pulls fontFamily from this CSS variable at attach
    // time (see src/terminal/client.ts). The variable IS readable from the
    // DOM, so we can verify the contract without depending on xterm's
    // canvas renderer state.
    const stack = await page.evaluate(() =>
      window.getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-family"),
    );
    expect(stack.toLowerCase()).toContain("hack nerd font mono");
    // The bundled face leads the stack so it wins over the OS monospace
    // fallbacks for both ASCII and icon glyphs.
    expect(stack.toLowerCase().split(",")[0]?.trim()).toContain("hack nerd font mono");
  });
});

test.describe("legacy .uatu.json terminal block", () => {
  test.afterEach(async ({ request }) => {
    await request.post("/__e2e/reset");
  });

  test("a legacy terminal block is not read and the panel mounts with the bundled default", async ({ page, request }) => {
    // The reset handler writes .uatu.json before re-creating the watch
    // session — see tests/e2e/server.ts.
    await request.post("/__e2e/reset", {
      data: { uatuConfig: { terminal: { fontFamily: "Courier New, monospace", fontSize: 18 } } },
    });

    const tokenResp = await request.get("/__e2e/terminal-token");
    const tokenBody = await tokenResp.json();
    if (!tokenBody.enabled) {
      test.skip(true, "terminal backend unavailable on this platform");
    }
    await page.goto(`/?t=${encodeURIComponent(tokenBody.token)}`);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    // The wire contract: /api/state carries no terminalConfig field even
    // when a legacy block is present in `.uatu.json`.
    const state = await page.evaluate(async () => {
      const response = await fetch("/api/state");
      return response.json();
    });
    expect("terminalConfig" in state).toBe(false);

    // The panel still mounts cleanly with the bundled default.
    await page.evaluate(() => {
      try {
        window.sessionStorage.removeItem("uatu:terminal-visible");
        window.localStorage.clear();
      } catch {
        // best-effort
      }
    });
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
  });
});
