import type { APIRequestContext, Locator, Page } from "@playwright/test";

import type { ConversationItem } from "../../src/chat/types";
import { chooseChatModel, installClipboardMock, openChatConfiguration, openChatPanel, readClipboardMock } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
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

/** The fake `visualViewport` the software-keyboard cases drive: a plain
 *  EventTarget whose height and offset the test moves, so keyboard geometry —
 *  including geometry no desktop browser will ever produce — can be fed to the
 *  controller exactly as iOS reports it. Must run before `boot` navigates. */
async function installFakeVisualViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number; scale: number };
    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.scale = 1;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
}

/** Move the fake viewport. `notify: false` is the transition this change is
 *  about: the geometry is different and the platform announced nothing. */
function setVisualViewport(page: Page, geometry: { height?: number; offsetTop?: number; scale?: number; notify?: boolean }): Promise<void> {
  return page.evaluate(next => {
    const viewport = window.visualViewport as VisualViewport & { height: number; offsetTop: number; scale: number };
    if (next.height !== undefined) viewport.height = next.height;
    if (next.offsetTop !== undefined) viewport.offsetTop = next.offsetTop;
    if (next.scale !== undefined) viewport.scale = next.scale;
    if (next.notify !== false) viewport.dispatchEvent(new Event("resize"));
  }, geometry);
}

/** What is actually painted at an element's centre. `toBeVisible` answers from
 *  boxes and CSS, which calls a control reachable while something floats over
 *  it — the distinction these cases exist to make. */
function paintedAtCentre(locator: Locator): Promise<{ reachable: boolean; painted: string }> {
  return locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const painted = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      reachable: painted !== null && (painted === element || element.contains(painted)),
      painted: painted ? painted.id || painted.className || painted.tagName.toLowerCase() : "nothing",
    };
  });
}

/** A poll predicate that answers true once a scroller has stopped moving. The
 *  coordinated owner settles a reveal over several frames — the strip the
 *  keyboard covers and the floats over the transcript both change the extent
 *  it measures against — and the position it defends is the settled one. */
function stillScrollTop(locator: Locator): () => Promise<boolean> {
  let previous = Number.NaN;
  return async () => {
    const current = await locator.evaluate(element => element.scrollTop);
    const still = Math.abs(current - previous) < 0.5;
    previous = current;
    return still;
  };
}

/** A touch conversation with all three pinned tracks populated and expanded.
 *  It runs on the Claude-shaped fixture agent because that is the one that
 *  declares `background-tasks`; the other two tracks are agent-neutral. */
/** `history` seeds the conversation ahead of its own first message: a case
 *  that asks where a request settles needs a transcript long enough to scroll,
 *  because a conversation that cannot move cannot lift a card anywhere. */
async function bootWithPinnedTracks(page: Page, request: APIRequestContext, history: ConversationItem[] = []): Promise<string> {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", count: 2 });
  const parent = await control(request, { action: "seed", agent: "claude", title: "Touch tracks", items: [
    ...history,
    { id: "message:u1", type: "user_message", createdAt: 1, text: "work through the list" },
  ] });
  const child = await control(request, { action: "seed", agent: "claude", title: "Child transcript", child: true, items: [
    { id: "part:child", type: "assistant_message", createdAt: 2, markdown: "child findings" },
  ] });
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await page.locator("#touch-tab-chat").click();
  await expect(page.locator("#chat-surface")).toBeVisible();
  await page.locator("#chat-conversation-select").selectOption(parent.conversation.id);
  await expect(page.locator("#chat-items")).toContainText("work through the list");

  const id = parent.conversation.id as string;
  // The pinned task list reads the newest `todowrite` snapshot, not the
  // `task_progress` block the timeline renders.
  await control(request, { action: "item", conversationId: id, item: {
    id: "tool:todos", type: "tool", createdAt: 3, name: "todowrite", status: "completed",
    input: JSON.stringify({ todos: [
      { content: "Read the code", status: "completed" },
      { content: "Fix the layout", status: "in_progress" },
      { content: "Write the tests", status: "pending" },
      { content: "Run the suite", status: "pending" },
      { content: "Prepare the PR", status: "pending" },
      { content: "Record the evidence", status: "pending" },
    ] }),
  } });
  await control(request, { action: "item", conversationId: id, item: {
    id: "tool:agent1", type: "tool", createdAt: 4, name: "task", status: "completed",
    input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
    childConversationId: child.conversation.id,
  } });
  await control(request, { action: "item", conversationId: id, item: {
    id: "task:b2f6", type: "background_task", createdAt: 5, taskId: "b2f6",
    description: "Sleep then report", taskType: "local_bash", toolUseId: "tool:bg", status: "running",
  } });

  await expect(page.locator("#chat-task-list")).toBeVisible();
  await expect(page.locator("#chat-subagents")).toBeVisible();
  await expect(page.locator("#chat-background-tasks")).toBeVisible();
  // Expanded, so "hidden" in these cases is about the keyboard rule rather
  // than about a closed <details>. Set rather than tapped: a tap lands on a
  // track row, and the point here is the geometry, not the summary's hit area.
  await page.evaluate(() => {
    for (const id of ["chat-task-list", "chat-subagents", "chat-background-tasks"]) {
      document.querySelector<HTMLDetailsElement>(`#${id}`)!.open = true;
    }
  });
  await expect(page.locator("#chat-task-list-items li")).toHaveCount(6);
  await expect(page.locator("#chat-subagents-items li")).toHaveCount(1);
  await expect(page.locator("#chat-background-tasks-items li")).toHaveCount(1);
  return id;
}

test("keeps workspace identity above full-width conversation controls", async ({ page, request }) => {
  await boot(page, request);
  const rows = await page.locator(".chat-header").evaluate(header => {
    const identity = header.querySelector(".chat-identity")!.getBoundingClientRect();
    const controls = header.querySelector(".chat-conversation-controls")!.getBoundingClientRect();
    const childrenContained = [...header.querySelector(".chat-conversation-controls")!.children].filter(child => getComputedStyle(child).display !== "none").every(child => {
      const bounds = child.getBoundingClientRect();
      return bounds.left >= controls.left - 1 && bounds.right <= controls.right + 1;
    });
    return { identityBottom: identity.bottom, controlsTop: controls.top, identityWidth: identity.width, controlsWidth: controls.width, childrenContained };
  });
  expect(rows.controlsTop).toBeGreaterThanOrEqual(rows.identityBottom);
  expect(Math.abs(rows.identityWidth - rows.controlsWidth)).toBeLessThan(2);
  expect(rows.childrenContained).toBe(true);
});

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

