import type { APIRequestContext, Page } from "@playwright/test";

import type { ConversationItem } from "../../src/chat/types";
import { chooseChatModel, installClipboardMock, openChatConfiguration, openChatPanel, readClipboardMock } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
import { expect, test } from "./fixtures";

async function bootChat(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
}

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

test.describe("desktop OpenCode chat", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("keeps workspace identity above full-width conversation controls", async ({ page }) => {
    const rows = await page.locator(".chat-header").evaluate(header => {
      const identity = header.querySelector(".chat-identity")!.getBoundingClientRect();
      const controls = header.querySelector(".chat-conversation-controls")!.getBoundingClientRect();
      const childrenContained = [...header.querySelector(".chat-conversation-controls")!.children].filter(child => getComputedStyle(child).display !== "none").every(child => {
        const bounds = child.getBoundingClientRect();
        return bounds.left >= controls.left - 1 && bounds.right <= controls.right + 1;
      });
      return { identityTop: identity.top, identityBottom: identity.bottom, controlsTop: controls.top, identityWidth: identity.width, controlsWidth: controls.width, childrenContained };
    });
    expect(rows.controlsTop).toBeGreaterThanOrEqual(rows.identityBottom);
    expect(Math.abs(rows.identityWidth - rows.controlsWidth)).toBeLessThan(2);
    expect(rows.childrenContained).toBe(true);
  });

  test("creates, resumes, queues, cancels, and retains the mounted surface", async ({ page }) => {
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    const firstId = await page.locator("#chat-conversation-select").inputValue();
    const configurationTrigger = page.locator("#chat-configuration-trigger");
    await chooseChatModel(page, "GPT-5");
    await page.locator("#chat-configuration-done").click();

    const input = page.locator("#chat-input");
    await input.fill("Initial prompt");
    const firstResponse = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Enter");
    await expect(configurationTrigger).toBeDisabled();
    const response = await firstResponse;
    expect(response.request().postDataJSON()).toMatchObject({ model: { providerId: "openai", modelId: "gpt-5" } });
    expect(await response.json()).toMatchObject({ held: false, conversation: { title: "Initial prompt" } });
    await expect(page.locator("#chat-title")).toHaveText("Initial prompt");
    await expect(page.locator("#chat-conversation-select option:checked")).toHaveText("Initial prompt");
    await expect(configurationTrigger).toBeEnabled();
    await expect(page.locator("#chat-items")).toContainText("Initial prompt");
    // The fixed trailing action becomes cancel while the turn is live.
    await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Cancel response");
    // With a turn in flight and nothing back yet, the timeline's working
    // line says so — the same line the first step will join.
    await expect(page.locator(".chat-activity-group.is-awaiting")).toBeVisible();
    await expect(page.locator(".chat-activity-group.is-awaiting")).toContainText("Working");

    await input.fill("Use the smaller approach");
    const heldResponse = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Enter");
    expect(await (await heldResponse).json()).toMatchObject({ held: true });
    // The busy submission pins at the composer as a held message.
    await expect(page.locator("#chat-queue .is-held")).toContainText("Use the smaller approach");

    await input.fill("draft retained across surfaces");
    // Collapse to the strip and reopen: the surface stays mounted, so the
    // draft, model choice, and conversation survive — and Preview is
    // co-visible the whole time.
    await page.locator("#chat-collapse").click();
    await expect(page.locator("#chat-timeline")).toBeHidden();
    await expect(page.locator(".preview-shell")).toBeVisible();
    await openChatPanel(page);
    await expect(input).toHaveValue("draft retained across surfaces");
    await expect(configurationTrigger).toContainText("GPT-5");

    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-composer-status")).toHaveAttribute("aria-label", "Cancelled");
    await expect(page.locator("#chat-items")).toContainText("Initial prompt");

    await page.reload();
    await openChatPanel(page);
    await expect(configurationTrigger).toContainText("GPT-5");
    await expect(page.locator("#chat-title")).toHaveText("Initial prompt");

    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue(firstId);
    await page.locator("#chat-conversation-select").selectOption(firstId);
    await expect(page.locator("#chat-items")).toContainText("Initial prompt");
    await expect(input).toHaveValue("draft retained across surfaces");
  });

  test("switches the mode for a prompt and defaults to the agent's own", async ({ page }) => {
    await page.getByRole("button", { name: "New conversation" }).click();
    await openChatConfiguration(page);
    const modeSelect = page.locator("#chat-configuration-mode");
    await expect(modeSelect.locator("option")).toHaveText(["Let Fixture Agent choose", "Build", "Plan"]);
    await expect(modeSelect).toHaveValue("");
    await page.locator("#chat-configuration-done").click();

    const input = page.locator("#chat-input");
    await input.fill("stay on the default mode");
    const defaulted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Enter");
    expect((await defaulted).request().postDataJSON()).not.toHaveProperty("mode");

    // Stuck in a read-only mode is the whole point: choosing Build must
    // reach the provider with the next prompt.
    await openChatConfiguration(page);
    await modeSelect.selectOption("build");
    await page.locator("#chat-configuration-done").click();
    await input.fill("now write some code");
    const switched = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Enter");
    expect((await switched).request().postDataJSON()).toMatchObject({ mode: "build" });

    await expect(modeSelect).toHaveValue("build");
  });

  // The surface takes its name from what the agent reported, so a workspace
  // with a different agent renames itself without a line of copy changing.
  test("names the agent it is talking to", async ({ page }) => {
    await expect(page.locator("#chat-title")).toHaveText("Fixture Agent Chat");
    await expect(page.locator("#chat-input")).toHaveAttribute("placeholder", "Ask Fixture Agent…");
    // The visible header, not only the assistive one: a workspace always has a
    // root label, so the agent has to sit beside it rather than behind it.
    await expect(page.locator("#chat-context")).toContainText("Fixture Agent");
  });

  // A model that advertises reasoning variants gets a control for them, sent
  // with the prompt; a model without variants shows none.
  test("offers a model's reasoning variants and sends the chosen one", async ({ page, request }) => {
    await page.getByRole("button", { name: "New conversation" }).click();
    const variantSelect = page.locator("#chat-configuration-variant");
    // Unknown configuration selects no inventory default. Choosing Claude
    // explicitly reveals its high/xhigh variants; GPT-5 advertises none.
    await chooseChatModel(page, "Claude Sonnet");
    await expect(variantSelect).toBeVisible();
    await expect(variantSelect.locator("option")).toHaveText(["Let Fixture Agent choose reasoning", "High", "Extra high"]);
    await page.locator(".chat-configuration-model", { hasText: "GPT-5" }).click();
    await expect(variantSelect).toBeHidden();
    await page.locator(".chat-configuration-model", { hasText: "Claude Sonnet" }).click();
    await variantSelect.selectOption("xhigh");
    await page.locator("#chat-configuration-done").click();

    const input = page.locator("#chat-input");
    await input.fill("think hard about this");
    const sent = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Enter");
    expect((await sent).request().postDataJSON()).toMatchObject({ variant: "xhigh" });
  });

  // The one path a workspace with a single real agent can never reach: an
  // agent that offers less. The control must be gone, not disabled — a
  // disabled control claims the feature exists and is merely unavailable now.
  test("removes a control the agent does not declare", async ({ page, request }) => {
    await control(request, { action: "declareOnly", capabilities: ["models", "commands", "permissions"] });
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
    await page.getByRole("button", { name: "New conversation" }).click();
    await openChatConfiguration(page);
    await expect(page.locator("#chat-configuration-models-section")).toBeVisible();
    await expect(page.locator("#chat-configuration-mode-section")).toBeHidden();
  });

  test("completes slash commands at the caret without sending prematurely", async ({ page }) => {
    await page.getByRole("button", { name: "New conversation" }).click();
    const input = page.locator("#chat-input");
    await input.fill("Use /rev");
    const menu = page.locator("#chat-command-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option")).toHaveCount(1);
    await expect(menu).toContainText("/review");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("Use /review ");
    await expect(menu).toBeHidden();

    await input.fill("/archive");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option")).toHaveCount(1);
    await expect(menu).toContainText("/openspec-archive-change");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("/openspec-archive-change ");
    await expect(menu).toBeHidden();

    await input.fill("/review API routes");
    const response = page.waitForResponse(candidate => candidate.url().endsWith("/prompts"));
    await page.locator("#chat-send").click();
    expect((await response).request().postDataJSON()).toMatchObject({ text: "/review API routes" });
    await expect(page.locator("#chat-items")).toContainText("/review API routes");
  });

  test("wraps long slash-command descriptions in full and keeps the highlight in view", async ({ page, request }, testInfo) => {
    const long = (topic: string) => `${topic}: ${"Review the diff for correctness bugs, reuse, simplification, and efficiency cleanups at the chosen effort level, then report ranked findings. ".repeat(3)}End of ${topic}.`;
    await control(request, { action: "commands", commands: Array.from({ length: 6 }, (_, index) => ({
      name: `code-lint-${index}`, description: long(`lint ${index}`), argumentHint: "[path/to/a/rather/long/argument/hint/that/also/wraps]", kind: "skill",
    })) });
    await page.reload();
    await openChatPanel(page);
    await page.getByRole("button", { name: "New conversation" }).click();
    const input = page.locator("#chat-input");
    await input.fill("/code-lint");
    const menu = page.locator("#chat-command-menu");
    await expect(menu.getByRole("option")).toHaveCount(6);
    const measured = await menu.evaluate(element => ({
      horizontal: element.scrollWidth - element.clientWidth,
      descriptions: [...element.querySelectorAll<HTMLElement>(".chat-command-description")].map(description => ({
        text: description.textContent,
        // Line height is "normal" here; two font sizes is well past one line.
        multiline: description.getBoundingClientRect().height > 2 * parseFloat(getComputedStyle(description).fontSize),
        clipped: description.scrollHeight > description.clientHeight + 1 || description.scrollWidth > description.clientWidth + 1,
        ellipsis: getComputedStyle(description).textOverflow,
        whiteSpace: getComputedStyle(description).whiteSpace,
      })),
    }));
    expect(measured.horizontal).toBeLessThanOrEqual(1);
    for (const [index, description] of measured.descriptions.entries()) {
      // Every suggestion, highlighted or not, shows its whole description.
      expect(description.text).toContain(`End of lint ${index}.`);
      expect(description.multiline).toBe(true);
      expect(description.clipped).toBe(false);
      expect(description.ellipsis).not.toBe("ellipsis");
      expect(description.whiteSpace).not.toBe("nowrap");
    }
    await captureScreenshot(page, testInfo, "slash-command-descriptions-wrap");

    // The highlight walks down through tall options and stays inside the menu.
    const inView = () => menu.evaluate(element => {
      const active = element.querySelector<HTMLElement>(".chat-command-option.is-active")!;
      const bounds = element.getBoundingClientRect();
      const option = active.getBoundingClientRect();
      return { name: active.querySelector(".chat-command-name")!.textContent, visible: option.top >= bounds.top - 1 && option.bottom <= bounds.bottom + 1 };
    });
    for (let step = 1; step < 6; step++) {
      await page.keyboard.press("ArrowDown");
      await expect.poll(inView).toEqual({ name: `/code-lint-${step}`, visible: true });
    }
    for (let step = 4; step >= 0; step--) {
      await page.keyboard.press("ArrowUp");
      await expect.poll(inView).toEqual({ name: `/code-lint-${step}`, visible: true });
    }
  });

  test("dates the conversation with sticky day separators", async ({ page, request }, testInfo) => {
    // Local instants in the page's zone: two days ago, yesterday, and today.
    const days = await page.evaluate(() => {
      const today = new Date();
      const at = (offset: number, hour: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, hour, 0).getTime();
      const older = new Date(at(2, 9));
      const iso = `${older.getFullYear()}-${String(older.getMonth() + 1).padStart(2, "0")}-${String(older.getDate()).padStart(2, "0")}`;
      return { older: at(2, 9), yesterday: at(1, 9), today: at(0, 0) + 60_000, olderLabel: `${older.toLocaleDateString([], { weekday: "short" })} ${iso}` };
    });
    // Prompts alternate with full-width replies, so there is transcript text
    // beside a pinned label as well as under it.
    const run = (prefix: string, start: number, count: number): ConversationItem[] => Array.from({ length: count }, (_, index) => {
      const text = `${prefix} message ${index} ${"content ".repeat(14)}`;
      return index % 2
        ? { id: `message:${prefix}-${index}`, type: "assistant_message", createdAt: start + index * 60_000, markdown: text }
        : { id: `message:${prefix}-${index}`, type: "user_message", createdAt: start + index * 60_000, text };
    });
    const seeded = await control(request, { action: "seed", title: "Dated", items: [...run("older", days.older, 3), ...run("yesterday", days.yesterday, 24), ...run("today", days.today, 3)] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id);
    const separators = page.locator("#chat-items > .chat-day-separator");
    await expect(separators).toHaveText([days.olderLabel, "Yesterday", "Today"]);
    const order = await page.locator("#chat-items > *").evaluateAll(nodes => nodes.map(node => node.classList.contains("chat-day-separator") ? `day:${node.textContent}` : node.getAttribute("data-chat-item-id")));
    expect(order.indexOf("day:Yesterday")).toBe(order.indexOf("message:yesterday-0") - 1);
    expect(order.indexOf("day:Today")).toBe(order.indexOf("message:today-0") - 1);
    await expect(separators.nth(1)).toHaveAttribute("role", "separator");
    await expect(separators.nth(1)).not.toHaveAttribute("data-chat-item-id", /.*/);

    // Scroll back into the middle of yesterday: its separator stays pinned at the top.
    const timeline = page.locator("#chat-timeline");
    await page.locator('[data-chat-item-id="message:yesterday-14"]').evaluate(element => element.scrollIntoView({ block: "center" }));
    // The labels a reader sees at the top of the transcript. Every day already
    // passed is pinned there too, but only the latest one's label is shown.
    const pinnedLabels = async () => timeline.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      return [...element.querySelectorAll<HTMLElement>(".chat-day-separator time")].filter(label => {
        const bounds = label.getBoundingClientRect();
        return bounds.top >= top - 1 && bounds.top <= top + 60 && getComputedStyle(label).visibility === "visible";
      }).map(label => label.textContent);
    });
    await expect.poll(pinnedLabels).toEqual(["Yesterday"]);
    await expect(separators.first()).toHaveAttribute("data-superseded", "");

    // Only the label covers the transcript: beside it, the text scrolled under
    // the pinned row is what a tap or a selection reaches.
    // Scrolled and measured in one task, and retried, so a settling scroll
    // cannot move the reply between the two.
    const beside = () => separators.nth(1).evaluate(separator => {
      const timeline = separator.closest<HTMLElement>("#chat-timeline")!;
      const replyNode = document.querySelector<HTMLElement>('[data-chat-item-id="message:yesterday-15"]')!;
      timeline.scrollTop += replyNode.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 4;
      const label = separator.querySelector("time")!.getBoundingClientRect();
      const row = separator.getBoundingClientRect();
      const reply = replyNode.getBoundingClientRect();
      const y = label.top + label.height / 2;
      const hit = (x: number) => {
        const element = document.elementFromPoint(x, y);
        return { separator: !!element?.closest(".chat-day-separator"), item: element?.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId ?? null };
      };
      return {
        background: getComputedStyle(separator).backgroundColor,
        pointerEvents: getComputedStyle(separator).pointerEvents,
        underRow: reply.top < y && reply.bottom > y && row.top <= y && row.bottom >= y,
        left: hit(Math.max(row.left, reply.left) + 12),
        right: hit(Math.min(row.right, reply.right) - 12),
        label: hit(label.left + label.width / 2).separator,
      };
    });
    await expect.poll(beside).toEqual({
      background: "rgba(0, 0, 0, 0)",
      pointerEvents: "none",
      underRow: true,
      left: { separator: false, item: "message:yesterday-15" },
      right: { separator: false, item: "message:yesterday-15" },
      label: true,
    });
    await captureScreenshot(page, testInfo, "chat-day-separator-sticky");

    // Two days' separators near the top at once: yesterday's arriving under the
    // older day's pinned label. Only one label shows, never one behind another.
    await timeline.evaluate(element => {
      element.scrollTop = 0;
      const arriving = element.querySelectorAll<HTMLElement>(".chat-day-separator")[1]!;
      element.scrollTop += arriving.getBoundingClientRect().top - element.getBoundingClientRect().top - 8;
    });
    const nearTop = () => timeline.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      const labels = [...element.querySelectorAll<HTMLElement>(".chat-day-separator time")].map(label => ({ label, bounds: label.getBoundingClientRect() }));
      return {
        near: labels.filter(({ bounds }) => bounds.top <= top + 60).length,
        visible: labels.filter(({ label, bounds }) => bounds.top <= top + 60 && getComputedStyle(label).visibility === "visible").map(({ label }) => label.textContent),
      };
    });
    await expect.poll(nearTop).toEqual({ near: 2, visible: ["Yesterday"] });
    // Past yesterday's first message, the older day's separator takes over.
    await timeline.evaluate(element => { element.scrollTop = 0; });
    await expect.poll(pinnedLabels).toEqual([days.olderLabel]);
    await expect(separators.first()).not.toHaveAttribute("data-superseded", /.*/);

    // An unstuck separator paints only its own box: it never reaches over
    // the end of the previous day's last row.
    await timeline.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const unstuck = await page.locator('#chat-items > .chat-day-separator[data-chat-day]').evaluateAll(nodes => nodes.map(node => {
      const previous = node.previousElementSibling?.getBoundingClientRect();
      return { gap: previous ? node.getBoundingClientRect().top - previous.bottom : 0, shadow: getComputedStyle(node).boxShadow };
    }));
    for (const separator of unstuck) {
      expect(separator.gap).toBeGreaterThanOrEqual(0);
      expect(separator.shadow).toBe("none");
    }

    // Whatever is scrolled to lands below the pinned row, not under its label.
    const clearOfBand = (id: string) => page.evaluate(target => {
      const timeline = document.querySelector<HTMLElement>("#chat-timeline")!;
      const top = timeline.getBoundingClientRect().top;
      const bands = [...timeline.querySelectorAll<HTMLElement>(".chat-day-separator")].map(node => node.getBoundingClientRect()).filter(bounds => bounds.top <= top + 1 && bounds.bottom > top);
      const bandBottom = Math.max(top, ...bands.map(bounds => bounds.bottom));
      return document.querySelector(`[data-chat-item-id="${target}"]`)!.getBoundingClientRect().top - bandBottom;
    }, id);
    // A prompt jump from the rail.
    await timeline.evaluate(element => { element.scrollTop = 0; });
    await page.locator('#chat-prompt-rail [data-prompt-target="message:yesterday-16"]').click();
    await expect.poll(() => clearOfBand("message:yesterday-16")).toBeGreaterThanOrEqual(0);
    await expect.poll(() => clearOfBand("message:yesterday-16")).toBeLessThan(40);

    // ⌘F: a match whose line sits under the pinned row is revealed below it,
    // and the separators' own labels are not matches.
    await page.locator('[data-chat-item-id="message:yesterday-20"]').evaluate(element => {
      const timeline = element.closest<HTMLElement>("#chat-timeline")!;
      timeline.scrollTop += element.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 4;
    });
    expect(await clearOfBand("message:yesterday-20")).toBeLessThan(0);
    await timeline.click({ position: { x: 5, y: 200 } });
    await page.keyboard.press("ControlOrMeta+f");
    await page.locator("#find-query").fill("yesterday message 20 ");
    await expect(page.locator("#find-status")).toHaveText("1 of 1");
    await expect.poll(() => clearOfBand("message:yesterday-20")).toBeGreaterThanOrEqual(-1);
    await page.locator("#find-query").fill("Yesterday");
    // 24 message texts say "yesterday"; the separator does not add a 25th.
    await expect(page.locator("#find-status")).toHaveText(/ of 24$/);
    await page.locator("#find-query").fill("Today");
    await expect(page.locator("#find-status")).toHaveText(/ of 3$/);
  });

  test("keeps an active turn timer across conversation navigation", async ({ page }) => {
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    const firstId = await page.locator("#chat-conversation-select").inputValue();
    await page.locator("#chat-input").fill("Keep timing this turn");
    await page.locator("#chat-input").press("Enter");
    const status = page.locator("#chat-composer-status");
    await expect(status).toHaveAttribute("aria-label", "Working");
    const elapsed = async () => elapsedSeconds(await status.getAttribute("title"));
    await expect.poll(elapsed).toBeGreaterThanOrEqual(1);
    const before = await elapsed();

    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue(firstId);
    await page.locator("#chat-conversation-select").selectOption(firstId);
    await expect(status).toHaveAttribute("aria-label", "Working");
    // One read once the timer shows at all: polling would let a timer that
    // restarted from zero count back up past `before` and pass.
    await expect(status).toHaveAttribute("title", /\d+s/);
    expect(await elapsed()).toBeGreaterThanOrEqual(before);
  });

  test("streams Markdown, exposes code copy on completion, and updates one tool entry in place", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Streaming", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    const id = seeded.conversation.id;
    await control(request, { action: "status", conversationId: id, status: "running" });
    const assistant: ConversationItem = { id: "part:answer", type: "assistant_message", createdAt: 10, markdown: "## Result\n\n" };
    await control(request, { action: "item", conversationId: id, item: assistant });
    await control(request, { action: "delta", conversationId: id, itemId: assistant.id, delta: "**streamed** safely" });
    await expect(page.locator("#chat-items h2")).toHaveText("Result");
    await expect(page.locator("#chat-items strong")).toHaveText("streamed");
    const assistantNode = page.locator('[data-chat-item-id="part:answer"]');
    await expect(assistantNode.locator("[data-chat-copy='answer']")).toHaveCount(0);
    await control(request, { action: "item", conversationId: id, item: { ...assistant, markdown: "## Result\n\n**streamed** safely\n\n```ts\nconst value = 1;\n```" } });
    await control(request, { action: "status", conversationId: id, status: "completed" });
    await expect(assistantNode.locator("[data-chat-copy='answer']")).toHaveCount(0);
    await expect(assistantNode.locator("[data-chat-copy='code']")).toHaveCount(1);
    const codeCopyGeometry = await assistantNode.evaluate(element => {
      const pre = element.querySelector("pre")!.getBoundingClientRect();
      const control = element.querySelector<HTMLElement>("[data-chat-copy='code']")!;
      const copy = control.getBoundingClientRect();
      return { preRight: pre.right, copyRight: copy.right, width: copy.width, borderWidth: getComputedStyle(control).borderTopWidth };
    });
    expect(codeCopyGeometry.copyRight).toBeLessThan(codeCopyGeometry.preRight);
    expect(codeCopyGeometry.width).toBeGreaterThanOrEqual(32);
    expect(parseFloat(codeCopyGeometry.borderWidth)).toBeGreaterThan(0);
    await installClipboardMock(page);
    const beforeCopy = await assistantNode.boundingBox();
    await assistantNode.locator("[data-chat-copy='code']").click();
    // The copied state is set once the clipboard write has resolved, and it
    // clears again after a moment: assert it first, then read the clipboard.
    await expect(assistantNode.locator("[data-chat-copy='code']")).toHaveAttribute("data-state", "copied");
    expect(await readClipboardMock(page)).toBe("const value = 1;\n");
    const afterCopy = await assistantNode.boundingBox();
    expect(afterCopy?.width).toBeCloseTo(beforeCopy?.width ?? 0, 1);
    expect(afterCopy?.height).toBeCloseTo(beforeCopy?.height ?? 0, 1);

    const running: ConversationItem = { id: "tool:read", type: "tool", createdAt: 11, name: "Read", status: "running", input: "README.md" };
    await control(request, { action: "item", conversationId: id, item: running });
    await expect(page.locator('[data-chat-item-id="tool:read"]')).toContainText("running");
    await control(request, { action: "item", conversationId: id, item: { ...running, status: "completed", output: "read complete" } });
    await expect(page.locator('[data-chat-item-id="tool:read"]')).toHaveCount(1);
    await expect(page.locator('[data-chat-item-id="tool:read"]')).toContainText("completed");
  });

  test("resolves permissions and structured questions once", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Interactions", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    const id = seeded.conversation.id;
    const permission: ConversationItem = { id: "permission:perm-1", type: "permission", createdAt: 10, requestId: "perm-1", action: "run command", resources: ["bun test"], status: "pending" };
    await control(request, { action: "item", conversationId: id, item: permission });

    // The persistent reply reaches past this conversation into every later one
    // the same OpenCode server handles, and covers the request's `always`
    // pattern rather than only the resource shown. The surface must say so
    // where the choice is made, and must not offer the old "Allow session"
    // wording, which implied a single conversation.
    const card = page.locator('[data-chat-item-id="permission:perm-1"]');
    await expect(card.getByRole("button", { name: "Allow always" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Allow session" })).toHaveCount(0);
    await expect(card).toContainText("later conversations");
    await expect(card).toContainText("until OpenCode restarts");

    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.locator('[data-chat-item-id="permission:perm-1"]')).toContainText("Allowed once");
    await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);

    const question: ConversationItem = {
      id: "question:q-1", type: "question", createdAt: 11, requestId: "q-1", status: "pending",
      questions: [{ header: "Approach", prompt: "Which implementation?", multiple: false, allowFreeForm: true, options: [{ label: "Minimal", description: "Small change" }] }],
    };
    await control(request, { action: "item", conversationId: id, item: question });
    const questionCard = page.locator('[data-chat-item-id="question:q-1"]');
    const answer = questionCard.getByRole("button", { name: "Answer", exact: true });
    await expect(questionCard.getByRole("radio", { name: "Type your own answer" })).toBeVisible();

    let replies = 0;
    page.on("request", request => {
      if (new URL(request.url()).pathname.endsWith(`/questions/${question.requestId}`)) replies += 1;
    });
    // Choosing an option only arms Answer. Whether it also sent a reply is
    // settled below: requests leave in order, so once Answer's own reply has
    // answered, any reply the choice had sent was already counted.
    await questionCard.getByRole("radio", { name: "Minimal Small change" }).check();
    await expect(answer).toBeEnabled();

    const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname.endsWith(`/questions/${question.requestId}`));
    await answer.click();
    expect((await response).request().postDataJSON()).toMatchObject({ outcome: { kind: "answered", answers: [["Minimal"]] } });
    expect(replies).toBe(1);
    await expect(questionCard).toContainText("Answered");
    await expect(answer).toHaveCount(0);
  });

  test("renders recovered free-form policy and sends ordered mixed answers", async ({ page, request }) => {
    const recovered: ConversationItem = {
      id: "question:q-recovered", type: "question", createdAt: 20, requestId: "q-recovered", status: "pending",
      questions: [{
        header: "Parts", prompt: "Which parts?", multiple: true, allowFreeForm: true,
        options: [{ label: "Parser", description: "Read input" }, { label: "Renderer", description: "Show output" }],
      }],
    };
    const seeded = await control(request, { action: "seed", title: "Recovered question", items: [recovered] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id);

    const card = page.locator('[data-chat-item-id="question:q-recovered"]');
    const custom = card.getByRole("checkbox", { name: "Type your own answer" });
    const customInput = card.locator("[data-question-custom-input]");
    await expect(custom).toBeVisible();
    await expect(customInput).toBeHidden();
    await card.getByRole("checkbox", { name: "Renderer Show output" }).check();
    await custom.check();
    await expect(customInput).toBeVisible();
    await customInput.fill("  Tests  ");

    const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname.endsWith(`/questions/${recovered.requestId}`));
    await card.getByRole("button", { name: "Answer", exact: true }).click();
    const payload = (await response).request().postDataJSON();
    expect(payload).toMatchObject({ outcome: { kind: "answered", answers: [["Renderer", "Tests"]] } });
    expect(payload.outcome.answers.flat()).not.toContain("Type your own answer");

    const fixed: ConversationItem = {
      id: "question:q-fixed", type: "question", createdAt: 21, requestId: "q-fixed", status: "pending",
      questions: [{
        header: "Release", prompt: "Ship now?", multiple: false, allowFreeForm: false,
        options: [{ label: "Yes", description: "Publish it" }],
      }],
    };
    await control(request, { action: "item", conversationId: seeded.conversation.id, item: fixed });
    const fixedCard = page.locator('[data-chat-item-id="question:q-fixed"]');
    await expect(fixedCard.getByRole("radio", { name: "Yes Publish it" })).toBeVisible();
    await expect(fixedCard.getByRole("radio", { name: "Type your own answer" })).toHaveCount(0);
    await expect(fixedCard.locator("[data-question-custom-input]")).toHaveCount(0);
  });

  test("streaming beside a pending question keeps the answer being typed", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Concurrent", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    const id = seeded.conversation.id;
    const question: ConversationItem = {
      id: "question:q-2", type: "question", createdAt: 11, requestId: "q-2", status: "pending",
      questions: [{ header: "Approach", prompt: "Which implementation?", multiple: false, allowFreeForm: true, options: [{ label: "Minimal", description: "Small change" }] }],
    };
    await control(request, { action: "item", conversationId: id, item: question });
    await control(request, { action: "item", conversationId: id, item: { id: "part:stream", type: "assistant_message", createdAt: 12, markdown: "Thinking" } });

    const card = page.locator('[data-chat-item-id="question:q-2"]');
    const custom = card.getByRole("radio", { name: "Type your own answer" });
    const freeForm = card.locator("[data-question-custom-input]");
    await expect(freeForm).toBeHidden();
    await custom.check();
    await expect(freeForm).toBeVisible();
    await expect(freeForm).toBeFocused();
    await freeForm.fill("my own answer");

    // The agent keeps streaming while the answer sits half-typed; a timeline
    // rebuild here would silently discard the text.
    for (const delta of [" about", " your"]) {
      await control(request, { action: "delta", conversationId: id, itemId: "part:stream", delta });
    }
    await expect(page.locator('[data-chat-item-id="part:stream"]')).toContainText("Thinking about your");
    await expect(freeForm).toHaveValue("my own answer");

    // Single choice: a provider option hides the custom editor but keeps its
    // draft available if the user returns to it.
    await card.getByRole("radio", { name: "Minimal Small change" }).check();
    await expect(freeForm).toBeHidden();
    await expect(freeForm).toHaveValue("my own answer");
    await control(request, { action: "delta", conversationId: id, itemId: "part:stream", delta: " question" });
    await expect(page.locator('[data-chat-item-id="part:stream"]')).toContainText("Thinking about your question");
    await expect(card.getByRole("radio", { name: "Minimal Small change" })).toBeChecked();

    await custom.check();
    await expect(freeForm).toBeVisible();
    await expect(freeForm).toHaveValue("my own answer");

    await card.getByRole("button", { name: "Answer", exact: true }).click();
    await expect(card).toContainText("Answered");
  });

  test("resending after a failure reuses the request id for at-most-once delivery", async ({ page, request }) => {
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    await control(request, { action: "failPrompt" });
    await page.locator("#chat-input").fill("retry me");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-composer-error")).toContainText("Draft restored");
    await expect(page.locator("#chat-input")).toHaveValue("retry me");

    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-items")).toContainText("retry me");
    const stats = await control(request, { action: "stats" }) as { promptAttempts: string[] };
    // Same id both times: the server's idempotency receipt can dedupe a
    // request whose first response was lost after acceptance.
    expect(stats.promptAttempts).toHaveLength(2);
    expect(stats.promptAttempts[0]).toBe(stats.promptAttempts[1]);
  });

  test("a success in another conversation does not discard a retained retry id", async ({ page, request }) => {
    const first = await control(request, { action: "seed", title: "First", items: [] }) as { conversation: { id: string } };
    const second = await control(request, { action: "seed", title: "Second", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    await page.locator("#chat-conversation-select").selectOption(first.conversation.id);
    await control(request, { action: "failPrompt" });
    await page.locator("#chat-input").fill("cross retry");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-composer-error")).toContainText("Draft restored");

    await page.locator("#chat-conversation-select").selectOption(second.conversation.id);
    await page.locator("#chat-input").fill("unrelated message");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-items")).toContainText("unrelated message");

    await page.locator("#chat-conversation-select").selectOption(first.conversation.id);
    await expect(page.locator("#chat-input")).toHaveValue("cross retry");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-items")).toContainText("cross retry");

    const stats = await control(request, { action: "stats" }) as { promptAttempts: string[] };
    expect(stats.promptAttempts).toHaveLength(3);
    expect(stats.promptAttempts[2]).toBe(stats.promptAttempts[0]);
    expect(stats.promptAttempts[1]).not.toBe(stats.promptAttempts[0]);
  });

  test("a prompt failure after switching conversations restores the draft on return", async ({ page, request }) => {
    const first = await control(request, { action: "seed", title: "First", items: [] }) as { conversation: { id: string } };
    const second = await control(request, { action: "seed", title: "Second", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    await page.locator("#chat-conversation-select").selectOption(first.conversation.id);
    await expect(page.locator("#chat-title")).toHaveText("First");

    await control(request, { action: "failPrompt" });
    const failed = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").fill("doomed message");
    await page.locator("#chat-send").click();
    // Switch away inside the fixture's 500ms in-flight window, before the
    // rejection lands.
    await page.locator("#chat-conversation-select").selectOption(second.conversation.id);
    await failed;
    // The response landing is not the rejection handler running: wait for
    // the handler's own status note before asserting where the error went,
    // or a regression writing to the selection could slip past both checks.
    await expect(page.locator("#chat-composer-status-live")).toHaveText("Message not accepted; draft restored");
    // The refusal belongs to the conversation that submitted: nothing
    // flashes here, and the reason waits with the restored draft.
    await expect(page.locator("#chat-composer-error")).toBeHidden();

    await page.locator("#chat-conversation-select").selectOption(first.conversation.id);
    await expect(page.locator("#chat-composer-error")).toContainText("Draft restored");
    await expect(page.locator("#chat-input")).toHaveValue("doomed message");
  });

  test("replays a missed event, resyncs a stale generation, and opens workspace files", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Reconnect", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    const id = seeded.conversation.id;
    await expect.poll(async () => (await page.locator("#chat-state").textContent()) ?? "").not.toContain("Loading");

    await control(request, { action: "disconnect" });
    await control(request, { action: "item", conversationId: id, item: { id: "notice:replayed", type: "notice", createdAt: 10, level: "info", message: "replayed after disconnect" } });
    await expect(page.locator("#chat-items")).toContainText("replayed after disconnect", { timeout: 10_000 });

    let snapshots = 0;
    page.on("response", response => {
      if (decodeURIComponent(new URL(response.url()).pathname).endsWith(`/api/chat/conversations/${id}`)) snapshots += 1;
    });
    await control(request, { action: "resync" });
    await expect.poll(() => snapshots, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(page.locator("#chat-items")).toContainText("replayed after disconnect");

    await control(request, { action: "item", conversationId: id, item: { id: "part:file", type: "assistant_message", createdAt: 20, markdown: "Open [setup](guides/setup.md:2)." } });
    await page.getByRole("button", { name: "setup" }).click();
    // Navigation happens in the co-visible Preview — the panel must not
    // collapse or hide the conversation.
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "open");
    await expect(page.locator("#chat-timeline")).toBeVisible();
  });
});

test("the chat backend starts only when the panel opens", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  // Chat initializes once the workspace state has loaded and the URL
  // credential has become the workspace cookie — the moment an eager
  // bootstrap would call status.
  const credentialPromoted = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/auth"));
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await (await credentialPromoted).finished();
  // One rendered frame lets the page run what that promotion resolved.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))));
  // Booting with the panel collapsed must not touch chat status — in
  // production that call lazily launches the OpenCode server.
  expect(((await control(request, { action: "stats" })) as { statusCalls: number }).statusCalls).toBe(0);
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await expect.poll(async () => ((await control(request, { action: "stats" })) as { statusCalls: number }).statusCalls).toBeGreaterThan(0);
});

