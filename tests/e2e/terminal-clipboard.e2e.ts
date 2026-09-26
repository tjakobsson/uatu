import { expect, test } from "./fixtures";
import { openTerminal, paneHost, typeInTerminal } from "./terminal-helpers";

// Real-browser coverage for the OSC 52 clipboard bridge: a program running
// in the PTY copies by emitting `ESC ] 52 ; c ; <base64> BEL`, and the
// bridge writes the decoded text to the BROWSER's clipboard (which is the
// host clipboard when the uatu server runs in a container). Parse/handler
// coverage lives in the unit suite (src/terminal/clipboard.test.ts); these
// tests prove the PTY → xterm parser → navigator.clipboard leg end to end.

type Ctx = {
  page: import("@playwright/test").Page;
  request: import("@playwright/test").APIRequestContext;
  context: import("@playwright/test").BrowserContext;
};

// Same boot as terminal.e2e.ts.
async function bootTerminal({ page, request, context }: Ctx): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

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
  await typeInTerminal(page, `printf '\\033]52;c;%s\\007' '${data}'`);
}

test("an OSC 52 copy lands on the browser clipboard and shows the toast", async ({ page, request, context }) => {
  await bootTerminal({ page, request, context });
  await openTerminal(page);
  await seedClipboard(page, "sentinel-before");

  const payload = "osc52_e2e_payload";
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  await emitOsc52(page, encoded);

  const toast = page.locator(".terminal-copy-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(`Copied ${payload.length} characters from terminal`);
  expect(await readClipboard(page)).toBe(payload);
});

test("read query: never answered, never touches the clipboard", async ({ page, request, context }) => {
  await bootTerminal({ page, request, context });
  await openTerminal(page);
  await seedClipboard(page, "sentinel-query");

  await emitOsc52(page, "?");

  // Round-trip marker: the shell is healthy and — critically — its input
  // line was NOT polluted by an injected OSC 52 response (a terminal that
  // answered would have typed base64 garbage at the prompt).
  // printf assembles the marker, so the echoed command line cannot match.
  await typeInTerminal(page, "printf 'after_%s\\n' osc52_query");
  await expect(paneHost(page)).toContainText("after_osc52_query");

  await expect(page.locator(".terminal-copy-toast")).toHaveCount(0);
  expect(await readClipboard(page)).toBe("sentinel-query");
});