test("questions wait for Answer and send a custom choice as text", async ({ page, request }) => {
  const question: ConversationItem = {
    id: "question:touch-choice", type: "question", createdAt: 1, requestId: "touch-choice", status: "pending",
    questions: [{
      header: "Approach", prompt: "Which approach?", multiple: false, allowFreeForm: true,
      options: [{ label: "Minimal", description: "Small change" }],
    }],
  };
  await boot(page, request, { items: [question] });

  const card = page.locator('[data-chat-item-id="question:touch-choice"]');
  const answer = card.getByRole("button", { name: "Answer", exact: true });
  let replies = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith(`/questions/${question.requestId}`)) replies += 1;
  });
  await card.getByRole("radio", { name: "Minimal Small change" }).check();
  await expect(answer).toBeEnabled();
  await page.waitForTimeout(100);
  expect(replies).toBe(0);

  const custom = card.getByRole("radio", { name: "Type your own answer" });
  const customInput = card.locator("[data-question-custom-input]");
  await custom.check();
  await expect(customInput).toBeVisible();
  await expect(customInput).toBeFocused();
  await customInput.fill("  Touch-friendly  ");

  const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname.endsWith(`/questions/${question.requestId}`));
  await answer.click();
  const payload = (await response).request().postDataJSON();
  expect(payload).toMatchObject({ outcome: { kind: "answered", answers: [["Touch-friendly"]] } });
  expect(payload.outcome.answers.flat()).not.toContain("Type your own answer");
  await expect(card).toContainText("Answered");
});

test("composer stays flush and its trailing action becomes cancel without adding a row", async ({ page, request }) => {
  const id = await boot(page, request);
  await chooseChatModel(page, "Claude Sonnet");
  await page.locator("#chat-configuration-mode").selectOption("build");
  await page.locator("#chat-configuration-variant").selectOption("high");
  await page.locator("#chat-configuration-done").click();
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
    const trigger = actions.querySelector<HTMLElement>("#chat-configuration-trigger")!.getBoundingClientRect();
    const status = actions.querySelector<HTMLElement>("#chat-composer-status")!.getBoundingClientRect();
    const bounds = actions.getBoundingClientRect();
    const composer = actions.closest(".chat-composer")!;
    const style = getComputedStyle(composer);
    return {
      sendTop: send.top,
      sendBottom: send.bottom,
      triggerBottom: trigger.bottom,
      statusBottom: status.bottom,
      sendRight: send.right,
      boundsRight: bounds.right,
      margin: style.margin,
    };
  });
  expect(Math.abs(geometry.sendBottom - geometry.triggerBottom)).toBeLessThanOrEqual(3);
  expect(Math.abs(geometry.statusBottom - geometry.triggerBottom)).toBeLessThanOrEqual(2);
  expect(geometry.sendRight).toBeLessThanOrEqual(geometry.boundsRight + 1);
  expect(geometry.margin).toBe("0px");

  await page.locator("#chat-input").fill("First line");
  await page.locator("#chat-input").press("Shift+Enter");
  await expect(page.locator("#chat-input")).toHaveValue("First line\n");
  await page.locator("#chat-input").fill("Queued from touch");
  await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Cancel response");
  const queuedResponse = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await page.locator("#chat-input").press("Enter");
  expect((await queuedResponse).request().postDataJSON()).toMatchObject({ text: "Queued from touch" });
  // The busy submission pins at the composer, marked queued and removable.
  await expect(page.locator("#chat-queue .is-held")).toContainText("Queued from touch");
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

test("a surfaced request opens its child transcript and returns to the selected parent", async ({ page, request }) => {
  const parent = await boot(page, request);
  const child = await control(request, { action: "seed", title: "Child transcript", child: true, items: [
    { id: "part:request-child", type: "assistant_message", createdAt: 1, markdown: "request owner findings" },
  ] });
  await control(request, { action: "item", conversationId: parent, item: {
    id: "tool:request-agent", type: "tool", createdAt: 2, name: "task", status: "completed",
    input: JSON.stringify({ description: "Audit request", subagent_type: "explore", prompt: "go" }),
    childConversationId: child.conversation.id,
  } });
  await control(request, { action: "item", conversationId: parent, item: {
    id: "question:surfaced-touch", type: "question", createdAt: 3, requestId: "surfaced-touch",
    conversationId: child.conversation.id, status: "pending",
    questions: [{ header: "Scope", prompt: "Which scope?", multiple: false, allowFreeForm: false, options: [{ label: "Focused", description: "" }] }],
  } });

  const card = page.locator('[data-chat-item-id="question:surfaced-touch"]');
  await card.getByRole("button", { name: "Open transcript" }).click();
  await expect(page.locator("#chat-drilldown-items")).toContainText("request owner findings");
  await expect(page.locator("#chat-conversation-select")).toHaveValue(parent);

  await page.locator("#chat-drilldown-back").click();
  await expect(page.locator("#chat-drilldown")).toBeHidden();
  await expect(page.locator("#chat-conversation-select")).toHaveValue(parent);
  await expect(card).toBeVisible();
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
  // The request card is on screen in the parent transcript — where the pill
  // yields to it — so this also proves the pill returns once the drill-down
  // is pushed over it and the card can no longer be reached.
  await expect(page.locator('[data-chat-item-id="permission:p1"]')).toBeVisible();
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
  await installFakeVisualViewport(page);
  await boot(page, request);
  await openChatConfiguration(page);
  await expect(page.locator("#chat-configuration-done")).toBeFocused();
  await expect(page.locator("#chat-configuration-search")).not.toBeFocused();
  await expect(page.locator("#chat-configuration-search")).toHaveCSS("font-size", "16px");
  await expect(page.locator("#chat-configuration-dialog")).toHaveAttribute("data-presentation", "touch");
  const closedKeyboardBounds = await page.evaluate(() => {
    const dialog = document.querySelector("#chat-configuration-dialog")!.getBoundingClientRect();
    const surface = document.querySelector("#chat-surface")!.getBoundingClientRect();
    const tabs = document.querySelector("#touch-tab-bar")!.getBoundingClientRect();
    return { dialogBottom: dialog.bottom, surfaceBottom: surface.bottom, tabTop: tabs.top };
  });
  expect(closedKeyboardBounds.dialogBottom).toBeLessThanOrEqual(closedKeyboardBounds.surfaceBottom + 1);
  expect(closedKeyboardBounds.dialogBottom).toBeLessThanOrEqual(closedKeyboardBounds.tabTop + 1);
  await page.locator("#chat-configuration-search").focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport as VisualViewport & { height: number };
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
  });
  const sheetGeometry = await page.evaluate(() => {
    const dialog = document.querySelector("#chat-configuration-dialog")!.getBoundingClientRect();
    return { top: dialog.top, bottom: dialog.bottom, visualHeight: window.visualViewport!.height };
  });
  expect(sheetGeometry.top).toBeGreaterThanOrEqual(0);
  expect(sheetGeometry.bottom).toBeLessThanOrEqual(sheetGeometry.visualHeight + 1);
  await page.locator("#chat-configuration-done").click();
  await expect(page.locator("#chat-configuration-trigger")).toBeFocused();
  await expect(page.locator("#chat-input")).toHaveCSS("font-size", "16px");
  await page.locator("#chat-input").focus();
  await expect(page.locator("html")).toHaveAttribute("data-chat-editing", "");
  await expect(page.locator("#touch-tab-bar")).toBeHidden();
  await page.evaluate(() => {
    const reverted = document.querySelector<HTMLDetailsElement>("#chat-reverted")!;
    reverted.hidden = false;
    document.querySelector("#chat-reverted-items")!.replaceChildren(...Array.from({ length: 8 }, () => document.createElement("article")));
    const queue = document.querySelector<HTMLElement>("#chat-queue")!;
    queue.hidden = false;
    queue.replaceChildren(...Array.from({ length: 8 }, () => document.createElement("article")));
  });
  await page.evaluate(() => window.visualViewport!.dispatchEvent(new Event("resize")));
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "460px");
  await expect(page.locator("#chat-reverted-items")).toBeHidden();
  await expect(page.locator("#chat-queue")).toBeHidden();
  const geometry = await page.evaluate(() => {
    const composer = document.querySelector("#chat-composer")!.getBoundingClientRect();
    return { bottom: composer.bottom, visualHeight: window.visualViewport!.height, marginBottom: getComputedStyle(document.querySelector("#chat-composer")!).marginBottom };
  });
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.visualHeight + 1);
  expect(geometry.marginBottom).toBe("0px");
});

