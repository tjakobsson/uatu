// The live-connection recovery path, driven the way a phone actually breaks
// it: the stream fails, the page is suspended and resumed, and the app has to
// come back on its own. Both cases are deterministic — the interruption is a
// refused request, and the resume is the lifecycle event the browser fires,
// not a wall-clock wait.

import type { APIRequestContext, Page } from "@playwright/test";
import { promises as fs } from "node:fs";

import { expect, standardBeforeEach, test } from "./fixtures";
import { openChatPanel } from "./chat-helpers";
import { workspacePath } from "./config";
import { treeRow } from "./tree-helpers";

// A resume signal the page cannot distinguish from a real one.
async function resumePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);
  });
}

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test.describe("document channel recovery", () => {
  test.beforeEach(async ({ page, request }) => {
    await standardBeforeEach(page, request);
  });

  test("an interrupted stream reads Reconnecting, then recovers current state on resume without a reload", async ({ page, request }) => {
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    // Every attempt to (re)open the event stream is refused from here on. The
    // network-restored signal makes the client install a fresh stream, which
    // is what walks it into the refusal — the shape of a vanished path.
    await page.route("**/api/events*", route => route.abort());
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.locator("#connection-state .connection-label")).toHaveText("Reconnecting", { timeout: 15_000 });
    await expect(page.locator("#connection-state")).toHaveClass(/is-reconnecting/);

    // The workspace changes while the page is out of touch: a new file, and an
    // edit to the very document being previewed.
    await fs.writeFile(workspacePath("recovered.md"), "# Recovered\n\nWritten during the gap.\n", "utf8");
    await fs.writeFile(workspacePath("README.md"), "# README\n\nEdited while the page was suspended.\n", "utf8");
    await expect(treeRow(page, "recovered.md")).toHaveCount(0);
    await expect(page.locator("#preview")).not.toContainText("Edited while the page was suspended");

    // Wait for the workspace itself to have noticed, so the assertion below is
    // about the client converging and not about watcher latency.
    await expect.poll(
      async () => {
        const state = await request.get("/api/state?compareTarget=base&scope=folder").then(r => r.json());
        return (state.roots as { docs: unknown[] }[]).flatMap(group => group.docs).length;
      },
      { timeout: 15_000 },
    ).toBe(19);

    // A wake-up while the stream is STILL refused. Only the reconciliation can
    // deliver here, which is the point: the edited document arrives with no
    // `changedId`, and once these roots are stored the replacement stream's
    // first frame sees no mtime difference either — so if the reconciliation
    // does not reload the preview, nothing ever will.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(treeRow(page, "recovered.md")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#preview")).toContainText("Edited while the page was suspended");
    // Transport is genuinely still down, and the indicator says so.
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Reconnecting");

    // The path comes back and the page resumes from the back/forward cache.
    await page.unroute("**/api/events*");
    await resumePage(page);

    // Connected means authoritative state was applied, not merely that a
    // socket opened — and the file written during the gap is on screen,
    // without the user reloading.
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected", { timeout: 15_000 });
    await expect(page.locator("#connection-state")).toHaveClass(/is-live/);
    await expect(treeRow(page, "recovered.md")).toBeVisible();
    await expect(page.locator("#document-count")).toHaveText("19 files");
    await expect(page.locator("#preview")).toContainText("Edited while the page was suspended");
  });
});

test.describe("Chat channel recovery", () => {
  test.beforeEach(async ({ page, request }: { page: Page; request: APIRequestContext }) => {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await openChatPanel(page);
    await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
    // A conversation has to be selected for there to be a conversation stream
    // to interrupt.
    await page.locator("#chat-new-conversation").click();
    await expect(page.locator("#chat-composer")).toBeVisible();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  });

  test("an idle reconnect clears the interruption message with no Chat activity in between", async ({ page }) => {
    const status = page.locator("#chat-state");
    await expect(status).not.toContainText("interrupted");

    // Refuse the selected conversation's stream only; the inventory stream is
    // a different route and stays healthy, so one stream fails alone.
    await page.route("**/api/chat/conversations/*/events*", route => route.abort());
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    // The first drop retries silently; the message appears only once the
    // outage outlives one reconnect attempt.
    await expect(status).toContainText("Chat connection interrupted; reconnecting", { timeout: 40_000 });
    // The document channel is unaffected — Chat's trouble is Chat's to report.
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    await page.unroute("**/api/chat/conversations/*/events*");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    // Nothing is sent and no assistant output arrives. The successful open is
    // the only evidence of recovery there is, and it has to be enough.
    await expect(status).not.toContainText("Chat connection interrupted; reconnecting", { timeout: 40_000 });
  });
});
