import type { APIRequestContext, Locator, Page } from "@playwright/test";
import type { ActivityStatus, ConversationItem } from "../../src/chat/types";
import { LIVE_ENVELOPE_EVENT } from "../../src/shared/live-protocol";
import { expect } from "./fixtures";
import { openChatPanel } from "./chat-helpers";

export type Shape = "command" | "bash";
export const shell = (shape: Shape, output: string, status: ActivityStatus = "running", id = "shell:a"): ConversationItem => ({
  id, createdAt: id === "shell:a" ? 100 : 101, status, output,
  ...(shape === "command" ? { type: "command", command: `fixture-${id}` }
    : { type: "tool", name: "Bash", input: JSON.stringify({ command: `fixture-${id}`, description: "Stream fixture output" }) }),
} as ConversationItem);

export const log = (count: number, wide = false) => Array.from({ length: count }, (_, i) =>
  `line-${String(i).padStart(5, "0")} ${wide ? "aligned-column ".repeat(150) : "repeatable terminal output"}`).join("\n");

export async function control(request: APIRequestContext, data: Record<string, unknown>) {
  const response = await request.post("/__e2e/chat", { data });
  expect(response.ok()).toBe(true);
  return response.json();
}

export async function bootShell(page: Page, request: APIRequestContext, options: {
  agent?: "claude" | "opencode"; shape?: Shape; child?: boolean; touch?: boolean; output?: string; status?: ActivityStatus;
  extra?: ConversationItem[];
} = {}) {
  const { agent = "opencode", shape = "command", child = false, touch = false, output = log(120, true), status = "running" } = options;
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", count: 2 });
  const item = shell(shape, output, status);
  const seeded = await control(request, { action: "seed", agent, child, title: "Scrollback owner", items: [
    { id: "prompt", type: "user_message", createdAt: 1, text: "Inspect the complete command log" }, item, ...(options.extra ?? []),
  ].sort((a, b) => a.createdAt - b.createdAt) });
  const id: string = seeded.conversation.id;
  const parent = child ? await control(request, { action: "seed", agent, title: "Parent fixture", items: [{
    id: "child-task", type: "tool", createdAt: 1, name: "task", status: "completed",
    input: JSON.stringify({ description: "Shell child", subagent_type: "explore" }), childConversationId: id,
  }] }) : seeded;
  if (status === "running") await control(request, { action: "status", conversationId: id, status: "running" });
  const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  if (touch) await page.locator("#touch-tab-chat").click();
  else await openChatPanel(page);
  await page.locator("#chat-conversation-select").selectOption(parent.conversation.id);
  if (child) {
    await page.locator("#chat-subagents summary").click();
    await page.getByRole("button", { name: "explore · Shell child" }).click();
  }
  const timeline = page.locator(child ? "#chat-drilldown-timeline" : "#chat-timeline");
  await openShellRow(timeline, "shell:a");
  const outputView = page.locator('.chat-shell-output[data-shell-item-id="shell:a"]');
  const viewport = outputView.locator(".chat-shell-viewport");
  await expect(viewport).toBeVisible();
  await frames(page);
  return { id, item, timeline, outputView, viewport, parentId: parent.conversation.id as string,
    update: async (next: ConversationItem) => control(request, { action: "item", conversationId: id, item: next }) };
}

export async function openShellRow(timeline: Locator, id: string) {
  const row = timeline.locator(`[data-chat-item-id="${id}"]`);
  await expect(row).toBeAttached();
  const group = row.locator("xpath=ancestor::details[contains(@class,'chat-activity-group')]");
  // A render can group the row or open it between a read and the toggle,
  // and a toggle on a row that just opened closes it again. Re-read and
  // retry until the row is seen open.
  await expect(async () => {
    if (await group.count() && await group.getAttribute("open") === null) {
      // A pending request's sticky banner can cover the last working line.
      // Native keyboard activation opens it without a forced pointer click.
      await group.locator("> summary").focus();
      await group.locator("> summary").press("Enter");
    }
    if (await row.getAttribute("open") === null) await row.locator("> summary").click();
    await expect(row).toHaveAttribute("open", "", { timeout: 1_000 });
  }).toPass();
  await expect(row).toHaveAttribute("open", "");
}