test("the surface recovers its height when the page returns with no viewport event", async ({ page, request }) => {
  // iOS restores a backgrounded page with the keyboard already dismissed and
  // fires no visual-viewport `resize`: the surface stayed the keyboard's size,
  // with a dead strip below it, until the user opened and dismissed the
  // keyboard again. The page-lifecycle transition is the only notification.
  await installFakeVisualViewport(page);
  await boot(page, request, { items: messages("loaded", 12) });
  await page.locator("#chat-input").focus();
  // Editing, so the bar contributes no inset: every `--chat-visual-height`
  // below is the whole visual viewport, which is the tabBarInset = 0 assertion.
  await expect(page.locator("html")).toHaveAttribute("data-chat-editing", "");

  await setVisualViewport(page, { height: 460 });
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "460px");
  await expect(page.locator("html")).toHaveAttribute("data-chat-keyboard", "");

  // The keyboard goes away while the app is in the background: the height is
  // simply different, and nothing announced it. Read back in the same turn as
  // the write, so the silence is observed rather than raced against.
  const afterSilentChange = await page.evaluate(() => {
    (window.visualViewport as VisualViewport & { height: number }).height = 844;
    return getComputedStyle(document.querySelector("#chat-surface")!).getPropertyValue("--chat-visual-height").trim();
  });
  expect(afterSilentChange).toBe("460px");

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  // The resync applies across a frame and a settle timer, so this is polled.
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "844px");
  await expect(page.locator("html")).not.toHaveAttribute("data-chat-keyboard", "");
  await expect.poll(() => page.evaluate(() => {
    const composer = document.querySelector("#chat-composer")!.getBoundingClientRect();
    return Math.round(composer.bottom - window.visualViewport!.height);
  })).toBeLessThanOrEqual(1);
});

test("a keyboard the platform pans for is still a keyboard", async ({ page, request }) => {
  // The reported iPhone geometry: an 844 layout, a 508 visual viewport panned
  // 266 up under the keyboard. Only 70px is occluded below the visible
  // rectangle, so an occlusion-based predicate called the keyboard absent and
  // left the pinned tracks holding their rows.
  await installFakeVisualViewport(page);
  await bootWithPinnedTracks(page, request);
  await page.locator("#chat-input").focus();
  // Editing, so the bar contributes no inset and `--chat-visual-height` below
  // is the whole visual viewport — the tabBarInset = 0 assertion.
  await expect(page.locator("html")).toHaveAttribute("data-chat-editing", "");

  await setVisualViewport(page, { height: 508, offsetTop: 266 });
  await expect(page.locator("html")).toHaveAttribute("data-chat-keyboard", "");
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "508px");
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-top", "266px");
  await expect(page.locator("#chat-task-list-items")).toBeHidden();
  await expect(page.locator("#chat-subagents-items")).toBeHidden();
  await expect(page.locator("#chat-background-tasks-items")).toBeHidden();
  // The rows yield; what each track reports does not.
  await expect(page.locator("#chat-task-list summary")).toBeVisible();
  await expect(page.locator("#chat-subagents summary")).toBeVisible();
  await expect(page.locator("#chat-background-tasks summary")).toBeVisible();
});

test("pinch zoom does not collapse progress tracks as a keyboard", async ({ page, request }) => {
  await installFakeVisualViewport(page);
  await bootWithPinnedTracks(page, request);
  const surface = page.locator("#chat-surface");
  const normalHeight = await surface.evaluate(element => element.style.getPropertyValue("--chat-visual-height"));
  await setVisualViewport(page, { height: 422, offsetTop: 100, scale: 2 });
  // Observe beyond the coalesced viewport callback, not just the old frame.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator("html")).not.toHaveAttribute("data-chat-keyboard");
  await expect(surface).toHaveCSS("--chat-visual-height", normalHeight);
  await expect(page.locator("#chat-task-list-items")).toBeVisible();
  await expect(page.locator("#chat-background-tasks-items")).toBeVisible();
  await setVisualViewport(page, { height: 460, offsetTop: 0, scale: 1 });
  await expect(page.locator("html")).toHaveAttribute("data-chat-keyboard", "");
  await expect(page.locator("#chat-task-list-items")).toBeHidden();
});

test("every pinned track expanded cannot displace the composer", async ({ page, request }) => {
  // The column is fixed-height and the transcript is its only shrinkable
  // child, so an unbounded track pushes the composer off the bottom edge
  // rather than clipping itself.
  await installFakeVisualViewport(page);
  await bootWithPinnedTracks(page, request);
  await page.locator("#chat-input").focus();
  // Editing, so the bar contributes no inset and `--chat-visual-height` below
  // is the whole visual viewport — the tabBarInset = 0 assertion.
  await expect(page.locator("html")).toHaveAttribute("data-chat-editing", "");

  await setVisualViewport(page, { height: 460 });
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "460px");
  await expect(page.locator("#chat-task-list-items")).toBeHidden();
  await expect(page.locator("#chat-subagents-items")).toBeHidden();
  await expect(page.locator("#chat-background-tasks-items")).toBeHidden();

  const geometry = await page.evaluate(() => {
    const composer = document.querySelector("#chat-composer")!.getBoundingClientRect();
    const send = document.querySelector("#chat-send")!.getBoundingClientRect();
    const timeline = document.querySelector("#chat-timeline")!.getBoundingClientRect();
    return { composerBottom: composer.bottom, sendBottom: send.bottom, timelineHeight: timeline.height, visualHeight: window.visualViewport!.height };
  });
  expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.visualHeight + 1);
  expect(geometry.sendBottom).toBeLessThanOrEqual(geometry.visualHeight + 1);
  // The transcript is what absorbed the reduction, and it still has room.
  expect(geometry.timelineHeight).toBeGreaterThan(0);
});

