import type { APIRequestContext, Page } from "@playwright/test";

import type { ConversationItem } from "../../src/chat/types";
import { openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<any> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function boot(page: Page, request: APIRequestContext, seed?: { items: ConversationItem[]; older?: ConversationItem[] }): Promise<string> {
  await request.post("/__e2e/reset");
  const snapshot = await control(request, { action: "seed", title: "Touch chat", items: seed?.items ?? [], older: seed?.older ?? [] });
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await page.locator("#touch-tab-chat").click();
  await expect(page.locator("#chat-surface")).toBeVisible();
  await expect(page.locator("#chat-conversation-select")).toHaveValue(snapshot.conversation.id);
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(page.locator("#chat-send .chat-send-icon")).toBeVisible();
  return snapshot.conversation.id as string;
}

const messages = (prefix: string, count: number, start = 0): ConversationItem[] => Array.from({ length: count }, (_, index) => ({
  id: `message:${prefix}-${index}`,
  type: "user_message" as const,
  createdAt: start + index,
  text: `${prefix} message ${index} ${"content ".repeat(12)}`,
}));

test("four tabs preserve chat state and keyboard navigation", async ({ page, request }) => {
  await boot(page, request);
  await expect(page.locator("#touch-tab-bar [role=tab]")).toHaveCount(4);
  await expect(page.locator("#touch-tab-bar .touch-tab-label")).toHaveText(["Files", "Preview", "Chat", "Terminal"]);
  await page.locator("#chat-input").fill("persistent touch draft");
  await expect(page.locator("#touch-tab-bar")).toBeHidden();
  await page.locator("#chat-input").blur();
  await expect(page.locator("#touch-tab-bar")).toBeVisible();
  for (const tab of ["files", "preview", "chat"] as const) {
    await page.locator(`#touch-tab-${tab}`).click();
    await expect(page.locator(`#touch-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
  }
  await expect(page.locator("#chat-input")).toHaveValue("persistent touch draft");
  await page.locator("#touch-tab-chat").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#touch-tab-terminal")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#touch-tab-files")).toBeFocused();
});

test("composer stays flush and its trailing action becomes cancel without adding a row", async ({ page, request }) => {
  const id = await boot(page, request);
  await page.locator("#chat-model-select").selectOption({ label: "Anthropic: Claude Sonnet" });
  await page.locator("#chat-mode-select").selectOption("build");
  await page.locator("#chat-variant-select").selectOption("high");
  await page.locator("#chat-input").fill("Idle first line");
  await page.locator("#chat-input").press("Enter");
  await expect(page.locator("#chat-input")).toHaveValue("Idle first line\n");
  await page.locator("#chat-input").fill("");
  await control(request, { action: "status", conversationId: id, status: "running" });
  await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Cancel response");
  await expect(page.locator("#chat-send .chat-send-cancel")).toBeVisible();
  await page.locator("#chat-input").focus();
  await expect(page.locator("html")).toHaveAttribute("data-chat-editing", "");

  const geometry = await page.locator(".chat-composer-actions").evaluate(actions => {
    const send = actions.querySelector<HTMLElement>("#chat-send")!.getBoundingClientRect();
    const controls = actions.querySelector<HTMLElement>(".chat-composer-controls")!.getBoundingClientRect();
    const bounds = actions.getBoundingClientRect();
    const composer = actions.closest(".chat-composer")!;
    const style = getComputedStyle(composer);
    return {
      sendTop: send.top,
      sendBottom: send.bottom,
      controlsBottom: controls.bottom,
      sendRight: send.right,
      boundsRight: bounds.right,
      margin: style.margin,
    };
  });
  expect(Math.abs(geometry.sendBottom - geometry.controlsBottom)).toBeLessThanOrEqual(1);
  expect(geometry.sendTop).toBeLessThan(geometry.controlsBottom);
  expect(geometry.sendRight).toBeLessThanOrEqual(geometry.boundsRight + 1);
  expect(geometry.margin).toBe("0px");

  await page.locator("#chat-input").fill("First line");
  await page.locator("#chat-input").press("Shift+Enter");
  await expect(page.locator("#chat-input")).toHaveValue("First line\n");
  await page.locator("#chat-input").fill("Steer from touch");
  await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Cancel response");
  const steerResponse = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await page.locator("#chat-input").press("Enter");
  expect((await steerResponse).request().postDataJSON()).toMatchObject({ text: "Steer from touch" });
});

test("a subagent transcript pushes as a screen and the back gesture pops it", async ({ page, request }) => {
  // `boot` resets the service, so the child is seeded after it and the row
  // that points at it is published once both conversations exist.
  const parent = await boot(page, request);
  const child = await control(request, { action: "seed", title: "Child transcript", child: true, items: [
    { id: "part:child", type: "assistant_message", createdAt: 1, markdown: "child findings" },
  ] });
  await control(request, { action: "item", conversationId: parent, item: {
    id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed",
    input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
    childConversationId: child.conversation.id,
  } });

  await expect(page.locator("#chat-subagents")).toBeVisible();
  await page.locator("#chat-subagents summary").click();
  await page.getByRole("button", { name: "explore · Review renderer" }).click();

  const drilldown = page.locator("#chat-drilldown");
  await expect(drilldown).toBeVisible();
  await expect(page.locator("#chat-drilldown-items")).toContainText("child findings");
  // A layer within the Chat tab, not a way out of it: the tab bar is still
  // there and Chat is still the selected tab.
  await expect(page.locator("#touch-tab-bar")).toBeVisible();
  await expect(page.locator("#touch-tab-chat")).toHaveAttribute("aria-selected", "true");
  // The picker is behind the pushed screen and still on the parent — a
  // subagent is never one of its entries.
  await expect(page.locator("#chat-conversation-select")).toHaveValue(parent);
  await expect(page.locator("#chat-conversation-select option")).toHaveCount(1);

  // The platform back gesture pops the screen rather than leaving the app or
  // navigating the document behind it.
  await page.goBack();
  await expect(drilldown).toBeHidden();
  await expect(page.locator("#chat-surface")).toBeVisible();
  await expect(page.locator("#chat-conversation-select")).toHaveValue(parent);
});

test("a request the parent is waiting on stays reachable over the pushed screen", async ({ page, request }) => {
  const parent = await boot(page, request);
  const child = await control(request, { action: "seed", title: "Child transcript", child: true, items: [
    { id: "part:child", type: "assistant_message", createdAt: 1, markdown: "child findings" },
  ] });
  await control(request, { action: "item", conversationId: parent, item: {
    id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed",
    input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
    childConversationId: child.conversation.id,
  } });
  await control(request, { action: "item", conversationId: parent, item: {
    id: "permission:p1", type: "permission", createdAt: 3, requestId: "p1", status: "pending",
    action: "bash", resources: ["rm -rf build"],
  } });

  await expect(page.locator("#chat-subagents")).toBeVisible();
  await page.locator("#chat-subagents summary").click({ position: { x: 8, y: 8 } });
  await page.getByRole("button", { name: "explore · Review renderer" }).click();
  await expect(page.locator("#chat-drilldown")).toBeVisible();

  // Asserted by what is painted, not by `toBeVisible`: the pushed screen
  // covers the whole surface, so a box-and-CSS check calls the pill visible
  // while it sits underneath and no finger can reach it. That is exactly how
  // this was missed the first time.
  const jump = page.locator("#chat-requests-jump");
  const box = (await jump.boundingBox())!;
  const painted = await page.evaluate(([x, y]) => document.elementFromPoint(x as number, y as number)?.id ?? "",
    [box.x + box.width / 2, box.y + box.height / 2]);
  expect(painted).toBe("chat-requests-jump");

  // And taking it returns to the parent with the card answerable.
  await jump.click();
  await expect(page.locator("#chat-drilldown")).toBeHidden();
  const card = page.locator('[data-chat-item-id="permission:p1"]');
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(jump).toBeHidden();
});

test("software-keyboard geometry keeps the composer in the visual viewport", async ({ page, request }) => {
  await page.addInitScript(() => {
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    viewport.height = 844;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  await boot(page, request);
  await page.locator("#chat-input").focus();
  await expect(page.locator("html")).toHaveAttribute("data-chat-editing", "");
  await expect(page.locator("#touch-tab-bar")).toBeHidden();
  await page.evaluate(() => {
    const viewport = window.visualViewport as VisualViewport & { height: number };
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "460px");
  const geometry = await page.evaluate(() => {
    const composer = document.querySelector("#chat-composer")!.getBoundingClientRect();
    return { bottom: composer.bottom, visualHeight: window.visualViewport!.height, marginBottom: getComputedStyle(document.querySelector("#chat-composer")!).marginBottom };
  });
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.visualHeight + 1);
  expect(geometry.marginBottom).toBe("0px");
});

test("pinned streaming follows while unpinned streaming offers jump to latest", async ({ page, request }) => {
  const id = await boot(page, request, { items: messages("loaded", 28) });
  const timeline = page.locator("#chat-timeline");
  await timeline.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await control(request, { action: "item", conversationId: id, item: { id: "message:pinned", type: "user_message", createdAt: 100, text: "pinned update" } });
  await expect(page.locator("#chat-items")).toContainText("pinned update");
  await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(50);

  await timeline.evaluate(element => { element.scrollTop = 20; element.dispatchEvent(new Event("scroll")); });
  const before = await timeline.evaluate(element => element.scrollTop);
  await control(request, { action: "item", conversationId: id, item: { id: "message:unseen", type: "user_message", createdAt: 101, text: "unseen update" } });
  await expect(page.locator("#chat-latest")).toBeVisible();
  expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(before, 0);
  await page.locator("#chat-latest").click();
  await expect(page.locator("#chat-latest")).toBeHidden();
  await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(50);
});

test("history prepend and activity expansion preserve semantic position", async ({ page, request }) => {
  const latest = messages("latest", 14, 100);
  await boot(page, request, { items: latest, older: messages("older", 12) });
  const timeline = page.locator("#chat-timeline");
  await timeline.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  const anchor = page.locator(`[data-chat-item-id="${latest[0]!.id}"]`);
  const before = await anchor.evaluate(element => element.getBoundingClientRect().top);
  const olderResponse = page.waitForResponse(response => response.url().includes("cursor=older"));
  await page.locator("#chat-load-older").click();
  expect((await olderResponse).ok()).toBe(true);
  await expect(page.locator("#chat-items")).toContainText("older message 0");
  expect(await anchor.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(before, 0);

  const id = await page.locator("#chat-conversation-select").inputValue();
  const activity: ConversationItem = { id: "tool:expand", type: "tool", createdAt: 200, name: "Inspect", status: "completed", output: "detail\n".repeat(30) };
  await control(request, { action: "item", conversationId: id, item: activity });
  // The spec anchors an expanded entry only away from the timeline end — at the
  // end, pinned follow-to-bottom wins — so put a message after the activity.
  await control(request, { action: "item", conversationId: id, item: { id: "message:after-activity", type: "user_message", createdAt: 201, text: `after activity ${"content ".repeat(30)}` } });
  const details = page.locator('[data-chat-item-id="tool:expand"]');
  await expect(page.locator('[data-chat-item-id="message:after-activity"]')).toBeAttached();
  await timeline.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 80; element.dispatchEvent(new Event("scroll")); });
  await expect(details).toBeInViewport();
  const activityTop = await details.evaluate(element => element.getBoundingClientRect().top);
  await details.locator("> summary").click();
  await expect(details).toHaveAttribute("open", "");
  expect(await details.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(activityTop, 0);
});

test("a permission's long paths wrap instead of running off the screen", async ({ page, request }) => {
  // Absolute paths and shell pipelines have no break opportunity a browser
  // takes on its own. Unwrapped, the longest one sets the card's width and
  // the rest leaves the viewport — a reader approving a command whose end
  // they cannot see, which is exactly what the card exists to prevent.
  const permission: ConversationItem = {
    id: "permission:p-long", type: "permission", createdAt: 10, requestId: "p-long",
    action: "bash",
    resources: [
      "cat /Users/tobias/src/github.com/tjakobsson/uatu/openspec/changes/chat-context-usage/design.md",
      "sed -n '1,80p' /Users/tobias/src/github.com/tjakobsson/uatu/README.md",
    ],
    status: "pending",
  };
  await boot(page, request, { items: [permission] });
  await expect(page.locator('[data-chat-item-id="permission:p-long"]')).toBeVisible();
  const timeline = await page.locator("#chat-timeline").evaluate(element => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(timeline.scrollWidth).toBeLessThanOrEqual(timeline.clientWidth);
});

test("rotation and live mode switching retain Chat without remounting", async ({ page, request }) => {
  await boot(page, request);
  await page.locator("#chat-input").fill("rotation draft");
  const marker = await page.locator("#chat-surface").evaluate(element => {
    (element as HTMLElement).dataset.e2eMount = "same";
    return (element as HTMLElement).dataset.e2eMount;
  });
  expect(marker).toBe("same");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator("#chat-input")).toHaveValue("rotation draft");
  await page.locator("#chat-input").blur();
  await page.locator("#touch-tab-files").click();
  // A desktop-capable viewport before escaping touch mode: below the 900px
  // stacked breakpoint the chat panel's viewport guard keeps it collapsed,
  // so the split needs iPad-landscape room to present.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#ui-mode-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
  await openChatPanel(page);
  await expect(page.locator("#chat-surface")).toHaveAttribute("data-e2e-mount", "same");
  await expect(page.locator("#chat-input")).toHaveValue("rotation draft");
  await page.locator("#ui-mode-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await expect(page.locator("#touch-tab-chat")).toHaveAttribute("aria-selected", "true");
});
