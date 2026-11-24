import type { APIRequestContext, Page } from "@playwright/test";
import type { ConversationItem } from "../../src/chat/types";
import { expect } from "./fixtures";
import { openChatPanel } from "./chat-helpers";

/** Screenshot concepts only: no scheduling API, capability, or product renderer.
 * The shell, transcript, worker projection, fonts, icons and CSS are the real
 * application. Only a future Scheduled row and its summary count are augmented.
 * Its detail is cloned from a REAL QueueDockRenderer steer card, captured using
 * the existing scripted OpenCode fixture, then reset out of the backend. No
 * pending user message survives into a screenshot. No global CSS is injected.
 */
export const unifiedStates = ["compact", "list", "expanded", "cancelling", "unconfirmed", "cancelled", "fired", "scheduled-only"] as const;
export type UnifiedState = typeof unifiedStates[number];
export const schedulePrompt = "Review CI and open pull requests; report anything that needs my attention.";

export async function chatControl(request: APIRequestContext, data: Record<string, unknown>) {
  const response = await request.post("/__e2e/chat", { data });
  expect(response.ok()).toBe(true);
  return response.json();
}

export async function enterActualChat(page: Page, request: APIRequestContext): Promise<void> {
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.locator("#touch-tab-chat").tap();
  else await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
}

/** Obtain incumbent steer markup rather than hand-writing an imitation. This
 * bootstrap uses only tests/e2e/opencode-v2-fake.ts, never a live provider. */