test("the outstanding-request pill leaves an answer field and its controls reachable", async ({ page, request }) => {
  // The pill floats over the transcript's lower right. A request at the end of
  // a long conversation put its free-form field and its Answer/Reject controls
  // exactly there, and `toBeVisible` says nothing about what is painted on top.
  const question: ConversationItem = {
    id: "question:clearance", type: "question", createdAt: 100, requestId: "clearance", status: "pending",
    questions: [{
      header: "Approach", prompt: "Which approach?", multiple: false, allowFreeForm: true,
      options: [{ label: "Minimal", description: "Small change" }],
    }],
  };
  await boot(page, request, { items: [...messages("loaded", 28), question] });
  const card = page.locator('[data-chat-item-id="question:clearance"]');
  const jump = page.locator("#chat-requests-jump");
  await expect(card).toBeVisible();
  // The card is the pill's own target and it is on screen, so the pill yields
  // to it — the count is still one, and it returns the moment the card is
  // scrolled away (covered by the report-yields case below).
  await expect(jump).toBeHidden();

  await card.getByRole("radio", { name: "Type your own answer" }).check();
  const customInput = card.locator("[data-question-custom-input]");
  await expect(customInput).toBeVisible();
  await expect(customInput).toBeFocused();
  // The answer field is a text control, so this is the same editing state —
  // and the same tabBarInset = 0 geometry — as the keyboard cases.
  await expect(page.locator("html")).toHaveAttribute("data-chat-editing", "");
  await customInput.fill("Touch-friendly");

  const primary = card.locator("[data-question-primary]");
  const reject = card.locator("[data-question-reject]");
  await expect(primary).toBeEnabled();
  await expect(jump).toBeHidden();
  expect(await paintedAtCentre(customInput)).toMatchObject({ reachable: true });
  expect(await paintedAtCentre(primary)).toMatchObject({ reachable: true });
  expect(await paintedAtCentre(reject)).toMatchObject({ reachable: true });

  // Reachable at the centre is the floor, not the requirement: the floats are
  // wide and the controls are narrow, so a centre that clears them says nothing
  // about the rest. The spec asks for no overlap at all, from the report or
  // from anything else the surface floats over the conversation — and the
  // Reject control clipped the pill's left edge before the timeline reserved
  // the strip. Rendered floats only: a display:none float has no box to hit.
  const overlaps = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(`[data-chat-item-id="question:clearance"] ${selector}`)!.getBoundingClientRect();
    const floats = ["#chat-requests-jump", "#chat-latest", "#chat-prompt-rail"]
      .map(selector => document.querySelector(selector)?.getBoundingClientRect())
      .filter((box): box is DOMRect => Boolean(box && box.width > 0 && box.height > 0));
    const hits = (other: DOMRect) => floats.some(float =>
      other.left < float.right && other.right > float.left && other.top < float.bottom && other.bottom > float.top);
    return { field: hits(rect("[data-question-custom-input]")), answer: hits(rect("[data-question-primary]")), reject: hits(rect("[data-question-reject]")) };
  });
  expect(overlaps).toEqual({ field: false, answer: false, reject: false });

  // And revealing the field held the conversation on the card being answered
  // rather than on whatever was topmost.
  // Measured at the controls rather than at the card's own border box: the
  // reveal places the question and its Answer/Reject row against the bottom of
  // the band, so the card's trailing padding is free to pass below the fold.
  // What must not happen is the conversation moving off this card.
  const held = await card.evaluate(element => {
    const timeline = document.querySelector("#chat-timeline")!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const controls = element.querySelector("[data-question-reject]")!.getBoundingClientRect();
    return { cardTop: bounds.top, controlsBottom: controls.bottom, timelineTop: timeline.top, timelineBottom: timeline.bottom };
  });
  expect(held.cardTop).toBeGreaterThanOrEqual(held.timelineTop - 1);
  expect(held.controlsBottom).toBeLessThanOrEqual(held.timelineBottom + 1);
});

/** The free-form question the answering cases put at the end of a
 *  conversation: one option beside "Type your own answer", so checking the
 *  custom choice reveals and focuses the field the keyboard opens for. */
const freeFormQuestion = (id: string, createdAt: number): ConversationItem => ({
  id: `question:${id}`, type: "question", createdAt, requestId: id, status: "pending",
  questions: [{
    header: "Approach", prompt: "Which approach?", multiple: false, allowFreeForm: true,
    options: [{ label: "Minimal", description: "Small change" }],
  }],
});

