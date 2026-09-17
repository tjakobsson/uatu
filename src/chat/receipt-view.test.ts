import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { conversationTotals } from "./conversation-totals";
import { buildReceiptRows, buildReceiptTotal, parseReceiptView, receiptHeading, subagentTrackSummary, subagentTranscriptTitle } from "./receipt-view";
import { subagentEntries } from "./timeline-renderer";
import type { ConversationItem, SessionTotals, SubagentLine, TokenUsage } from "./types";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
const Q = "Qwen/Qwen3.8-27B-FP8";
const names = (id: string) => (id === Q ? "Qwen3.8 27B" : id);

const carrier = (id: string, usage: TokenUsage, agent?: string, modelId = Q): ConversationItem => ({
  id: `usage:${id}`, type: "assistant_message", createdAt: 1, markdown: "", usage, model: { providerId: "berget", modelId }, ...(agent ? { agent } : {}),
});
const row = (id: string, description: string, kind: string, conversationId: string, usage?: TokenUsage, descendants?: SubagentLine[], status: "completed" | "running" = "completed"): ConversationItem => ({
  id, type: "tool", createdAt: 3, name: "task", status, input: JSON.stringify({ description, subagent_type: kind }), childConversationId: conversationId,
  ...(usage ? { usage, model: Q } : {}), ...(descendants ? { descendants } : {}),
});

// The real conversation in the change's screenshots: three generals, one of
// them given a second task, and an explore launching an explore under another.
const items: ConversationItem[] = [
  carrier("b1", { input: 40_695, output: 1_560, costUsd: 0.0241 }, "build"),
  row("tool:summarise", "Summarise README", "general", "ses_a", { input: 23_233, output: 170, costUsd: 0.0113 }),
  row("tool:links", "List link targets", "general", "ses_b", { input: 34_931, output: 247, costUsd: 0.0169 }),
  row("tool:audit", "Audit mermaid docs", "general", "ses_c", { input: 23_476, output: 217, costUsd: 0.0116 }, [
    { id: "tool:find", parentId: "tool:audit", description: "Find mermaid files", subagent: "explore", conversationId: "ses_d", model: Q, usage: { input: 21_395, output: 583, costUsd: 0.0119 } },
    { id: "tool:count", parentId: "tool:find", description: "Count diagram lines", subagent: "explore", conversationId: "ses_e", model: Q, usage: { input: 27_369, output: 288, costUsd: 0.0136 } },
  ]),
  row("tool:shorten", "Shorten README summary", "general", "ses_a", { input: 11_854, output: 65, costUsd: 0.0057 }),
];
const totals = conversationTotals(items)!;
const cells = (element: Element) => [...element.querySelectorAll("td, th")].map(cell => cell.textContent);
const label = (element: Element) => element.querySelector("td")!.firstChild!.textContent;
const noteOf = (element: Element) => element.querySelector(".chat-plan-session-agent-model")?.textContent;

