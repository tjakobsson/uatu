// An OpenCode conversation's cost as a receipt: line items that sum to a
// total, itemized by agent, by kind of agent, or by model. Fixture-driven —
// the conversation is the shape that broke the earlier readout: a main agent
// that was also summarised, a subagent given a second task (one child session,
// two rows), and a subagent that launched a subagent that launched another.

import type { APIRequestContext, Page } from "@playwright/test";

import type { ConversationItem, SubagentLine, TokenUsage } from "../../src/chat/types";
import { openChatPanel } from "./chat-helpers";
import { openSeeded } from "./chat-shell-helpers";
import { captureScreenshot } from "./evidence";
import { expect, test } from "./fixtures";

const PREFIX = process.env.UATU_SHOT_PREFIX ?? "after";
// `openSeeded` takes the conversation id and the terminal token as one string.
const SEPARATOR = String.fromCharCode(1);

const carrier = (id: string, createdAt: number, agent: string, costUsd: number, modelId = "gpt-5"): ConversationItem => ({
  id: `usage:${id}`, type: "assistant_message", createdAt, markdown: "", usage: { input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, costUsd }, model: { providerId: "openai", modelId }, agent,
});
const said = (id: string, createdAt: number, markdown: string): ConversationItem => ({ id: `message:${id}`, type: "assistant_message", createdAt, markdown, completedAt: createdAt });
const spend = (costUsd: number): TokenUsage => ({ input: 5_000, output: 50, cacheRead: 0, cacheWrite: 0, costUsd });
const task = (id: string, createdAt: number, description: string, child: string, costUsd: number, descendants?: SubagentLine[]): ConversationItem => ({
  id, type: "tool", createdAt, name: "task", status: "completed", input: JSON.stringify({ description, subagent_type: "general" }), output: "done",
  childConversationId: child, model: "gpt-5", usage: spend(costUsd), ...(descendants ? { descendants } : {}),
});

// build $0.75 · compaction $0.05 · general A: $0.20 then $0.15 · general B
// $0.10 · explore $0.30 · explore $0.05 — $1.60, each message once. Text
// between the rows keeps them out of one folded activity group.
const receiptItems = (a: string, b: string): ConversationItem[] => [
  { id: "message:u1", type: "user_message", createdAt: 1, text: "Review the docs; delegate what you can." },
  carrier("b1", 2, "build", 0.5),
  task("tool:t1", 3, "Summarise README", a, 0.2),
  said("a1", 4, "The summary is in. Auditing the diagrams next."),
  task("tool:t2", 5, "Audit mermaid docs", b, 0.1, [
    { id: "tool:g1", parentId: "tool:t2", description: "Find mermaid files", subagent: "explore", conversationId: "ses_explore_1", model: "claude-sonnet", usage: spend(0.3) },
    { id: "tool:g2", parentId: "tool:g1", description: "Count diagram lines", subagent: "explore", conversationId: "ses_explore_2", model: "claude-sonnet", usage: spend(0.05) },
  ]),
  carrier("s1", 6, "compaction", 0.05),
  said("a2", 7, "Asking the first subagent to tighten its summary."),
  // The SAME subagent as tool:t1, handed a further task: its own row, its own spend.
  task("tool:t3", 8, "Shorten README summary", a, 0.15),
  carrier("b2", 9, "build", 0.25),
  said("a3", 10, "All done."),
];

async function seedReceipt(request: APIRequestContext): Promise<{ main: string; other: string; token: string }> {
  await request.post("/__e2e/reset");
  const create = async (title: string, items: ConversationItem[]) => {
    const response = await request.post("/__e2e/chat", { data: { action: "seed", title, items } });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  };
  const childA = await create("Summarise README", [{ id: "message:c1", type: "user_message", createdAt: 1, text: "Summarise the README." }, said("c2", 2, "A sample fixture.")]);
  const childB = await create("Audit mermaid docs", [{ id: "message:d1", type: "user_message", createdAt: 1, text: "Audit the diagrams." }, said("d2", 2, "Delegated.")]);
  const other = await create("Another priced conversation", [{ id: "message:o1", type: "user_message", createdAt: 1, text: "hi" }, carrier("o", 2, "plan", 2)]);
  const main = await create("Receipt", receiptItems(childA, childB));
  const token = (await request.get("/__e2e/terminal-token").then(reply => reply.json()) as { token: string }).token;
  return { main, other, token };
}

/** Every line's label, its note, its cost and its nesting step, as the open readout shows them. */
const lines = (page: Page) => page.locator("#chat-plan-session-models tr").evaluateAll(rows => rows.map(row => {
  const name = row.querySelector("td")!;
  const note = name.querySelector(".chat-plan-session-agent-model")?.textContent ?? "";
  return [name.textContent!.slice(0, name.textContent!.length - note.length), note, row.querySelector("td:last-child")!.textContent!, (row as HTMLElement).dataset.depth ?? ""];
}));
const dollars = (rows: string[][]) => Math.round(rows.reduce((sum, row) => sum + Number(row[2]!.replace("$", "")), 0) * 100) / 100;