test("answering a request on touch puts the chrome under the keyboard and brings it back on blur", async ({ page, request }) => {
  // The chrome that cannot be acted on while the answer is being typed is not
  // taken away for it: the surface keeps its layout height, so the keyboard
  // simply covers the composer and the pinned tracks. They are under it rather
  // than gone — no reflow of the conversation on the way in, and dismissing
  // the keyboard is what brings them back. What the band above the keyboard
  // has to hold is the question: its field and its Answer/Reject controls.
  await installFakeVisualViewport(page);
  // Long enough to scroll: where the request settles is only a question the
  // transcript can answer if it has somewhere to move.
  const id = await bootWithPinnedTracks(page, request, messages("loaded", 28, 10));
  await control(request, { action: "item", conversationId: id, item: freeFormQuestion("answering", 100) });

  const card = page.locator('[data-chat-item-id="question:answering"]');
  const customInput = card.locator("[data-question-custom-input]");
  await expect(card).toBeVisible();
  await card.getByRole("radio", { name: "Type your own answer" }).check();
  await expect(customInput).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-chat-answering", "");

  // The keyboard takes the lower 384px; the surface keeps all 844 of the
  // layout height, which is what puts the chrome underneath it.
  await setVisualViewport(page, { height: 460 });
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "844px");
  // The timeline runs on under the keyboard too, so the strip it covers is
  // reserved as scroll room — without it a request at the end of the
  // conversation could never be lifted into the band above the keyboard.
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-keyboard-inset", "384px");
  await expect(page.locator(".chat-header")).toBeVisible();
  await expect(page.locator("#chat-requests-jump")).toBeHidden();
  await expect(page.locator("#chat-prompt-rail")).toBeHidden();

  // Below the keyboard's edge, not above it: still laid out, still there to
  // come back to. Polled with the field's own position, because the reveal
  // and the surface's height transition settle over the following frames.
  // `answerAtBandBottom` is the field-test regression: the Answer control has
  // to sit *directly* above the keyboard, not merely somewhere inside the
  // band — the reveal aligns the field and its Answer/Reject row to the
  // visible bottom less the timeline's scroll padding, so a strip wider than
  // that padding between the buttons and the keyboard is the bug.
  await expect.poll(() => page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const edge = window.visualViewport!.height;
    const pad = Number.parseFloat(getComputedStyle(document.querySelector("#chat-timeline")!).scrollPaddingBottom) || 0;
    const answerGap = box("[data-question-primary]").bottom - edge;
    return {
      composerTop: Math.round(box("#chat-composer").top - edge) >= -1,
      tasksTop: Math.round(box("#chat-task-list").top - edge) >= -1,
      fieldBottom: Math.round(box("[data-question-custom-input]").bottom - edge) <= 1,
      answerBottom: Math.round(answerGap) <= 1,
      answerAtBandBottom: answerGap >= -(pad + 4),
    };
  })).toEqual({ composerTop: true, tasksTop: true, fieldBottom: true, answerBottom: true, answerAtBandBottom: true });

  // Blur is what clears the state — `blur()` fires the `focusout` the surface
  // listens to, and the sync it schedules runs in a microtask. The fake
  // keyboard is still up, so the surface returns to the visible band and the
  // chrome lands above the keyboard's edge rather than back under it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator("html")).not.toHaveAttribute("data-chat-answering", "");
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "460px");
  await expect(page.locator("#chat-composer")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const edge = window.visualViewport!.height;
    return {
      composerBottom: Math.round(box("#chat-composer").bottom - edge) <= 1,
      tasksBottom: Math.round(box("#chat-task-list").bottom - edge) <= 1,
    };
  })).toEqual({ composerBottom: true, tasksBottom: true });

  // And with the keyboard gone the surface is the whole screen again, minus
  // the tab bar the blur brought back — so the height is read against the bar
  // rather than pinned to 844.
  await setVisualViewport(page, { height: 844 });
  await expect(page.locator("#touch-tab-bar")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const composer = document.querySelector("#chat-composer")!.getBoundingClientRect();
    const tabs = document.querySelector("#touch-tab-bar")!.getBoundingClientRect();
    return Math.round(composer.bottom - tabs.top);
  })).toBeLessThanOrEqual(1);
  await expect(page.locator("#chat-composer")).toBeVisible();
  await expect(page.locator("#chat-task-list")).toBeVisible();
  await expect(page.locator("#chat-subagents")).toBeVisible();
  await expect(page.locator("#chat-background-tasks")).toBeVisible();
});
test("the transcript holds still while an answer is typed", async ({ page, request }) => {
  // iOS autoscrolls a scroller natively while a caret or selection handle is
  // dragged near its edge, and it honours neither `overflow: hidden` nor
  // `touch-action: none` while it does. With the answer field focused that
  // runs the conversation away and takes the field off screen. The owner
  // holds the position its reveal established instead: a scroll it did not
  // write is undone on the next coordinated frame. Driven here as the
  // platform delivers it — a `scrollTop` the page never asked for, followed
  // by the `scroll` event that announces it.
  await installFakeVisualViewport(page);
  await boot(page, request, { items: [...messages("loaded", 28), freeFormQuestion("held", 100)] });
  const card = page.locator('[data-chat-item-id="question:held"]');
  const customInput = card.locator("[data-question-custom-input]");
  const timeline = page.locator("#chat-timeline");
  await card.getByRole("radio", { name: "Type your own answer" }).check();
  await expect(customInput).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-chat-answering", "");

  // The surface keeps its layout height while answering — the keyboard covers
  // its lower part — so the field's position is read against the visible band
  // rather than against the surface.
  await setVisualViewport(page, { height: 460 });
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "844px");
  const fieldOvershoot = () => page.evaluate(() => Math.round(
    document.querySelector("[data-question-custom-input]")!.getBoundingClientRect().bottom - window.visualViewport!.height));
  await expect.poll(fieldOvershoot).toBeLessThanOrEqual(1);
  // Read once it has stopped moving: the field is inside the band a frame or
  // two before the extent the reveal measures against has finished settling,
  // and the position the hold defends is the settled one.
  await expect.poll(stillScrollTop(timeline)).toBe(true);
  // And it settles directly above the keyboard: the held reveal aligns the
  // field together with its Answer/Reject row to the band's bottom, so what
  // separates the buttons from the keyboard's edge is the timeline's scroll
  // padding and nothing more.
  const answerAtBandBottom = () => page.evaluate(() => {
    const pad = Number.parseFloat(getComputedStyle(document.querySelector("#chat-timeline")!).scrollPaddingBottom) || 0;
    const gap = document.querySelector("[data-question-primary]")!.getBoundingClientRect().bottom - window.visualViewport!.height;
    return gap <= 1 && gap >= -(pad + 4);
  });
  await expect.poll(answerAtBandBottom).toBe(true);
  const held = await timeline.evaluate(element => element.scrollTop);
  expect(held).toBeGreaterThan(300);

  await timeline.evaluate(element => { element.scrollTop -= 300; element.dispatchEvent(new Event("scroll")); });
  await expect.poll(fieldOvershoot).toBeLessThanOrEqual(1);
  await expect.poll(answerAtBandBottom).toBe(true);
  await expect.poll(() => timeline.evaluate(element => element.scrollTop)).toBeGreaterThan(held - 2);
  expect(await timeline.evaluate(element => element.scrollTop)).toBeLessThan(held + 2);

  // Blur releases the hold: the transcript is the reader's again, and nothing
  // pulls it back to where the answer was being typed.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator("html")).not.toHaveAttribute("data-chat-answering", "");
  await expect(page.locator("#chat-composer")).toBeVisible();
  await timeline.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
  expect(await timeline.evaluate(element => element.scrollTop)).toBe(0);
});

async function expectAnswerAtKeyboard(card: Locator, timeline: Locator): Promise<void> {
  const padding = await timeline.evaluate(element => Number.parseFloat(getComputedStyle(element).scrollPaddingBottom) || 0);
  await expect.poll(() => card.evaluate((element, pad) => {
    const viewport = window.visualViewport!;
    const edge = viewport.offsetTop + viewport.height;
    const field = element.querySelector("[data-question-custom-input]")!.getBoundingClientRect();
    const actions = element.querySelector(".chat-request-actions")!.getBoundingClientRect();
    return field.top >= viewport.offsetTop && field.bottom <= edge + 1
      && actions.bottom <= edge + 1 && actions.bottom >= edge - pad - 4;
  }, padding)).toBe(true);
}

/** Seed through the actual fixture service and enter the same drill-down the
 * subagent row opens in production. No synthetic request DOM or focus events. */
async function bootAnswerOwner(page: Page, request: APIRequestContext, drilldown: boolean, questionId: string): Promise<{ parent: string; owner: string; timeline: Locator; card: Locator }> {
  const parent = await boot(page, request, { items: drilldown ? [freeFormQuestion("parent-waiting", 1)] : [...messages("answer-history", 28), freeFormQuestion(questionId, 100)] });
  let owner = parent;
  if (drilldown) {
    owner = (await control(request, { action: "seed", title: "Answer owner", child: true, items: [...messages("answer-history", 28), freeFormQuestion(questionId, 100)] })).conversation.id as string;
    await control(request, { action: "item", conversationId: parent, item: {
      id: "tool:answer-owner", type: "tool", createdAt: 200, name: "task", status: "completed",
      input: JSON.stringify({ description: "Answer owner", subagent_type: "explore", prompt: "go" }), childConversationId: owner,
    } });
    await page.locator("#chat-subagents summary").click();
    await page.getByRole("button", { name: "explore · Answer owner" }).click();
    await expect(page.locator("#chat-drilldown")).toBeVisible();
  }
  const timeline = page.locator(drilldown ? "#chat-drilldown-timeline" : "#chat-timeline");
  const card = timeline.locator(`[data-chat-item-id="question:${questionId}"]`);
  await card.getByRole("radio", { name: "Type your own answer" }).check();
  await card.locator("[data-question-custom-input]").fill("Keep it minimal");
  await expect(card.locator("[data-question-custom-input]")).toBeFocused();
  await setVisualViewport(page, { height: 460 });
  await expectAnswerAtKeyboard(card, timeline);
  await expect.poll(stillScrollTop(timeline)).toBe(true);
  return { parent, owner, timeline, card };
}

