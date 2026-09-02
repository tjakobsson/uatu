import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import spike from "../../../tests/fixtures/claude-sdk/spike-messages.json";
import type { NormalizedProviderEvent } from "../provider";
import { createClaudeEventMemory, normalizeClaudeMessage, normalizeContextUsage, normalizeTranscriptEntries } from "./normalization";
import { ClaudeProvider, type ClaudeQueryHandle, type ClaudeQueryInput, type ClaudeUserEnvelope } from "./provider";
import type { QuestionRequest } from "../types";
import { claudeProjectDir } from "./transcript";

class FakeQuery implements ClaudeQueryHandle {
  readonly emitted: unknown[] = [];
  private readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  private readonly queued: unknown[] = [];
  interrupts = 0;
  returned = false;
  failure: Error | null = null;
  setPermissionMode?: (mode: string) => Promise<void>;
  rewindFiles?: (userMessageId: string, options?: { dryRun?: boolean }) => Promise<{ canRewind: boolean; error?: string; filesChanged?: string[] }>;
  supportedModels?: () => Promise<unknown>;
  supportedCommands?: () => Promise<unknown>;
  applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
  getContextUsage?: () => Promise<unknown>;

  constructor(readonly input: ClaudeQueryInput) {}

  push(message: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.queued.push(message);
  }

  fail(error: Error): void {
    this.failure = error;
    const waiter = this.waiters.shift();
    if (waiter) waiter(Promise.reject(error) as never);
  }

  async interrupt(): Promise<unknown> {
    this.interrupts += 1;
    return {};
  }

  async return(): Promise<IteratorResult<unknown, void>> {
    this.returned = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.failure) return Promise.reject(this.failure);
        const value = this.queued.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.returned) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}

function fixture(): { provider: ClaudeProvider; queries: FakeQuery[]; configDir: string; workspace: string } {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-provider-")));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const configDir = path.join(root, "config");
  mkdirSync(claudeProjectDir(workspace, configDir), { recursive: true });
  const queries: FakeQuery[] = [];
  const provider = new ClaudeProvider({
    workspacePath: workspace,
    stateFile: path.join(workspace, ".uatu-test-state.json"),
    executable: "/usr/local/bin/claude",
    configDir,
    catalogProbe: false,
    queryFactory: input => {
      const query = new FakeQuery(input);
      queries.push(query);
      return query;
    },
  });
  return { provider, queries, configDir, workspace };
}

function collect(provider: ClaudeProvider): { events: NormalizedProviderEvent[]; stop: () => void } {
  const abort = new AbortController();
  const events: NormalizedProviderEvent[] = [];
  void (async () => {
    for await (const event of provider.events(abort.signal)) events.push(event);
  })();
  return { events, stop: () => abort.abort() };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition never became true");
}

describe("normalization against the recorded SDK traffic", () => {
  test("every spike message is either handled or deliberately ignored", () => {
    const memory = createClaudeEventMemory();
    const outcomes = new Map<string, number>();
    for (const entry of (spike as { entries: Array<{ label: string; message: unknown }> }).entries) {
      if (!entry.label.startsWith("turn-")) continue;
      const normalized = normalizeClaudeMessage(entry.message, memory, "live");
      outcomes.set(normalized.outcome, (outcomes.get(normalized.outcome) ?? 0) + 1);
      expect(["handled", "ignored"]).toContain(normalized.outcome);
    }
    expect(outcomes.get("handled") ?? 0).toBeGreaterThan(0);
  });

  test("a real turn produces text, tool lifecycle, usage carrier, and completion", () => {
    const memory = createClaudeEventMemory();
    const entries = (spike as { entries: Array<{ label: string; message: unknown }> }).entries
      .filter(entry => entry.label === "turn-2-edit");
    const updates = entries.flatMap(entry => normalizeClaudeMessage(entry.message, memory, "live").updates);
    const upserts = updates.filter(update => update.kind === "upsert").map(update => (update as { item: { id: string; type: string; status?: string } }).item);
    // The recorded turn ran the Write tool; its lifecycle lands as one row.
    const tools = upserts.filter(item => item.type === "tool");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some(item => item.status === "completed")).toBe(true);
    expect(upserts.some(item => item.id.startsWith("usage:"))).toBe(true);
    expect(updates.some(update => update.kind === "status" && update.status === "completed")).toBe(true);
  });
});

describe("context usage measures the window, not the turn (D1)", () => {
  const call = (uuid: string, occupancy: number) => ({
    type: "assistant", uuid, timestamp: "2026-09-02T10:00:00.000Z",
    message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "step" }], usage: { input_tokens: 100, cache_read_input_tokens: occupancy - 100, output_tokens: 20 } },
  });

  test("a five-call turn at 30k occupancy yields a latest carrier of 30k, not 150k", () => {
    const memory = createClaudeEventMemory();
    const updates = [1, 2, 3, 4, 5].flatMap(index => normalizeClaudeMessage(call(`a${index}`, 30_000), memory, "live").updates);
    const result = normalizeClaudeMessage({
      type: "result", subtype: "success", uuid: "r1", timestamp: "2026-09-02T10:00:05.000Z",
      // The SDK's per-turn sum: five calls of 30k input-side tokens.
      usage: { input_tokens: 500, cache_read_input_tokens: 149_500, output_tokens: 100 },
    }, memory, "live");
    const carriers = updates.filter(update => update.kind === "upsert" && update.item.type === "assistant_message" && update.item.markdown === "")
      .map(update => (update as { item: { id: string; usage: { input: number; cacheRead: number } } }).item);
    expect(carriers.map(item => item.id)).toEqual(["usage:a1", "usage:a2", "usage:a3", "usage:a4", "usage:a5"]);
    const latest = carriers.at(-1)!;
    expect(latest.usage.input + latest.usage.cacheRead).toBe(30_000);
    // The result carries the turn's status and nothing about the window.
    expect(result.updates).toEqual([{ kind: "status", status: "completed" }]);
    expect(result.assistantUsage).toBeUndefined();
  });

  test("a stored compaction boundary survives a reload with the same marker and report", () => {
    // The transcript spells the boundary camelCase; the same row and report
    // come out of a reopen as the live message produced.
    const { items } = normalizeTranscriptEntries([
      { kind: "user", uuid: "u1", parentUuid: null, timestamp: 1, isSidechain: false, parentToolUseId: null, message: { role: "user", content: "hi" } },
      { kind: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 180_000, postTokens: 40_000 }, uuid: "cb1", parentUuid: "u1", timestamp: 2, isSidechain: false, parentToolUseId: null, message: {} },
      { kind: "assistant", uuid: "a1", parentUuid: "cb1", timestamp: 3, isSidechain: false, parentToolUseId: null, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "after" }] } },
    ]);
    expect(items.map(item => item.id)).toEqual(["message:u1", "compaction:cb1", "context:cb1", "message:a1"]);
    expect(items[1]).toEqual({ id: "compaction:cb1", type: "compaction", createdAt: 2, trigger: "auto", preTokens: 180_000, postTokens: 40_000 });
    expect(items[2]).toEqual(expect.objectContaining({ type: "context_report", total: 40_000 }));
  });

  test("a subagent's frames carry no window carrier and never move the conversation's model", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "system", subtype: "init", uuid: "i1", model: "claude-opus-5[1m]" }, memory, "live");
    const child = normalizeClaudeMessage({
      type: "assistant", uuid: "sub1", timestamp: "2026-09-02T10:00:00.000Z", parent_tool_use_id: "toolu_task",
      message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "child" }], usage: { input_tokens: 50, cache_read_input_tokens: 5_000, output_tokens: 10 } },
    }, memory, "live");
    expect(child.updates.some(update => update.kind === "upsert" && update.item.id === "usage:sub1")).toBe(false);
    expect(child.assistantUsage).toBeUndefined();
    expect(memory.lastModel).toBe("claude-opus-5[1m]");
    // The parent's own next frame is attributed to the parent's model.
    const parent = normalizeClaudeMessage(call("a1", 30_000), memory, "live");
    expect(parent.updates.some(update => update.kind === "upsert" && update.item.id === "usage:a1")).toBe(true);
  });

  test("a compact boundary marks the timeline and resets the readout to the post-compaction figure", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage(call("a1", 180_000), memory, "live");
    const normalized = normalizeClaudeMessage({
      type: "system", subtype: "compact_boundary", uuid: "cb1", timestamp: "2026-09-02T10:00:06.000Z",
      compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 40_000 },
    }, memory, "live");
    expect(normalized.outcome).toBe("handled");
    expect(normalized.updates).toEqual([
      { kind: "upsert", item: { id: "compaction:cb1", type: "compaction", createdAt: Date.parse("2026-09-02T10:00:06.000Z"), trigger: "auto", preTokens: 180_000, postTokens: 40_000 } },
      { kind: "upsert", item: { id: "context:cb1", type: "context_report", createdAt: Date.parse("2026-09-02T10:00:06.000Z"), total: 40_000, model: { providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" } } },
    ]);
  });

  test("the control channel's breakdown becomes a report whose used rows sum to its total", () => {
    // The shape `getContextUsage()` answered on 2026-09-02 (Claude Code 2.1.258).
    const item = normalizeContextUsage({
      categories: [
        { name: "System tools", tokens: 7608, color: "inactive" },
        { name: "System tools (deferred)", tokens: 13170, color: "inactive", isDeferred: true },
        { name: "Skills", tokens: 2079, color: "warning" },
        { name: "Messages", tokens: 10, color: "purple" },
        { name: "Free space", tokens: 990303, color: "promptBorder" },
      ],
      totalTokens: 9697, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, percentage: 1, gridRows: [],
    }, 1_700_000_000_000, "opus[1m]") as { type: string; total: number; max?: number; categories: Array<{ name: string; tokens: number; kind: string }>; model?: { modelId: string } };
    expect(item.type).toBe("context_report");
    expect(item.total).toBe(9697);
    expect(item.max).toBe(1_000_000);
    expect(item.model?.modelId).toBe("opus[1m]");
    expect(item.categories.map(category => [category.name, category.kind])).toEqual([
      ["System tools", "used"], ["System tools (deferred)", "deferred"], ["Skills", "used"], ["Messages", "used"], ["Free space", "free"],
    ]);
    expect(item.categories.filter(category => category.kind === "used").reduce((sum, category) => sum + category.tokens, 0)).toBe(item.total);
    expect(normalizeContextUsage({ categories: [] }, 1, undefined)).toBeNull();
  });
});

describe("model alias resolution", () => {
  test("session-reported resolved ids translate to the catalog's alias ids", () => {
    const memory = createClaudeEventMemory();
    memory.resolveModel = id => ({ "claude-sonnet-5": "sonnet" } as Record<string, string>)[id] ?? id;
    const normalized = normalizeClaudeMessage({
      type: "assistant", uuid: "a1", timestamp: "2026-09-01T10:00:00.000Z",
      message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 } },
    }, memory, "live");
    // The gauge joins on the alias — the id the catalog keys windows by.
    expect(normalized.assistantModel?.model).toBe("sonnet");
    expect(memory.lastModel).toBe("sonnet");
  });
});

