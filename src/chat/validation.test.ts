import { describe, expect, test } from "bun:test";

import {
  parseChatAvailability,
  parseChatCommand,
  parseChatEvent,
  parseChatMode,
  parseChatModel,
  parseConversationInventoryEvent,
  parseConversationItem,
  parseConversationConfiguration,
  parseConversationSnapshot,
  parseConversationSummary,
  parseInteractionRequest,
  parseReversibleHistoryResult,
  parseReversibleHistoryState,
} from "./validation";
import type { ConversationItem } from "./types";

const summary = {
  id: "opencode:session-1",
  title: "Implement chat",
  createdAt: 1,
  updatedAt: 2,
  status: "running",
  agent: { id: "opencode", name: "OpenCode" },
} as const;

const items = [
  { id: "user-1", type: "user_message", createdAt: 1, text: "Build it", requestId: "request-1" },
  { id: "assistant-1", type: "assistant_message", createdAt: 2, markdown: "Working on **chat**." },
  { id: "reasoning-1", type: "reasoning", createdAt: 3, text: "Inspect routes", status: "completed" },
  { id: "tool-1", type: "tool", createdAt: 4, name: "read", status: "running", input: "src/app.ts" },
  { id: "command-1", type: "command", createdAt: 5, command: "bun test", status: "completed", exitCode: 0 },
  { id: "file-1", type: "file_change", createdAt: 6, path: "src/chat/types.ts", operation: "create", additions: 10 },
  {
    id: "permission-1",
    type: "permission",
    createdAt: 7,
    requestId: "provider-permission-1",
    action: "shell",
    resources: ["bun test"],
    status: "pending",
  },
  {
    id: "question-1",
    type: "question",
    createdAt: 8,
    requestId: "provider-question-1",
    questions: [{
      prompt: "Choose tests",
      header: "Tests",
      options: [{ label: "Unit", description: "Run unit tests" }],
      multiple: true,
      allowFreeForm: true,
    }],
    status: "resolved",
    outcome: { kind: "answered", answers: [["Unit", "E2E"]] },
  },
  { id: "status-1", type: "turn_status", createdAt: 9, status: "completed" },
  { id: "notice-1", type: "notice", createdAt: 10, level: "warning", message: "Output was truncated" },
] as const;