for (const drilldown of [false, true]) {
  for (const resolution of ["answer", "reject", "remote-remove"] as const) {
    test(`resolved answer clears editing and releases scroll without focusout (${drilldown ? "drill-down" : "parent"}, ${resolution})`, async ({ page, request }) => {
      await installFakeVisualViewport(page);
      const { owner, timeline, card } = await bootAnswerOwner(page, request, drilldown, "resolve-focus");
      await expect(page.locator("html")).toHaveAttribute("data-chat-answering", "");
      await expect(page.locator("#touch-tab-bar")).toBeHidden();
      // A real tap must retain WebKit's compatibility click while preventing
      // premature focus transfer; do not blur the input as test setup.
      if (resolution === "remote-remove") {
        await control(request, { action: "removeItem", conversationId: owner, itemId: "question:resolve-focus" });
      } else {
        await card.locator(resolution === "answer" ? "[data-question-primary]" : "[data-question-reject]").tap();
        await expect(card).toContainText(resolution === "answer" ? "Answered" : "Rejected");
      }
      await expect(card.locator("[data-question-custom-input]")).toHaveCount(0);
      await expect(page.locator("html")).not.toHaveAttribute("data-chat-answering", "");
      await expect(page.locator("html")).not.toHaveAttribute("data-chat-editing", "");
      await setVisualViewport(page, { height: 844 });
      await expect(page.locator("#touch-tab-bar")).toBeVisible();
      await expect.poll(stillScrollTop(timeline)).toBe(true);

      // Originally at the live end: answering is a temporary positioning
      // override, not an instruction to stop following subsequent output.
      const heightBeforeAppend = await timeline.evaluate(element => element.scrollHeight);
      await control(request, { action: "item", conversationId: owner, item: {
        id: "part:after-answer", type: "assistant_message", createdAt: 300,
        markdown: "After the answer\n\n" + "Fresh assistant output.\n\n".repeat(24),
      } });
      await expect(timeline.locator('[data-chat-item-id="part:after-answer"]')).toBeAttached();
      await expect.poll(() => timeline.evaluate(element => element.scrollHeight)).toBeGreaterThan(heightBeforeAppend + 100);
      await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(50);

      // A raw platform scroll after resolution must not be corrected back to
      // the now-detached field's stale position. No wheel/key release masks it.
      await timeline.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
      expect(await timeline.evaluate(element => element.scrollTop)).toBe(0);
    });
  }

  test(`live snapshot refresh retains an active answer hold (${drilldown ? "drill-down" : "parent"})`, async ({ page, request }) => {
    await installFakeVisualViewport(page);
    const { owner, timeline, card } = await bootAnswerOwner(page, request, drilldown, "refresh-focus");
    const snapshot = page.waitForResponse(response => response.url().includes(`/conversations/${encodeURIComponent(owner)}`)
      && response.request().method() === "GET" && !response.url().includes("/events"));
    await control(request, { action: "resync" });
    expect((await snapshot).ok()).toBe(true);
    await expect(card.locator("[data-question-custom-input]")).toBeFocused();
    await expect(card.locator("[data-question-custom-input]")).toHaveValue("Keep it minimal");
    // Wait past one-shot layout/reveal work, so it cannot hide a lost hold.
    await page.waitForTimeout(500);
    await expect.poll(stillScrollTop(timeline)).toBe(true);
    await timeline.evaluate(element => { element.scrollTop -= 200; element.dispatchEvent(new Event("scroll")); });
    await expectAnswerAtKeyboard(card, timeline);
    await card.locator("[data-question-primary]").tap();
    await expect(card.locator("[data-question-custom-input]")).toHaveCount(0);
    await setVisualViewport(page, { height: 844 });
    await expect(page.locator("#touch-tab-bar")).toBeVisible();
    await expect.poll(stillScrollTop(timeline)).toBe(true);
    const heightBeforeAppend = await timeline.evaluate(element => element.scrollHeight);
    await control(request, { action: "item", conversationId: owner, item: {
      id: "part:after-refresh-answer", type: "assistant_message", createdAt: 300,
      markdown: "Refreshed answer continuation\n\n" + "Fresh assistant output.\n\n".repeat(24),
    } });
    await expect(timeline.locator('[data-chat-item-id="part:after-refresh-answer"]')).toBeAttached();
    await expect.poll(() => timeline.evaluate(element => element.scrollHeight)).toBeGreaterThan(heightBeforeAppend + 100);
    await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(50);
  });
}

test("child answer clearance wins over a pending parent request pill", async ({ page, request }) => {
  await installFakeVisualViewport(page);
  const { card, timeline } = await bootAnswerOwner(page, request, true, "child-clearance");
  const parentPill = page.locator("#chat-requests-jump");
  // The child hides the parent request, so the pill is eligible in DOM state;
  // answering hides it only through CSS. Its :has selector must not steal
  // precedence from the child's keyboard inset and scroll-padding rules.
  await expect(parentPill).not.toHaveAttribute("hidden", "");
  await expect(parentPill).toBeHidden();
  await expect.poll(() => timeline.evaluate(element => {
    const style = getComputedStyle(element);
    const clearance = 0.6 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Math.abs(Number.parseFloat(style.scrollPaddingBottom) - clearance) < 0.1
      && Math.abs(Number.parseFloat(style.paddingBottom) - clearance - 384) < 0.1;
  })).toBe(true);
  await expectAnswerAtKeyboard(card, timeline);
  await expect.poll(() => paintedAtCentre(card.locator("[data-question-primary]"))).toMatchObject({ reachable: true });
});

for (const drilldown of [false, true]) {
  test(`answer hold follows direct field transfer and retained foreground focus (${drilldown ? "drill-down" : "parent"})`, async ({ page, request }) => {
    await installFakeVisualViewport(page);
    const parent = await boot(page, request);
    const owner = drilldown
      ? (await control(request, { action: "seed", title: "Answer owner", child: true, items: [] })).conversation.id as string
      : parent;
    const other = await control(request, { action: "seed", title: "Independent request owner", child: true, items: [] });
    for (const item of [...messages("answer-history", 28), freeFormQuestion("transfer-a", 100),
      { ...freeFormQuestion("transfer-b", 101), conversationId: other.conversation.id }]) {
      await control(request, { action: "item", conversationId: owner, item });
    }
    if (drilldown) {
      await control(request, { action: "item", conversationId: parent, item: {
        id: "tool:answer-owner", type: "tool", createdAt: 200, name: "task", status: "completed",
        input: JSON.stringify({ description: "Answer owner", subagent_type: "explore", prompt: "go" }), childConversationId: owner,
      } });
      await page.locator("#chat-subagents summary").click();
      await page.getByRole("button", { name: "explore · Answer owner" }).click();
      await expect(page.locator("#chat-drilldown")).toBeVisible();
    }
    const timeline = page.locator(drilldown ? "#chat-drilldown-timeline" : "#chat-timeline");
    const a = timeline.locator('[data-chat-item-id="question:transfer-a"]');
    const b = timeline.locator('[data-chat-item-id="question:transfer-b"]');
    // Open both editors first. The regression is a direct input-to-input
    // transfer, not clicking a radio (which would blur out of answering).
    for (const card of [a, b]) {
      await card.getByRole("radio", { name: "Type your own answer" }).check();
      // Release setup focus before Playwright scrolls the next radio into
      // view; the direct field-to-field transfer is exercised below.
      await card.locator("[data-question-custom-input]").evaluate(element => (element as HTMLElement).blur());
      // Blur resumes following and restores the tab bar through a height
      // transition. Let both settle before Playwright scrolls the next radio
      // into view; otherwise WebKit can scroll the outer chat surface during
      // setup, displacing the entire timeline before the transfer is tested.
      await expect(page.locator("html")).not.toHaveAttribute("data-chat-answering", "");
      await expect.poll(() => page.locator("#chat-surface").evaluate(element => Math.abs(
        element.getBoundingClientRect().bottom - document.querySelector("#touch-tab-bar")!.getBoundingClientRect().top,
      ))).toBeLessThan(0.5);
      await expect.poll(stillScrollTop(timeline)).toBe(true);
    }
    expect(await page.locator("#chat-surface").evaluate(element => element.scrollTop)).toBe(0);
    await a.locator("[data-question-custom-input]").evaluate(element => (element as HTMLElement).focus({ preventScroll: true }));
    await setVisualViewport(page, { height: 460 });
    await expectAnswerAtKeyboard(a, timeline);
    await b.locator("[data-question-custom-input]").evaluate(element => (element as HTMLElement).focus({ preventScroll: true }));
    await expectAnswerAtKeyboard(b, timeline);
    await expect.poll(stillScrollTop(timeline)).toBe(true);
    await timeline.evaluate(element => { element.scrollTop -= 150; element.dispatchEvent(new Event("scroll")); });
    await expectAnswerAtKeyboard(b, timeline);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(b.locator("[data-question-custom-input]")).toBeFocused();
    // Let lifecycle reveal/settle work finish before injecting caret scroll;
    // a pending one-shot reveal must not disguise a missing standing hold.
    await page.waitForTimeout(500);
    await expect.poll(stillScrollTop(timeline)).toBe(true);
    await timeline.evaluate(element => { element.scrollTop -= 150; element.dispatchEvent(new Event("scroll")); });
    await expectAnswerAtKeyboard(b, timeline);
  });
}

