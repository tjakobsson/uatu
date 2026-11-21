import { test as baseTest, expect } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { openChatPanel } from "./chat-helpers";
import { control, position, settleScroll } from "./chat-shell-helpers";
import { saveEvidence } from "./evidence";

const test = withEngineBrowsers(baseTest);
attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: New conversation follows its first streamed reply without losing paused history`, async ({ launchBrowser, request, baseURL }, info) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
    try {
      await request.post("/__e2e/reset");
      const items = Array.from({ length: 60 }, (_, index) => ({
        id: `new-follow:history:${index}`, type: "assistant_message", createdAt: index + 1,
        markdown: `History row ${index}.\n\nContext for this distinct reading row.\n\nMore context in the same row.`,
      }));
      const seeded = await control(request, { action: "seed", title: "Paused history A", items });
      const a = seeded.conversation.id as string;
      const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await openChatPanel(page);
      const picker = page.locator("#chat-conversation-select");
      const timeline = page.locator("#chat-timeline");
      const latest = page.locator("#chat-latest");
      await picker.selectOption(a);
      await expect(timeline.locator("[data-chat-item-id]")).toHaveCount(items.length);
      await expect.poll(async () => Math.abs((await position(timeline)).bottom)).toBeLessThanOrEqual(2);
      await settleScroll(timeline);

      // Pause through real native upward input, never a test-owned scrollTop.
      await timeline.hover();
      await page.mouse.wheel(0, -600);
      await expect.poll(async () => (await position(timeline)).bottom).toBeGreaterThan(300);
      await settleScroll(timeline);
      const reading = await timeline.evaluate(node => {
        const band = node.getBoundingClientRect();
        const row = [...node.querySelectorAll<HTMLElement>("[data-chat-item-id]")].find(row => {
          const rect = row.getBoundingClientRect();
          return rect.height > 0 && rect.top >= band.top && rect.bottom <= band.bottom;
        });
        if (!row) throw new Error("Native wheel setup left no complete visible history row");
        return { id: row.dataset.chatItemId!, offset: row.getBoundingClientRect().top - band.top, top: node.scrollTop };
      });
      expect(reading.id).not.toBe(items[0]!.id);
      const drift = () => timeline.evaluate((node, reading) => {
        const row = [...node.querySelectorAll<HTMLElement>("[data-chat-item-id]")].find(row => row.dataset.chatItemId === reading.id);
        return row ? Math.abs(row.getBoundingClientRect().top - node.getBoundingClientRect().top - reading.offset) : Infinity;
      }, reading);
      await control(request, { action: "item", conversationId: a, item: {
        id: "new-follow:unseen-a", type: "assistant_message", createdAt: 61, markdown: "Unseen output while reading A.",
      } });
      await expect(timeline).toContainText("Unseen output while reading A.");
      await expect(latest).toBeVisible();
      await settleScroll(timeline);
      expect(await drift()).toBeLessThanOrEqual(2);

      // Exercise the actual creation handler, not an API-seeded B or chooser
      // shortcut: the outgoing paused projection must not own B's position.
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await expect(picker).not.toHaveValue(a);
      await expect(picker).not.toHaveValue("");
      const b = await picker.inputValue();
      await expect(timeline.locator("[data-chat-item-id]")).toHaveCount(0);
      const prompt = "Start the new conversation's first reply";
      await page.locator("#chat-input").fill(prompt);
      const accepted = page.waitForResponse(response => response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/prompts"));
      await page.locator("#chat-send").click();
      const response = await accepted;
      expect(response.ok()).toBe(true);
      expect(await response.json()).toMatchObject({ pending: false });
      await expect(timeline).toContainText(prompt);
      await expect(page.locator("#chat-stop")).toBeEnabled();

      // FakeE2EChatService dispatches the real submitted user row and running
      // status but produces no automatic reply. Its public item/delta controls
      // deliver the response through the real SSE -> projection -> render path.
      const reply = { id: "new-follow:first-reply", type: "assistant_message", createdAt: Date.now() + 1,
        markdown: "First streamed reply paragraph.\n\n".repeat(60) + "First reply tail." };
      await control(request, { action: "item", conversationId: b, item: reply });
      const replyRow = timeline.locator('[data-chat-item-id="new-follow:first-reply"]');
      await expect(replyRow).toContainText("First reply tail.");
      await expect.poll(async () => (await position(timeline)).height).toBeGreaterThan(0);
      await expect.poll(() => timeline.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(300);
      await expect.poll(async () => Math.abs((await position(timeline)).bottom)).toBeLessThanOrEqual(2);
      await settleScroll(timeline);
      await expect(replyRow.getByText("First reply tail.", { exact: true })).toBeInViewport();
      expect(Math.abs((await position(timeline)).bottom)).toBeLessThanOrEqual(2);
      const firstReply = await position(timeline);
      expect(Math.abs(firstReply.bottom)).toBeLessThanOrEqual(2);
      const firstHeight = await timeline.evaluate(node => node.scrollHeight);
      await control(request, { action: "delta", conversationId: b, itemId: reply.id,
        delta: "\n\nLater streamed reply paragraph.\n\n".repeat(80) + "Later reply tail." });
      await expect(replyRow).toContainText("Later reply tail.");
      await expect.poll(() => timeline.evaluate(node => node.scrollHeight)).toBeGreaterThan(firstHeight + 300);
      await expect.poll(async () => Math.abs((await position(timeline)).bottom)).toBeLessThanOrEqual(2);
      await settleScroll(timeline);
      await expect(replyRow.getByText("Later reply tail.", { exact: true })).toBeInViewport();
      expect(Math.abs((await position(timeline)).bottom)).toBeLessThanOrEqual(2);
      await expect(latest).toBeHidden();
      const grownReply = await position(timeline);
      expect(Math.abs(grownReply.bottom)).toBeLessThanOrEqual(2);

      // Grow content ABOVE A's retained row while away: restoring only its old
      // raw scrollTop cannot satisfy the semantic row-offset assertion below.
      await control(request, { action: "item", conversationId: a, item: {
        ...items[0], markdown: items[0]!.markdown + "\n\nAdditional context above the retained reading row.".repeat(20),
      } });
      await picker.selectOption(a);
      await expect(timeline.locator(`[data-chat-item-id="${items[0]!.id}"]`)).toContainText("Additional context above the retained reading row.");
      await expect.poll(drift).toBeLessThanOrEqual(2);
      await settleScroll(timeline);
      expect(await drift()).toBeLessThanOrEqual(2);
      expect((await position(timeline)).top).toBeGreaterThan(reading.top + 100);
      expect((await position(timeline)).bottom).toBeGreaterThan(300);

      await control(request, { action: "item", conversationId: a, item: {
        id: "new-follow:later-a", type: "assistant_message", createdAt: 62,
        markdown: "Later output must not resume A.\n\n".repeat(30),
      } });
      await expect(timeline.locator('[data-chat-item-id="new-follow:later-a"]')).toContainText("Later output must not resume A.");
      await expect(latest).toBeVisible();
      await settleScroll(timeline);
      expect(await drift()).toBeLessThanOrEqual(2);
      expect((await position(timeline)).bottom).toBeGreaterThan(300);
      await saveEvidence(info, `${engine}-new-conversation-follow-geometry.json`,
        JSON.stringify({ reading, firstReply, grownReply, restored: await position(timeline), drift: await drift() }));
    } finally {
      await browser.close();
    }
  });
}