/** Records every live-stream envelope once the page's own listeners have
 *  handled it. A test that asserts nothing happened after an event first
 *  awaits that event's delivery with `expectLiveDelivered`. */
export async function recordLiveDelivery(page: Page) {
  await page.addInitScript(eventName => {
    const delivered: string[] = (window as any).__liveDelivered = [];
    const add = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function (this: EventSource, type: string, listener: any, options?: any) {
      if (type !== eventName || typeof listener !== "function") return add.call(this, type, listener, options);
      return add.call(this, type, function (this: EventSource, event: Event) {
        try { return listener.call(this, event); } finally {
          delivered.push(String((event as MessageEvent).data));
          if (delivered.length > 16) delivered.shift();
        }
      }, options);
    } as typeof EventSource.prototype.addEventListener;
  }, LIVE_ENVELOPE_EVENT);
}

export const expectLiveDelivered = (page: Page, needle: string) => expect.poll(() => page.evaluate(
  text => ((window as any).__liveDelivered as string[]).some(data => data.includes(text)), needle),
  `live envelope carrying ${needle} handled by the page`).toBe(true);

export const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => {
  let left = 4;
  const next = () => --left ? requestAnimationFrame(next) : resolve();
  requestAnimationFrame(next);
}));
export const position = (view: Locator) => view.evaluate(el => ({ top: el.scrollTop, left: el.scrollLeft,
  bottom: el.scrollHeight - el.clientHeight - el.scrollTop, height: el.clientHeight }));

/** Native PageUp/PageDown may animate after keyup. Capture the settled reader anchor. */
export const settleScroll = (view: Locator) => view.evaluate(el => new Promise<void>((resolve, reject) => {
  let previous = el.scrollTop, stable = 0, frames = 0;
  const sample = () => {
    stable = el.scrollTop === previous ? stable + 1 : 0;
    previous = el.scrollTop;
    if (stable >= 5) resolve();
    else if (++frames > 120) reject(new Error("Reader scroll did not settle"));
    else requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}));

export async function drag(page: Page, control: Locator, dx: number, dy: number) {
  await control.scrollIntoViewIfNeeded();
  const box = (await control.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await frames(page); await page.mouse.up(); await frames(page);
}

export async function expectReading(view: Locator, anchor: { top: number; left: number }) {
  await expect.poll(async () => Math.abs((await position(view)).top - anchor.top)).toBeLessThan(2);
  await expect.poll(async () => Math.abs((await position(view)).left - anchor.left)).toBeLessThan(2);
}

export async function expectBounded(page: Page, view: Locator) {
  await expect.poll(async () => {
    const rect = await view.boundingBox(), size = page.viewportSize()!;
    return !!rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= size.width + 1 && rect.y + rect.height <= size.height + 1;
  }).toBe(true);
  const rect = (await view.boundingBox())!;
  const size = page.viewportSize()!;
  expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(size.width + 1);
  expect(rect.y + rect.height).toBeLessThanOrEqual(size.height + 1);
  await expect(view.getByRole("button", { name: "Return to chat" })).toBeInViewport();
}

export async function seed(request: APIRequestContext, title: string, items: ConversationItem[]): Promise<string> {
  await request.post("/__e2e/reset");
  const response = await request.post("/__e2e/chat", { data: { action: "seed", title, items } });
  expect(response.ok()).toBe(true);
  const seeded = await response.json() as { conversation: { id: string } };
  const token = await request.get("/__e2e/terminal-token").then(reply => reply.json()) as { token: string };
  return `${seeded.conversation.id}\u0001${token.token}`;
}

export async function openSeeded(page: Page, seededAndToken: string, touch: boolean): Promise<void> {
  const [conversationId, token] = seededAndToken.split("\u0001");
  await page.goto(`/?t=${encodeURIComponent(token!)}`);
  if (touch) {
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator("#chat-surface")).toBeVisible();
  } else {
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await openChatPanel(page);
  }
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await page.locator("#chat-conversation-select").selectOption(conversationId!);
}