test("answering corrects a combined resize and pan with an unchanged visible bottom", async ({ page, request }) => {
  await installFakeVisualViewport(page);
  await boot(page, request, { items: [...messages("pan-history", 28), freeFormQuestion("resize-pan", 100)] });
  const card = page.locator('[data-chat-item-id="question:resize-pan"]');
  const timeline = page.locator("#chat-timeline");
  await card.getByRole("radio", { name: "Type your own answer" }).check();
  await setVisualViewport(page, { height: 460, offsetTop: 0 });
  await expectAnswerAtKeyboard(card, timeline);
  await page.waitForTimeout(500);
  await expect.poll(stillScrollTop(timeline)).toBe(true);
  // Exactly one geometry notification, no later focus, item or resize to
  // mask the missed correction. Layout height and visible bottom stay fixed.
  await setVisualViewport(page, { height: 360, offsetTop: 100 });
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "844px");
  await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-top", "100px");
  await expectAnswerAtKeyboard(card, timeline);
});

test("focusing a request's answer field does not zoom the page", async ({ page, request }) => {
  // iOS zooms the page on focus for any text control under 16px, and the
  // free-form answer field is the one that takes focus mid-conversation —
  // the same rule the composer and the configuration dialog already carry.
  await boot(page, request, { items: [freeFormQuestion("zoom", 1)] });
  const card = page.locator('[data-chat-item-id="question:zoom"]');
  const customInput = card.locator("[data-question-custom-input]");
  await card.getByRole("radio", { name: "Type your own answer" }).check();
  await expect(customInput).toBeFocused();
  await expect(customInput).toHaveCSS("font-size", "16px");
});

