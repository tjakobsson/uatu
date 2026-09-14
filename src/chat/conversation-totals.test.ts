import { describe, expect, test } from "bun:test";

import { planChip } from "./composer-status";
import { conversationTotals, resolveSessionTotals } from "./conversation-totals";
import type { ConversationItem, SessionTotals, TokenUsage } from "./types";

const carrier = (id: string, usage: TokenUsage, modelId?: string): ConversationItem => ({
  id: `usage:${id}`, type: "assistant_message", createdAt: 1, markdown: "", usage,
  ...(modelId ? { model: { providerId: "openai", modelId } } : {}),
});

describe("conversationTotals", () => {
  test("sums each priced message once, at its latest figure, grouped by model", () => {
    // Two messages on one model, one on another. The adapter already
    // replaced msg_a's carrier with its restatement, so the fold sees one
    // carrier per message and never a partial figure beside a final one.
    const totals = conversationTotals([
      { id: "message:u", type: "user_message", createdAt: 0, text: "hi" },
      carrier("msg_a", { input: 1_000, output: 20, cacheRead: 100, cacheWrite: 0, costUsd: 0.75 }, "gpt-5.6-sol"),
      carrier("msg_b", { input: 800, output: 7, costUsd: 0.375 }, "gpt-5.6-sol"),
      carrier("msg_c", { input: 10, output: 1, costUsd: 0.125 }, "gpt-5.6-mini"),
    ]);
    expect(totals).toEqual({
      costUsd: 1.25, apiDurationMs: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0,
      models: [
        { id: "gpt-5.6-sol", input: 1_800, output: 27, cacheRead: 100, cacheWrite: 0, costUsd: 1.125 },
        { id: "gpt-5.6-mini", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.125 },
      ],
      agents: [{ id: "main", label: "This agent", main: true, input: 1_810, output: 28, cacheRead: 100, cacheWrite: 0, costUsd: 1.25 }],
    });
    expect(totals).not.toHaveProperty("since");
  });

  test("subagents count toward the total and the model rows, and get their own row", () => {
    const subagent = (id: string, description: string, usage: TokenUsage, model?: string): ConversationItem => ({
      id, type: "tool", createdAt: 3, name: "task", status: "completed", input: JSON.stringify({ description, subagent_type: "explore" }), childConversationId: `child-${id}`, usage, ...(model ? { model } : {}),
    });
    const totals = conversationTotals([
      carrier("msg_a", { input: 1_000, output: 20, costUsd: 0.75 }, "gpt-5.6-sol"),
      // On the main agent's model: one model row, two agent rows.
      subagent("tool:a", "Review renderer", { input: 500, output: 50, cacheRead: 10, cacheWrite: 0, costUsd: 0.25 }, "gpt-5.6-sol"),
      // Tokens but no price: listed, not asserted as free, not in the total.
      subagent("tool:b", "Scan tests", { input: 300, output: 30 }, "local/llama"),
    ]);
    expect(totals).toEqual(expect.objectContaining({
      costUsd: 1,
      models: [
        { id: "gpt-5.6-sol", input: 1_500, output: 70, cacheRead: 10, cacheWrite: 0, costUsd: 1 },
        { id: "local/llama", input: 300, output: 30, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
      ],
      agents: [
        { id: "main", label: "This agent", main: true, input: 1_000, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.75 },
        { id: "tool:a", label: "explore · Review renderer", main: false, model: "gpt-5.6-sol", input: 500, output: 50, cacheRead: 10, cacheWrite: 0, costUsd: 0.25 },
        { id: "tool:b", label: "explore · Scan tests", main: false, model: "local/llama", input: 300, output: 30, cacheRead: 0, cacheWrite: 0 },
      ],
    }));
    expect(planChip({ session: totals }, undefined)?.text).toBe("$1.00 this conversation");
    // A priced subagent alone is a priced conversation.
    expect(conversationTotals([carrier("m", { input: 5 }), subagent("tool:c", "Alone", { input: 1, costUsd: 0.5 })])?.costUsd).toBe(0.5);
  });

  test("an unpriced carrier contributes nothing, and an all-zero conversation shows no cost", () => {
    // Absent is "the agent did not price it" (a Claude Code carrier); zero is
    // "OpenCode has no price for this model". Neither becomes a $0.00 chip.
    expect(conversationTotals([carrier("a", { input: 5 }), carrier("b", { input: 6 })])).toBeUndefined();
    expect(conversationTotals([carrier("a", { input: 5, costUsd: 0 }, "local/llama")])).toBeUndefined();
    // But an unpriced carrier beside a priced one is left out, not zeroed
    // into the priced model's row.
    expect(conversationTotals([carrier("a", { input: 5 }, "gpt-5.6-sol"), carrier("b", { input: 6, costUsd: 0.5 }, "gpt-5.6-sol")]))
      .toEqual(expect.objectContaining({ costUsd: 0.5, models: [{ id: "gpt-5.6-sol", input: 6, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 }] }));
  });

  test("a carrier without a model still counts, under an unknown row", () => {
    expect(conversationTotals([carrier("a", { input: 5, costUsd: 0.5 })])?.models).toEqual([{ id: "unknown", input: 5, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 }]);
  });

  test("the chip reads the folded cost as this conversation's", () => {
    const items = [carrier("a", { input: 5, costUsd: 1.23 }, "gpt-5.6-sol")];
    expect(planChip({ session: conversationTotals(items) }, undefined)).toEqual({ text: "$1.23 this conversation", level: "normal", kind: "cost" });
  });
});

describe("resolveSessionTotals", () => {
  test("the agent's own totals win over the fold; a report without them does not", () => {
    const session: SessionTotals = { costUsd: 9, apiDurationMs: 1, durationMs: 2, linesAdded: 0, linesRemoved: 0, models: [], since: 5 };
    const priced = carrier("a", { input: 5, costUsd: 0.5 }, "gpt-5.6-sol");
    expect(resolveSessionTotals([priced, { id: "r", type: "context_report", createdAt: 2, total: 10, session }])).toBe(session);
    // A compaction's report speaks to the window, not the cost.
    expect(resolveSessionTotals([priced, { id: "r", type: "context_report", createdAt: 2, total: 10 }])).toEqual(expect.objectContaining({ costUsd: 0.5 }));
    // A newer plan report without totals retires the older tally rather
    // than letting it stand: the agent reported none this time.
    expect(resolveSessionTotals([
      { id: "r1", type: "context_report", createdAt: 1, total: 10, plan: {}, session },
      { id: "r2", type: "context_report", createdAt: 2, total: 12, plan: { fiveHour: { utilization: 9 } } },
    ])).toBeUndefined();
    expect(resolveSessionTotals([])).toBeUndefined();
  });
});