describe("catalog hydration probe", () => {
  // The catalog as the CLI actually reports it: no contextWindow field,
  // alias values, resolved ids that sessions then report stripped of the
  // variant marker.
  const realCatalog = [
    { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "Opus 5 with 1M context · Best for everyday, complex tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday, complex tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "fable[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
  ];

  function probeFixture(): { provider: ClaudeProvider; queries: FakeQuery[]; workspace: string } {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-probe-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    mkdirSync(claudeProjectDir(workspace, configDir), { recursive: true });
    const queries: FakeQuery[] = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/usr/local/bin/claude",
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.supportedModels = async () => realCatalog;
        query.supportedCommands = async () => [
          { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "<instructions>" },
        ];
        queries.push(query);
        // The probe session reports init like any session start.
        queueMicrotask(() => query.push({ type: "system", subtype: "init", slash_commands: ["/compact"] }));
        return query;
      },
    });
    return { provider, queries, workspace };
  }

  test("the first picker read hydrates the live catalog without a prompt", async () => {
    const { provider, queries, workspace } = probeFixture();
    const models = await provider.listModels();
    // One probe session, promptless, in the workspace itself: a promptless
    // probe writes no transcript, and the command inventory must include
    // the workspace's own project commands.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.input.options.cwd).toBe(workspace);
    expect(queries[0]!.input.options.enableFileCheckpointing).toBe(false);
    expect(queries[0]!.returned).toBe(true);
    // Live entries with derived windows; the CLI's recommended default is
    // first-class and flagged, exactly as Claude Code presents it.
    // The catalog's rows first, then UatuCode's app-only set under "More
    // models" — never an id the catalog already offers (D3).
    expect(models.map(model => model.selection.modelId)).toEqual(["default", "opus[1m]", "fable[1m]", "sonnet", "haiku", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]);
    expect(models.slice(5).every(model => model.provider === "More models")).toBe(true);
    // Every surface names the model with its version, derived from the
    // description when the CLI's display name lacks one (D2).
    expect(models.slice(1, 5).map(model => model.name)).toEqual(["Opus 5 (1M context)", "Fable 5.1", "Sonnet 5", "Haiku 4.5"]);
    const defaultEntry = models.find(model => model.selection.modelId === "default")!;
    expect(defaultEntry.default).toBe(true);
    expect(defaultEntry.name).toBe("Default (recommended)");
    expect(defaultEntry.detail).toBe("Opus 5 with 1M context · Best for everyday, complex tasks");
    expect(defaultEntry.contextLimit).toBe(1_000_000);
    // The default names what it runs: the concrete entry sharing its
    // resolved model.
    expect(defaultEntry.resolvesTo).toEqual({ providerId: "anthropic", modelId: "opus[1m]" });
    expect(models.find(model => model.selection.modelId === "opus[1m]")?.contextLimit).toBe(1_000_000);
    expect(models.find(model => model.selection.modelId === "fable[1m]")?.contextLimit).toBe(1_000_000);
    expect(models.find(model => model.selection.modelId === "claude-opus-4-8")?.contextLimit).toBe(1_000_000);
    expect(models.find(model => model.selection.modelId === "claude-opus-4-6")?.contextLimit).toBe(200_000);
    expect(models.find(model => model.selection.modelId === "sonnet")?.contextLimit).toBe(200_000);
    // The control channel's command list rode the same probe, with
    // descriptions init's bare names cannot carry.
    expect(await provider.listCommands()).toEqual([
      { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "<instructions>", kind: "command" },
    ]);
    // A second read reuses the hydrated catalog: still one query.
    await provider.listModels();
    expect(queries).toHaveLength(1);
    await provider.dispose();
  });

  test("an exact resolved-id join beats another entry's stripped heuristic regardless of order", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-order-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    mkdirSync(claudeProjectDir(workspace, configDir), { recursive: true });
    const queries: FakeQuery[] = [];
    // The [1m] row first: its stripped spelling ("claude-sonnet-5") must
    // not shadow the base row's exact join.
    const orderedCatalog = [
      { value: "sonnet[1m]", resolvedModel: "claude-sonnet-5[1m]" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5" },
    ];
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/usr/local/bin/claude",
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.supportedModels = async () => orderedCatalog;
        queries.push(query);
        return query;
      },
    });
    await provider.listModels();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "hello", delivery: "queue" });
    const live = queries[1]!;
    live.push({ type: "assistant", uuid: "a1", timestamp: "2026-09-01T10:00:00.000Z",
      message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 } } });
    live.push({ type: "result", uuid: "r1-result", subtype: "success", timestamp: "2026-09-01T10:00:01.000Z",
      usage: { input_tokens: 3, output_tokens: 1 } });
    const carriers = () => events.flatMap(event => event.updates)
      .filter(update => update.kind === "upsert")
      .map(update => (update as { item: { type: string; usage?: unknown; model?: { modelId: string } } }).item)
      .filter(item => item.type === "assistant_message" && item.usage !== undefined);
    await waitFor(() => carriers().length > 0);
    // The base session attributes to the base entry, not the 1M variant.
    expect(carriers().at(-1)!.model?.modelId).toBe("sonnet");
    stop();
    await provider.dispose();
  });

  test("the join covers resolved ids with and without the variant marker", async () => {
    const { provider, queries } = probeFixture();
    await provider.listModels();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "hello", delivery: "queue" });
    const live = queries[1]!;
    // The assistant reports the resolved id stripped of the marker.
    live.push({ type: "assistant", uuid: "a1", timestamp: "2026-09-01T10:00:00.000Z",
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 } } });
    live.push({ type: "result", uuid: "r1-result", subtype: "success", timestamp: "2026-09-01T10:00:01.000Z",
      usage: { input_tokens: 3, output_tokens: 1 } });
    const carriers = () => events.flatMap(event => event.updates)
      .filter(update => update.kind === "upsert")
      .map(update => (update as { item: { id: string; type: string; usage?: unknown; model?: { modelId: string } } }).item)
      .filter(item => item.type === "assistant_message" && item.usage !== undefined);
    await waitFor(() => carriers().length > 0);
    // Attribution lands on the catalog id, where the gauge finds the window.
    expect(carriers().at(-1)!.model?.modelId).toBe("opus[1m]");
    stop();
    await provider.dispose();
  });
});