test("the outstanding-request report yields to a visible request", async ({ page, request }) => {
  // The pill leads to a request; while that request is already on screen it
  // has nothing to offer, and it floats over the very card the reader would
  // be answering. It comes back — with the same count — once the card is
  // scrolled away and the report is the only way back to it.
  await boot(page, request, { items: [...messages("loaded", 28), freeFormQuestion("yields", 100)] });
  const card = page.locator('[data-chat-item-id="question:yields"]');
  const timeline = page.locator("#chat-timeline");
  const jump = page.locator("#chat-requests-jump");
  await expect(card).toBeVisible();

  await timeline.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
  await expect(card).toBeInViewport();
  // Asserted by retrying: the observer answers off the scroll path, a frame
  // or more after the position it is answering about.
  await expect(jump).toBeHidden();

  await timeline.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await expect(jump).toBeVisible();
  // Yielding is about whether the report shows, never about what it counts.
  await expect(jump).toHaveText("1 request needs your answer");
  // And while it is shown the timeline reserves its strip, so the request it
  // leads to is not parked underneath it on arrival.
  await expect(timeline).toHaveCSS("padding-bottom", "56px");
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
      "cat /workspace/packages/preview/src/components/markdown/code-block-decorations/language-detection-heuristics.ts",
      "sed -n '1,80p' /workspace/README.md",
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

test("completed code copy stays reachable without hover or reflow", async ({ page, request }) => {
  await boot(page, request, { items: [{
    id: "part:copy", type: "assistant_message", createdAt: 1,
    markdown: "Touch answer\n\n```ts\nconst touch = true;\n```",
  }] });
  await installClipboardMock(page);
  const message = page.locator('[data-chat-item-id="part:copy"]');
  const answer = message.locator('[data-chat-copy="answer"]');
  const code = message.locator('[data-chat-copy="code"]');
  await expect(answer).toHaveCount(0);
  await expect(code).toBeVisible();
  await expect(code).toHaveCSS("opacity", "1");
  const before = await message.boundingBox();
  await code.tap();
  expect(await readClipboardMock(page)).toBe("const touch = true;\n");
  await expect(code).toHaveAttribute("data-state", "copied");
  const after = await message.boundingBox();
  expect(after?.width).toBeCloseTo(before?.width ?? 0, 1);
  expect(after?.height).toBeCloseTo(before?.height ?? 0, 1);
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

// The folded rate-limit chip in the layout where composer room is scarcest:
// a second chip beside it used to compete for the same row.
test.describe("rate-limit standing in touch mode", () => {
  test("the standing rides the plan chip and opens, with no timeline row", async ({ page, request }, testInfo) => {
    const id = await boot(page, request, { items: [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Keep going" },
      { id: "context:report:1", type: "context_report", createdAt: 2, total: 24_000, max: 200_000, plan: { fiveHour: { utilization: 9, resetsAt: Date.now() + 3_600_000 }, sevenDay: { utilization: 25, resetsAt: Date.now() + 3_600_000 } } },
    ] });
    const chip = page.locator("#chat-plan-usage");
    const summary = page.locator("#chat-plan-usage-summary");
    await expect(summary).toHaveText("Session 9% · Week 25%");

    await control(request, { action: "item", conversationId: id, item: { id: "notice:rate-limit", type: "notice", createdAt: 3, level: "warning", message: "Approaching your 7-day (overage included) rate limit (77% used).", code: "rate-limit-warning", resetsAt: Date.now() + 3_600_000 } });
    await expect(chip).toHaveAttribute("data-level", "warning");
    await expect(page.locator('[data-chat-item-id="notice:rate-limit"]')).toHaveCount(0);
    await captureScreenshot(page, testInfo, "touch-rate-limit-warning");
    // It opens here too, and the readout stays clear of the composer.
    await summary.click();
    await expect(page.locator("#chat-plan-readout-standing")).toBeVisible();
    await captureScreenshot(page, testInfo, "touch-rate-limit-warning-readout");
    await summary.click();

    await control(request, { action: "item", conversationId: id, item: { id: "notice:rate-limit", type: "notice", createdAt: 3, level: "error", message: "Rate limit reached for your 7-day window.", code: "rate-limit-rejected", resetsAt: Date.now() + 3_600_000 } });
    await expect(summary).toHaveText(/^Rate limited · resets /);
    await expect(chip).toHaveAttribute("data-level", "rejected");
    await captureScreenshot(page, testInfo, "touch-rate-limit-rejected");
  });
});

test("the touch chooser files both agents' conversations under their days", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", count: 2 });
  const now = new Date();
  const at = (daysAgo: number, hour: number, minute = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute).getTime();
  await control(request, { action: "seed", agent: "opencode", title: "OpenCode yesterday", items: [], updatedAt: at(1, 9, 30) });
  const today = await control(request, { action: "seed", agent: "claude", title: "Claude today", items: [], updatedAt: at(0, 0, 1) });
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await page.locator("#touch-tab-chat").click();
  const select = page.locator("#chat-conversation-select");
  await expect(select).toHaveValue(today.conversation.id);
  await expect(select.locator("optgroup")).toHaveCount(2);
  const groups = await select.locator("optgroup").evaluateAll(nodes => nodes.map(node => [
    (node as HTMLOptGroupElement).label,
    Array.from(node.querySelectorAll("option")).map(option => option.textContent),
  ]));
  expect(groups.map(([label]) => label)).toEqual(["Today", "Yesterday"]);
  expect(groups[0]![1]).toEqual([expect.stringMatching(/^Claude today · Claude Code · 00:01$/)]);
  expect(groups[1]![1]).toEqual([expect.stringMatching(/^OpenCode yesterday · OpenCode · 09:30$/)]);
});

test("day separators and wrapped slash-command descriptions fit the touch layout", async ({ page, request }, testInfo) => {
  // Seeded before the page exists, so the days are local to the test runner,
  // which shares the browser's zone.
  const now = new Date();
  const at = (offset: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, hour, 0).getTime();
  // Each prompt gets a full-width reply, so there is transcript text beside
  // the pinned label.
  const withReplies = (prompts: ConversationItem[]): ConversationItem[] => prompts.flatMap(prompt => [prompt, {
    id: `${prompt.id}-reply`, type: "assistant_message" as const, createdAt: prompt.createdAt, markdown: `Reply ${"to the prompt above, at full width ".repeat(3)}`,
  }]);
  const items: ConversationItem[] = [
    ...withReplies(messages("yesterday", 6, at(1, 12))),
    ...withReplies(messages("today", 2, at(0, 0) + 60_000)),
  ];
  await boot(page, request, { items });
  const separators = page.locator("#chat-items > .chat-day-separator");
  await expect(separators).toHaveText(["Yesterday", "Today"]);
  // Yesterday pinned over one of its replies: only the label covers it; the
  // reply shows and takes taps on either side of the label.
  await page.locator('[data-chat-item-id="message:yesterday-3-reply"]').evaluate(element => {
    const timeline = element.closest<HTMLElement>(".chat-timeline")!;
    timeline.scrollTop += element.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 2;
  });
  const pinned = () => separators.first().evaluate(element => {
    const timeline = element.closest(".chat-timeline")!.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    const label = element.querySelector("time")!.getBoundingClientRect();
    const y = label.top + label.height / 2;
    const hit = (x: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId ?? null;
    return {
      withinWidth: row.left >= timeline.left - 1 && row.right <= timeline.right + 1,
      stuck: Math.abs(row.top - timeline.top) <= 1,
      left: hit(label.left - 16),
      right: hit(label.right + 16),
    };
  });
  await expect.poll(pinned).toEqual({ withinWidth: true, stuck: true, left: "message:yesterday-3-reply", right: "message:yesterday-3-reply" });
  await captureScreenshot(page, testInfo, "touch-day-separators");

  const hintText = "[path/to/a/long/argument] [--comment] [--effort=low|medium|high] [--base=origin/main]";
  const overlong = `[--${"a-single-token-wider-than-the-menu-".repeat(3)}]`;
  await control(request, { action: "commands", commands: [{
    name: "code-review-with-a-rather-long-command-name", kind: "skill", argumentHint: hintText,
    description: `${"Review the diff for correctness bugs, reuse, simplification, and efficiency cleanups at the chosen effort level. ".repeat(2)}End of review.`,
  }, { name: "overlong-hint", kind: "skill", argumentHint: overlong, description: "One token wider than the menu." }] });
  await page.reload();
  await page.locator("#touch-tab-chat").click();
  const input = page.locator("#chat-input");
  await input.fill("/code-review-with");
  const menu = page.locator("#chat-command-menu");
  await expect(menu.getByRole("option")).toHaveCount(1);
  const measured = await menu.evaluate(element => {
    const description = element.querySelector<HTMLElement>(".chat-command-description")!;
    const hint = element.querySelector<HTMLElement>(".chat-command-hint")!;
    const tokens = [...hint.querySelectorAll<HTMLElement>(".chat-command-hint-token")].map(token => ({ text: token.textContent, bounds: token.getBoundingClientRect() }));
    const lineHeight = Math.min(...tokens.map(token => token.bounds.height));
    return {
      // Beside a name too long to leave it room, the hint drops to its own
      // line rather than wrapping a character per line in a sliver.
      hintWidth: hint.getBoundingClientRect().width,
      hintLines: new Set(tokens.map(token => Math.round(token.bounds.top))).size,
      hintText: hint.textContent,
      // Each token stays whole on one line: "[--comment]" is not split after
      // "--", and no "]" is left on a line of its own.
      brokenTokens: tokens.filter(token => token.bounds.height > lineHeight * 1.5).map(token => token.text),
      horizontal: element.scrollWidth - element.clientWidth,
      text: description.textContent,
      clipped: description.scrollHeight > description.clientHeight + 1 || description.scrollWidth > description.clientWidth + 1,
    };
  });
  expect(measured.horizontal).toBeLessThanOrEqual(1);
  expect(measured.text).toContain("End of review.");
  expect(measured.clipped).toBe(false);
  expect(measured.hintWidth).toBeGreaterThanOrEqual(120);
  expect(measured.hintText).toBe(hintText);
  expect(measured.brokenTokens).toEqual([]);
  // It wraps, but only between its four tokens.
  expect(measured.hintLines).toBeGreaterThanOrEqual(2);
  expect(measured.hintLines).toBeLessThanOrEqual(4);
  await captureScreenshot(page, testInfo, "touch-slash-command-descriptions-wrap");

  // Only a token wider than the whole menu is broken, and then within it.
  await input.fill("/overlong-hint");
  const option = menu.getByRole("option").filter({ hasText: "/overlong-hint" });
  await expect(option).toHaveCount(1);
  const overflowing = await option.evaluate(element => {
    const menu = element.closest<HTMLElement>("#chat-command-menu")!;
    const token = element.querySelector<HTMLElement>(".chat-command-hint-token")!;
    // The one-line name gives the height of a line.
    const lineHeight = element.querySelector<HTMLElement>(".chat-command-name")!.getBoundingClientRect().height;
    return { horizontal: menu.scrollWidth - menu.clientWidth, lines: Math.round(token.getBoundingClientRect().height / lineHeight), text: token.textContent };
  });
  expect(overflowing.horizontal).toBeLessThanOrEqual(1);
  expect(overflowing.lines).toBeGreaterThanOrEqual(2);
  expect(overflowing.text).toBe(overlong);
});