describe("the receipt's rows", () => {
  test("by agent: one line per task with its own cost, nested lines stepped in under their launcher", () => {
    const rows = buildReceiptRows(document, totals, "agents", names);
    expect(rows.map(element => [element.dataset.depth, label(element), cells(element).at(-1)])).toEqual([
      [undefined, "build", "$0.0241"],
      [undefined, "general · Summarise README", "$0.0113"],
      [undefined, "general · List link targets", "$0.0169"],
      [undefined, "general · Audit mermaid docs", "$0.0116"],
      ["1", "explore · Find mermaid files", "$0.0119"],
      ["2", "explore · Count diagram lines", "$0.0136"],
      [undefined, "general · Shorten README summary", "$0.0057"],
    ]);
    // The main agent is named and said to be one; a further task for an agent
    // already listed names that line rather than passing as a new agent.
    expect(noteOf(rows[0]!)).toBe("Qwen3.8 27B · main agent");
    expect(noteOf(rows[1]!)).toBe("Qwen3.8 27B");
    expect(noteOf(rows[6]!)).toBe("Qwen3.8 27B · same agent as “Summarise README”");
    // Tokens: the compact figure, with the exact one a hover away.
    expect(cells(rows[1]!).slice(1, 3)).toEqual(["23k", "170"]);
    expect(rows[1]!.querySelectorAll("td")[1]!.title).toBe("23,233 input · 0 cache read · 0 cache write");
  });

  test("by type: distinct subagents per kind, tasks stated only where they differ", () => {
    const rows = buildReceiptRows(document, totals, "types", names);
    expect(rows.map(element => [element.querySelector("td")!.textContent, cells(element).at(-1)])).toEqual([
      ["buildQwen3.8 27B · main agent", "$0.0241"],
      ["3 × generalQwen3.8 27B · 4 tasks", "$0.0455"],
      ["2 × exploreQwen3.8 27B", "$0.0255"],
    ]);
    expect(rows[1]!.querySelector(".chat-receipt-count")?.textContent).toBe("3 × ");
    expect(rows[0]!.querySelector(".chat-receipt-count")).toBeNull();
  });

  test("by model: each model names who ran it", () => {
    const rows = buildReceiptRows(document, totals, "models", names);
    expect(rows).toHaveLength(1);
    expect(label(rows[0]!)).toBe("Qwen3.8 27B");
    expect(rows[0]!.querySelector("td")!.title).toBe(Q);
    expect(noteOf(rows[0]!)).toBe("build · 3 × general · 2 × explore");
    expect(cells(rows[0]!).slice(1)).toEqual(["183k", "3.1k", "$0.0951"]);
  });

  test("the total line is what every itemization sums to", () => {
    expect(cells(buildReceiptTotal(document, totals.receipt!.total))).toEqual(["Total", "183k", "3.1k", "$0.0951"]);
    const dollars = (text: string | null) => Number(text!.replace("$", ""));
    for (const view of ["agents", "types", "models"] as const) {
      const sum = buildReceiptRows(document, totals, view, names).reduce((total, element) => total + dollars(cells(element).at(-1)!), 0);
      expect(sum).toBeCloseTo(0.0951, 4);
    }
  });

  test("a line with no price reads as a dash, a compaction line says what it did, and deep nesting stops stepping in", () => {
    const deep = (depth: number): SubagentLine[] => Array.from({ length: depth }, (_, index) => ({
      id: `tool:d${index}`, parentId: index === 0 ? "tool:top" : `tool:d${index - 1}`, description: `Level ${index + 1}`, subagent: "explore", conversationId: `ses_d${index}`, usage: { input: 1, costUsd: 0.01 },
    }));
    const rows = buildReceiptRows(document, conversationTotals([
      carrier("c", { input: 6_000, output: 200, costUsd: 0.08 }, "compaction"),
      row("tool:free", "Local scan", "general", "ses_f", { input: 300, output: 30 }),
      row("tool:zero", "Unpriced model", "general", "ses_z", { input: 300, output: 30, costUsd: 0 }),
      row("tool:top", "Delegates", "general", "ses_t", { input: 1, costUsd: 0.01 }, deep(6)),
    ])!, "agents", names);
    expect(noteOf(rows[0]!)).toBe("Qwen3.8 27B · summarised the conversation");
    expect(cells(rows[1]!).at(-1)).toBe("—");
    expect(rows[1]!.querySelectorAll("td")[3]!.title).toBe("No price reported");
    expect(cells(rows[2]!).at(-1)).toBe("—");
    expect(rows.slice(4).map(element => element.dataset.depth)).toEqual(["1", "2", "3", "4", "4", "4"]);
  });

  test("totals the agent tallies itself have one itemization: per model, as reported, with no receipt behind it", () => {
    const session: SessionTotals = { costUsd: 1.5, apiDurationMs: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0, models: [
      { id: "claude-opus", input: 1_000, output: 100, cacheRead: 50, cacheWrite: 0, costUsd: 1.5 },
      { id: "claude-haiku", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    ] };
    for (const view of ["agents", "types", "models"] as const) {
      const rows = buildReceiptRows(document, session, view, id => id);
      expect(rows.map(element => cells(element))).toEqual([["claude-opus", "1.1k", "100", "$1.50"], ["claude-haiku", "10", "1", "$0.00"]]);
      expect(rows.every(element => noteOf(element) === undefined)).toBe(true);
    }
  });

  test("the itemization is a closed choice, and each has its column heading", () => {
    expect([parseReceiptView("agents"), parseReceiptView("types"), parseReceiptView("models")]).toEqual(["agents", "types", "models"]);
    expect([parseReceiptView("model"), parseReceiptView(undefined), parseReceiptView(3)]).toEqual([undefined, undefined, undefined]);
    expect((["agents", "types", "models"] as const).map(receiptHeading)).toEqual(["Agent", "Type", "Model"]);
  });
});

describe("a subagent in context", () => {
  test("its transcript is titled with what the agent itself spent across its tasks", () => {
    const entries = subagentEntries(items);
    // Two tasks, one agent: the title is the agent, not either task's figure.
    expect(subagentTranscriptTitle(entries, items, "ses_a")).toBe("general · Summarise README · $0.017");
    // What it launched is not part of it: $0.0116, not the branch's $0.0371.
    expect(subagentTranscriptTitle(entries, items, "ses_c")).toBe("general · Audit mermaid docs · $0.0116");
    expect(subagentTranscriptTitle(entries, [row("tool:n", "No price yet", "general", "ses_n")], "ses_n")).toBe("Subagent");
    expect(subagentTranscriptTitle(subagentEntries([row("tool:n", "No price yet", "general", "ses_n")]), [row("tool:n", "No price yet", "general", "ses_n")], "ses_n")).toBe("general · No price yet");
    expect(subagentTranscriptTitle(entries, items, "ses_missing")).toBe("Subagent");
  });

  test("the composer list counts subagents, and states tasks where a subagent was given more than one", () => {
    const one = (id: string, conversationId: string, status: "completed" | "running" = "completed") => subagentEntries([row(id, `Task ${id}`, "general", conversationId, undefined, undefined, status)])[0]!;
    // One task per subagent: as it has always read.
    expect(subagentTrackSummary([one("a", "s1"), one("b", "s2"), one("c", "s3"), one("d", "s4")])).toBe("4 subagents finished");
    expect(subagentTrackSummary([one("a", "s1")])).toBe("1 subagent finished");
    expect(subagentTrackSummary([one("a", "s1"), one("b", "s2", "running")])).toBe("1 of 2 subagents working · Task b");
    // Three subagents, one of them given a second task: four rows, three agents.
    expect(subagentTrackSummary([one("a", "s1"), one("b", "s2"), one("c", "s3"), one("d", "s1")])).toBe("3 subagents · 4 tasks finished");
    expect(subagentTrackSummary([one("a", "s1"), one("b", "s2"), one("d", "s1", "running")])).toBe("2 subagents · 1 of 3 tasks working · Task d");
    expect(subagentTrackSummary([one("a", "s1"), one("d", "s1")])).toBe("1 subagent · 2 tasks finished");
    // The real conversation: four rows, three generals.
    expect(subagentTrackSummary(subagentEntries(items))).toBe("3 subagents · 4 tasks finished");
  });
});
