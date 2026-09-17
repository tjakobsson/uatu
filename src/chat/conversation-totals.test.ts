import { describe, expect, test } from "bun:test";

import { planChip } from "./composer-status";
import { conversationTotals, resolveSessionTotals, subagentSpend } from "./conversation-totals";
import type { ConversationItem, SessionTotals, SubagentLine, TokenUsage } from "./types";

const carrier = (id: string, usage: TokenUsage, modelId?: string, agent?: string): ConversationItem => ({
  id: `usage:${id}`, type: "assistant_message", createdAt: 1, markdown: "", usage,
  ...(modelId ? { model: { providerId: "openai", modelId } } : {}),
  ...(agent ? { agent } : {}),
});

const subagent = (id: string, description: string, usage: TokenUsage | undefined, model?: string, options: { kind?: string; conversationId?: string; descendants?: SubagentLine[] } = {}): ConversationItem => ({
  id, type: "tool", createdAt: 3, name: "task", status: "completed", input: JSON.stringify({ description, subagent_type: options.kind ?? "explore" }),
  childConversationId: options.conversationId ?? `child-${id}`, ...(usage ? { usage } : {}), ...(model ? { model } : {}), ...(options.descendants ? { descendants: options.descendants } : {}),
});

const sumCost = (lines: ReadonlyArray<{ costUsd?: number }>) => lines.reduce((sum, line) => sum + (line.costUsd ?? 0), 0);

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
    expect(totals).toEqual(expect.objectContaining({
      costUsd: 1.25, apiDurationMs: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0,
      models: [
        { id: "gpt-5.6-sol", input: 1_800, output: 27, cacheRead: 100, cacheWrite: 0, costUsd: 1.125, agents: ["This agent"] },
        { id: "gpt-5.6-mini", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.125, agents: ["This agent"] },
      ],
    }));
    // An agent that names none is one line, reading "This agent".
    expect(totals?.receipt?.lines).toEqual([
      { id: "main:", kind: "main", depth: 0, description: "This agent", label: "This agent", models: ["gpt-5.6-sol", "gpt-5.6-mini"], input: 1_810, output: 28, cacheRead: 100, cacheWrite: 0, costUsd: 1.25 },
    ]);
    expect(totals).not.toHaveProperty("since");
  });

  test("subagents count toward the total and the model rows, and get their own line", () => {
    const totals = conversationTotals([
      carrier("msg_a", { input: 1_000, output: 20, costUsd: 0.75 }, "gpt-5.6-sol"),
      // On the main agent's model: one model row, two lines.
      subagent("tool:a", "Review renderer", { input: 500, output: 50, cacheRead: 10, cacheWrite: 0, costUsd: 0.25 }, "gpt-5.6-sol"),
      // Tokens but no price: listed, not asserted as free, not in the total.
      subagent("tool:b", "Scan tests", { input: 300, output: 30 }, "local/llama"),
    ]);
    expect(totals).toEqual(expect.objectContaining({
      costUsd: 1,
      models: [
        { id: "gpt-5.6-sol", input: 1_500, output: 70, cacheRead: 10, cacheWrite: 0, costUsd: 1, agents: ["This agent", "explore"] },
        { id: "local/llama", input: 300, output: 30, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: true, agents: ["explore"] },
      ],
    }));
    expect(totals?.receipt?.lines.map(line => [line.id, line.label, line.models, line.input, line.costUsd])).toEqual([
      ["main:", "This agent", ["gpt-5.6-sol"], 1_000, 0.75],
      ["tool:a", "explore · Review renderer", ["gpt-5.6-sol"], 500, 0.25],
      ["tool:b", "explore · Scan tests", ["local/llama"], 300, undefined],
    ]);
    expect(planChip({ session: totals }, undefined)?.text).toBe("$1.00 this conversation");
    // A model OpenCode prices at zero beside a paid one stays unpriced.
    expect(conversationTotals([carrier("m", { input: 5, costUsd: 0.5 }, "gpt-5.6-sol"), carrier("n", { input: 5, costUsd: 0 }, "local/llama")])?.models)
      .toEqual([
        { id: "gpt-5.6-sol", input: 5, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.5, agents: ["This agent"] },
        { id: "local/llama", input: 5, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: true, agents: ["This agent"] },
      ]);
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
      .toEqual(expect.objectContaining({ costUsd: 0.5, models: [{ id: "gpt-5.6-sol", input: 6, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.5, agents: ["This agent"] }] }));
  });

  test("a carrier without a model still counts, under an unknown row", () => {
    expect(conversationTotals([carrier("a", { input: 5, costUsd: 0.5 })])?.models).toEqual([{ id: "unknown", input: 5, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.5, agents: ["This agent"] }]);
  });

  test("the chip reads the folded cost as this conversation's", () => {
    const items = [carrier("a", { input: 5, costUsd: 1.23 }, "gpt-5.6-sol")];
    expect(planChip({ session: conversationTotals(items) }, undefined)).toEqual({ text: "$1.23 this conversation", level: "normal", kind: "cost" });
  });
});

