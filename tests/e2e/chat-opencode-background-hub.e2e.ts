import { childChatControl, expect, openEventSources, openSessionTab, test } from "./hub-fixtures";
import { openChatPanel, openChatWorkers } from "./chat-helpers";
import type { Page } from "@playwright/test";

test.use({ hubWorkspaces: ["alpha", "beta"] });

async function visibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { value, configurable: true });
    Object.defineProperty(document, "hidden", { value: value === "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("native V2 workers keep another workspace working and return through one stream with the draft and reading position", async ({ hub, hubContext }) => {
  const alpha = hub.workspaces[0]!;
  const beta = hub.workspaces[1]!;
  await childChatControl(alpha, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
  const parent = await openSessionTab(hubContext, alpha);
  await openChatPanel(parent);
  await parent.getByRole("button", { name: "New conversation" }).click();
  await expect(parent.locator("#chat-conversation-select")).not.toHaveValue("");
  const conversationId = await parent.locator("#chat-conversation-select").inputValue();
  await parent.locator("#chat-input").fill("Start native fixture work");
  await parent.locator("#chat-send").click();
  await expect(parent.locator("#chat-stop")).toBeEnabled();
  const worker = await childChatControl(alpha, { action: "opencode", op: "launchWorker", conversationId }) as { childId: string; taskId: string };
  await childChatControl(alpha, { action: "opencode", op: "appendHistory", conversationId, count: 60 });
  await childChatControl(alpha, { action: "opencode", op: "finish", conversationId });
  // The fake appends old provider history, not 120 live text frames. Open
  // its paged snapshot before placing a reader in that historical text.
  await parent.reload();
  await openChatPanel(parent);
  await expect(parent.locator("#chat-items")).toContainText("Historical fixture answer 59");
  await openChatWorkers(parent);
  const row = parent.locator(`[data-background-task="${worker.taskId}"]`);
  await expect(row).toBeVisible();
  await parent.locator("#chat-input").fill("Preserved workspace draft");
  const timeline = parent.locator("#chat-timeline");
  await timeline.evaluate(element => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
    element.scrollTop = 600;
  });
  await parent.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const anchor = await timeline.evaluate(async element => {
    // Intrinsic-size rows can materialize over several rendering frames.
    // Establish a stable reader position before testing its preservation.
    let previous = "";
    let stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const top = element.getBoundingClientRect().top;
      const rows = [...element.querySelectorAll<HTMLElement>("[data-chat-item-id]")].map(row => ({ id: row.dataset.chatItemId!, rect: row.getBoundingClientRect() }));
      const row = rows.find(row => row.rect.top >= top && row.rect.height > 0)!;
      const result = { id: row.id, offset: row.rect.top - top };
      const current = JSON.stringify([element.scrollTop, element.scrollHeight, result]);
      stable = current === previous ? stable + 1 : 0;
      if (stable === 3) return result;
      previous = current;
    }
    throw new Error("Reader geometry never settled");
  });
  await row.locator("[data-inspect-task]").click();
  await expect(parent.locator("#chat-drilldown-items")).toContainText("Check fixture");
  await expect.poll(() => openEventSources(parent)).toHaveLength(1);
  expect(new URL((await openEventSources(parent))[0]!, hub.origin).pathname).toBe("/api/hub/live");
  await visibility(parent, "hidden");
  await expect.poll(() => openEventSources(parent)).toHaveLength(0);

  const other = await openSessionTab(hubContext, beta);
  await expect(other.locator("#hub-activity-badge")).toHaveClass(/is-working/);
  await childChatControl(alpha, { action: "opencode", op: "settleWorker", childId: worker.childId, text: "Cross-workspace native report" });
  await expect(other.locator("#hub-activity-badge")).toHaveClass(/is-finished/);
  await visibility(other, "hidden");
  await visibility(parent, "visible");
  await expect(parent.locator("#chat-drilldown-task")).toContainText("finished");
  await expect(parent.locator("#chat-drilldown-items")).toContainText("Cross-workspace native report");
  await expect.poll(() => openEventSources(parent)).toHaveLength(1);
  await parent.keyboard.press("Escape");
  await expect(parent.locator("#chat-drilldown")).toBeHidden();
  await expect(parent.locator("#chat-input")).toHaveValue("Preserved workspace draft");
  await parent.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // Content above this row can change height when the worker settles; the
  // reader's visible row/offset, not the old absolute scrollTop, must survive.
  const offset = await timeline.evaluate((element, id) => element.querySelector<HTMLElement>(`[data-chat-item-id="${CSS.escape(id)}"]`)!.getBoundingClientRect().top - element.getBoundingClientRect().top, anchor.id);
  expect(Math.abs(offset - anchor.offset)).toBeLessThan(4);
  await expect(parent.locator(`[data-chat-item-id="task:${worker.taskId}"]`)).toHaveCount(1);
  await expect(parent.locator('#chat-compact-workers-items .chat-worker-row:is([data-state="working"], [data-state="unknown"]) [data-inspect-task]')).toHaveCount(0);
});
