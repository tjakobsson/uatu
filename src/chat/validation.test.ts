import { describe, expect, test } from "bun:test";

import {
  parseChatAvailability,
  parseChatCommand,
  parseChatEvent,
  parseChatModel,
  parseConversationItem,
  parseConversationConfiguration,
  parseConversationSnapshot,
  parseConversationSummary,
  parseInteractionRequest,
} from "./validation";

const summary = {
  id: "session-1",
  title: "Implement chat",
  createdAt: 1,
  updatedAt: 2,
  status: "running",
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
      olderCursor: "before:user-1",
    };
    expect(parseConversationSnapshot(snapshot)).toBeDefined();
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
    const base = { generation: "generation-1", conversationId: "session-1" };
    const events = [
      { ...base, sequence: 1, type: "item.upsert", item: items[0] },
      { ...base, sequence: 2, type: "item.remove", itemId: "notice-1" },
      { ...base, sequence: 3, type: "item.text_delta", itemId: "assistant-1", delta: " More" },
      { ...base, sequence: 4, type: "conversation.status", status: "completed" },
      { ...base, sequence: 5, type: "conversation.configuration", configuration: { model: { providerId: "anthropic", modelId: "claude" }, variant: "high" } },
      { ...base, sequence: 6, type: "conversation.updated", conversation: summary },
      { ...base, sequence: 7, type: "resync", reason: "retention-gap" },
    ];
    for (const event of events) expect(parseChatEvent(event)).toBeDefined();
  });

  test("rejects malformed identities, statuses, ordering, and unknown variants", () => {
    const invalid = [
      () => parseConversationSummary({ ...summary, id: "" }),
      () => parseConversationSummary({ ...summary, status: "busy" }),
      () => parseConversationItem({ ...items[3], status: "done" }),
      () => parseConversationItem({ ...items[0], type: "provider_message" }),
      () => parseChatEvent({ generation: "g", sequence: -1, conversationId: "c", type: "item.remove", itemId: "i" }),
      () => parseChatEvent({ generation: "g", sequence: 1.5, conversationId: "c", type: "item.remove", itemId: "i" }),
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