// A real conversation, priced by Berget's Qwen3.8 27B (the figures in the
// change's screenshots): `build` ran three `general` subagents, one of which
// launched an `explore` that launched another, and then gave the first
// `general` a second task. Today's fold read it as $0.11; it cost $0.0951.
describe("the receipt, from a real conversation", () => {
  const Q = "Qwen/Qwen3.8-27B-FP8";
  const items: ConversationItem[] = [
    carrier("b1", { input: 13_000, output: 500, costUsd: 0.008 }, Q, "build"),
    subagent("tool:summarise", "Summarise README", { input: 23_233, output: 170, costUsd: 0.0113 }, Q, { kind: "general", conversationId: "ses_a" }),
    subagent("tool:links", "List link targets", { input: 34_931, output: 247, costUsd: 0.0169 }, Q, { kind: "general", conversationId: "ses_b" }),
    subagent("tool:audit", "Audit mermaid docs", { input: 23_476, output: 217, costUsd: 0.0116 }, Q, { kind: "general", conversationId: "ses_c", descendants: [
      { id: "tool:find", parentId: "tool:audit", description: "Find mermaid files", subagent: "explore", conversationId: "ses_d", model: Q, usage: { input: 21_395, output: 583, costUsd: 0.0119 } },
      { id: "tool:count", parentId: "tool:find", description: "Count diagram lines", subagent: "explore", conversationId: "ses_e", model: Q, usage: { input: 27_369, output: 288, costUsd: 0.0136 } },
    ] }),
    carrier("b2", { input: 27_695, output: 1_060, costUsd: 0.0161 }, Q, "build"),
    // The same `general` as the first row, given a further task: its own line,
    // its own spend — not the agent's running total again.
    subagent("tool:shorten", "Shorten README summary", { input: 11_854, output: 65, costUsd: 0.0057 }, Q, { kind: "general", conversationId: "ses_a" }),
  ];
  const receipt = conversationTotals(items)!.receipt!;

  test("itemized by agent, each line is its own work and the lines sum to the total", () => {
    expect(receipt.lines.map(line => [line.depth, line.label, line.costUsd])).toEqual([
      [0, "build", 0.0241],
      [0, "general · Summarise README", 0.0113],
      [0, "general · List link targets", 0.0169],
      [0, "general · Audit mermaid docs", 0.0116],
      [1, "explore · Find mermaid files", 0.0119],
      [2, "explore · Count diagram lines", 0.0136],
      [0, "general · Shorten README summary", 0.0057],
    ].map(([depth, label, cost]) => [depth, label, expect.closeTo(cost as number, 10)]));
    expect(sumCost(receipt.lines)).toBeCloseTo(0.0951, 10);
    expect(receipt.total.costUsd).toBeCloseTo(0.0951, 10);
    expect(conversationTotals(items)!.costUsd).toBeCloseTo(0.0951, 10);
    // Tokens add up the same way.
    expect(receipt.total.input).toBe(receipt.lines.reduce((sum, line) => sum + line.input, 0));
    expect(receipt.total.input).toBe(182_953);
    // A nested line names what launched it; the launcher's line is its own spend only.
    expect(receipt.lines.find(line => line.id === "tool:count")).toEqual(expect.objectContaining({ parentId: "tool:find", depth: 2, kind: "task", agent: "explore", conversationId: "ses_e" }));
    expect(receipt.lines.find(line => line.id === "tool:audit")?.costUsd).toBeCloseTo(0.0116, 10);
  });

  test("main agents are named, one line per name, and the summarising agent gets its own", () => {
    expect(receipt.lines[0]).toEqual(expect.objectContaining({ id: "main:build", kind: "main", agent: "build", label: "build", input: 40_695, output: 1_560 }));
    const switched = conversationTotals([
      carrier("p", { input: 10, costUsd: 0.1 }, Q, "plan"),
      carrier("b", { input: 20, costUsd: 0.2 }, Q, "build"),
      carrier("c", { input: 5, costUsd: 0.05 }, Q, "compaction"),
      carrier("b2", { input: 30, costUsd: 0.3 }, Q, "build"),
    ])!.receipt!;
    expect(switched.lines.map(line => [line.label, line.kind, line.costUsd])).toEqual([
      ["plan", "main", 0.1], ["build", "main", 0.5], ["compaction", "summary", 0.05],
    ]);
    expect(switched.lines.some(line => line.label === "This agent")).toBe(false);
  });

  test("a task given to a subagent that already has a line names that line; a namesake does not", () => {
    expect(receipt.lines.find(line => line.id === "tool:shorten")?.sameAgentAs).toBe("tool:summarise");
    expect(receipt.lines.filter(line => line.sameAgentAs !== undefined)).toHaveLength(1);
    // Two DIFFERENT subagents that happen to share a description are two agents.
    const namesakes = conversationTotals([
      subagent("tool:x", "Review", { input: 1, costUsd: 0.1 }, Q, { kind: "general", conversationId: "ses_x" }),
      subagent("tool:y", "Review", { input: 1, costUsd: 0.1 }, Q, { kind: "general", conversationId: "ses_y" }),
    ])!.receipt!;
    expect(namesakes.lines.every(line => line.sameAgentAs === undefined)).toBe(true);
    // A nested subagent given a second task by ITS launcher is the same agent too.
    const nested = conversationTotals([subagent("tool:p", "Parent", { input: 1, costUsd: 0.1 }, Q, { kind: "general", conversationId: "ses_p", descendants: [
      { id: "tool:n1", parentId: "tool:p", description: "First", subagent: "explore", conversationId: "ses_n", usage: { costUsd: 0.1 } },
      { id: "tool:n2", parentId: "tool:p", description: "Second", subagent: "explore", conversationId: "ses_n", usage: { costUsd: 0.2 } },
    ] })])!.receipt!;
    expect(nested.lines.find(line => line.id === "tool:n2")?.sameAgentAs).toBe("tool:n1");
  });

  test("itemized by type, distinct subagents are counted per kind at any depth, with tasks where they differ", () => {
    expect(receipt.types.map(line => [line.label, line.kind, line.agents, line.tasks, line.input, line.output])).toEqual([
      ["build", "main", undefined, undefined, 40_695, 1_560],
      // Three generals, one of them given two tasks.
      ["general", "task", 3, 4, 93_494, 699],
      // Both explores are nested — counted all the same.
      ["explore", "task", 2, 2, 48_764, 871],
    ]);
    expect(receipt.types.map(line => line.costUsd)).toEqual([0.0241, 0.0455, 0.0255].map(cost => expect.closeTo(cost, 10)));
    expect(sumCost(receipt.types)).toBeCloseTo(0.0951, 10);
  });

  test("itemized by model, each model names who ran it, and the three itemizations agree", () => {
    expect(receipt.models).toEqual([expect.objectContaining({ id: Q, input: 182_953, output: 3_130, agents: ["build", "3 × general", "2 × explore"] })]);
    expect(sumCost(receipt.models)).toBeCloseTo(0.0951, 10);
    for (const itemization of [receipt.lines, receipt.types, receipt.models]) {
      expect(sumCost(itemization)).toBeCloseTo(receipt.total.costUsd!, 10);
      expect(itemization.reduce((sum, line) => sum + line.input, 0)).toBe(receipt.total.input);
      expect(itemization.reduce((sum, line) => sum + line.output, 0)).toBe(receipt.total.output);
    }
  });

  test("a line whose session reported no cost is listed without a figure, and one that reported nothing is not listed", () => {
    const partial = conversationTotals([
      carrier("b", { input: 5, costUsd: 0.5 }, Q, "build"),
      subagent("tool:free", "Local scan", { input: 300, output: 30 }, "local/llama", { kind: "general" }),
      subagent("tool:pending", "Just launched", undefined, undefined, { kind: "general" }),
      // No figure of its own, but something ran beneath it: it stays, to hang the line off.
      subagent("tool:idle", "Delegated everything", undefined, undefined, { kind: "general", descendants: [
        { id: "tool:worker", parentId: "tool:idle", description: "Did the work", subagent: "explore", conversationId: "ses_w", usage: { input: 9, costUsd: 0.25 } },
      ] }),
    ])!.receipt!;
    expect(partial.lines.map(line => [line.id, line.costUsd])).toEqual([["main:build", 0.5], ["tool:free", undefined], ["tool:idle", undefined], ["tool:worker", 0.25]]);
    expect(partial.total.costUsd).toBe(0.75);
    // A line that reported nothing contributes to no model: the delegator
    // names no model and must not mint an "unknown" row, and neither it nor
    // the worker (which named none either, but DID spend) is lost from the sum.
    expect(partial.models.map(model => [model.id, model.input, model.costUsd, model.agents])).toEqual([
      [Q, 5, 0.5, ["build"]],
      ["local/llama", 300, 0, ["general"]],
      ["unknown", 9, 0.25, ["explore"]],
    ]);
    // A nested line that names its model but has reported no spend yet adds no empty row either.
    const silent = conversationTotals([carrier("b", { input: 5, costUsd: 0.5 }, Q, "build"), subagent("tool:p", "Parent", { input: 1, costUsd: 0.1 }, Q, { kind: "general", descendants: [
      { id: "tool:quiet", parentId: "tool:p", description: "Not yet", subagent: "explore", conversationId: "ses_q", model: "other/model" },
    ] })])!.receipt!;
    expect(silent.models.map(model => model.id)).toEqual([Q]);
    expect(silent.lines.map(line => line.id)).toEqual(["main:build", "tool:p", "tool:quiet"]);
    for (const itemization of [partial.lines, partial.types, partial.models]) expect(sumCost(itemization)).toBeCloseTo(0.75, 10);
  });

  test("a subagent's own spend across its tasks leaves out what it launched", () => {
    expect(subagentSpend(items, "ses_a")?.costUsd).toBeCloseTo(0.017, 10);
    expect(subagentSpend(items, "ses_c")?.costUsd).toBeCloseTo(0.0116, 10);
    // A nested subagent is found among the lines.
    expect(subagentSpend(items, "ses_d")).toEqual(expect.objectContaining({ input: 21_395, costUsd: 0.0119 }));
    expect(subagentSpend(items, "ses_unknown")).toBeUndefined();
  });
});

describe("resolveSessionTotals", () => {
  test("the agent's own totals win over the fold; a report without them does not", () => {
    const session: SessionTotals = { costUsd: 9, apiDurationMs: 1, durationMs: 2, linesAdded: 0, linesRemoved: 0, models: [], since: 5 };
    const priced = carrier("a", { input: 5, costUsd: 0.5 }, "gpt-5.6-sol");
    expect(resolveSessionTotals([priced, { id: "r", type: "context_report", createdAt: 2, total: 10, session }])).toBe(session);
    // The agent's own totals carry no receipt: there is nothing to itemize per agent.
    expect(resolveSessionTotals([priced, { id: "r", type: "context_report", createdAt: 2, total: 10, session }])).not.toHaveProperty("receipt");
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