describe("chat domain validation", () => {
  test("accepts strict command metadata", () => {
    expect(parseChatCommand({ name: "review", description: "Review changes", argumentHint: "[focus]", kind: "skill" }))
      .toEqual(expect.objectContaining({ name: "review", kind: "skill" }));
    expect(parseChatCommand({ name: "undo", description: "Undo a turn", argumentHint: "", kind: "local-operation" }))
      .toEqual(expect.objectContaining({ name: "undo", kind: "local-operation" }));
    expect(() => parseChatCommand({ name: "bad/name", description: "", argumentHint: "", kind: "command" })).toThrow();
  });

  test("accepts strict provider-independent model metadata", () => {
    expect(parseChatModel({
      selection: { providerId: "anthropic", modelId: "claude-sonnet" },
      provider: "Anthropic",
      name: "Claude Sonnet",
    })).toBeDefined();
    expect(() => parseChatModel({
      selection: { providerId: "anthropic", modelId: "claude-sonnet", variant: "fast" },
      provider: "Anthropic",
      name: "Claude Sonnet",
    })).toThrow();
  });

  test("declared-default model and mode metadata round-trips; malformed values are rejected", () => {
    const base = { selection: { providerId: "anthropic", modelId: "default" }, provider: "Anthropic", name: "Default (recommended)" };
    expect(parseChatModel({
      ...base,
      detail: "Opus 5 with 1M context",
      default: true,
      resolvesTo: { providerId: "anthropic", modelId: "opus[1m]" },
    })).toBeDefined();
    // Absent fields stay legal: an older server omits them.
    expect(parseChatModel(base)).toBeDefined();
    expect(() => parseChatModel({ ...base, detail: "" })).toThrow();
    expect(() => parseChatModel({ ...base, default: "yes" })).toThrow();
    expect(() => parseChatModel({ ...base, resolvesTo: { providerId: "anthropic" } })).toThrow();
    expect(parseChatMode({ name: "auto", description: "Claude handles permission decisions", default: true })).toBeDefined();
    expect(parseChatMode({ name: "build", description: "" })).toBeDefined();
    expect(() => parseChatMode({ name: "auto", description: "", default: 1 })).toThrow();
  });

  test("accepts representative status, summary, snapshot, and timeline fixtures", () => {
    expect(parseChatAvailability({ state: "ready", version: "1.18.18" })).toEqual({
      state: "ready",
      version: "1.18.18",
    });
    expect(parseConversationSummary(summary)).toBeDefined();
    for (const item of items) expect(parseConversationItem(item)).toBeDefined();

    const snapshot = {
      conversation: summary,
      configuration: { model: { providerId: "anthropic", modelId: "claude" }, mode: "build", variant: "high" },
      generation: "generation-1",
      cursor: "generation-1:10",
      items,
      queued: [{ id: "held-1", text: "queued follow-up", queuedAt: 11, requestId: "request-9" }],
      reversibleHistory: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "message:user-1", text: "hello" }] },
      olderCursor: "before:user-1",
    };
    expect(parseConversationSnapshot(snapshot)).toBeDefined();
    // Absent means empty; a producer without a queue concept stays parseable.
    expect(parseConversationSnapshot({ ...snapshot, queued: undefined })).toBeDefined();
  });

  test("accepts pending and resolved interaction request fixtures", () => {
    expect(parseInteractionRequest(items[6])).toBeDefined();
    expect(parseInteractionRequest(items[7])).toBeDefined();
    expect(parseInteractionRequest({
      ...items[6],
      status: "resolved",
      outcome: "approved-once",
    })).toEqual(expect.objectContaining({ outcome: "approved-once" }));
    expect(parseInteractionRequest({
      ...items[7],
      status: "resolved",
      outcome: { kind: "rejected" },
    })).toEqual(expect.objectContaining({ outcome: { kind: "rejected" } }));
  });

  test("accepts every ordered event fixture", () => {
    const base = { generation: "generation-1", conversationId: "opencode:session-1" };
    const events = [
      { ...base, sequence: 1, type: "item.upsert", item: items[0] },
      { ...base, sequence: 2, type: "item.remove", itemId: "notice-1" },
      { ...base, sequence: 3, type: "item.text_delta", itemId: "assistant-1", delta: " More" },
      { ...base, sequence: 4, type: "conversation.status", status: "completed" },
      { ...base, sequence: 5, type: "conversation.configuration", configuration: { model: { providerId: "anthropic", modelId: "claude" }, variant: "high" } },
      { ...base, sequence: 6, type: "conversation.updated", conversation: summary },
      { ...base, sequence: 7, type: "conversation.queue", queued: [{ id: "held-1", text: "queued follow-up", queuedAt: 11 }], change: { kind: "held", messageId: "held-1" } },
      { ...base, sequence: 8, type: "conversation.queue", queued: [], change: { kind: "delivered", messageId: "held-1" } },
      { ...base, sequence: 9, type: "resync", reason: "retention-gap" },
      { ...base, sequence: 10, type: "resync", reason: "conversation-rewritten" },
    ];
    for (const event of events) expect(parseChatEvent(event)).toBeDefined();
  });

  test("accepts only the normalized conversation inventory event", () => {
    expect(parseConversationInventoryEvent({ type: "conversation.inventory" })).toEqual({
      type: "conversation.inventory",
    });
    expect(() => parseConversationInventoryEvent({ type: "conversation.created" })).toThrow(/type/);
    expect(() => parseConversationInventoryEvent({ type: "conversation.inventory", conversationId: "c1" })).toThrow(/unknown/);
    expect(() => parseConversationInventoryEvent(null)).toThrow(/object/);
  });

  test("rejects malformed identities, statuses, ordering, and unknown variants", () => {
    const invalid = [
      () => parseConversationSummary({ ...summary, id: "" }),
      () => parseConversationSummary({ ...summary, status: "busy" }),
      () => parseConversationItem({ ...items[3], status: "done" }),
      () => parseConversationItem({ ...items[0], type: "provider_message" }),
      () => parseChatEvent({ generation: "g", sequence: -1, conversationId: "c", type: "item.remove", itemId: "i" }),
      () => parseChatEvent({ generation: "g", sequence: 1.5, conversationId: "c", type: "item.remove", itemId: "i" }),
      () => parseChatEvent({ generation: "g", sequence: 1, conversationId: "c", type: "conversation.queue", queued: [{ id: "held-1", text: 5, queuedAt: 1 }], change: { kind: "held", messageId: "held-1" } }),
      () => parseChatEvent({ generation: "g", sequence: 1, conversationId: "c", type: "conversation.queue", queued: [], change: { kind: "steered", messageId: "held-1" } }),
    ];
    for (const parse of invalid) expect(parse).toThrow();
  });

  test("strictly validates normalized conversation configuration", () => {
    expect(parseConversationConfiguration({})).toEqual({});
    expect(parseConversationConfiguration({ model: { providerId: "openai", modelId: "gpt" }, mode: "build", variant: "high" })).toBeDefined();
    expect(() => parseConversationConfiguration({ variant: "high" })).toThrow(/requires a model/);
    expect(() => parseConversationConfiguration({ model: { providerId: "openai", modelId: "gpt" }, extra: true })).toThrow(/unknown/);
    expect(() => parseConversationConfiguration({ mode: "" })).toThrow();
  });

  test("strictly validates reversible history state and mutation results", () => {
    expect(parseReversibleHistoryState({ staged: false, canUndo: true, canRedo: false, revertedMessages: [] })).toBeDefined();
    expect(parseReversibleHistoryResult({
      outcome: "changed",
      state: { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:user-1", text: "Try another approach" }] },
      restoredDraft: {
        text: "Try another approach",
        attachments: [{ id: "attachment-1", name: "screen.png", mimeType: "image/png" }],
      },
    })).toBeDefined();
    expect(() => parseReversibleHistoryState({ staged: false, canUndo: true, canRedo: true, revertedMessages: [] })).toThrow(/cannot redo/);
    expect(() => parseReversibleHistoryState({ staged: false, canUndo: true, canRedo: false, revertedMessages: [{ id: "message:user-1", text: "hidden" }] })).toThrow(/cannot list reverted messages/);
    expect(() => parseReversibleHistoryState({ staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "", text: "hidden" }] })).toThrow(/id/);
    expect(() => parseReversibleHistoryResult({
      outcome: "changed",
      state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "message:user-1", text: "draft" }] },
      restoredDraft: { text: "draft", data: "bytes" },
    })).toThrow(/unknown/);
  });

  test("token usage parses on assistant and tool items and stays a closed shape", () => {
    const usage = { input: 12_000, output: 400, reasoning: 90, cacheRead: 8_000, cacheWrite: 512 };
    expect(parseConversationItem({ ...items[1], usage, model: { providerId: "anthropic", modelId: "claude" } })).toBeDefined();
    expect(parseConversationItem({ ...items[3], model: "anthropic/claude-sonnet", usage: { input: 5 } })).toBeDefined();
    // An agent reports what it measures, so every component is optional — but
    // the readouts do arithmetic on these, so a component that is present must
    // be a count and no other key may ride along.
    expect(parseConversationItem({ ...items[1], usage: {} })).toBeDefined();
    expect(() => parseConversationItem({ ...items[1], usage: { input: -1 } })).toThrow(/non-negative/);
    expect(() => parseConversationItem({ ...items[1], usage: { input: "12000" } })).toThrow(/non-negative/);
    expect(() => parseConversationItem({ ...items[1], usage: { total: 12_400 } })).toThrow(/unknown/);
    expect(() => parseConversationItem({ ...items[1], usage: 12_400 })).toThrow();
    expect(() => parseConversationItem({ ...items[1], model: { providerId: "anthropic" } })).toThrow();
    expect(() => parseConversationItem({ ...items[3], model: 5 })).toThrow();
  });

  test("an optional question parses and may be answered with an empty array", () => {
    const question = { prompt: "Retries?", header: "retries", options: [], multiple: false, allowFreeForm: true, optional: true };
    expect(parseConversationItem({ id: "question:o", type: "question", createdAt: 1, requestId: "o", status: "pending", questions: [question] })).toBeTruthy();
    expect(parseConversationItem({ id: "question:o", type: "question", createdAt: 1, requestId: "o", status: "resolved", questions: [question], outcome: { kind: "answered", answers: [[]] } })).toBeTruthy();
    expect(() => parseConversationItem({ id: "question:o", type: "question", createdAt: 1, requestId: "o", status: "pending", questions: [{ ...question, optional: "yes" }] })).toThrow(/optional/);
  });

  test("a dialog or elicitation question carries its source, intro, link, and raw request", () => {
    const base = { id: "question:d1", type: "question", createdAt: 3, requestId: "d1", status: "pending", questions: [{ prompt: "Retry?", header: "Refusal", options: [{ label: "Retry", description: "" }], multiple: false, allowFreeForm: false }] };
    expect(parseConversationItem({ ...base, source: "dialog", intro: "Claude Code asks", schema: { dialogKind: "refusal_fallback_prompt", payload: {} } })).toBeTruthy();
    expect(parseConversationItem({ ...base, source: "elicitation", intro: "github asks", link: "https://example.com/auth" })).toBeTruthy();
    expect(() => parseConversationItem({ ...base, source: "hook" })).toThrow(/question source/);
    expect(() => parseConversationItem({ ...base, link: "javascript:alert(1)" })).toThrow(/http/);
    expect(() => parseConversationItem({ ...base, intro: "" })).toThrow(/intro/);
    expect(() => parseConversationItem({ ...base, schema: "not-an-object" })).toThrow(/schema/);
  });

  test("named live statuses, labelled reasoning, coded notices, and plan utilization parse", () => {
    for (const status of ["background", "retrying", "compacting"]) {
      expect(parseConversationItem({ id: "s", type: "turn_status", createdAt: 1, status })).toBeTruthy();
    }
    expect(() => parseConversationItem({ id: "s", type: "turn_status", createdAt: 1, status: "paused" })).toThrow(/status/);
    expect(parseConversationItem({ id: "memory:1", type: "reasoning", createdAt: 1, text: "x", status: "completed", label: "Recalled from memory" })).toBeTruthy();
    expect(() => parseConversationItem({ id: "memory:1", type: "reasoning", createdAt: 1, text: "x", status: "completed", label: "" })).toThrow(/label/);
    expect(parseConversationItem({ id: "n", type: "notice", createdAt: 1, level: "error", message: "m", code: "rate-limit-rejected", resetsAt: 5 })).toBeTruthy();
    expect(() => parseConversationItem({ id: "n", type: "notice", createdAt: 1, level: "error", message: "m", resetsAt: -1 })).toThrow(/resetsAt/);
    expect(parseConversationItem({ id: "c", type: "context_report", createdAt: 1, total: 10, plan: { fiveHour: { utilization: 37, resetsAt: 5 }, sevenDay: {} } })).toBeTruthy();
    expect(() => parseConversationItem({ id: "c", type: "context_report", createdAt: 1, total: 10, plan: { fiveHour: { utilization: -1 } } })).toThrow(/utilization/);
  });

  test("a widened plan report passes as a superset, wrong-typed fields fail, and windows the SDK adds later are ignored", () => {
    const superset = {
      id: "c", type: "context_report", createdAt: 1, total: 10,
      plan: {
        subscription: "max",
        fiveHour: { utilization: 9, resetsAt: 5 }, sevenDay: { utilization: 25, resetsAt: 9 },
        sevenDayOpus: { utilization: 61 }, sevenDaySonnet: { utilization: 4 }, sevenDayOauthApps: { utilization: 0, resetsAt: 9 },
        modelScoped: [{ label: "Fable", utilization: 83, resetsAt: 9 }],
        extraUsage: { enabled: true, usedCredits: 12.5, monthlyLimit: 100, utilization: 12.5, currency: "USD" },
      },
      session: { costUsd: 1.2, apiDurationMs: 42, durationMs: 90, linesAdded: 1, linesRemoved: 0, models: [{ id: "claude-opus-5", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 1.1 }] },
    };
    expect(parseConversationItem(superset)).toBeTruthy();
    // An unknown window key is a newer SDK talking, not a broken report.
    expect(parseConversationItem({ ...superset, plan: { ...superset.plan, thirtyDay: { utilization: 1 } } })).toBeTruthy();
    expect(() => parseConversationItem({ ...superset, plan: { ...superset.plan, subscription: 7 } })).toThrow(/subscription/);
    expect(() => parseConversationItem({ ...superset, plan: { ...superset.plan, sevenDayOpus: { utilization: "lots" } } })).toThrow(/sevenDayOpus utilization/);
    expect(() => parseConversationItem({ ...superset, plan: { ...superset.plan, modelScoped: [{ utilization: 1 }] } })).toThrow(/modelScoped label/);
    expect(() => parseConversationItem({ ...superset, plan: { ...superset.plan, extraUsage: { enabled: "yes" } } })).toThrow(/extraUsage enabled/);
    expect(() => parseConversationItem({ ...superset, session: { ...superset.session, costUsd: "free" } })).toThrow(/session costUsd/);
    expect(() => parseConversationItem({ ...superset, session: { ...superset.session, models: [{ id: "x", input: 1 }] } })).toThrow(/session model output/);
    expect(() => parseConversationItem({ ...superset, session: { ...superset.session, behaviors: {} } })).toThrow(/unknown context report session field/);
    expect(parseConversationItem({ id: "t", type: "tool", createdAt: 1, name: "Bash", status: "running", elapsedMs: 1200 })).toBeTruthy();
    expect(parseConversationItem({ id: "task:1", type: "background_task", createdAt: 1, taskId: "1", description: "d", status: "running" })).toBeTruthy();
    expect(() => parseConversationItem({ id: "task:1", type: "background_task", createdAt: 1, taskId: "1", description: "d", status: "paused" })).toThrow(/background task status/);
  });

  test("context reports and compaction markers parse as closed shapes", () => {
    const report = { id: "context:1", type: "context_report", createdAt: 5, total: 9697, max: 1_000_000, model: { providerId: "anthropic", modelId: "opus[1m]" }, categories: [{ name: "Messages", tokens: 10, kind: "used" }, { name: "Free space", tokens: 990_303, kind: "free" }] } as ConversationItem;
    expect(parseConversationItem(report)).toEqual(report);
    expect(parseConversationItem({ id: "context:2", type: "context_report", createdAt: 5, total: 0 })).toBeTruthy();
    expect(() => parseConversationItem({ id: "context:3", type: "context_report", createdAt: 5 })).toThrow(/total/);
    expect(() => parseConversationItem({ ...report, max: 0 })).toThrow(/max/);
    expect(() => parseConversationItem({ ...report, categories: [{ name: "Messages", tokens: 10, kind: "spent" }] })).toThrow(/category kind/);
    expect(() => parseConversationItem({ ...report, percentage: 1 })).toThrow(/unknown context_report field/);
    const compaction = { id: "compaction:1", type: "compaction", createdAt: 6, trigger: "auto", preTokens: 180_000, postTokens: 40_000 } as ConversationItem;
    expect(parseConversationItem(compaction)).toEqual(compaction);
    expect(parseConversationItem({ id: "compaction:2", type: "compaction", createdAt: 6 })).toBeTruthy();
    expect(() => parseConversationItem({ ...compaction, trigger: "scheduled" })).toThrow(/compaction trigger/);
    expect(() => parseConversationItem({ ...compaction, preTokens: -1 })).toThrow(/preTokens/);
  });

  test("rejects contradictory interaction request state and unsafe extra fields", () => {
    expect(() => parseInteractionRequest({ ...items[6], outcome: "approved-once" })).toThrow(/pending/);
    expect(() => parseInteractionRequest({ ...items[6], status: "resolved" })).toThrow(/outcome/);
    expect(() => parseInteractionRequest({ ...items[7], status: "pending", outcome: { kind: "rejected" } })).toThrow(/pending/);
    expect(() => parseConversationSnapshot({
      conversation: summary,
      configuration: {},
      generation: "g",
      cursor: "c",
      items: [],
      providerPayload: {},
    })).toThrow(/unknown/);
  });
});
