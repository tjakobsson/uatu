import { expect, test } from "./fixtures";

// Real-browser coverage for the OSC 52 clipboard bridge: a program running
// in the PTY copies by emitting `ESC ] 52 ; c ; <base64> BEL`, and the
// bridge writes the decoded text to the BROWSER's clipboard (which is the
// host clipboard when the uatu server runs in a container). Policy matrix
// lives in the unit suite (src/terminal/clipboard.test.ts); these tests
// prove the PTY → xterm parser → navigator.clipboard leg end to end.

type Ctx = {
  page: import("@playwright/test").Page;
  request: import("@playwright/test").APIRequestContext;
  context: import("@playwright/test").BrowserContext;
};

// Same boot as terminal.e2e.ts, parameterized on the `.uatu.json` the reset
// handler writes before re-loading terminal config.
async function bootWithConfig(
  { page, request, context }: Ctx,
  uatuConfig?: unknown,
): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.post("/__e2e/reset", uatuConfig ? { data: { uatuConfig } } : undefined);
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

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

// Open the panel, wait for the prompt, and focus xterm's hidden textarea so
// page.keyboard events reach the PTY. Typing before the shell has printed a
// prompt races its init (zsh line-editor setup eats or garbles input), so
// poll the rows DOM for rendered content first.
async function openTerminal(page: Ctx["page"]): Promise<void> {
  await page.locator("#terminal-toggle").click();
  await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
  const rows = page.locator(".terminal-pane-host .xterm-rows > div");
  await expect
    .poll(
      async () => {
        const texts = await rows.allTextContents();
        return texts.some(text => text.trim().length > 0);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  // A settled prompt can still be mid-redraw (multi-line prompts); give the
  // shell a beat after first paint before sending keystrokes.
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const helper = document.querySelector<HTMLTextAreaElement>(
      ".terminal-pane-host .xterm-helper-textarea",
    );
    helper?.focus();
  });
}

async function seedClipboard(page: Ctx["page"], value: string): Promise<void> {
  await page.evaluate(text => navigator.clipboard.writeText(text), value);
}

function readClipboard(page: Ctx["page"]): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

// Emit an OSC 52 sequence from inside the shell. printf interprets \033/\007,
// so the escape bytes are produced by the PTY-side program — exactly the path
// a TUI's copy takes.
async function emitOsc52(page: Ctx["page"], data: string): Promise<void> {
  await page.keyboard.type(`printf '\\033]52;c;%s\\007' '${data}'`);
  await page.keyboard.press("Enter");
}

test("notify (default): an OSC 52 copy lands on the browser clipboard and shows the toast", async ({ page, request, context }) => {
  await bootWithConfig({ page, request, context });
  await openTerminal(page);
  await seedClipboard(page, "sentinel-before");

  const payload = "osc52_e2e_payload";
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  await emitOsc52(page, encoded);

  const toast = page.locator(".terminal-copy-toast");
  await expect(toast).toBeVisible({ timeout: 5000 });
  await expect(toast).toContainText(`Copied ${payload.length} characters from terminal`);
  expect(await readClipboard(page)).toBe(payload);
});

test("off: the sequence is ignored — no toast, clipboard untouched", async ({ page, request, context }) => {
  await bootWithConfig({ page, request, context }, { terminal: { clipboard: "off" } });
  await openTerminal(page);
  await seedClipboard(page, "sentinel-off");

  const encoded = Buffer.from("must_not_copy", "utf8").toString("base64");
  await emitOsc52(page, encoded);

  // Round-trip marker proves the PTY processed our input past the sequence.
  const marker = "after_osc52_off";
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press("Enter");
  await expect(page.locator(".terminal-pane-host")).toContainText(marker, { timeout: 5000 });

  await expect(page.locator(".terminal-copy-toast")).toHaveCount(0);
  expect(await readClipboard(page)).toBe("sentinel-off");
});

test("confirm: nothing is written until the toast's Copy button is clicked", async ({ page, request, context }) => {
  await bootWithConfig({ page, request, context }, { terminal: { clipboard: "confirm" } });
  await openTerminal(page);
  await seedClipboard(page, "sentinel-confirm");

  const payload = "needs_a_click";
  await emitOsc52(page, Buffer.from(payload, "utf8").toString("base64"));

  const toast = page.locator(".terminal-copy-toast");
  await expect(toast).toBeVisible({ timeout: 5000 });
  await expect(toast).toContainText(`Terminal wants to copy ${payload.length} characters`);
  // Held, not written.
  expect(await readClipboard(page)).toBe("sentinel-confirm");

  await toast.locator(".terminal-copy-toast-copy").click();
  await expect(toast).toContainText(`Copied ${payload.length} characters from terminal`);
  expect(await readClipboard(page)).toBe(payload);
});

test("read query: never answered, never touches the clipboard", async ({ page, request, context }) => {
  await bootWithConfig({ page, request, context });
  await openTerminal(page);
  await seedClipboard(page, "sentinel-query");

  await emitOsc52(page, "?");

  // Round-trip marker: the shell is healthy and — critically — its input
  // line was NOT polluted by an injected OSC 52 response (a terminal that
  // answered would have typed base64 garbage at the prompt).
  const marker = "after_osc52_query";
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press("Enter");
  await expect(page.locator(".terminal-pane-host")).toContainText(marker, { timeout: 5000 });

  await expect(page.locator(".terminal-copy-toast")).toHaveCount(0);
  expect(await readClipboard(page)).toBe("sentinel-query");
});