export async function actualSteerCard(page: Page, request: APIRequestContext): Promise<string> {
  expect((await request.post("/__e2e/reset")).ok()).toBe(true);
  await chatControl(request, { action: "agents", stack: "opencode-v2" });
  await enterActualChat(page, request);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode");
  const id = await page.locator("#chat-conversation-select").inputValue();
  const submit = async (text: string) => {
    const response = await page.request.post(`/api/chat/conversations/${encodeURIComponent(id)}/prompts`, {
      headers: { origin: new URL(page.url()).origin },
      data: { requestId: `unified-template-${text === schedulePrompt ? "steer" : "start"}`, text, delivery: "steer" },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  expect(await submit("Start the sample review")).toMatchObject({ pending: false });
  await expect(page.locator("#chat-stop")).toBeEnabled();
  expect(await submit(schedulePrompt)).toMatchObject({ pending: true, delivery: "steer" });
  const card = page.locator('#chat-queue .chat-queued-message.is-steer[data-delivery="steer"]');
  await expect(card).toHaveCount(1);
  return card.evaluate(node => node.outerHTML);
}

/** Each scenario has its own reset and conversation, independent of previous
 * cancellation/firing simulations. Existing FakeE2EChatService renders ordinary
 * agent + shell rows. There is deliberately no invented IMAGE worker kind. */
export async function seedUnifiedState(page: Page, request: APIRequestContext, state: UnifiedState): Promise<void> {
  expect((await request.post("/__e2e/reset")).ok()).toBe(true);
  await chatControl(request, { action: "agents" });
  // The primary fake's default capability set is deliberately narrower than
  // OpenCode V2's actual descriptor (src/chat/opencode/v2/provider.ts). Use the
  // existing control to enable its already-supported background-task fixture
  // behavior: these are existing OpenCode capabilities, not a new scheduling
  // capability or evidence of native provider scheduling compatibility.
  await chatControl(request, { action: "declareOnly", capabilities: ["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context", "conversation-rename", "attachments", "background-tasks"] });
  await chatControl(request, { action: "modes", modes: [{ name: "Build", description: "Implement and verify changes" }, { name: "Plan", description: "Plan without edits" }] });
  const model = { providerId: "fixture", modelId: "review-model" };
  await chatControl(request, { action: "models", models: [{ selection: model, provider: "Fixture provider", name: "Fixture review model", variants: ["low", "medium", "high"], contextLimit: 200000 }] });
  const now = Date.now();
  const items: ConversationItem[] = [
    { id: "concept", type: "notice", level: "info", createdAt: now - 6000, message: "Concept / sample data — Scheduled rows are a screenshot-only prototype in the actual frontend." },
    { id: "brief", type: "user_message", createdAt: now - 5000, text: "Review the worker activity. Check CI and open pull requests every weekday at 09:00 Europe/Stockholm." },
    { id: "answer", type: "assistant_message", createdAt: now - 4000, markdown: state === "cancelled"
      ? "**Sample outcome: cancellation confirmed.** The schedule has been removed. Existing workers continue independently."
      : state === "scheduled-only"
        ? "No workers are running. The next scheduled check is **Tuesday 10 November at 09:00**, Europe/Stockholm."
        : "The agent review and shell check are running independently. The next scheduled check is **Tuesday 10 November at 09:00**, Europe/Stockholm." },
  ];
  if (state !== "scheduled-only") items.push(
    { id: "worker:review", type: "background_task", taskId: "review", taskType: "agent", description: "Review worker activity", subagentType: "reviewer", status: "running", createdAt: now - 72000, usage: { totalTokens: 8200, toolUses: 5, durationMs: 72000 }, workerSession: { model: "Fixture review model", effort: "medium", costUsd: null } },
    { id: "worker:ci", type: "background_task", taskId: "ci", taskType: "shell", description: "Check CI status", status: "running", createdAt: now - 38000 },
  );
  if (state === "fired") items.push(
    { id: "sample:wakeup", type: "user_message", createdAt: now - 2000, text: schedulePrompt, origin: "wakeup", wakeupId: "sample-weekday-review" },
    { id: "sample:followup", type: "assistant_message", createdAt: now - 1000, markdown: "**Sample scheduled follow-up · Tuesday 10 November, 09:00.** CI is green and one pull request needs review. The next check is **Wednesday 11 November at 09:00**, Europe/Stockholm." },
  );
  const seeded = await chatControl(request, { action: "seed", title: "Concept · unified Workers", configuration: { mode: "Build", model, variant: "medium" }, items });
  await enterActualChat(page, request);
  await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
  await expect(page.locator('[data-chat-item-id="concept"]')).toContainText("Concept / sample data");
  await expect(page.locator("#chat-configuration-summary")).toContainText("Fixture review model");
  await expect(page.locator("#chat-compact-workers-items [data-worker-id]")).toHaveCount(state === "scheduled-only" ? 0 : 2);
  await expect(page.locator("#chat-queue .chat-queued-message")).toHaveCount(0);
  await expect(page.locator("#chat-scheduled-wakeups")).toBeHidden();
  // Wait for the real initial paint/disclosure echo before the one-shot overlay.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** One-shot DOM augmentation after the native seed settles. No MutationObserver,
 * recurring patch, app-state override, or persistent UI implementation. Native
 * rerenders are allowed to invalidate the demo; assertions catch that. The only
 * explicit layout declaration makes the cloned native button fill its row;
 * all typography, density, palette and card styling come from src/styles.css.
 */
export async function augmentScheduledRow(page: Page, state: UnifiedState, steerHtml: string, workerHtml: string): Promise<void> {
  await page.evaluate(({ state, steerHtml, workerHtml, prompt }) => {
    const required = <T extends HTMLElement>(selector: string): T => {
      const node = document.querySelector<T>(selector);
      if (!node) throw new Error(`Missing actual frontend element: ${selector}`);
      return node;
    };
    const workers = required<HTMLDetailsElement>("#chat-compact-workers");
    const list = required<HTMLUListElement>("#chat-compact-workers-items > ul");
    const summary = required<HTMLElement>("#chat-compact-workers-label");
    const only = state === "scheduled-only";
    // Explicit fixture-only force: production currently hides empty Workers.
    // This demonstrates scheduled-only presentation, not implemented behavior.
    workers.hidden = false;
    workers.open = state !== "compact";
    summary.textContent = state === "cancelled" ? "2 working" : only ? "1 scheduled" : "2 working · 1 scheduled";
    workers.querySelector("summary")!.setAttribute("aria-label", `Workers: ${summary.textContent}`);
    if (state === "cancelled") return;

    const template = document.createElement("template");
    template.innerHTML = workerHtml;
    const native = template.content.firstElementChild as HTMLLIElement;
    if (!native?.matches(".chat-worker-row")) throw new Error("Expected a native compact worker row");
    const row = document.createElement("li");
    row.dataset.unifiedSchedule = "sample-weekday-review";
    const header = document.createElement("div");
    header.className = native.className;
    header.dataset.state = "unknown"; // CSS reuse only; not provider liveness or a worker lifecycle fact.
    const toggle = native.querySelector<HTMLButtonElement>(".chat-worker-inspect")!;
    // Strip delegated product actions/identities: this is not an inspectable task.
    for (const attribute of [...toggle.attributes]) if (attribute.name.startsWith("data-")) toggle.removeAttribute(attribute.name);
    const due = state === "fired" ? "Wed 11 Nov · 09:00 CET" : "Tue 10 Nov · 09:00 CET";
    toggle.title = `${prompt} · ${due} · Europe/Stockholm`;
    toggle.setAttribute("aria-label", `Scheduled: review CI and open pull requests, ${due}, Europe/Stockholm`);
    toggle.setAttribute("aria-controls", "sample-schedule-card");
    const expanded = ["expanded", "cancelling", "unconfirmed", "fired", "scheduled-only"].includes(state);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.querySelector(".chat-worker-glyph")!.textContent = "◌";
    toggle.querySelector(".chat-worker-name")!.textContent = "Review CI and open PRs";
    const kind = document.createElement("span");
    kind.className = "chat-worker-kind";
    kind.textContent = "Scheduled";
    toggle.querySelector(".chat-worker-meta")!.replaceChildren(kind);
    toggle.querySelector(".chat-worker-model")!.textContent = state === "fired" ? "Wed 09:00 CET" : "Tue 09:00 CET";
    for (const selector of [".chat-worker-tokens", ".chat-worker-cost"]) toggle.querySelector(selector)!.textContent = "";
    // Native desktop worker layout reserves a second column for Stop. There is
    // no Stop on a schedule; span that unused column without adding a stylesheet.
    toggle.style.gridColumn = "1 / -1";
    header.append(toggle);
    row.append(header);

    template.innerHTML = steerHtml;
    const card = template.content.firstElementChild as HTMLElement;
    if (!card?.matches(".chat-queued-message.is-steer")) throw new Error("Expected a real rendered steer card");
    card.id = "sample-schedule-card";
    card.removeAttribute("role");
    card.removeAttribute("data-chat-queued-id");
    card.removeAttribute("data-delivery");
    card.querySelector(".chat-queued-badge")!.textContent = "Scheduled";
    card.querySelector(".chat-queued-tag")!.textContent = `Weekdays · ${due} · Europe/Stockholm`;
    card.querySelector("p")!.textContent = prompt;
    const actions = card.querySelector<HTMLElement>(".chat-queued-actions")!;
    const cancel = card.querySelector<HTMLButtonElement>(".chat-queued-remove")!;
    if (!cancel) throw new Error("Rendered steer card has no native Remove button to reuse");
    for (const attribute of [...cancel.attributes]) if (attribute.name.startsWith("data-queue-")) cancel.removeAttribute(attribute.name);
    // Pending actions intentionally use 32px on touch; schedule cancellation
    // instead reuses the existing native task-action 44px target unchanged.
    cancel.className = "chat-task-stop";
    cancel.dataset.unifiedCancel = "sample-weekday-review";
    cancel.textContent = state === "cancelling" ? "Cancelling…" : "Cancel";
    cancel.setAttribute("aria-label", "Cancel scheduled CI and pull request review");
    cancel.disabled = state === "cancelling" || state === "unconfirmed";
    actions.replaceChildren(cancel);
    if (state === "cancelling" || state === "unconfirmed") {
      const feedback = document.createElement("small");
      feedback.className = "chat-queued-tag";
      feedback.setAttribute("role", "status");
      feedback.textContent = state === "cancelling"
        ? "Awaiting native confirmation. This schedule remains listed."
        : "Cancellation unconfirmed. This schedule may still fire; do not assume it stopped.";
      card.querySelector("footer")!.before(feedback);
    }
    // A plain hidden wrapper avoids overriding the real card's display:flex.
    const detail = document.createElement("div");
    detail.hidden = !expanded;
    detail.append(card);
    toggle.addEventListener("click", event => {
      event.stopPropagation();
      detail.hidden = !detail.hidden;
      toggle.setAttribute("aria-expanded", String(!detail.hidden));
    });
    // Cancel is illustrative only: no scheduler or queue endpoint is called.
    cancel.addEventListener("click", event => event.stopPropagation());
    row.append(detail);
    list.append(row);
  }, { state, steerHtml, workerHtml, prompt: schedulePrompt });
}