function elapsedSeconds(value: string | null): number {
  const match = /(?:·\s*)?(?:(\d+)m\s+)?(\d+)s/.exec(value ?? "");
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : -1;
}

test.describe("timeline reading position", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  const seedLong = async (page: Page, request: APIRequestContext): Promise<string> => {
    const items: ConversationItem[] = Array.from({ length: 28 }, (_, index) => ({
      id: `message:loaded-${index}`, type: "user_message", createdAt: index, text: `loaded message ${index} ${"content ".repeat(12)}`,
    }));
    const seeded = await control(request, { action: "seed", title: "Reading", items }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id);
    await expect(page.locator("#chat-items")).toContainText("loaded message 27");
    return seeded.conversation.id;
  };

  test("a small upward wheel scroll during streaming is not pulled back to the end", async ({ page, request }) => {
    const id = await seedLong(page, request);
    const timeline = page.locator("#chat-timeline");
    await timeline.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await control(request, { action: "status", conversationId: id, status: "running" });
    await control(request, { action: "item", conversationId: id, item: { id: "part:stream", type: "assistant_message", createdAt: 500, markdown: "Streaming" } });
    await expect(page.locator("#chat-items")).toContainText("Streaming");
    await timeline.evaluate(el => {
      (window as any).__scrollTops = [] as number[];
      el.addEventListener("scroll", () => (window as any).__scrollTops.push(el.scrollTop));
    });
    await timeline.hover();
    // Trackpad-sized steps, each well inside the 48px near-end threshold,
    // while the turn keeps rendering underneath them.
    const streaming = (async () => {
      for (let index = 0; index < 30; index++) {
        await control(request, { action: "delta", conversationId: id, itemId: "part:stream", delta: ` word${index}` });
        await page.waitForTimeout(40);
      }
    })();
    for (let index = 0; index < 20; index++) {
      await page.mouse.wheel(0, -12);
      await page.waitForTimeout(30);
    }
    await streaming;
    const tops = await page.evaluate(() => (window as any).__scrollTops as number[]);
    const pulledBack = tops.filter((top, index) => index > 0 && top > tops[index - 1]! + 1);
    expect(pulledBack).toEqual([]);
    expect(await timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(150);
    await expect(page.locator("#chat-latest")).toBeVisible();
  });

  test("sending a message returns the reader to the end", async ({ page, request }) => {
    await seedLong(page, request);
    const timeline = page.locator("#chat-timeline");
    await timeline.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 150; el.dispatchEvent(new Event("scroll")); });
    await page.locator("#chat-input").fill("hello there");
    await page.locator("#chat-input").press("Enter");
    await expect(page.locator("#chat-items")).toContainText("hello there");
    await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
    await expect(page.locator("#chat-latest")).toBeHidden();
  });

  test("a reading position saved just above the end survives a reload and the next update", async ({ page, request }) => {
    const id = await seedLong(page, request);
    const timeline = page.locator("#chat-timeline");
    const distance = () => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
    // Leave by less than the near-end threshold, then let the position save.
    await timeline.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 30; el.dispatchEvent(new Event("scroll")); });
    await expect.poll(distance).toBeGreaterThan(20);
    await expect.poll(() => page.evaluate(() =>
      Object.entries(localStorage).some(([key, value]) => key.endsWith(":chat-presentation") && /"anchors":\{"[^"]+":\{/.test(String(value))),
    )).toBe(true);
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-items")).toContainText("loaded message 27");
    // The restore lands where the reader left, and its own scroll echo must
    // not read as the reader arriving near the end.
    await expect.poll(distance).toBeGreaterThan(20);
    const restored = await distance();
    await control(request, { action: "status", conversationId: id, status: "running" });
    await control(request, { action: "item", conversationId: id, item: { id: "part:after-reload", type: "assistant_message", createdAt: 500, markdown: "After reload " + "content ".repeat(40) } });
    await expect(page.locator("#chat-latest")).toBeVisible();
    // The update landed below the reader: the distance grew by its height.
    await expect.poll(distance).toBeGreaterThan(restored + 20);
  });
});