test.describe("an OpenCode conversation's cost is a receipt", () => {
  test("every line is its own work, nested subagents are listed, and three itemizations close on one total", async ({ page, request }, testInfo) => {
    const seeded = await seedReceipt(request);
    await openSeeded(page, `${seeded.main}${SEPARATOR}${seeded.token}`, false);
    // What the whole conversation cost, each message once — not $1.95, which
    // billing the reused subagent's $0.35 on both of its rows would make it.
    const chip = page.locator("#chat-plan-usage-summary");
    await expect(chip).toHaveText("$1.60 this conversation");

    // In context: each task's row states that task alone, the launcher's row
    // leaves out what it launched, and the list counts subagents, not rows.
    const subject = (id: string) => page.locator(`[data-chat-item-id="${id}"] .chat-activity-subject`);
    await expect(subject("tool:t1")).toHaveText("general · Summarise README · $0.20");
    await expect(subject("tool:t2")).toHaveText("general · Audit mermaid docs · $0.10");
    await expect(subject("tool:t3")).toHaveText("general · Shorten README summary · $0.15");
    await expect(page.locator("#chat-subagents-label")).toHaveText("2 subagents · 3 tasks finished");
    await page.locator("#chat-subagents > summary").click();
    await expect(page.locator("#chat-subagents-items li .chat-subagent-attribution")).toContainText(["$0.20", "$0.10", "$0.15"]);
    await page.locator("#chat-subagents > summary").click();

    await chip.click();
    await expect(page.locator("#chat-plan-readout")).toBeVisible();
    await expect(page.locator("#chat-plan-session-cost")).toHaveText("$1.60");
    const views = page.locator("#chat-plan-session-views");
    const total = page.locator("#chat-plan-session-total td").last();

    // By agent: named main agents, the summariser on its own line, a line per
    // task, and the nested subagents stepped in under what launched them.
    await expect(page.locator("#chat-plan-session-heading")).toHaveText("Agent");
    const byAgent = await lines(page);
    expect(byAgent).toEqual([
      ["build", "GPT-5 · main agent", "$0.75", ""],
      ["compaction", "GPT-5 · summarised the conversation", "$0.05", ""],
      ["general · Summarise README", "GPT-5", "$0.20", ""],
      ["general · Audit mermaid docs", "GPT-5", "$0.10", ""],
      ["explore · Find mermaid files", "Claude Sonnet", "$0.30", "1"],
      ["explore · Count diagram lines", "Claude Sonnet", "$0.05", "2"],
      ["general · Shorten README summary", "GPT-5 · same agent as “Summarise README”", "$0.15", ""],
    ]);
    expect(byAgent.some(line => line[0] === "This agent")).toBe(false);
    await expect(total).toHaveText("$1.60");
    await captureScreenshot(page, testInfo, `${PREFIX}-receipt-by-agent-desktop`);

    // By type: distinct subagents per kind at any depth, tasks where they differ.
    await views.getByRole("radio", { name: "Types" }).click();
    await expect(page.locator("#chat-plan-session-heading")).toHaveText("Type");
    const byType = await lines(page);
    expect(byType).toEqual([
      ["build", "GPT-5 · main agent", "$0.75", ""],
      ["compaction", "GPT-5 · summarised the conversation", "$0.05", ""],
      ["2 × general", "GPT-5 · 3 tasks", "$0.45", ""],
      ["2 × explore", "Claude Sonnet", "$0.35", ""],
    ]);
    await expect(total).toHaveText("$1.60");
    await captureScreenshot(page, testInfo, `${PREFIX}-receipt-by-type-desktop`);

    // By model, reached with the keyboard: a radiogroup moves with the arrows.
    await views.getByRole("radio", { name: "Types" }).press("ArrowRight");
    await expect(views.getByRole("radio", { name: "Models" })).toBeFocused();
    await expect(page.locator("#chat-plan-session-heading")).toHaveText("Model");
    const byModel = await lines(page);
    expect(byModel).toEqual([
      ["GPT-5", "build · compaction · 2 × general", "$1.25", ""],
      ["Claude Sonnet", "2 × explore", "$0.35", ""],
    ]);
    await expect(total).toHaveText("$1.60");
    await captureScreenshot(page, testInfo, `${PREFIX}-receipt-by-model-desktop`);
    // Three itemizations, one total.
    expect([dollars(byAgent), dollars(byType), dollars(byModel)]).toEqual([1.6, 1.6, 1.6]);

    // The choice is the reader's: it holds across conversations and a reload.
    await views.getByRole("radio", { name: "Types" }).click();
    await page.keyboard.press("Escape");
    await page.locator("#chat-conversation-select").selectOption(seeded.other);
    await expect(chip).toHaveText("$2.00 this conversation");
    await chip.click();
    await expect(views.getByRole("radio", { name: "Types" })).toHaveAttribute("aria-checked", "true");
    expect(await lines(page)).toEqual([["plan", "GPT-5 · main agent", "$2.00", ""]]);
    await page.reload();
    await openChatPanel(page);
    await page.locator("#chat-conversation-select").selectOption(seeded.main);
    await expect(chip).toHaveText("$1.60 this conversation");
    await chip.click();
    await expect(views.getByRole("radio", { name: "Types" })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#chat-plan-session-heading")).toHaveText("Type");
    await page.keyboard.press("Escape");

    // An opened transcript is the subagent, not one task: what it spent
    // across both tasks it was given.
    const first = page.locator('[data-chat-item-id="tool:t1"]');
    await first.locator("> summary").click();
    await first.locator("[data-open-conversation]").click();
    await expect(page.locator("#chat-drilldown-title")).toHaveText("general · Summarise README · $0.35");
  });
});
