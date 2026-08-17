// The unavailable surface is the whole point of the chat-startup-diagnostics
// change: when OpenCode will not start, the report has to diagnose itself and
// the user has to be able to recover without restarting the workspace.

import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

async function bootWithFailedStartup(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  // Arm the failure before the page opens Chat, so the very first status()
  // the surface makes is the failing one.
  const armed = await request.post("/__e2e/chat", { data: { action: "failStartup" } });
  expect(armed.ok()).toBe(true);
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
}

test.describe("chat startup failure", () => {
  test("surfaces attributable diagnostics and recovers through retry", async ({ page, request }) => {
    await bootWithFailedStartup(page, request);

    const state = page.locator("#chat-state");
    await expect(state).toContainText("never accepted a health request");
    // The composer stays shut while chat cannot run.
    await expect(page.locator("#chat-composer")).toBeHidden();

    // Evidence a user can paste into a bug report without running anything.
    await page.locator(".chat-unavailable__details summary").click();
    const report = page.locator(".chat-unavailable__report");
    await expect(report).toContainText("/mnt/c/Users/x/AppData/Roaming/npm/opencode");
    await expect(report).toContainText("/home/linuxbrew/.linuxbrew/bin/opencode");
    await expect(report).toContainText("http://127.0.0.1:41823");
    await expect(report).toContainText("connection refused");
    await expect(report).toContainText("30.0s, 97 probes");

    // Retry clears the cached failure and brings the surface back without a
    // reload — the recovery path for someone who just fixed their PATH. The
    // composer stays hidden until a conversation exists (renderChooser's rule
    // for an empty inventory), so recovery is asserted through the surface
    // becoming usable rather than through the composer alone.
    await page.locator(".chat-unavailable__retry").click();
    await expect(page.locator(".chat-unavailable")).toHaveCount(0);
    await expect(state).not.toHaveClass(/is-error/);
    const newButton = page.getByRole("button", { name: "New" });
    await expect(newButton).toBeEnabled();
    await newButton.click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    await expect(page.locator("#chat-composer")).toBeVisible();
  });
});
