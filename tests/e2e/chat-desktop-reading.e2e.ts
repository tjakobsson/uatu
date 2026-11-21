import { test, expect } from "./fixtures";
import { openChatPanel } from "./chat-helpers";
import { control, settleScroll } from "./chat-shell-helpers";
import { expectWorkControlVisible, expectWorkLayoutReady } from "./work-panel-assertions";
import { saveEvidence } from "./evidence";

test("expanded desktop work leaves a balanced conversation reading area", async ({ page, request }, info) => {
  await page.setViewportSize({ width: 1100, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await request.post("/__e2e/reset");
  const seeded = await control(request, { action: "seed", title: "Reading during active work", items: [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `reading:${i}`, type: "assistant_message", createdAt: i + 1,
      markdown: `Review finding ${i}. ${"Keep the conversation readable while independent work continues. ".repeat(8)}` })),
    ...Array.from({ length: 12 }, (_, i) => ({ id: `worker:${i}`, type: "background_task", taskId: `worker:${i}`,
      taskType: "agent", description: `Review implementation area ${i}`, status: "running", createdAt: 100 + i })),
  ] });
  const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await openChatPanel(page);
  await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
  await control(request, { action: "status", conversationId: seeded.conversation.id, status: "running" });
  await expect(page.locator("#chat-stop")).toBeEnabled();
  for (let i = 0; i < 8; i++) {
    await page.locator("#chat-input").fill(`Check follow-up ${i}`);
    const accepted = page.waitForResponse(r => r.url().endsWith("/prompts") && r.request().method() === "POST");
    await page.locator("#chat-input").press("Alt+Enter");
    await accepted;
  }
  await expect(page.locator(".chat-queued-message")).toHaveCount(8);
  await expect(page.locator("#chat-compact-workers")).toHaveAttribute("open");
  await expect(page.locator("[data-pending-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expectWorkLayoutReady(page);
  const transcript = page.locator(".chat-transcript-area");
  // A worked layout target, deliberately independent of the allocation formula:
  // the former policy left only 200px in this 844px-high fixture window.
  await expect.poll(() => transcript.evaluate(n => n.clientHeight)).toBeGreaterThanOrEqual(280);
  const timeline = page.locator("#chat-timeline");
  const workers = page.locator("#chat-compact-workers > summary");
  const pending = page.locator("[data-pending-toggle]");
  const evidence: unknown[] = [];
  for (const size of [{ width: 1100, height: 844 }, { width: 1440, height: 900 }, { width: 1100, height: 650 }]) {
    await page.setViewportSize(size);
    await expectWorkLayoutReady(page);
    const reveal = page.locator("#chat-work-toggle");
    if (await reveal.isVisible()) await reveal.click();
    await expectWorkControlVisible(workers);
    await expectWorkControlVisible(pending);
    await expectWorkControlVisible(page.locator("#chat-send"));
    await expectWorkControlVisible(page.locator("#chat-stop"));
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
    const panes = ["chat-compact-workers-items", "chat-queue-content"];
    for (const id of panes) {
      const sibling = page.locator(`#${panes.find(other => other !== id)}`);
      const before = await sibling.evaluate(n => n.scrollTop);
      const header = await pending.boundingBox();
      const pane = page.locator(`#${id}`);
      expect(await pane.evaluate(n => n.scrollHeight - n.clientHeight)).toBeGreaterThan(0);
      await pane.evaluate(n => n.scrollTop = 0);
      await settleScroll(pane);
      await pane.hover();
      await page.mouse.wheel(0, 250);
      await expect.poll(() => pane.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
      await settleScroll(pane);
      expect(await sibling.evaluate(n => n.scrollTop)).toBe(before);
      expect((await pending.boundingBox())!.y).toBeCloseTo(header!.y, 0);
    }
    evidence.push({ size, boxes: await page.evaluate(() => Object.fromEntries(
      ["chat-timeline", "chat-work-dock", "chat-composer"].map(id => [id, document.getElementById(id)!.getBoundingClientRect().toJSON()]))) });
  }
  // Reading is paused through an actual manual scroll before disclosure/resize.
  await page.setViewportSize({ width: 1100, height: 844 });
  await expectWorkLayoutReady(page);
  await timeline.hover();
  await page.mouse.wheel(0, -900);
  await expect.poll(() => timeline.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop)).toBeGreaterThan(300);
  await settleScroll(timeline);
  const anchor = await timeline.evaluate(n => {
    const top = n.getBoundingClientRect().top;
    const row = [...n.querySelectorAll<HTMLElement>("[data-chat-item-id]")].find(row => row.getBoundingClientRect().top >= top)!;
    return { id: row.dataset.chatItemId!, offset: row.getBoundingClientRect().top - top };
  });
  for (const action of [async () => workers.click(), async () => workers.click(), async () => page.setViewportSize({ width: 1100, height: 900 })]) {
    await action();
    await expectWorkLayoutReady(page);
    await settleScroll(timeline);
    const offset = await timeline.locator(`[data-chat-item-id="${anchor.id}"]`).evaluate(n => n.getBoundingClientRect().top - document.getElementById("chat-timeline")!.getBoundingClientRect().top);
    expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(2);
  }
  await saveEvidence(info, "desktop-reading-geometry.json", JSON.stringify(evidence, null, 2));
});