describe("ClaudeProvider sessions", () => {
  test("creation mints a UUID session, announces it, and lists it as pending", async () => {
    const { provider } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("ignored-suggestion");
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.title).toBe("New conversation");
    expect((await provider.listSessions()).map(entry => entry.id)).toContain(session.id);
    await waitFor(() => events.some(event => event.sessionLifecycle?.kind === "created"));
    stop();
    await provider.dispose();
  });

  test("a first prompt starts a session claiming the minted id; a stored one resumes", async () => {
    const { provider, queries, configDir, workspace } = fixture();
    const created = await provider.createSession("x");
    await provider.prompt(created.id, { id: "req-1", text: "hello", delivery: "queue" });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.input.options.sessionId).toBe(created.id);
    expect(queries[0]!.input.options.resume).toBeUndefined();
    expect(queries[0]!.input.options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    expect(queries[0]!.input.options.enableFileCheckpointing).toBe(true);

    // A conversation with a transcript on disk resumes instead.
    const storedId = "11111111-2222-4333-8444-555555555555";
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`),
      `${JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-08-30T10:00:00.000Z", cwd: workspace, message: { role: "user", content: "earlier work" } })}\n`);
    await provider.prompt(storedId, { id: "req-2", text: "continue", delivery: "queue" });
    expect(queries).toHaveLength(2);
    expect(queries[1]!.input.options.resume).toBe(storedId);
    expect(queries[1]!.input.options.sessionId).toBeUndefined();
    await provider.dispose();
  });

  test("prompting mints the user item, streams the turn, and completes", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "req-1", text: "reply pong", delivery: "queue" });

    // The provider minted the user message and reported running.
    await waitFor(() => events.some(event => event.eventType === "prompt.accepted"));
    const accepted = events.find(event => event.eventType === "prompt.accepted")!;
    expect(accepted.conversationId).toBe(session.id);
    expect(accepted.updates).toEqual([
      expect.objectContaining({ kind: "upsert", item: expect.objectContaining({ id: "message:req-1", type: "user_message", text: "reply pong" }) }),
      { kind: "status", status: "running" },
    ]);
    // The envelope reached the SDK input stream.
    const query = queries[0]!;
    const sent: ClaudeUserEnvelope[] = [];
    void (async () => { for await (const envelope of query.input.prompt) sent.push(envelope); })();
    await waitFor(() => sent.length === 1);
    expect(sent[0]!.message.content).toEqual([{ type: "text", text: "reply pong" }]);

    // The fake session answers; the stream normalizes and completes.
    query.push({ type: "assistant", uuid: "a-1", timestamp: "2026-08-30T10:00:01.000Z", session_id: session.id, message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "pong" }], usage: { input_tokens: 5, output_tokens: 2 } } });
    query.push({ type: "result", subtype: "success", uuid: "r-1", timestamp: "2026-08-30T10:00:02.000Z", session_id: session.id, is_error: false, usage: { input_tokens: 5, output_tokens: 2 } });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "status" && update.status === "completed")));
    const texts = events.flatMap(event => event.updates).filter(update => update.kind === "upsert").map(update => (update as { item: { id: string } }).item.id);
    expect(texts).toContain("message:a-1");
    // The window-fill carrier belongs to the assistant message (one API
    // call); the result's per-turn sum is never a carrier (D1).
    expect(texts).toContain("usage:a-1");
    expect(texts).not.toContain("usage:r-1");
    // The turn retitled the pending conversation from its first prompt.
    expect(events.some(event => event.sessionLifecycle?.kind === "updated" && event.sessionLifecycle.title === "reply pong")).toBe(true);
    stop();
    await provider.dispose();
  });

  test("each turn's result is followed by one context report from the session's own breakdown", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "req-1", text: "first", delivery: "queue" });
    const query = queries[0]!;
    let contextReads = 0;
    query.getContextUsage = async () => {
      contextReads += 1;
      return { categories: [{ name: "Messages", tokens: 3_000, color: "x" }, { name: "Free space", tokens: 197_000, color: "y" }], totalTokens: 3_000, maxTokens: 200_000 };
    };
    query.push({ type: "system", subtype: "init", uuid: "i-1", session_id: session.id, model: "claude-sonnet-5" });
    query.push({ type: "assistant", uuid: "a-1", timestamp: "2026-08-30T10:00:01.000Z", session_id: session.id, message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "one" }], usage: { input_tokens: 5, output_tokens: 2 } } });
    query.push({ type: "result", subtype: "success", uuid: "r-1", timestamp: "2026-08-30T10:00:02.000Z", session_id: session.id, is_error: false, usage: { input_tokens: 5, output_tokens: 2 } });
    await waitFor(() => events.some(event => event.eventType === "context.reported"));
    // The report follows the turn's completed status — the status is never
    // held for the round trip — and lands before the idle session retires.
    const order = events.map(event => event.eventType);
    expect(order.indexOf("context.reported")).toBeGreaterThan(order.indexOf("result"));
    await waitFor(() => query.returned);
    expect(contextReads).toBe(1);
    const report = events.find(event => event.eventType === "context.reported")!.updates[0] as { kind: string; item: { type: string; total: number; max: number; model?: { modelId: string }; categories: Array<{ name: string; tokens: number; kind: string }> } };
    expect(report.item).toEqual(expect.objectContaining({ type: "context_report", total: 3_000, max: 200_000, model: { providerId: "anthropic", modelId: "claude-sonnet-5" } }));
    expect(report.item.categories).toEqual([{ name: "Messages", tokens: 3_000, kind: "used" }, { name: "Free space", tokens: 197_000, kind: "free" }]);
    // A second turn on a fresh session reports once more; a failing control
    // call leaves the carrier as the only source and never fails the turn.
    await provider.prompt(session.id, { id: "req-2", text: "second", delivery: "queue" });
    const second = queries[1]!;
    second.getContextUsage = async () => { throw new Error("no control channel"); };
    second.push({ type: "result", subtype: "success", uuid: "r-2", timestamp: "2026-08-30T10:00:04.000Z", session_id: session.id, is_error: false });
    await waitFor(() => second.returned);
    expect(events.filter(event => event.eventType === "context.reported")).toHaveLength(1);
    expect(events.filter(event => event.updates.some(update => update.kind === "status" && update.status === "completed"))).toHaveLength(2);
    stop();
    await provider.dispose();
  });

  test("a prompt delivered while the context report is in flight keeps its session alive", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "first", delivery: "queue" });
    const query = queries[0]!;
    let release!: (value: unknown) => void;
    query.getContextUsage = () => new Promise(resolve => { release = resolve; });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:02.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "status" && update.status === "completed")));
    // The adapter releases a held prompt on the completed status — before
    // the report has answered. It lands in this very session.
    await provider.prompt(session.id, { id: "r2", text: "second", delivery: "queue" });
    expect(queries).toHaveLength(1);
    release({ categories: [], totalTokens: 10, maxTokens: 200_000 });
    await waitFor(() => events.some(event => event.eventType === "context.reported"));
    await Bun.sleep(10);
    expect(provider.liveSessionCount()).toBe(1);
    expect(query.returned).toBe(false);
    // The second turn runs to its own result, and only then does the
    // session retire.
    query.getContextUsage = async () => ({ categories: [], totalTokens: 12, maxTokens: 200_000 });
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => query.returned);
    expect(provider.liveSessionCount()).toBe(0);
    expect(events.filter(event => event.updates.some(update => update.kind === "status" && update.status === "completed"))).toHaveLength(2);
    stop();
    await provider.dispose();
  });

  test("a context probe overtaken by a later turn's probe is dropped, so the newest report is the newest turn's", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "first", delivery: "queue" });
    const query = queries[0]!;
    const pending: Array<(value: unknown) => void> = [];
    query.getContextUsage = () => new Promise(resolve => { pending.push(resolve); });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:02.000Z", session_id: session.id, is_error: false });
    await waitFor(() => pending.length === 1);
    await provider.prompt(session.id, { id: "r2", text: "second", delivery: "queue" });
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:04.000Z", session_id: session.id, is_error: false });
    await waitFor(() => pending.length === 2);
    // The second turn's probe answers first; the first turn's late answer
    // must not land after it.
    pending[1]!({ categories: [], totalTokens: 2_000, maxTokens: 200_000 });
    await waitFor(() => events.some(event => event.eventType === "context.reported"));
    pending[0]!({ categories: [], totalTokens: 1_000, maxTokens: 200_000 });
    await Bun.sleep(10);
    const reports = events.filter(event => event.eventType === "context.reported").map(event => (event.updates[0] as { item: { total: number } }).item.total);
    expect(reports).toEqual([2_000]);
    stop();
    await provider.dispose();
  });

  test("interrupt reaches the live session and reports interrupted", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "req-1", text: "long task", delivery: "queue" });
    await provider.interrupt(session.id);
    expect(queries[0]!.interrupts).toBe(1);
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "status" && update.status === "interrupted")));
    stop();
    await provider.dispose();
  });

  test("an elicitation form becomes question steps and answers as coerced MCP content", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "connect", delivery: "queue" });
    const query = queries[0]!;
    expect(query.input.options.supportedDialogKinds).toEqual(["refusal_fallback_prompt"]);
    const schema = {
      type: "object",
      properties: {
        username: { type: "string", title: "GitHub username", description: "Your login" },
        retries: { type: "integer" },
        verbose: { type: "boolean", description: "Log everything?" },
        region: { type: "string", enum: ["eu", "us"], enumNames: ["Europe", "United States"] },
      },
      required: ["username"],
    };
    const answer = query.input.options.onElicitation!(
      { serverName: "github", message: "Sign in to continue", mode: "form", requestedSchema: schema },
      { signal: new AbortController().signal, requestId: "el-1" },
    );
    await waitFor(() => events.some(event => event.eventType === "interaction.requested"));
    const card = (events.find(event => event.eventType === "interaction.requested")!.updates[0] as { item: QuestionRequest }).item;
    expect(card).toEqual(expect.objectContaining({ id: "question:el-1", type: "question", source: "elicitation", intro: "github asks: Sign in to continue", schema, status: "pending" }));
    // Only `username` is required: every other step can be skipped, and its
    // prompt says so, so no fabricated value has to be sent for it.
    expect(card.questions.map(question => [question.header, question.options.map(option => option.label), question.allowFreeForm, question.optional ?? false])).toEqual([
      ["GitHub username", [], true, false],
      ["retries", [], true, true],
      ["verbose", ["Yes", "No"], false, true],
      ["region", ["Europe", "United States"], false, true],
    ]);
    // Recovery lists the same context the live card carried.
    expect(await provider.listQuestions!()).toEqual([expect.objectContaining({ requestId: "el-1", source: "elicitation", intro: "github asks: Sign in to continue", schema })]);
    // An optional step left empty leaves its key out; nothing in-band.
    await provider.replyQuestion(session.id, "el-1", [["octocat"], [], ["No"], ["United States"]]);
    expect(await answer).toEqual({ action: "accept", content: { username: "octocat", verbose: false, region: "us" } });

    // A multi-select array field and a titled-enum field are choices too;
    // the array answers as a list of the declared values.
    const multi = query.input.options.onElicitation!(
      { serverName: "svc", message: "Scopes", mode: "form", requestedSchema: { type: "object", properties: {
        scopes: { type: "array", items: { type: "string", enum: ["repo", "gist"], enumNames: ["Repositories", "Gists"] } },
        tier: { type: "string", anyOf: [{ const: "free", title: "Free" }, { const: "pro", title: "Pro" }] },
        count: { type: "integer", minimum: 1, maximum: 5 },
        email: { type: "string", format: "email", maxLength: 40 },
        tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] }, minItems: 2, maxItems: 2 },
        when: { type: "string", format: "date" },
        // A title on only some choices stays with its own value.
        lane: { type: "string", anyOf: [{ const: "fast" }, { const: "slow", title: "Slow lane" }] },
      }, required: ["scopes", "tier", "count", "email", "tags", "when", "lane"] } },
      { signal: new AbortController().signal, requestId: "el-multi" },
    );
    await waitFor(() => events.filter(event => event.eventType === "interaction.requested").length === 2);
    const multiCard = (events.filter(event => event.eventType === "interaction.requested")[1]!.updates[0] as { item: QuestionRequest }).item;
    expect(multiCard.questions.map(question => [question.multiple, question.options.map(option => option.label), question.prompt])).toEqual([
      [true, ["Repositories", "Gists"], "scopes"],
      [false, ["Free", "Pro"], "tier"],
      [false, [], "count (whole number, at least 1, at most 5)"],
      [false, [], "email (an email address, at most 40 characters)"],
      [true, ["a", "b", "c"], "tags (choose at least 2, choose at most 2)"],
      [false, [], "when (a date (YYYY-MM-DD))"],
      [false, ["fast", "Slow lane"], "lane"],
    ]);
    // Answers the schema refuses keep the card pending; the message says why.
    const ok = { scopes: ["Repositories", "Gists"], tier: ["Pro"], count: [" 3 "], email: ["me@example.com"], tags: ["a", "c"], when: ["2026-09-02"], lane: ["Slow lane"] };
    const attempt = (over: Partial<typeof ok>) => provider.replyQuestion(session.id, "el-multi", [over.scopes ?? ok.scopes, over.tier ?? ok.tier, over.count ?? ok.count, over.email ?? ok.email, over.tags ?? ok.tags, over.when ?? ok.when, over.lane ?? ok.lane]);
    await expect(attempt({ count: ["1.5"] })).rejects.toThrow(/whole number/);
    await expect(attempt({ count: ["9"] })).rejects.toThrow(/at most 5/);
    await expect(attempt({ count: ["x"] })).rejects.toThrow(/enter a number/);
    await expect(attempt({ email: ["not-an-address"] })).rejects.toThrow(/email address/);
    await expect(attempt({ email: [`${"x".repeat(40)}@example.com`] })).rejects.toThrow(/at most 40 characters/);
    await expect(attempt({ tags: ["a"] })).rejects.toThrow(/at least 2/);
    await expect(attempt({ tags: ["a", "b", "c"] })).rejects.toThrow(/at most 2/);
    // An impossible day is refused, not rolled forward into the next month.
    await expect(attempt({ when: ["2025-02-30"] })).rejects.toThrow(/a date/);
    await expect(attempt({ when: ["2025-2-3"] })).rejects.toThrow(/a date/);
    expect(await provider.listQuestions!()).toEqual([expect.objectContaining({ requestId: "el-multi" })]);
    await attempt({});
    expect(await multi).toEqual({ action: "accept", content: { scopes: ["repo", "gist"], tier: "pro", count: 3, email: "me@example.com", tags: ["a", "c"], when: "2026-09-02", lane: "slow" } });

    // Enum values that would make empty or identical labels are named and
    // numbered, and answers map back by position, not by parsing.
    const odd = query.input.options.onElicitation!(
      { serverName: "svc", message: "Pick", mode: "form", requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["", "a", "a"] }, n: { type: "integer", enum: [1, "1"] } }, required: ["choice", "n"] } },
      { signal: new AbortController().signal, requestId: "el-odd" },
    );
    await waitFor(() => events.filter(event => event.eventType === "interaction.requested").length === 3);
    const oddCard = (events.filter(event => event.eventType === "interaction.requested")[2]!.updates[0] as { item: QuestionRequest }).item;
    expect(oddCard.questions.map(question => question.options.map(option => option.label))).toEqual([["(empty)", "a", "a (2)"], ["1", "1 (2)"]]);
    await provider.replyQuestion(session.id, "el-odd", [["a (2)"], ["1 (2)"]]);
    expect(await odd).toEqual({ action: "accept", content: { choice: "a", n: "1" } });
    stop();
    await provider.dispose();
  });

  test("a URL elicitation links out and a decline returns the MCP decline", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "auth", delivery: "queue" });
    const query = queries[0]!;
    const answer = query.input.options.onElicitation!(
      { serverName: "linear", message: "Authorize UatuCode", mode: "url", url: "https://example.com/auth", title: "Linear" },
      { signal: new AbortController().signal, requestId: "el-2" },
    );
    await waitFor(() => events.some(event => event.eventType === "interaction.requested"));
    const card = (events.find(event => event.eventType === "interaction.requested")!.updates[0] as { item: QuestionRequest }).item;
    expect(card.link).toBe("https://example.com/auth");
    expect(card.intro).toBe("Linear asks: Authorize UatuCode");
    expect(card.questions[0]!.options.map(option => option.label)).toEqual(["Done"]);
    await provider.rejectQuestion(session.id, "el-2");
    expect(await answer).toEqual({ action: "decline" });
    // A custom-scheme callback cannot be a link; the prompt spells it out.
    const custom = query.input.options.onElicitation!(
      { serverName: "app", message: "Authorize", mode: "url", url: "vscode://auth/callback?x=1" },
      { signal: new AbortController().signal, requestId: "el-3" },
    );
    await waitFor(() => events.filter(event => event.eventType === "interaction.requested").length === 2);
    const customCard = (events.filter(event => event.eventType === "interaction.requested")[1]!.updates[0] as { item: QuestionRequest }).item;
    expect(customCard.link).toBeUndefined();
    expect(customCard.questions[0]!.prompt).toBe("Open vscode://auth/callback?x=1 to continue, then confirm here.");
    await provider.replyQuestion(session.id, "el-3", [["Done"]]);
    expect(await custom).toEqual({ action: "accept" });
    stop();
    await provider.dispose();
  });

  test("a refusal-fallback dialog offers the retry and answers in the CLI's vocabulary", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "do it", delivery: "queue" });
    const query = queries[0]!;
    const answer = query.input.options.onUserDialog!(
      { dialogKind: "refusal_fallback_prompt", payload: { originalModel: "claude-opus-5", fallbackModel: "claude-sonnet-5", guidanceText: "Opus declined; Sonnet can try." }, toolUseID: "tu-1" },
      { signal: new AbortController().signal, requestId: "dl-1" },
    );
    await waitFor(() => events.some(event => event.eventType === "interaction.requested"));
    const card = (events.find(event => event.eventType === "interaction.requested")!.updates[0] as { item: QuestionRequest }).item;
    expect(card).toEqual(expect.objectContaining({ id: "question:dl-1", source: "dialog", intro: "Claude Code asks how to continue after claude-opus-5 declined this request." }));
    expect(card.questions[0]!.prompt).toBe("Opus declined; Sonnet can try.");
    expect(card.questions[0]!.options.map(option => option.label)).toEqual(["Retry on claude-sonnet-5", "Edit the prompt"]);
    expect(card.schema).toEqual({ dialogKind: "refusal_fallback_prompt", payload: expect.objectContaining({ fallbackModel: "claude-sonnet-5" }) });
    await provider.replyQuestion(session.id, "dl-1", [["Retry on claude-sonnet-5"]]);
    expect(await answer).toEqual({ behavior: "completed", result: "retry_fallback" });

    // An undeclared kind can only be dismissed, and a rejection cancels.
    const other = query.input.options.onUserDialog!({ dialogKind: "plugin_hint", payload: { name: "x" } }, { signal: new AbortController().signal, requestId: "dl-2" });
    await Bun.sleep(5);
    await provider.rejectQuestion(session.id, "dl-2");
    expect(await other).toEqual({ behavior: "cancelled" });
    stop();
    await provider.dispose();
  });

  test("a dead session abandons its dialog and elicitation visibly with their own cancel results", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    const dialog = query.input.options.onUserDialog!({ dialogKind: "refusal_fallback_prompt", payload: {} }, { signal: new AbortController().signal, requestId: "dl-9" });
    const elicitation = query.input.options.onElicitation!({ serverName: "s", message: "m" }, { signal: new AbortController().signal, requestId: "el-9" });
    await waitFor(() => events.filter(event => event.eventType === "interaction.requested").length === 2);
    query.fail(new Error("child process died"));
    expect(await dialog).toEqual({ behavior: "cancelled" });
    expect(await elicitation).toEqual({ action: "cancel" });
    await waitFor(() => events.filter(event => event.eventType === "interaction.abandoned").length === 2);
    const resolved = events.filter(event => event.eventType === "interaction.abandoned").map(event => (event.updates[0] as { item: QuestionRequest }).item);
    expect(resolved.map(item => [item.id, item.status, item.outcome])).toEqual([
      ["question:dl-9", "resolved", { kind: "rejected" }],
      ["question:el-9", "resolved", { kind: "rejected" }],
    ]);
    expect(await provider.listQuestions!()).toEqual([]);
    // An interrupted turn (aborted signal) abandons the same way.
    await provider.prompt(session.id, { id: "r2", text: "again", delivery: "queue" });
    const aborter = new AbortController();
    const interrupted = queries[1]!.input.options.onUserDialog!({ dialogKind: "refusal_fallback_prompt", payload: {} }, { signal: aborter.signal, requestId: "dl-10" });
    await Bun.sleep(5);
    aborter.abort();
    expect(await interrupted).toEqual({ behavior: "cancelled" });
    stop();
    await provider.dispose();
  });

  test("a model id the CLI rejects fails that turn with the reported error", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    // A typed id is passed through verbatim (the adapter does not gate it
    // for an agent that declares custom-model-id).
    await provider.prompt(session.id, { id: "req-1", text: "hello", delivery: "queue", model: { providerId: "anthropic", modelId: "claude-nope-9" } });
    const query = queries[0]!;
    expect(query.input.options.model).toBe("claude-nope-9");
    query.push({ type: "result", subtype: "error_during_execution", uuid: "r-1", timestamp: "2026-08-30T10:00:02.000Z", session_id: session.id, is_error: true, errors: ["API Error: 404 model: claude-nope-9 not found"] });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "status" && update.status === "failed")));
    const failed = events.flatMap(event => event.updates).find(update => update.kind === "status" && update.status === "failed") as { message?: string };
    expect(failed.message).toBe("API Error: 404 model: claude-nope-9 not found");
    stop();
    await provider.dispose();
  });

  test("a dying session stream surfaces a notice and frees the session", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "req-1", text: "boom", delivery: "queue" });
    queries[0]!.fail(new Error("child process died"));
    await waitFor(() => events.some(event => event.eventType === "session.failed"));
    expect(provider.liveSessionCount()).toBe(0);
    const failure = events.find(event => event.eventType === "session.failed")!;
    expect(failure.updates.some(update => update.kind === "status" && update.status === "failed")).toBe(true);
    stop();
    await provider.dispose();
  });

  test("dispose interrupts and closes every live session — no process outlives it", async () => {
    const { provider, queries } = fixture();
    const first = await provider.createSession("a");
    const second = await provider.createSession("b");
    await provider.prompt(first.id, { id: "r1", text: "one", delivery: "queue" });
    await provider.prompt(second.id, { id: "r2", text: "two", delivery: "queue" });
    expect(provider.liveSessionCount()).toBe(2);
    await provider.dispose();
    expect(provider.liveSessionCount()).toBe(0);
    for (const query of queries) {
      expect(query.interrupts).toBeGreaterThan(0);
      expect(query.returned).toBe(true);
    }
    await expect(provider.prompt(first.id, { id: "r3", text: "after", delivery: "queue" })).rejects.toThrow("disposed");
  });

  test("a tool request waits as a pending permission and approval releases it", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "edit the file", delivery: "queue" });
    const query = queries[0]!;

    const suggestions = [
      { type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Write" }] },
      { type: "addRules", behavior: "allow", destination: "userSettings", rules: [{ toolName: "Write" }] },
    ];
    let result: unknown = null;
    const decision = query.input.options.canUseTool!("Write", { file_path: "/workspace/a.txt", content: "x" }, {
      signal: new AbortController().signal,
      suggestions,
      title: "Claude wants to write a.txt",
      toolUseID: "toolu_1",
    }).then(value => { result = value; return value; });

    await waitFor(() => events.some(event => event.eventType === "interaction.requested"));
    const card = events.find(event => event.eventType === "interaction.requested")!.updates[0]!;
    expect(card).toEqual({ kind: "upsert", item: expect.objectContaining({
      id: "permission:toolu_1",
      type: "permission",
      action: "Claude wants to write a.txt",
      resources: ["/workspace/a.txt"],
      status: "pending",
    }) });
    expect(await provider.listPermissions!()).toEqual([expect.objectContaining({ requestId: "toolu_1", conversationId: session.id })]);

    await provider.replyPermission(session.id, "toolu_1", "always");
    await decision;
    // Always maps to allow + the session-scoped suggestions only (D5).
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/workspace/a.txt", content: "x" },
      updatedPermissions: [suggestions[0]],
    });
    expect(await provider.listPermissions!()).toEqual([]);
    stop();
    await provider.dispose();
  });

  test("once approves without permission updates; reject denies", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    const signal = new AbortController().signal;

    const first = query.input.options.canUseTool!("Bash", { command: "ls" }, { signal, toolUseID: "t1", suggestions: [{ destination: "session" }] });
    await waitFor(() => provider.liveSessionCount() === 1 && true);
    await Bun.sleep(5);
    await provider.replyPermission(session.id, "t1", "once");
    expect(await first).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });

    const second = query.input.options.canUseTool!("Bash", { command: "rm -rf /" }, { signal, toolUseID: "t2" });
    await Bun.sleep(5);
    await provider.replyPermission(session.id, "t2", "reject");
    expect(await second).toEqual({ behavior: "deny", message: "The user denied this action." });
    await provider.dispose();
  });

  test("AskUserQuestion becomes a structured question and answers in tool shape", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "ask me", delivery: "queue" });
    const query = queries[0]!;

    const input = {
      questions: [
        { question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "SQLite", description: "embedded" }, { label: "Postgres", description: "server" }] },
        { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "Auth", description: "" }, { label: "Sync", description: "" }] },
      ],
    };
    const decision = query.input.options.canUseTool!("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "q1" });
    await waitFor(() => events.some(event => event.eventType === "interaction.requested"));
    const card = events.find(event => event.eventType === "interaction.requested")!.updates[0]! as { item: { type: string; questions: unknown[] } };
    expect(card.item.type).toBe("question");
    expect(card.item.questions).toEqual([
      { prompt: "Which database?", header: "Database", options: [{ label: "SQLite", description: "embedded" }, { label: "Postgres", description: "server" }], multiple: false, allowFreeForm: true },
      { prompt: "Which features?", header: "Features", options: [{ label: "Auth", description: "" }, { label: "Sync", description: "" }], multiple: true, allowFreeForm: true },
    ]);
    expect(await provider.listQuestions!()).toEqual([expect.objectContaining({ requestId: "q1" })]);

    await provider.replyQuestion(session.id, "q1", [["SQLite"], ["Auth", "Sync"]]);
    expect(await decision).toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which database?": "SQLite", "Which features?": "Auth, Sync" } },
    });
    stop();
    await provider.dispose();
  });

  test("rejecting a question denies without ending the turn", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "ask", delivery: "queue" });
    const decision = queries[0]!.input.options.canUseTool!("AskUserQuestion", { questions: [{ question: "Pick", header: "P", options: [] }] }, { signal: new AbortController().signal, toolUseID: "q1" });
    await Bun.sleep(5);
    await provider.rejectQuestion(session.id, "q1");
    expect(await decision).toEqual({ behavior: "deny", message: "The user declined to answer." });
    await provider.dispose();
  });

  test("a dead session resolves its pending permission visibly", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "work", delivery: "queue" });
    const query = queries[0]!;
    const decision = query.input.options.canUseTool!("Write", { file_path: "/a" }, { signal: new AbortController().signal, toolUseID: "t1" });
    await waitFor(() => events.some(event => event.eventType === "interaction.requested"));

    query.fail(new Error("child died"));
    expect(await decision).toEqual({ behavior: "deny", message: "The session failed before the user answered." });
    await waitFor(() => events.some(event => event.eventType === "interaction.abandoned"));
    const resolved = events.find(event => event.eventType === "interaction.abandoned")!.updates[0]! as { item: { status: string; outcome: string } };
    expect(resolved.item.status).toBe("resolved");
    expect(resolved.item.outcome).toBe("rejected");
    expect(await provider.listPermissions!()).toEqual([]);
    stop();
    await provider.dispose();
  });

  test("an interrupted turn resolves its pending card through the abort signal", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "work", delivery: "queue" });
    const abort = new AbortController();
    const decision = queries[0]!.input.options.canUseTool!("Write", { file_path: "/a" }, { signal: abort.signal, toolUseID: "t1" });
    await Bun.sleep(5);
    abort.abort();
    expect(await decision).toEqual({ behavior: "deny", message: "The turn was interrupted before the user answered." });
    await waitFor(() => events.some(event => event.eventType === "interaction.abandoned"));
    stop();
    await provider.dispose();
  });

  test("the live catalog replaces the manifest with real windows and effort levels", async () => {
    const { provider, queries } = fixture();
    // Cold: the static fallback answers.
    expect((await provider.listModels()).find(model => model.selection.modelId === "claude-opus-5")?.contextLimit).toBe(200_000);

    const session = await provider.createSession("x");
    const catalog = [
      { value: "default", displayName: "Default (recommended)", contextWindow: 200_000 },
      { value: "claude-opus-5[1m]", displayName: "Opus 5 (1M context)", contextWindow: 1_000_000, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", contextWindow: 200_000, supportedEffortLevels: ["low", "medium", "high"] },
    ];
    // The hook must exist before the session spawns.
    const provider2 = new ClaudeProvider({
      workspacePath: queries.length ? (queries[0]!.input.options.cwd) : process.cwd(),
      executable: "/bin/claude",
      configDir: undefined as never,
      catalogProbe: false,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.supportedModels = async () => catalog;
        return query;
      },
    });
    void session;
    const created = await provider2.createSession("y");
    await provider2.prompt(created.id, { id: "r1", text: "hi", delivery: "queue" });
    let models = await provider2.listModels();
    for (let attempt = 0; attempt < 200 && !models.some(model => model.contextLimit === 1_000_000); attempt += 1) {
      await Bun.sleep(5);
      models = await provider2.listModels();
    }
    expect(models.find(model => model.selection.modelId === "claude-opus-5[1m]")).toEqual(expect.objectContaining({
      name: "Opus 5 (1M context)",
      contextLimit: 1_000_000,
    }));
    // The CLI's recommended default rides along as a flagged first-class
    // entry rather than being filtered.
    expect(models.find(model => model.selection.modelId === "default")?.default).toBe(true);
    // Variant validation follows the live catalog.
    await provider2.switchModel(created.id, { providerId: "anthropic", modelId: "claude-opus-5[1m]" }, "max");
    await provider2.dispose();
    await provider.dispose();
  });

  test("modes exclude bypass without the operator opt-in and include it with it", async () => {
    const { provider } = fixture();
    expect((await provider.listModes()).map(mode => mode.name)).toEqual(["auto", "default", "acceptEdits", "plan"]);
    await provider.dispose();

    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-bypass-")));
    mkdirSync(path.join(root, "ws"), { recursive: true });
    const optedIn = new ClaudeProvider({
      workspacePath: path.join(root, "ws"),
      stateFile: path.join(path.join(root, "ws"), ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir: path.join(root, "cfg"),
      offerBypassPermissions: true,
      queryFactory: input => new FakeQuery(input),
    });
    expect((await optedIn.listModes()).map(mode => mode.name)).toContain("bypassPermissions");
    await optedIn.dispose();
  });

  test("a replacement prompt that fails before acceptance keeps redo possible", async () => {
    const { configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const forkId = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const marker = path.join(workspace, "marker.txt");
    writeFileSync(marker, "tip");
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second"),
    ].join("\n"));
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${forkId}.jsonl`),
      turn("u1", "2026-08-30T10:00:00.000Z", "first"));
    let failNextSpawn = false;
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        if (failNextSpawn) { failNextSpawn = false; throw new Error("spawn failed"); }
        const query = new FakeQuery(input);
        query.rewindFiles = async (_uuid, options) => {
          if (!options?.dryRun) writeFileSync(marker, "rewound");
          return { canRewind: true, filesChanged: [marker] };
        };
        return query;
      },
      forkSession: async () => ({ sessionId: forkId }),
    });
    await provider.undo!(storedId);
    // The replacement's session fails to start: the commit rolls back and
    // the staged revert (with its redo) survives.
    failNextSpawn = true;
    await expect(provider.prompt(storedId, { id: "r2", text: "replacement", delivery: "queue" })).rejects.toThrow("spawn failed");
    const state = await provider.getReversibleHistoryState!(storedId);
    expect(state.staged).toBe(true);
    expect(state.canRedo).toBe(true);
    await provider.redo!(storedId);
    expect(readFileSync(marker, "utf8")).toBe("tip");
    // The same protection covers an attachment that vanished after
    // admission — the last fallible step before acceptance.
    await provider.undo!(storedId);
    await expect(provider.prompt(storedId, {
      id: "r3", text: "with image", delivery: "queue",
      attachments: [{ id: "gone", name: "gone.png", mimeType: "image/png", absolutePath: path.join(workspace, "missing.png") }],
    })).rejects.toThrow();
    const after = await provider.getReversibleHistoryState!(storedId);
    expect(after.staged).toBe(true);
    expect(after.canRedo).toBe(true);
    await provider.redo!(storedId);
    expect(readFileSync(marker, "utf8")).toBe("tip");
    await provider.dispose();
  });

  test("a failed replacement retires the fork-bound session it started", async () => {
    const { configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const forkId = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second"),
    ].join("\n"));
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${forkId}.jsonl`),
      turn("u1", "2026-08-30T10:00:00.000Z", "first"));
    const queries: FakeQuery[] = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async () => ({ canRewind: true, filesChanged: [] });
        queries.push(query);
        return query;
      },
      forkSession: async () => ({ sessionId: forkId }),
    });
    await provider.undo!(storedId);
    // The replacement's fork session starts, then the attachment read fails.
    await expect(provider.prompt(storedId, {
      id: "r2", text: "replacement", delivery: "queue",
      attachments: [{ id: "gone", name: "gone.png", mimeType: "image/png", absolutePath: path.join(workspace, "missing.png") }],
    })).rejects.toThrow();
    // The fork-bound session is retired with the rollback...
    const forkBound = queries.at(-1)!;
    expect(forkBound.input.options.resume).toBe(forkId);
    expect(forkBound.returned).toBe(true);
    // ...so the NEXT prompt starts fresh against the rolled-back identity.
    await provider.prompt(storedId, { id: "r3", text: "try again", delivery: "queue" });
    expect(queries.at(-1)!.input.options.resume).toBe(forkId);
    await provider.dispose();
  });

  test("a refused rewind leaves the staged snapshot unpolluted", async () => {
    const { configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const fileA = path.join(workspace, "a.txt");
    const fileB = path.join(workspace, "b.txt");
    writeFileSync(fileA, "a-tip");
    writeFileSync(fileB, "b-tip");
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second"),
    ].join("\n"));
    let refuseNonDry = false;
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async (uuid, options) => {
          const changed = uuid === "u2" ? [fileB] : [fileA, fileB];
          if (options?.dryRun) return { canRewind: true, filesChanged: changed };
          if (refuseNonDry) return { canRewind: false, error: "checkpoint gone" };
          if (uuid === "u2") writeFileSync(fileB, "b-rewound");
          else { writeFileSync(fileA, "a-rewound"); writeFileSync(fileB, "b-rewound-deeper"); }
          return { canRewind: true, filesChanged: changed };
        };
        return query;
      },
    });
    await provider.undo!(storedId);
    // The deeper undo's non-dry rewind refuses AFTER the preview captured
    // fileA: the stored snapshot must not have gained that entry.
    refuseNonDry = true;
    await expect(provider.undo!(storedId)).rejects.toThrow("checkpoint gone");
    refuseNonDry = false;
    // Terminal redo restores exactly what the first boundary displaced.
    await provider.redo!(storedId);
    expect(readFileSync(fileB, "utf8")).toBe("b-tip");
    // fileA was never rewound and never captured; it is untouched.
    expect(readFileSync(fileA, "utf8")).toBe("a-tip");
    await provider.dispose();
  });

  test("a rewind whose record cannot be written restores the tip instead of acknowledging", async () => {
    const { configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const marker = path.join(workspace, "marker.txt");
    writeFileSync(marker, "tip");
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second"),
    ].join("\n"));
    // The state file's parent is a FILE: every persist fails.
    const blocked = path.join(workspace, "blocked");
    writeFileSync(blocked, "not a directory");
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(blocked, "state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async (_uuid, options) => {
          if (!options?.dryRun) writeFileSync(marker, "rewound");
          return { canRewind: true, filesChanged: [marker] };
        };
        return query;
      },
    });
    await expect(provider.undo!(storedId)).rejects.toThrow("could not be recorded");
    // The workspace is back at tip and nothing claims to be staged.
    expect(readFileSync(marker, "utf8")).toBe("tip");
    expect((await provider.getReversibleHistoryState!(storedId)).staged).toBe(false);
    await provider.dispose();
  });

  test("a commit whose record cannot be written keeps the staged state and refuses the prompt", async () => {
    const { configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const forkId = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const marker = path.join(workspace, "marker.txt");
    writeFileSync(marker, "tip");
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second"),
    ].join("\n"));
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${forkId}.jsonl`),
      turn("u1", "2026-08-30T10:00:00.000Z", "first"));
    // Persistence works during the stage, then the state file's path is
    // blocked before the commit.
    const stateFile = path.join(workspace, "state-dir", "state.json");
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile,
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async (_uuid, options) => {
          if (!options?.dryRun) writeFileSync(marker, "rewound");
          return { canRewind: true, filesChanged: [marker] };
        };
        return query;
      },
      forkSession: async () => ({ sessionId: forkId }),
    });
    await provider.undo!(storedId);
    rmSync(path.join(workspace, "state-dir"), { recursive: true, force: true });
    writeFileSync(path.join(workspace, "state-dir"), "not a directory");
    await expect(provider.prompt(storedId, { id: "r2", text: "replacement", delivery: "queue" })).rejects.toThrow("could not be recorded");
    // The staged revert survives: redo is still possible.
    const state = await provider.getReversibleHistoryState!(storedId);
    expect(state.staged).toBe(true);
    expect(state.canRedo).toBe(true);
    await provider.dispose();
  });

  test("a failed prompt rolls its model and mode selection back", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "start", delivery: "queue" });
    const before = await provider.getConversationConfiguration(session.id);
    // The prompt stages a new model and mode, then the attachment read fails.
    await expect(provider.prompt(session.id, {
      id: "r2", text: "switch", delivery: "queue",
      model: { providerId: "anthropic", modelId: "claude-sonnet-5" }, mode: "acceptEdits",
      attachments: [{ id: "gone", name: "gone.png", mimeType: "image/png", absolutePath: "/nonexistent/gone.png" }],
    })).rejects.toThrow();
    // Nothing the failed prompt selected sticks.
    expect(await provider.getConversationConfiguration(session.id)).toEqual(before);
    // The surviving session's live effort returned to the prior value too.
    const applied: unknown[] = [];
    queries[0]!.applyFlagSettings = async settings => { applied.push(settings); };
    await expect(provider.prompt(session.id, {
      id: "r3", text: "again", delivery: "queue",
      model: { providerId: "anthropic", modelId: "claude-sonnet-5" }, variant: "max",
      attachments: [{ id: "gone", name: "gone.png", mimeType: "image/png", absolutePath: "/nonexistent/gone.png" }],
    })).rejects.toThrow();
    expect(applied.at(-1)).toEqual({ effortLevel: null });
    await provider.dispose();
  });

  test("a session dying mid-admission refuses the prompt through the rollback", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "start", delivery: "queue" });
    const before = await provider.getConversationConfiguration(session.id);
    // The live mode switch kills the stream mid-admission.
    queries[0]!.setPermissionMode = async () => {
      queries[0]!.fail(new Error("stream died"));
      await Bun.sleep(10);
    };
    await expect(provider.prompt(session.id, { id: "r2", text: "more", delivery: "queue", mode: "plan" }))
      .rejects.toThrow("ended before the prompt was accepted");
    // Nothing the refused prompt staged sticks.
    expect(await provider.getConversationConfiguration(session.id)).toEqual(before);
    await provider.dispose();
  });

  test("a rejected interrupt leaves the turn's real outcome intact", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "work", delivery: "queue" });
    queries[0]!.interrupt = async () => { throw new Error("control channel down"); };
    await expect(provider.interrupt(session.id)).rejects.toThrow("control channel down");
    // The turn finishes on its own: the result reports completed, not a
    // cancellation that never took.
    queries[0]!.push({ type: "result", uuid: "res-1", subtype: "success", timestamp: "2026-08-30T10:01:00.000Z", usage: { input_tokens: 1, output_tokens: 1 } });
    await waitFor(() => events.some(event =>
      event.updates.some(update => update.kind === "status" && (update as { status: string }).status === "completed")));
    stop();
    await provider.dispose();
  });

  test("a stream ending mid-turn reports the interruption instead of a stuck running state", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "work", delivery: "queue" });
    // The CLI exits cleanly without a result while the turn is running.
    await queries[0]!.return();
    await waitFor(() => events.some(event =>
      event.updates.some(update => update.kind === "status" && (update as { status: string }).status === "failed")));
    stop();
    await provider.dispose();
  });

  test("an undo on an idle conversation leaves no control session behind", async () => {
    const { queries, configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const marker = path.join(workspace, "marker.txt");
    writeFileSync(marker, "tip");
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second"),
    ].join("\n"));
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async (_uuid, options) => {
          if (!options?.dryRun) writeFileSync(marker, "rewound");
          return { canRewind: true, filesChanged: [marker] };
        };
        queries.push(query);
        return query;
      },
    });
    await provider.undo!(storedId);
    // The control session existed only for the rewind: it retires with it.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.returned).toBe(true);
    await provider.dispose();
  });

  test("a crafted subagent id under a foreign parent is refused", async () => {
    const { provider, configDir, workspace } = fixture();
    const foreignId = "99999999-0000-4111-8222-333333333333";
    const agentId = "abc123def4567890";
    const turn = JSON.stringify({
      type: "user", uuid: "u1", parentUuid: null, isSidechain: false,
      timestamp: "2026-08-30T10:00:00.000Z", cwd: "/somewhere/else",
      message: { role: "user", content: "foreign work" },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${foreignId}.jsonl`), turn);
    const subagentDir = path.join(claudeProjectDir(workspace, configDir), foreignId, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(path.join(subagentDir, `agent-${agentId}.jsonl`), turn);
    // The parent fails workspace confinement, so its child is unreachable
    // through the synthetic id too.
    expect(await provider.getSession(`sub:${foreignId}:${agentId}`)).toBeNull();
    await expect(provider.listMessages(`sub:${foreignId}:${agentId}`, { limit: 10 })).rejects.toThrow("unknown Claude subagent");
    await provider.dispose();
  });

  test("a terminal result retires the query; the next prompt resumes fresh", async () => {
    const { provider, queries, configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`),
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-08-30T10:00:00.000Z", cwd: workspace, message: { role: "user", content: "first" } }));
    await provider.prompt(storedId, { id: "r1", text: "work", delivery: "queue" });
    expect(queries).toHaveLength(1);
    queries[0]!.push({ type: "result", uuid: "res-1", subtype: "success", timestamp: "2026-08-30T10:01:00.000Z", usage: { input_tokens: 1, output_tokens: 1 } });
    // The turn's end releases the process: an idle conversation holds none.
    await waitFor(() => queries[0]!.returned);
    // The next prompt starts a fresh session resuming the same native id.
    await provider.prompt(storedId, { id: "r2", text: "more", delivery: "queue" });
    expect(queries).toHaveLength(2);
    expect(queries[1]!.input.options.resume).toBe(storedId);
    await provider.dispose();
  });

  test("an already-aborted permission signal settles immediately, never stranding a card", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "work", delivery: "queue" });
    const aborted = new AbortController();
    aborted.abort();
    const decision = await queries[0]!.input.options.canUseTool!("Write", { file_path: "/a" }, { signal: aborted.signal, toolUseID: "t1" });
    expect(decision).toEqual({ behavior: "deny", message: "The turn was interrupted before the user answered." });
    expect(await provider.listPermissions()).toEqual([]);
    await provider.dispose();
  });

  test("a slash command dispatches as a turn through the session", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.command(session.id, { id: "cmd-1", name: "compact", arguments: "focus on the tests" });
    expect(queries).toHaveLength(1);
    // The CLI parses "/name args" from the user message and runs it.
    const envelope = await new Promise<{ message: { content: Array<{ type: string; text?: string }> } }>(resolve => {
      void (async () => {
        for await (const value of queries[0]!.input.prompt) { resolve(value as never); break; }
      })();
    });
    expect(envelope.message.content).toEqual([{ type: "text", text: "/compact focus on the tests" }]);
    await waitFor(() => events.some(event => event.eventType === "prompt.accepted"));
    stop();
    await provider.dispose();
  });

  test("a mode not offered is refused; an offered one applies at start and live", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await expect(provider.prompt(session.id, { id: "r0", text: "go", delivery: "queue", mode: "bypassPermissions" }))
      .rejects.toThrow("does not offer the mode");

    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue", mode: "plan" });
    expect(queries[0]!.input.options.permissionMode).toBe("plan");
    // A later prompt switches the live session in place.
    const modeCalls: string[] = [];
    queries[0]!.setPermissionMode = async mode => { modeCalls.push(mode); };
    await provider.prompt(session.id, { id: "r2", text: "build it", delivery: "queue", mode: "acceptEdits" });
    expect(modeCalls).toEqual(["acceptEdits"]);
    expect((await provider.getConversationConfiguration(session.id)).mode).toBe("acceptEdits");
    await provider.dispose();
  });

  test("models come from the manifest and an unsupported effort is refused", async () => {
    const { provider } = fixture();
    const models = await provider.listModels();
    expect(models.map(model => model.selection.modelId)).toContain("claude-opus-5");
    const haiku = models.find(model => model.selection.modelId === "claude-haiku-4-5-20251001")!;
    expect(haiku.variants).toEqual(["low", "medium", "high"]);

    const session = await provider.createSession("x");
    await expect(provider.switchModel(session.id, { providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" }, "xhigh"))
      .rejects.toThrow("does not offer effort level");
    await provider.switchModel(session.id, { providerId: "anthropic", modelId: "claude-opus-5" }, "xhigh");
    // "auto" is the house default mode a fresh conversation starts with.
    expect(await provider.getConversationConfiguration(session.id)).toEqual({
      mode: "auto",
      model: { providerId: "anthropic", modelId: "claude-opus-5" },
      variant: "xhigh",
    });
    await provider.dispose();
  });

  test("a staged effort reaches the session start options", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.switchModel(session.id, { providerId: "anthropic", modelId: "claude-opus-5" }, "max");
    await provider.prompt(session.id, { id: "r1", text: "think hard", delivery: "queue" });
    expect(queries[0]!.input.options.model).toBe("claude-opus-5");
    expect(queries[0]!.input.options.effort).toBe("max");
    await provider.dispose();
  });

  test("slash commands are cached from the session's init message", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    expect(await provider.listCommands()).toEqual([]);
    await provider.prompt(session.id, { id: "r1", text: "hello", delivery: "queue" });
    queries[0]!.push({ type: "system", subtype: "init", uuid: "i1", session_id: session.id, model: "claude-opus-5", slash_commands: ["review", "compact"] });
    await waitFor(() => provider.listCommands().then === undefined || true);
    await waitFor(() => (provider as unknown as { commands: unknown[] }).commands.length === 2);
    expect(await provider.listCommands()).toEqual([
      { name: "review", description: "", argumentHint: "", kind: "command" },
      { name: "compact", description: "", argumentHint: "", kind: "command" },
    ]);
    await provider.dispose();
  });

  test("staged images reach the turn as base64 blocks and ride the user item", async () => {
    const { provider, queries, workspace } = fixture();
    const imagePath = path.join(workspace, "shot.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const session = await provider.createSession("x");
    await provider.prompt(session.id, {
      id: "r1",
      text: "look at this",
      delivery: "queue",
      attachments: [{ id: "att-1", name: "shot.png", mimeType: "image/png", absolutePath: imagePath }],
    });
    const query = queries[0]!;
    const sent: ClaudeUserEnvelope[] = [];
    void (async () => { for await (const envelope of query.input.prompt) sent.push(envelope); })();
    await waitFor(() => sent.length === 1);
    expect(sent[0]!.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") } },
      { type: "text", text: "look at this" },
    ]);
    await provider.dispose();
  });

  test("replayed image prompts degrade to labeled placeholders without ids", async () => {
    const { provider, configDir, workspace } = fixture();
    const storedId = "44444444-5555-4666-8777-888888888888";
    const entry = {
      type: "user", uuid: "u1", parentUuid: null, isSidechain: false,
      timestamp: "2026-08-30T10:00:00.000Z", cwd: workspace,
      message: { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } },
        { type: "text", text: "what is this" },
      ] },
    };
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), `${JSON.stringify(entry)}\n`);
    const page = await provider.listMessages(storedId, { limit: 10 });
    expect(page.items[0]).toEqual(expect.objectContaining({
      type: "user_message",
      text: "what is this",
      // Unrecoverable reference: name and mime survive, the id does not.
      attachments: [{ name: "attachment-1.webp", mimeType: "image/webp" }],
    }));
    await provider.dispose();
  });

  test("the pre-plan mode survives a restart: the restore intent still returns to it", async () => {
    const { configDir, workspace } = fixture();
    const stateFile = path.join(workspace, ".uatu-test-state.json");
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`),
      turn("u1", "2026-08-30T10:00:00.000Z", "first"));
    const build = (queries: FakeQuery[]) => new ClaudeProvider({
      workspacePath: workspace,
      stateFile,
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        queries.push(query);
        return query;
      },
    });

    const firstQueries: FakeQuery[] = [];
    const first = build(firstQueries);
    await first.prompt(storedId, { id: "r0", text: "work", delivery: "queue", mode: "acceptEdits" });
    await first.prompt(storedId, { id: "r1", text: "plan it", delivery: "queue", mode: "plan" });
    await first.dispose();

    const secondQueries: FakeQuery[] = [];
    const second = build(secondQueries);
    const { events, stop } = collect(second);
    await second.prompt(storedId, { id: "r2", text: "still planning", delivery: "queue" });
    const decision = secondQueries.at(-1)!.input.options.canUseTool!("ExitPlanMode", { plan: "steps" }, { signal: new AbortController().signal, toolUseID: "p1" });
    await waitFor(() => events.some(event => event.eventType === "interaction.requested"));
    const card = events.find(event => event.eventType === "interaction.requested")!.updates[0]! as { item: { choices?: Array<{ id: string; label: string }> } };
    // The restore intent survives the restart and still names acceptEdits.
    expect(card.item.choices?.map(choice => choice.id)).toEqual(["implement", "implement-and-restore"]);
    expect(card.item.choices?.at(-1)?.label).toContain("acceptEdits");
    await second.replyPermission(storedId, "p1", "once", "implement-and-restore");
    await decision;
    expect((await second.getConversationConfiguration(storedId)).mode).toBe("acceptEdits");
    stop();
    await second.dispose();
  });

  test("a completed plan asks with intents; each intent sets the follow-on mode", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    // Entering plan from acceptEdits remembers where to return to.
    await provider.prompt(session.id, { id: "r0", text: "start", delivery: "queue", mode: "acceptEdits" });
    const query = queries[0]!;
    const modeCalls: string[] = [];
    query.setPermissionMode = async mode => { modeCalls.push(mode); };
    await provider.prompt(session.id, { id: "r1", text: "plan it", delivery: "queue", mode: "plan" });

    const decision = query.input.options.canUseTool!("ExitPlanMode", { plan: "## Plan\n1. Do the thing" }, { signal: new AbortController().signal, toolUseID: "p1" });
    await waitFor(() => events.some(event => event.eventType === "interaction.requested"));
    const card = events.find(event => event.eventType === "interaction.requested")!.updates[0]! as { item: { plan?: string; choices?: Array<{ id: string }> ; action: string } };
    expect(card.item.action).toBe("Review the plan");
    expect(card.item.plan).toContain("Do the thing");
    expect(card.item.choices?.map(choice => choice.id)).toEqual(["implement", "implement-and-restore"]);

    await provider.replyPermission(session.id, "p1", "once", "implement-and-restore");
    expect(await decision).toEqual({ behavior: "allow", updatedInput: { plan: "## Plan\n1. Do the thing" } });
    // The restore intent returns to the pre-plan mode, live and in config.
    expect(modeCalls).toEqual(["plan", "acceptEdits"]);
    expect((await provider.getConversationConfiguration(session.id)).mode).toBe("acceptEdits");
    await waitFor(() => events.some(event => event.eventType === "plan.approved" && event.configuration?.mode === "acceptEdits"));
    stop();
    await provider.dispose();
  });

  test("the implement intent leaves planning for the declared default mode", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "plan it", delivery: "queue", mode: "plan" });
    const query = queries[0]!;
    const decision = query.input.options.canUseTool!("ExitPlanMode", { plan: "steps" }, { signal: new AbortController().signal, toolUseID: "p1" });
    await Bun.sleep(5);
    await provider.replyPermission(session.id, "p1", "once", "implement");
    await decision;
    expect((await provider.getConversationConfiguration(session.id)).mode).toBe("auto");
    await provider.dispose();
  });

  test("rejecting a plan keeps the conversation planning", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "plan it", delivery: "queue", mode: "plan" });
    const decision = queries[0]!.input.options.canUseTool!("ExitPlanMode", { plan: "steps" }, { signal: new AbortController().signal, toolUseID: "p1" });
    await Bun.sleep(5);
    await provider.replyPermission(session.id, "p1", "reject");
    expect(await decision).toEqual({ behavior: "deny", message: "The user did not approve this plan. Keep planning and present a revised plan." });
    expect((await provider.getConversationConfiguration(session.id)).mode).toBe("plan");
    await provider.dispose();
  });

  test("TodoWrite becomes the task-progress surface, live and on replay, without tool rows", async () => {
    const { provider, configDir, workspace } = fixture();
    const storedId = "55555555-6666-4777-8888-999999999999";
    const todoUse = (uuid: string, timestamp: string, todos: unknown[]) => JSON.stringify({
      type: "assistant", uuid, parentUuid: null, isSidechain: false, timestamp,
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: `todo-${uuid}`, name: "TodoWrite", input: { todos } }] },
    });
    const todoResult = (uuid: string, timestamp: string, toolId: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "Todos updated" }] },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      todoUse("t1", "2026-08-30T10:00:00.000Z", [
        { content: "Read the code", status: "in_progress", activeForm: "Reading the code" },
        { content: "Fix it", status: "pending" },
      ]),
      todoResult("t1r", "2026-08-30T10:00:01.000Z", "todo-t1"),
      todoUse("t2", "2026-08-30T10:05:00.000Z", [
        { content: "Read the code", status: "completed" },
        { content: "Fix it", status: "completed" },
      ]),
    ].join("\n"));

    const page = await provider.listMessages(storedId, { limit: 10 });
    // One presentation, final state, no TodoWrite tool rows or results.
    const taskItems = page.items.filter(item => item.type === "task_progress");
    expect(taskItems).toHaveLength(1);
    expect(taskItems[0]).toEqual(expect.objectContaining({
      id: "task-progress",
      createdAt: Date.parse("2026-08-30T10:00:00.000Z"),
      entries: [
        { text: "Read the code", status: "completed" },
        { text: "Fix it", status: "completed" },
      ],
    }));
    expect(page.items.some(item => item.type === "tool")).toBe(false);
    await provider.dispose();
  });

  test("a custom tool's arbitrary input still yields an approval resource", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    void queries[0]!.input.options.canUseTool!("mcp__linear__create_issue", { query: "fix the bug", project: "uatu" }, { signal: new AbortController().signal, toolUseID: "t1" });
    await waitFor(() => events.some(event => event.eventType === "interaction.requested"));
    const card = events.find(event => event.eventType === "interaction.requested")!.updates[0]! as { item: { resources: string[] } };
    // No conventional keys — the compact input is the resource, so the card
    // survives projection and the callback stays answerable.
    expect(card.item.resources).toHaveLength(1);
    expect(card.item.resources[0]).toContain("fix the bug");
    stop();
    await provider.dispose();
  });

  test("an unreadable existing file aborts the rewind instead of snapshotting as absent", async () => {
    const { configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const locked = path.join(workspace, "locked.txt");
    writeFileSync(locked, "secret", { mode: 0o000 });
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second"),
    ].join("\n"));
    let realRewinds = 0;
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async (_uuid, options) => {
          if (!options?.dryRun) realRewinds += 1;
          return { canRewind: true, filesChanged: [locked] };
        };
        return query;
      },
    });
    // The capture failure aborts before the destructive rewind runs.
    await expect(provider.undo!(storedId)).rejects.toThrow("cannot snapshot");
    expect(realRewinds).toBe(0);
    expect(statSync(locked).size).toBeGreaterThan(0);
    await provider.dispose();
  });

  test("redo restores file modes and symlinks, not only bytes", async () => {
    const { queries, configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const script = path.join(workspace, "run.sh");
    const link = path.join(workspace, "latest");
    writeFileSync(script, "#!/bin/sh\necho tip\n", { mode: 0o755 });
    symlinkSync("run.sh", link);
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second"),
    ].join("\n"));
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async (_uuid, options) => {
          if (!options?.dryRun) {
            // The rewind removes what the tip created.
            rmSync(script, { force: true });
            rmSync(link, { force: true });
          }
          return { canRewind: true, filesChanged: [script, link] };
        };
        queries.push(query);
        return query;
      },
    });
    await provider.undo!(storedId);
    expect(existsSync(script)).toBe(false);
    await provider.redo!(storedId);
    // The executable bit and the symlink both came back.
    expect(statSync(script).mode & 0o111).not.toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(script, "utf8")).toContain("echo tip");
    await provider.dispose();
  });

  test("a deeper undo grows the tip snapshot: terminal redo restores every affected file", async () => {
    const { queries, configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const fileA = path.join(workspace, "a.txt");
    const fileB = path.join(workspace, "b.txt");
    writeFileSync(fileA, "a-tip");
    writeFileSync(fileB, "b-tip");
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first prompt"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second prompt"),
    ].join("\n"));

    // Turn 1 changed A, turn 2 changed B: rewinding to u2 reverts B only,
    // rewinding to u1 reverts both.
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async (uuid, options) => {
          const changed = uuid === "u2" ? [fileB] : [fileA, fileB];
          if (!options?.dryRun) {
            if (uuid === "u2") writeFileSync(fileB, "b-before-2");
            else { writeFileSync(fileA, "a-before-1"); writeFileSync(fileB, "b-before-1"); }
          }
          return { canRewind: true, filesChanged: changed };
        };
        queries.push(query);
        return query;
      },
    });

    await provider.undo!(storedId);
    expect(readFileSync(fileB, "utf8")).toBe("b-before-2");
    // The deeper undo touches A for the first time — its tip bytes must be
    // captured now, while the shallower rewind has left them alone.
    await provider.undo!(storedId);
    expect(readFileSync(fileA, "utf8")).toBe("a-before-1");
    // Terminal redo: every turn returns and BOTH files carry tip bytes.
    await provider.redo!(storedId);
    const terminal = await provider.redo!(storedId);
    expect(terminal.state.staged).toBe(false);
    expect(readFileSync(fileA, "utf8")).toBe("a-tip");
    expect(readFileSync(fileB, "utf8")).toBe("b-tip");
    await provider.dispose();
  });

  test("an effort switch reaches the live session through the flag-settings control", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const applied: unknown[] = [];
    queries[0]!.applyFlagSettings = async settings => { applied.push(settings); };
    await provider.switchModel(session.id, { providerId: "anthropic", modelId: "claude-opus-5" }, "max");
    expect(applied).toEqual([{ effortLevel: "max" }]);
    // Clearing the variant clears the flag layer.
    await provider.switchModel(session.id, { providerId: "anthropic", modelId: "claude-opus-5" });
    expect(applied).toEqual([{ effortLevel: "max" }, { effortLevel: null }]);
    // An unchanged effort is not re-sent.
    await provider.switchModel(session.id, { providerId: "anthropic", modelId: "claude-sonnet-5" });
    expect(applied).toHaveLength(2);
    await provider.dispose();
  });

  test("undo rewinds files, hides the turn, returns the draft; failing rewind claims nothing", async () => {
    const { queries, configDir, workspace } = fixture();
    const storedId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const marker = path.join(workspace, "marker.txt");
    writeFileSync(marker, "after-turn-2");
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first prompt"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second prompt"),
    ].join("\n"));

    // A rewind the checkpoint store refuses changes nothing. The hook rides
    // the factory: the control session is spawned lazily by the undo itself.
    let allowRewind = false;
    const rewinds: Array<{ uuid: string; dryRun: boolean }> = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async (uuid, options) => {
          rewinds.push({ uuid, dryRun: options?.dryRun === true });
          if (!allowRewind) return { canRewind: false, error: "no checkpoint" };
          if (!options?.dryRun) writeFileSync(marker, "before-turn-2");
          return { canRewind: true, filesChanged: [marker] };
        };
        queries.push(query);
        return query;
      },
    });

    const before = await provider.getReversibleHistoryState!(storedId);
    expect(before).toEqual({ staged: false, canUndo: true, canRedo: false, revertedMessages: [] });

    await expect(provider.undo!(storedId)).rejects.toThrow("the checkpoint store refused the rewind: no checkpoint");
    expect((await provider.getReversibleHistoryState!(storedId)).staged).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("after-turn-2");

    allowRewind = true;
    const undone = await provider.undo!(storedId);
    expect(undone.outcome).toBe("changed");
    expect(undone.restoredDraft).toEqual({ text: "second prompt" });
    expect(undone.state).toEqual({ staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "message:u2", text: "second prompt" }] });
    expect(readFileSync(marker, "utf8")).toBe("before-turn-2");
    // The staged boundary hides the turn from history.
    expect((await provider.listMessages(storedId, { limit: 10 })).items.map(item => item.id)).toEqual(["message:u1"]);

    // Terminal redo restores the tip bytes from the snapshot.
    const redone = await provider.redo!(storedId);
    expect(redone.outcome).toBe("changed");
    expect(redone.state.staged).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("after-turn-2");
    expect((await provider.listMessages(storedId, { limit: 10 })).items.map(item => item.id)).toEqual(["message:u1", "message:u2"]);
    await provider.dispose();
  });

  test("interrupt markers are not undoable turns", async () => {
    const { provider, configDir, workspace } = fixture();
    const storedId = "aaaaaaaa-1111-4222-8333-444444444444";
    const line = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      line("u1", "2026-08-30T10:00:00.000Z", "real prompt"),
      line("u2", "2026-08-30T10:01:00.000Z", "[Request interrupted by user]"),
    ].join("\n"));
    const state = await provider.getReversibleHistoryState!(storedId);
    // One real turn; the marker neither counts nor becomes a boundary target.
    expect(state.canUndo).toBe(true);
    await expect(provider.revert!(storedId, "message:u2")).rejects.toThrow();
    await provider.dispose();
  });

  test("a staged revert survives a restart: the tip bytes remain restorable", async () => {
    const { configDir, workspace } = fixture();
    const stateFile = path.join(workspace, ".uatu-test-state.json");
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const marker = path.join(workspace, "marker.txt");
    writeFileSync(marker, "tip-bytes");
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "first"),
      turn("u2", "2026-08-30T10:05:00.000Z", "second"),
    ].join("\n"));
    const build = () => new ClaudeProvider({
      workspacePath: workspace,
      stateFile,
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async (_uuid, options) => {
          if (!options?.dryRun) writeFileSync(marker, "rewound-bytes");
          return { canRewind: true, filesChanged: [marker] };
        };
        return query;
      },
    });

    const first = build();
    await first.undo!(storedId);
    expect(readFileSync(marker, "utf8")).toBe("rewound-bytes");
    await first.dispose();

    // The restarted provider still knows the boundary and holds the
    // displaced tip bytes; terminal redo puts them back.
    const second = build();
    const state = await second.getReversibleHistoryState!(storedId);
    expect(state.staged).toBe(true);
    expect(state.canRedo).toBe(true);
    await second.redo!(storedId);
    expect(readFileSync(marker, "utf8")).toBe("tip-bytes");
    await second.dispose();
  });

  test("a created-but-unprompted conversation survives a restart", async () => {
    const { configDir, workspace } = fixture();
    const stateFile = path.join(workspace, ".uatu-test-state.json");
    const build = () => new ClaudeProvider({
      workspacePath: workspace,
      stateFile,
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => new FakeQuery(input),
    });
    const first = build();
    const created = await first.createSession("x");
    await first.dispose();
    const second = build();
    expect((await second.listSessions()).map(session => session.id)).toContain(created.id);
    expect(await second.getSession(created.id)).not.toBeNull();
    await second.dispose();
  });

  test("modes and fork redirections survive a provider restart", async () => {
    const { configDir, workspace } = fixture();
    const stateFile = path.join(workspace, ".uatu-test-state.json");
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const forkId = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "keep this"),
      turn("u2", "2026-08-30T10:05:00.000Z", "revert this"),
    ].join("\n"));
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${forkId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "keep this"),
      turn("u3", "2026-08-30T10:10:00.000Z", "the fork way"),
    ].join("\n"));

    const build = (queries: FakeQuery[]) => new ClaudeProvider({
      workspacePath: workspace,
      stateFile,
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async () => ({ canRewind: true, filesChanged: [] });
        queries.push(query);
        return query;
      },
      forkSession: async () => ({ sessionId: forkId }),
    });

    // First life: the user parks the conversation in plan mode, then a
    // replacement prompt commits a revert onto the fork.
    const firstQueries: FakeQuery[] = [];
    const first = build(firstQueries);
    await first.prompt(storedId, { id: "r1", text: "think first", delivery: "queue", mode: "plan" });
    await first.undo!(storedId);
    await first.prompt(storedId, { id: "r2", text: "a different direction", delivery: "queue" });
    await first.dispose();

    // Second life: the sidecar restores what memory lost.
    const secondQueries: FakeQuery[] = [];
    const second = build(secondQueries);
    // The parked mode survives — and governs the resumed session.
    expect((await second.getConversationConfiguration(storedId)).mode).toBe("plan");
    await second.prompt(storedId, { id: "r3", text: "continue", delivery: "queue" });
    expect(secondQueries.at(-1)!.input.options.permissionMode).toBe("plan");
    // The fork redirect survives: the original id resumes the fork, and the
    // fork does not reappear as a second conversation.
    expect(secondQueries.at(-1)!.input.options.resume).toBe(forkId);
    const listed = await second.listSessions();
    expect(listed.map(session => session.id)).not.toContain(forkId);
    // The public summary describes the fork's transcript (its timestamps),
    // not the pre-fork history the conversation no longer shows.
    const summary = listed.find(session => session.id === storedId)!;
    expect(summary.updatedAt).toBe(Date.parse("2026-08-30T10:10:00.000Z"));
    await second.dispose();
  });

  test("a replacement prompt commits the revert by forking the native session", async () => {
    const { provider, queries, configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const forkId = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "keep this"),
      turn("u2", "2026-08-30T10:05:00.000Z", "revert this"),
    ].join("\n"));
    // The fork exists on disk like the real store would have it.
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${forkId}.jsonl`),
      turn("u1", "2026-08-30T10:00:00.000Z", "keep this"));

    const forks: Array<{ sessionId: string; upToMessageId: string }> = [];
    const root2 = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-fork-")));
    void root2;
    const forking = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async () => ({ canRewind: true, filesChanged: [] });
        queries.push(query);
        return query;
      },
      forkSession: async (sessionId, options) => {
        forks.push({ sessionId, upToMessageId: options.upToMessageId });
        return { sessionId: forkId };
      },
    });

    await forking.undo!(storedId);
    await forking.prompt(storedId, { id: "r-new", text: "a different direction", delivery: "queue" });
    expect(forks).toEqual([{ sessionId: storedId, upToMessageId: "u1" }]);
    // The prompt's session resumed the fork, and the fork stays out of the picker.
    const promptQuery = queries.at(-1)!;
    expect(promptQuery.input.options.resume).toBe(forkId);
    expect((await forking.listSessions()).map(session => session.id)).not.toContain(forkId);
    expect((await forking.getReversibleHistoryState!(storedId)).staged).toBe(false);
    await forking.dispose();
  });

  test("a fork-committed conversation's subagents resolve under the fork's directory", async () => {
    const { configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const forkId = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const agentId = "a1b2c3d4e5f60718";
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "keep this"),
      turn("u2", "2026-08-30T10:05:00.000Z", "revert this"),
    ].join("\n"));
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${forkId}.jsonl`),
      turn("u1", "2026-08-30T10:00:00.000Z", "keep this"));
    // The replacement turn's subagent lives under the FORK's directory.
    const subagentDir = path.join(claudeProjectDir(workspace, configDir), forkId, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(path.join(subagentDir, `agent-${agentId}.jsonl`),
      turn("s1", "2026-08-30T10:10:00.000Z", "count the files"));

    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async () => ({ canRewind: true, filesChanged: [] });
        return query;
      },
      forkSession: async () => ({ sessionId: forkId }),
    });
    await provider.undo!(storedId);
    await provider.prompt(storedId, { id: "r2", text: "new direction", delivery: "queue" });
    // The public link keeps the original parent id; resolution follows the
    // active native id to the fork.
    const page = await provider.listMessages(`sub:${storedId}:${agentId}`, { limit: 10 });
    expect(page.items.some(item => item.type === "user_message")).toBe(true);
    await provider.dispose();
  });

  test("a redirected conversation's Task links carry the public parent id", async () => {
    const { configDir, workspace } = fixture();
    const storedId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const forkId = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const agentId = "a1b2c3d4e5f60718";
    const turn = (uuid: string, timestamp: string, text: string) => JSON.stringify({
      type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, cwd: workspace,
      message: { role: "user", content: text },
    });
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), [
      turn("u1", "2026-08-30T10:00:00.000Z", "keep this"),
      turn("u2", "2026-08-30T10:05:00.000Z", "revert this"),
    ].join("\n"));
    // The fork's history includes a completed Task.
    const forkLines = [
      turn("u1", "2026-08-30T10:00:00.000Z", "keep this"),
      JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, timestamp: "2026-08-30T10:10:00.000Z",
        message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: "toolu_t1", name: "Task", input: { description: "review", prompt: "go" } }] } }),
      JSON.stringify({ type: "user", uuid: "u3", parentUuid: "a1", isSidechain: false, timestamp: "2026-08-30T10:11:00.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1", content: "done" }] },
        toolUseResult: { status: "completed", agentId, agentType: "reviewer" } }),
    ].join("\n");
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${forkId}.jsonl`), forkLines);
    const provider = new ClaudeProvider({
      workspacePath: workspace,
      stateFile: path.join(workspace, ".uatu-test-state.json"),
      executable: "/bin/claude",
      catalogProbe: false,
      configDir,
      queryFactory: input => {
        const query = new FakeQuery(input);
        query.rewindFiles = async () => ({ canRewind: true, filesChanged: [] });
        return query;
      },
      forkSession: async () => ({ sessionId: forkId }),
    });
    await provider.undo!(storedId);
    await provider.prompt(storedId, { id: "r2", text: "new direction", delivery: "queue" });
    const page = await provider.listMessages(storedId, { limit: 20 });
    const task = page.items.find(item => item.type === "tool") as { childConversationId?: string };
    // Public id, not the hidden fork's — the link must survive resolution.
    expect(task?.childConversationId).toBe(`sub:${storedId}:${agentId}`);
    // And the link actually resolves through the redirect.
    const subagentDir = path.join(claudeProjectDir(workspace, configDir), forkId, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(path.join(subagentDir, `agent-${agentId}.jsonl`), turn("s1", "2026-08-30T10:12:00.000Z", "child work"));
    expect(await provider.getSession(`sub:${storedId}:${agentId}`)).not.toBeNull();
    await provider.dispose();
  });

  test("a completed Task links its subagent transcript and carries the store's attribution", async () => {
    const { provider, configDir, workspace } = fixture();
    const parentId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    const agentId = "af5234142f8645688";
    const parentLines = [
      { type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-08-30T10:00:00.000Z", cwd: workspace, message: { role: "user", content: "fan out a reviewer" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, timestamp: "2026-08-30T10:00:01.000Z", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: "toolu_task1", name: "Task", input: { description: "Review the diff", subagent_type: "reviewer", prompt: "go" } }] } },
      { type: "user", uuid: "u2", parentUuid: "a1", isSidechain: false, timestamp: "2026-08-30T10:05:00.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_task1", content: "Both findings fixed." }] },
        toolUseResult: { status: "completed", agentId, agentType: "reviewer", resolvedModel: "claude-sonnet-5", totalTokens: 4321, usage: { input_tokens: 4000, output_tokens: 321 } } },
    ].map(value => JSON.stringify(value)).join("\n");
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${parentId}.jsonl`), `${parentLines}\n`);
    const subagentDir = path.join(claudeProjectDir(workspace, configDir), parentId, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(path.join(subagentDir, `agent-${agentId}.jsonl`), [
      { type: "user", uuid: "s1", parentUuid: null, isSidechain: true, timestamp: "2026-08-30T10:00:02.000Z", message: { role: "user", content: "Review the diff carefully." } },
      { type: "assistant", uuid: "s2", parentUuid: "s1", isSidechain: true, timestamp: "2026-08-30T10:04:00.000Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Two findings, both fixed." }] } },
    ].map(value => JSON.stringify(value)).join("\n"));

    // The parent's row links the child and carries model + tokens.
    const parentPage = await provider.listMessages(parentId, { limit: 10 });
    const taskRow = parentPage.items.find(item => item.type === "tool")!;
    expect(taskRow).toEqual(expect.objectContaining({
      id: "tool:toolu_task1",
      status: "completed",
      childConversationId: `sub:${parentId}:${agentId}`,
      model: "claude-sonnet-5",
      usage: expect.objectContaining({ input: 4000, output: 321 }),
    }));

    // The child opens as its own read-only transcript with a parent.
    const childId = `sub:${parentId}:${agentId}`;
    const childSession = await provider.getSession(childId);
    expect(childSession).toEqual(expect.objectContaining({ id: childId, parentId }));
    const childPage = await provider.listMessages(childId, { limit: 10 });
    expect(childPage.items.map(item => item.type)).toEqual(["user_message", "assistant_message"]);
    expect(childPage.items[1]).toEqual(expect.objectContaining({ markdown: "Two findings, both fixed." }));
    await expect(provider.prompt(childId, { id: "r1", text: "no", delivery: "queue" })).rejects.toThrow("read-only");

    // Children never enter the inventory.
    expect((await provider.listSessions()).map(session => session.id)).not.toContain(childId);
    await provider.dispose();
  });

  test("history pages the stored transcript and refuses unknown conversations", async () => {
    const { provider, configDir, workspace } = fixture();
    const storedId = "22222222-3333-4444-8555-666666666666";
    const lines = [
      { type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-08-30T10:00:00.000Z", cwd: workspace, message: { role: "user", content: "question" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, timestamp: "2026-08-30T10:00:01.000Z", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10, output_tokens: 3 } } },
    ].map(value => JSON.stringify(value)).join("\n");
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${storedId}.jsonl`), `${lines}\n`);

    const page = await provider.listMessages(storedId, { limit: 10 });
    expect(page.items.map(item => item.id)).toEqual(["message:u1", "message:a1", "usage:a1"]);
    expect(page.accounting).toEqual([expect.objectContaining({ messageId: "a1", usage: expect.objectContaining({ input: 10, output: 3 }), model: "claude-opus-5" })]);

    const newest = await provider.listMessages(storedId, { limit: 1 });
    expect(newest.items.map(item => item.id)).toEqual(["usage:a1"]);
    expect(newest.completeItems?.length).toBe(3);
    expect(newest.nextCursor).toBe("2");

    await expect(provider.listMessages("33333333-4444-4555-8666-777777777777", { limit: 10 })).rejects.toThrow("unknown Claude conversation");
    await provider.dispose();
  });
});
