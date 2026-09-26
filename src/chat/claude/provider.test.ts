import { describe, expect, test } from "bun:test";
import { notificationPipeline } from "../../../tests/notification-pipeline";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import spike from "../../../tests/fixtures/claude-sdk/spike-messages.json";
import spikeRevival from "../../../tests/fixtures/claude-sdk/spike-cron-revival.json";
import forkedRuns from "../../../tests/fixtures/claude-sdk/forked-runs-2.1.280.json";
import type { NormalizedProviderEvent } from "../provider";
import { createClaudeEventMemory, markTasksBackgrounded, normalizeClaudeMessage, normalizeContextUsage, normalizeTranscriptEntries } from "./normalization";
import { ClaudeProvider, normalizePlanUtilization, normalizeSessionTotals, taskOutputKey, wakeupPromptMatches, WAKEUP_PAUSED_MESSAGE, WAKEUP_PAUSED_ONCE_MESSAGE, type ClaudeQueryHandle, type ClaudeQueryInput, type ClaudeUserEnvelope } from "./provider";
import type { QuestionRequest } from "../types";
import { BackgroundTaskUnavailableError, ReleaseUnavailableError, ScheduledWakeupUnavailableError } from "../provider";
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
  stopTask?: (taskId: string) => Promise<void>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;

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

function fixture(prepare?: (query: FakeQuery) => void, options: { usageReadTimeoutMs?: number } = {}): { provider: ClaudeProvider; queries: FakeQuery[]; configDir: string; workspace: string } {
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
    ...options,
    queryFactory: input => {
      const query = new FakeQuery(input);
      prepare?.(query);
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

test("verified Claude history avoids repeated processing and reconciles native file mutations", async () => {
  const { provider, configDir, workspace, queries } = fixture();
  const file = path.join(claudeProjectDir(workspace, configDir), "reuse-session.jsonl");
  const row = (id: string, text: string) => JSON.stringify({ type: "user", uuid: id, parentUuid: null, isSidechain: false, timestamp: "2026-09-01T12:00:00Z", message: { role: "user", content: text } }) + "\n";
  writeFileSync(file, row("one", "first") + row("two", "second"));
  const previous = globalThis.__uatuChatPerformance;
  globalThis.__uatuChatPerformance = { counts: {}, durations: {} };
  try {
    const first = await provider.listMessages("reuse-session", { limit: 1 });
    const older = await provider.listMessages("reuse-session", { limit: 1, cursor: first.nextCursor });
    expect(older.items).toMatchObject([{ text: "first" }]);
    expect(globalThis.__uatuChatPerformance.counts["claude-read"]).toBe(1);
    expect(globalThis.__uatuChatPerformance.counts["claude-normalize"]).toBe(1);
    const appended = row("three", "third");
    appendFileSync(file, appended.slice(0, 30));
    expect((await provider.listMessages("reuse-session", { limit: 10 })).items).toHaveLength(2);
    appendFileSync(file, appended.slice(30));
    expect((await provider.listMessages("reuse-session", { limit: 10 })).items).toHaveLength(3);
    await expect(provider.listMessages("reuse-session", { limit: 1, cursor: first.nextCursor })).rejects.toThrow("history changed");
    writeFileSync(file, row("one", "edited"));
    expect((await provider.listMessages("reuse-session", { limit: 10 })).items).toMatchObject([{ text: "edited" }]);
    writeFileSync(file + ".replacement", row("replacement", "replaced"));
    renameSync(file + ".replacement", file);
    expect((await provider.listMessages("reuse-session", { limit: 10 })).items).toMatchObject([{ text: "replaced" }]);
    writeFileSync(file, "");
    expect((await provider.listMessages("reuse-session", { limit: 10 })).items).toEqual([]);
    rmSync(file);
    await expect(provider.listMessages("reuse-session", { limit: 10 })).rejects.toThrow("unknown Claude conversation");
    expect(queries).toHaveLength(0);
  } finally { globalThis.__uatuChatPerformance = previous; await provider.dispose(); }
});

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

  test("a reopened conversation replays a background task's notification as its settled row, not a bubble", () => {
    // The store keeps no task edges — only the notification the model was
    // sent, as a user record. It settles the same `task:<id>` row the live
    // stream would, named by the Bash step that launched it.
    const notification = "<task-notification>\n<task-id>bp1gl2rjw</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<output-file>/tmp/bp1gl2rjw.output</output-file>\n<status>completed</status>\n<summary>Background command \"Wait for CI to finish on 6fc0e5e\" completed (exit code 0)</summary>\n</task-notification>";
    const { items } = normalizeTranscriptEntries([
      { kind: "user", uuid: "u1", parentUuid: null, timestamp: 1, isSidechain: false, parentToolUseId: null, origin: "human", message: { role: "user", content: "merge it when green" } },
      { kind: "assistant", uuid: "a1", parentUuid: "u1", timestamp: 2, isSidechain: false, parentToolUseId: null, message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "gh run watch", description: "Wait for CI to finish on 6fc0e5e", run_in_background: true } }] } },
      { kind: "user", uuid: "u2", parentUuid: "a1", timestamp: 3, isSidechain: false, parentToolUseId: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Command running in background with ID: bp1gl2rjw" }] } },
      { kind: "user", uuid: "u3", parentUuid: "u2", timestamp: 4, isSidechain: false, parentToolUseId: null, origin: "task-notification", message: { role: "user", content: notification } },
      { kind: "assistant", uuid: "a2", parentUuid: "u3", timestamp: 5, isSidechain: false, parentToolUseId: null, message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "CI is green; merging." }] } },
    ]);
    expect(items.map(item => item.id)).toEqual(["message:u1", "tool:toolu_bg", "task:bp1gl2rjw", "message:a2"]);
    expect(items[2]).toEqual({
      id: "task:bp1gl2rjw", type: "background_task", createdAt: 4, taskId: "bp1gl2rjw", toolUseId: "toolu_bg",
      description: "Wait for CI to finish on 6fc0e5e", status: "completed",
      summary: "Background command \"Wait for CI to finish on 6fc0e5e\" completed (exit code 0)",
    });
    expect(items.some(item => item.type === "user_message" && item.text.includes("<task-notification>"))).toBe(false);
  });

  test("replayed notifications settle by status and fall back to a generic name; harness records never bubble", () => {
    const entry = (uuid: string, timestamp: number, content: string, extra: Partial<Parameters<typeof normalizeTranscriptEntries>[0][number]> = {}) =>
      ({ kind: "user" as const, uuid, parentUuid: null, timestamp, isSidechain: false, parentToolUseId: null, message: { role: "user", content }, ...extra });
    const { items } = normalizeTranscriptEntries([
      // An unknown launcher: the live fallback name, the reported outcome.
      entry("n1", 1, "<task-notification>\n<task-id>f1</task-id>\n<status>failed</status>\n<summary>exit 1</summary>\n</task-notification>", { origin: "task-notification" }),
      entry("n2", 2, "<task-notification>\n<task-id>k1</task-id>\n<status>killed</status>\n<summary></summary>\n</task-notification>", { origin: "task-notification" }),
      // A monitor event names no status: settled as completed, as live does.
      entry("n3", 3, "<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: \"review activity\"</summary>\n<event>x</event>\nIf this matters, notify.\n</task-notification>", { origin: "task-notification" }),
      // An older record with no author but the generated envelope is one too.
      entry("n4", 4, "<task-notification>\n<task-id>o1</task-id>\n<status>completed</status>\n<summary>ok</summary>\n</task-notification>"),
      // The store says notification but the text is not one: nothing, never markup.
      entry("n5", 5, "garbled", { origin: "task-notification" }),
      // A skill's preamble is the harness's, not the person's.
      entry("n6", 6, "Base directory for this skill: /x/skills/simplify", { isMeta: true }),
      // The person quoting the tag keeps their bubble.
      entry("n7", 7, "why did <task-notification> show up in my chat?", { origin: "human" }),
      // And so does the person who pastes nothing BUT an envelope — asking
      // what it is, say. The store says who wrote it; the shape only stands
      // in where it does not (records older than `origin`).
      entry("n8", 8, "<task-notification>\n<task-id>h1</task-id>\n<status>completed</status>\n<summary>is this mine?</summary>\n</task-notification>", { origin: "human" }),
    ]);
    expect(items.map(item => item.id)).toEqual(["task:f1", "task:k1", "task:m1", "task:o1", "message:n7", "message:n8"]);
    expect(items.some(item => item.id === "task:h1")).toBe(false);
    expect(items[5]).toEqual(expect.objectContaining({ type: "user_message", text: expect.stringContaining("<task-id>h1</task-id>") }));
    expect(items[0]).toEqual(expect.objectContaining({ type: "background_task", description: "Background task", status: "failed", summary: "exit 1" }));
    expect(items[1]).toEqual(expect.objectContaining({ type: "background_task", status: "stopped" }));
    expect(items[1]).not.toHaveProperty("summary");
    expect(items[2]).toEqual(expect.objectContaining({ type: "background_task", status: "completed", summary: "Monitor event: \"review activity\"" }));
    expect(items[3]).toEqual(expect.objectContaining({ type: "background_task", status: "completed", summary: "ok" }));
    expect(items[4]).toEqual(expect.objectContaining({ type: "user_message", text: "why did <task-notification> show up in my chat?" }));
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

describe("background tasks and tool progress normalize into in-place rows (D8)", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 2, 10, 0, seconds)).toISOString();

  test("start, progress, and completion upsert the same task row linked to its tool use", () => {
    const memory = createClaudeEventMemory();
    const started = normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: at(0), task_id: "b2f6", tool_use_id: "toolu_1", description: "Sleep for 8 seconds then echo done", task_type: "local_bash", is_backgrounded: true }, memory, "live");
    expect(started.outcome).toBe("handled");
    expect(started.updates).toEqual([{ kind: "upsert", item: { id: "task:b2f6", type: "background_task", createdAt: Date.parse(at(0)), taskId: "b2f6", description: "Sleep for 8 seconds then echo done", taskType: "local_bash", toolUseId: "toolu_1", status: "running" } }]);
    // A shell task reports no progress in practice (spike); should an edge
    // arrive anyway, its usage is kept but the last tool is never the
    // progress line — the reader sees elapsed time instead.
    const progress = normalizeClaudeMessage({ type: "system", subtype: "task_progress", uuid: "tp1", timestamp: at(3), task_id: "b2f6", description: "Sleep for 8 seconds then echo done", usage: { total_tokens: 0, tool_uses: 1, duration_ms: 3000 }, last_tool_name: "Bash" }, memory, "live");
    expect(progress.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:b2f6", createdAt: Date.parse(at(0)), status: "running", usage: { totalTokens: 0, toolUses: 1, durationMs: 3000 } }) });
    expect((progress.updates[0] as { item: object }).item).not.toHaveProperty("progress");
    const notified = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn1", timestamp: at(8), task_id: "b2f6", tool_use_id: "toolu_1", status: "completed", output_file: "/tmp/out", summary: "done" }, memory, "live");
    expect(notified.updates[0]).toEqual({ kind: "upsert", item: { id: "task:b2f6", type: "background_task", createdAt: Date.parse(at(0)), taskId: "b2f6", description: "Sleep for 8 seconds then echo done", taskType: "local_bash", toolUseId: "toolu_1", status: "completed", summary: "done", usage: { totalTokens: 0, toolUses: 1, durationMs: 3000 }, outputFile: "/tmp/out" } });
  });

  // The frames below are the spike's (spike-background-tasks.md, probes a2
  // and b), shapes verbatim.
  const spikeOutputFile = "/private/tmp/claude-501/-private-tmp-uatu-spike-work/57489e13/tasks/ada2b9582caa230c5.output";
  const spikePrompt = "List the files in the current directory and count them.";

  test("a backgrounded agent task carries its type, prompt, child id, usage, and progress summary from the edges", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "assistant", uuid: "a1", timestamp: at(0), message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: "toolu_013s2jZsDCiw3cAHYTqFeSpc", name: "Agent", input: { description: "List files and count them", prompt: spikePrompt, run_in_background: true } }] } }, memory, "live", "57489e13");
    const started = normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: at(0), task_id: "ada2b9582caa230c5", tool_use_id: "toolu_013s2jZsDCiw3cAHYTqFeSpc", description: "List files and count them", subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1, task_type: "local_agent", prompt: spikePrompt }, memory, "live", "57489e13");
    // The task id is the agent id (D8): the child is addressable at start —
    // by the task row and, from the same edge, by the row that launched it.
    expect(started.updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "tool:toolu_013s2jZsDCiw3cAHYTqFeSpc", name: "Agent", status: "running", childConversationId: "sub:57489e13:ada2b9582caa230c5" }) },
      { kind: "upsert", item: { id: "task:ada2b9582caa230c5", type: "background_task", createdAt: Date.parse(at(0)), taskId: "ada2b9582caa230c5", description: "List files and count them", taskType: "local_agent", toolUseId: "toolu_013s2jZsDCiw3cAHYTqFeSpc", status: "running", subagentType: "general-purpose", prompt: spikePrompt, childConversationId: "sub:57489e13:ada2b9582caa230c5" } },
    ]);
    // The async AgentOutput is complete at launch: the launching row is
    // openable now, and the task learns where its output goes.
    const launched = normalizeClaudeMessage({ type: "user", uuid: "u1", timestamp: at(0), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_013s2jZsDCiw3cAHYTqFeSpc", content: "Async agent launched successfully." }] },
      tool_use_result: { isAsync: true, status: "async_launched", agentId: "ada2b9582caa230c5", description: "List files and count them", resolvedModel: "claude-haiku-4-5-20251001", prompt: spikePrompt, outputFile: spikeOutputFile, canReadOutputFile: true } }, memory, "live", "57489e13");
    expect(launched.updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "tool:toolu_013s2jZsDCiw3cAHYTqFeSpc", name: "Agent", status: "completed", childConversationId: "sub:57489e13:ada2b9582caa230c5", model: "claude-haiku-4-5-20251001" }) },
      { kind: "upsert", item: expect.objectContaining({ id: "task:ada2b9582caa230c5", status: "running", outputFile: spikeOutputFile, prompt: spikePrompt, subagentType: "general-purpose", childConversationId: "sub:57489e13:ada2b9582caa230c5" }) },
    ]);
    // Progress: the last tool until the model writes a summary, which then
    // replaces it; usage is cumulative and rides every edge from here.
    const progress = normalizeClaudeMessage({ type: "system", subtype: "task_progress", uuid: "tp1", timestamp: at(4), task_id: "ada2b9582caa230c5", tool_use_id: "toolu_013s2jZsDCiw3cAHYTqFeSpc", description: "List files and count them", usage: { total_tokens: 13122, tool_uses: 1, duration_ms: 4751 }, last_tool_name: "Bash" }, memory, "live", "57489e13");
    expect(progress.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:ada2b9582caa230c5", status: "running", progress: "Using Bash", usage: { totalTokens: 13122, toolUses: 1, durationMs: 4751 }, outputFile: spikeOutputFile, subagentType: "general-purpose" }) });
    const summarized = normalizeClaudeMessage({ type: "system", subtype: "task_progress", uuid: "tp2", timestamp: at(30), task_id: "ada2b9582caa230c5", tool_use_id: "toolu_013s2jZsDCiw3cAHYTqFeSpc", description: "List files and count them", usage: { total_tokens: 20000, tool_uses: 2, duration_ms: 30000 }, last_tool_name: "Read", summary: "Counting files in the working tree" }, memory, "live", "57489e13");
    expect(summarized.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ progress: "Counting files in the working tree", usage: { totalTokens: 20000, toolUses: 2, durationMs: 30000 } }) });
    const notified = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn1", timestamp: at(35), task_id: "ada2b9582caa230c5", tool_use_id: "toolu_013s2jZsDCiw3cAHYTqFeSpc", status: "completed", output_file: spikeOutputFile, summary: "There is **1 file** in the directory.", usage: { total_tokens: 21000, tool_uses: 2, duration_ms: 34000 } }, memory, "live", "57489e13");
    expect(notified.updates[0]).toEqual({ kind: "upsert", item: { id: "task:ada2b9582caa230c5", type: "background_task", createdAt: Date.parse(at(0)), taskId: "ada2b9582caa230c5", description: "List files and count them", taskType: "local_agent", toolUseId: "toolu_013s2jZsDCiw3cAHYTqFeSpc", status: "completed", summary: "There is **1 file** in the directory.", subagentType: "general-purpose", prompt: spikePrompt, usage: { totalTokens: 21000, toolUses: 2, durationMs: 34000 }, outputFile: spikeOutputFile, childConversationId: "sub:57489e13:ada2b9582caa230c5" } });
    // Without a session id there is no child id to derive; nothing else changes.
    const anonymous = createClaudeEventMemory();
    const unscoped = normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts2", timestamp: at(0), task_id: "b0b0", description: "Explore", subagent_type: "Explore", is_backgrounded: true, task_type: "local_agent" }, anonymous, "live");
    expect((unscoped.updates[0] as { item: object }).item).not.toHaveProperty("childConversationId");
  });

  test("a backgrounded shell command's output file is learned from its launch text, whichever wording the CLI used", () => {
    const outputFile = "/private/tmp/claude-501/-private-tmp-uatu-spike-work/57489e13/tasks/bgjpa5uwy.output";
    const launchText = `Command running in background with ID: bgjpa5uwy. Output is being written to: ${outputFile}. You will be notified when it completes.\nTo check interim output, use Read on that file path.`;
    const bashOutput = { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "bgjpa5uwy" };
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "assistant", uuid: "a1", timestamp: at(0), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01E1fJ", name: "Bash", input: { command: "sleep 25; echo spike-done", run_in_background: true } }] } }, memory, "live", "57489e13");
    normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: at(0), task_id: "bgjpa5uwy", tool_use_id: "toolu_01E1fJ", description: "sleep 25; echo spike-done", is_backgrounded: true, task_type: "local_bash" }, memory, "live", "57489e13");
    const launched = normalizeClaudeMessage({ type: "user", uuid: "u1", timestamp: at(0), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01E1fJ", content: launchText }] }, tool_use_result: bashOutput }, memory, "live", "57489e13");
    expect(launched.updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "tool:toolu_01E1fJ", name: "Bash", status: "completed" }) },
      { kind: "upsert", item: { id: "task:bgjpa5uwy", type: "background_task", createdAt: Date.parse(at(0)), taskId: "bgjpa5uwy", description: "sleep 25; echo spike-done", taskType: "local_bash", toolUseId: "toolu_01E1fJ", status: "running", outputFile } },
    ]);
    expect((launched.updates[0] as { item: object }).item).not.toHaveProperty("childConversationId");
    // The notification only confirms the path; the row keeps it.
    const notified = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn1", timestamp: at(25), task_id: "bgjpa5uwy", tool_use_id: "toolu_01E1fJ", status: "completed", output_file: outputFile, summary: "Background command \"sleep 25; echo spike-done\" completed (exit code 0)" }, memory, "live", "57489e13");
    expect(notified.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:bgjpa5uwy", status: "completed", outputFile }) });
    // A command moved to the background on timeout says it differently but
    // names the file the same way; content as text blocks reads the same.
    const moved = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts2", timestamp: at(0), task_id: "bgq1w2e3r", tool_use_id: "toolu_02", description: "make test", is_backgrounded: true, task_type: "local_bash" }, moved, "live");
    const timedOut = normalizeClaudeMessage({ type: "user", uuid: "u2", timestamp: at(120), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02", content: [{ type: "text", text: "Command did not complete within its 120s timeout and was moved to the background (ID: bgq1w2e3r). Output is being written to: /tmp/claude-501/-work/s/tasks/bgq1w2e3r.output. You will be notified when it completes." }] }] }, tool_use_result: { ...bashOutput, backgroundTaskId: "bgq1w2e3r" } }, moved, "live");
    expect(timedOut.updates.at(-1)).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:bgq1w2e3r", status: "running", outputFile: "/tmp/claude-501/-work/s/tasks/bgq1w2e3r.output" }) });
    // A launch result that beats its start edge says nothing yet; the edge
    // then names the task and carries the file.
    const early = createClaudeEventMemory();
    const silent = normalizeClaudeMessage({ type: "user", uuid: "u3", timestamp: at(0), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_03", content: launchText.replaceAll("bgjpa5uwy", "bgearly01") }] }, tool_use_result: { ...bashOutput, backgroundTaskId: "bgearly01" } }, early, "live");
    expect(silent.updates.map(update => update.kind === "upsert" ? update.item.type : update.kind)).toEqual(["tool"]);
    const late = normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts3", timestamp: at(0), task_id: "bgearly01", tool_use_id: "toolu_03", description: "late job", is_backgrounded: true, task_type: "local_bash" }, early, "live");
    expect(late.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:bgearly01", description: "late job", outputFile: outputFile.replace("bgjpa5uwy", "bgearly01") }) });
    // A result without the sentence changes nothing.
    const plain = normalizeClaudeMessage({ type: "user", uuid: "u4", timestamp: at(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_03", content: "done" }] }, tool_use_result: { ...bashOutput, backgroundTaskId: "bgearly01" } }, early, "live");
    expect(plain.updates).toHaveLength(1);
  });

  test("a launch result's output file is the one the CLI's own last sentence names for that task", () => {
    const real = "/private/tmp/claude-501/-work/57489e13/tasks/bgq1w2e3r.output";
    const bashOutput = { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "bgq1w2e3r" };
    const launch = (memory: ReturnType<typeof createClaudeEventMemory>, text: string) => {
      normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts", timestamp: at(0), task_id: "bgq1w2e3r", tool_use_id: "toolu_02", description: "make test", is_backgrounded: true, task_type: "local_bash" }, memory, "live");
      return normalizeClaudeMessage({ type: "user", uuid: "u", timestamp: at(120), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02", content: text }] }, tool_use_result: bashOutput }, memory, "live");
    };
    // The command's own stdout comes first and imitates the sentence; the
    // CLI appends its real one after it, and that is the one that counts.
    const decoyed = launch(createClaudeEventMemory(), `building…\nOutput is being written to: /tmp/evil/tasks/bgq1w2e3r.output. ok\nCommand did not complete within its 120s timeout and was moved to the background (ID: bgq1w2e3r). Output is being written to: ${real}. You will be notified when it completes.`);
    expect(decoyed.updates.at(-1)).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:bgq1w2e3r", outputFile: real }) });
    // A sentence naming another task's file is not this task's.
    const foreign = launch(createClaudeEventMemory(), "Command running in background with ID: bgq1w2e3r. Output is being written to: /private/tmp/claude-501/-work/57489e13/tasks/bgzzzzzzz.output. You will be notified when it completes.");
    expect(foreign.updates.every(update => update.kind !== "upsert" || update.item.type !== "background_task" || update.item.outputFile === undefined)).toBe(true);
    // The CLI's other wordings still parse: manually backgrounded, and moved
    // so a message can reach the agent.
    for (const text of [
      `Command was manually backgrounded by user with ID: bgq1w2e3r. Output is being written to: ${real}.`,
      `Command was moved to the background so that a message from the user can reach you (ID: bgq1w2e3r). Output is being written to: ${real}. You will be notified when it completes.`,
    ]) {
      expect(launch(createClaudeEventMemory(), text).updates.at(-1)).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:bgq1w2e3r", outputFile: real }) });
    }
  });

  test("a subagent's forwarded text and thinking stay out of the parent's timeline; its tool blocks land as before", () => {
    const memory = createClaudeEventMemory();
    const frame = (uuid: string, content: unknown[]) => ({ type: "assistant", uuid, timestamp: at(1), parent_tool_use_id: "toolu_013s2jZsDCiw3cAHYTqFeSpc", message: { role: "assistant", model: "claude-haiku-4-5-20251001", content } });
    const mixed = normalizeClaudeMessage(frame("sub1", [{ type: "thinking", thinking: "Let me list the files." }, { type: "text", text: "Listing now." }, { type: "tool_use", id: "toolu_inner", name: "Bash", input: { command: "ls" } }]), memory, "live", "57489e13");
    expect(mixed.outcome).toBe("handled");
    expect(mixed.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ id: "tool:toolu_inner", type: "tool", name: "Bash", status: "running" }) }]);
    const textOnly = normalizeClaudeMessage(frame("sub2", [{ type: "text", text: "There is 1 file." }]), memory, "live", "57489e13");
    expect(textOnly.outcome).toBe("ignored");
    expect(textOnly.updates).toEqual([]);
    // The subagent's own tool result still completes the row it opened.
    const result = normalizeClaudeMessage({ type: "user", uuid: "sub3", timestamp: at(2), parent_tool_use_id: "toolu_013s2jZsDCiw3cAHYTqFeSpc", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_inner", content: "README.md" }] }, tool_use_result: null }, memory, "live", "57489e13");
    expect(result.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ id: "tool:toolu_inner", status: "completed", output: "README.md" }) }]);
  });

  test("failure, stop, and a killed patch settle the row with their outcome", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: at(0), task_id: "f1", description: "Flaky job", is_backgrounded: true }, memory, "live");
    const failed = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn1", timestamp: at(5), task_id: "f1", status: "failed", output_file: "/tmp/f", summary: "exit 1" }, memory, "live");
    expect(failed.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:f1", status: "failed", summary: "exit 1" }) });
    normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts2", timestamp: at(0), task_id: "s1", description: "Long job", is_backgrounded: true }, memory, "live");
    const stopped = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn2", timestamp: at(5), task_id: "s1", status: "stopped", output_file: "/tmp/s", summary: "" }, memory, "live");
    expect(stopped.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:s1", status: "stopped" }) });
    const killed = normalizeClaudeMessage({ type: "system", subtype: "task_updated", uuid: "tu1", timestamp: at(6), task_id: "s1", patch: { status: "killed", end_time: 1 } }, memory, "live");
    expect(killed.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:s1", status: "stopped" }) });
    // A notification for a task never known to run in the background is
    // not a row; one the level signal named is, even without a start edge.
    const orphan = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn3", timestamp: at(9), task_id: "o1", status: "completed", output_file: "/tmp/o", summary: "ok" }, memory, "live");
    expect(orphan.outcome).toBe("ignored");
    markTasksBackgrounded(memory, [{ taskId: "o2", description: "Named by the level", taskType: "local_bash" }], Date.parse(at(8)));
    const named = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn4", timestamp: at(9), task_id: "o2", status: "completed", output_file: "/tmp/o", summary: "ok" }, memory, "live");
    expect(named.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:o2", description: "Named by the level", taskType: "local_bash", createdAt: Date.parse(at(8)), status: "completed", summary: "ok" }) });
  });

  test("foreground work is never a background row until the agent sends it to the background", () => {
    const memory = createClaudeEventMemory();
    // A blocking subagent: start, progress, and completion edges with the
    // flag unset stay silent — its tool row already shows the work.
    const start = normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: at(0), task_id: "fg", tool_use_id: "toolu_task", description: "Explore the repo", task_type: "local_agent", subagent_type: "Explore", is_backgrounded: false }, memory, "live");
    expect(start.outcome).toBe("ignored");
    expect(normalizeClaudeMessage({ type: "system", subtype: "task_progress", uuid: "tp1", timestamp: at(1), task_id: "fg", description: "Explore the repo", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }, memory, "live").outcome).toBe("ignored");
    // Moved to the background (Ctrl+B): from here it is a background task,
    // linked to the tool use that launched it.
    const promoted = normalizeClaudeMessage({ type: "system", subtype: "task_updated", uuid: "tu1", timestamp: at(2), task_id: "fg", patch: { is_backgrounded: true } }, memory, "live");
    expect(promoted.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:fg", description: "Explore the repo", taskType: "local_agent", toolUseId: "toolu_task", status: "running", createdAt: Date.parse(at(0)) }) });
    const done = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn1", timestamp: at(5), task_id: "fg", status: "completed", output_file: "/tmp/o", summary: "found it" }, memory, "live");
    expect(done.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:fg", status: "completed", summary: "found it" }) });
    // A foreground task that completes in the foreground never shows.
    normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts2", timestamp: at(6), task_id: "fg2", description: "Quick check", is_backgrounded: false }, memory, "live");
    expect(normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn2", timestamp: at(7), task_id: "fg2", status: "completed", output_file: "/tmp/o", summary: "ok" }, memory, "live").outcome).toBe("ignored");
  });

  // Spike probe c, shapes verbatim: a foreground agent gets the same
  // task_started as a backgrounded one, with `is_backgrounded: false`.
  test("a foreground agent run opens its launching row at task_started, not only when the run ends", () => {
    const memory = createClaudeEventMemory();
    const agentId = "adcea0e635b291813";
    normalizeClaudeMessage({ type: "assistant", uuid: "a1", timestamp: at(0), message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: "toolu_fg", name: "Agent", input: { description: "List files and count them", prompt: spikePrompt } }] } }, memory, "live", "57489e13");
    const started = normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: at(0), task_id: agentId, tool_use_id: "toolu_fg", description: "List files and count them", subagent_type: "general-purpose", is_backgrounded: false, spawn_depth: 1, task_type: "local_agent", prompt: spikePrompt }, memory, "live", "57489e13");
    // No background row — the run is in the foreground, and its tool row
    // already shows the work — but that row is now openable, which is what
    // makes a running subagent reachable from the track before it finishes.
    expect(started.outcome).toBe("handled");
    expect(started.updates).toEqual([{ kind: "upsert", item: {
      id: "tool:toolu_fg", type: "tool", createdAt: Date.parse(at(0)), name: "Agent", status: "running",
      input: JSON.stringify({ description: "List files and count them", prompt: spikePrompt }, null, 1),
      childConversationId: `sub:57489e13:${agentId}`,
    } }]);
    // The result at the end of the run still carries the row's attribution,
    // and the child id survives the re-upsert.
    const result = normalizeClaudeMessage({ type: "user", uuid: "u1", timestamp: at(9), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: "There is 1 file." }] },
      tool_use_result: { agentId, agentType: "general-purpose", content: "There is 1 file.", resolvedModel: "claude-haiku-4-5-20251001" } }, memory, "live", "57489e13");
    expect(result.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "tool:toolu_fg", name: "Agent", status: "completed", childConversationId: `sub:57489e13:${agentId}`, model: "claude-haiku-4-5-20251001" }) });
    // A tool use this normalizer never saw gets no invented row: an upsert
    // replaces the item, and a bare row would be a tool call with no name.
    const blind = createClaudeEventMemory();
    const orphan = normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts2", timestamp: at(0), task_id: agentId, tool_use_id: "toolu_unseen", description: "List files and count them", subagent_type: "general-purpose", is_backgrounded: false, task_type: "local_agent" }, blind, "live", "57489e13");
    expect(orphan.updates).toEqual([]);
    expect(orphan.outcome).toBe("ignored");
  });

  test("ambient housekeeping tasks never become rows, start to finish", () => {
    const memory = createClaudeEventMemory();
    const started = normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: at(0), task_id: "amb", description: "Live update watcher", ambient: true, skip_transcript: true }, memory, "live");
    expect(started.outcome).toBe("ignored");
    expect(started.updates).toEqual([]);
    // Later edges omit the flag; the remembered id keeps them out.
    const progress = normalizeClaudeMessage({ type: "system", subtype: "task_progress", uuid: "tp1", timestamp: at(1), task_id: "amb", description: "Live update watcher", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 } }, memory, "live");
    expect(progress.outcome).toBe("ignored");
    const notified = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: "tn1", timestamp: at(2), task_id: "amb", status: "completed", output_file: "/tmp/a", summary: "x", ambient: true }, memory, "live");
    expect(notified.outcome).toBe("ignored");
  });

  test("a tool progress heartbeat gives the running tool row an elapsed time; reasoning rows are unaffected", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "assistant", uuid: "a1", timestamp: at(0), message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "thinking", thinking: "hmm" }, { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "sleep 30" } }] } }, memory, "live");
    const heartbeat = normalizeClaudeMessage({ type: "tool_progress", uuid: "hb1", timestamp: at(12), tool_use_id: "toolu_9", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 12.4, heartbeat: true }, memory, "live");
    expect(heartbeat.outcome).toBe("handled");
    expect(heartbeat.updates).toEqual([{ kind: "upsert", item: { id: "tool:toolu_9", type: "tool", createdAt: Date.parse(at(0)), name: "Bash", status: "running", input: JSON.stringify({ command: "sleep 30" }, null, 1), elapsedMs: 12_400 } }]);
    expect(heartbeat.updates.some(update => update.kind === "upsert" && update.item.type === "reasoning")).toBe(false);
    // Unknown tool ids (a subagent's inner tool) are ignored, not invented.
    expect(normalizeClaudeMessage({ type: "tool_progress", uuid: "hb2", timestamp: at(13), tool_use_id: "toolu_unknown", tool_name: "Read", parent_tool_use_id: "toolu_9", elapsed_time_seconds: 1 }, memory, "live").outcome).toBe("ignored");
  });
});

describe("streaming and session signals (D10, D11)", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 2, 11, 0, seconds)).toISOString();
  const stream = (uuid: string, seconds: number, event: Record<string, unknown>) => ({ type: "stream_event", uuid, timestamp: at(seconds), parent_tool_use_id: null, event });

  test("text deltas grow one item in place and the completed block replaces it with the final text", () => {
    const memory = createClaudeEventMemory();
    const started = normalizeClaudeMessage(stream("s1", 0, { type: "message_start", message: { id: "msg_1" } }), memory, "live");
    expect(started.outcome).toBe("ignored");
    const opened = normalizeClaudeMessage(stream("s2", 0, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), memory, "live");
    expect(opened.updates).toEqual([{ kind: "upsert", item: { id: "message:stream:msg_1:0", type: "assistant_message", createdAt: Date.parse(at(0)), markdown: "" } }]);
    const first = normalizeClaudeMessage(stream("s3", 1, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Autumn brings" } }), memory, "live");
    const second = normalizeClaudeMessage(stream("s4", 1, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " a crisp chill." } }), memory, "live");
    expect(first.updates).toEqual([{ kind: "text", itemId: "message:stream:msg_1:0", identity: "message:stream:msg_1:0", mode: "incremental", text: "Autumn brings", item: { id: "message:stream:msg_1:0", type: "assistant_message", createdAt: Date.parse(at(0)), markdown: "" } }]);
    expect(second.updates[0]).toEqual(expect.objectContaining({ kind: "text", itemId: "message:stream:msg_1:0", text: " a crisp chill." }));
    // Thinking deltas and a subagent's stream stay out.
    expect(normalizeClaudeMessage(stream("s5", 1, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }), memory, "live").outcome).toBe("ignored");
    expect(normalizeClaudeMessage({ ...stream("s6", 1, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }), parent_tool_use_id: "toolu_sub" }, memory, "live").outcome).toBe("ignored");
    // The completed block: the streamed item goes, the final one lands.
    const completed = normalizeClaudeMessage({ type: "assistant", uuid: "a1", timestamp: at(2), message: { id: "msg_1", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Autumn brings a crisp chill." }], usage: { input_tokens: 5, output_tokens: 9 } } }, memory, "live");
    expect(completed.updates[0]).toEqual({ kind: "remove", itemId: "message:stream:msg_1:0" });
    expect(completed.updates[1]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "message:a1", type: "assistant_message", markdown: "Autumn brings a crisp chill." }) });
    // A second text block of the same API message consumes the next streamed index.
    normalizeClaudeMessage(stream("s7", 3, { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }), memory, "live");
    const next = normalizeClaudeMessage({ type: "assistant", uuid: "a2", timestamp: at(4), message: { id: "msg_1", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Second." }] } }, memory, "live");
    expect(next.updates[0]).toEqual({ kind: "remove", itemId: "message:stream:msg_1:2" });
    // Without a stream (partial messages off), nothing is removed.
    const plain = normalizeClaudeMessage({ type: "assistant", uuid: "a3", timestamp: at(5), message: { id: "msg_other", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Plain." }] } }, memory, "live");
    expect(plain.updates.some(update => update.kind === "remove")).toBe(false);
  });

  test("a retry names its state and returns to working when the turn resumes; compaction likewise", () => {
    const memory = createClaudeEventMemory();
    const retry = normalizeClaudeMessage({ type: "system", subtype: "api_retry", uuid: "r1", timestamp: at(0), attempt: 2, max_retries: 10, retry_delay_ms: 2000, error_status: 529, error: "overloaded" }, memory, "live");
    expect(retry.updates).toEqual([{ kind: "status", status: "retrying", message: "attempt 2 of 10, HTTP 529" }]);
    const resumed = normalizeClaudeMessage(stream("s1", 3, { type: "message_start", message: { id: "msg_2" } }), memory, "live");
    expect(resumed.updates).toEqual([{ kind: "status", status: "running" }]);
    const compacting = normalizeClaudeMessage({ type: "system", subtype: "status", uuid: "st1", timestamp: at(4), status: "compacting" }, memory, "live");
    expect(compacting.updates).toEqual([{ kind: "status", status: "compacting" }]);
    const done = normalizeClaudeMessage({ type: "system", subtype: "status", uuid: "st2", timestamp: at(6), status: null, compact_result: "success" }, memory, "live");
    expect(done.updates).toEqual([{ kind: "status", status: "running" }]);
    const failed = normalizeClaudeMessage({ type: "system", subtype: "status", uuid: "st3", timestamp: at(7), status: null, compact_result: "failed", compact_error: "too large" }, memory, "live");
    expect(failed.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ type: "notice", level: "warning", message: "Context compaction failed: too large." }) }]);
    // An assistant message also resumes a pending retry.
    normalizeClaudeMessage({ type: "system", subtype: "api_retry", uuid: "r2", timestamp: at(8), attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: null, error: "x" }, memory, "live");
    const message = normalizeClaudeMessage({ type: "assistant", uuid: "a9", timestamp: at(9), message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "back" }] } }, memory, "live");
    expect(message.updates[0]).toEqual({ kind: "status", status: "running" });
  });

  test("a retry abandons the open stream, and a result ends any transient state", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage(stream("s1", 0, { type: "message_start", message: { id: "msg_A" } }), memory, "live");
    normalizeClaudeMessage(stream("s2", 0, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), memory, "live");
    normalizeClaudeMessage(stream("s3", 1, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The build fails because" } }), memory, "live");
    // The retried request streams under a new message id: msg_A's open
    // block is never completed, so the retry removes it.
    const retry = normalizeClaudeMessage({ type: "system", subtype: "api_retry", uuid: "r1", timestamp: at(2), attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: 529, error: "overloaded" }, memory, "live");
    expect(retry.updates).toEqual([{ kind: "remove", itemId: "message:stream:msg_A:0" }, { kind: "status", status: "retrying", message: "attempt 1 of 3, HTTP 529" }]);
    expect(memory.streams.has("msg_A")).toBe(false);
    // Retries exhausted: the failed result ends the retrying state, and the
    // next frame does not "resume" a turn that is over.
    normalizeClaudeMessage({ type: "result", subtype: "error_during_execution", uuid: "res1", timestamp: at(3), is_error: true, errors: ["overloaded"] }, memory, "live");
    const later = normalizeClaudeMessage({ type: "assistant", uuid: "a2", timestamp: at(4), message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "hi" }] } }, memory, "live");
    expect(later.updates.some(update => update.kind === "status")).toBe(false);
  });

  test("a refusal's retracted messages and a superseding frame evict the refused leg", () => {
    const memory = createClaudeEventMemory();
    const fallback = normalizeClaudeMessage({ type: "system", subtype: "model_refusal_fallback", uuid: "mf1", timestamp: at(0), trigger: "refusal", direction: "retry", scope: "session", original_model: "claude-opus-5", fallback_model: "claude-sonnet-5", request_id: null, retracted_message_uuids: ["a1", ""], content: "…" }, memory, "live");
    expect(fallback.updates[0]).toEqual({ kind: "remove", itemId: "message:a1" });
    expect(fallback.updates[1]).toEqual({ kind: "upsert", item: expect.objectContaining({ code: "refusal-fallback" }) });
    const replacement = normalizeClaudeMessage({ type: "assistant", uuid: "a2", timestamp: at(1), supersedes: ["a1"], message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Here is a safer answer." }] } }, memory, "live");
    expect(replacement.updates[0]).toEqual({ kind: "remove", itemId: "message:a1" });
    // A refused leg that reasoned and called a tool: every row the frames
    // minted goes, not only the text.
    normalizeClaudeMessage({ type: "assistant", uuid: "a3", timestamp: at(2), message: { role: "assistant", model: "claude-opus-5", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } }] } }, memory, "live");
    normalizeClaudeMessage({ type: "user", uuid: "u3", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "files" }] } }, memory, "live");
    const retracted = normalizeClaudeMessage({ type: "system", subtype: "model_refusal_fallback", uuid: "mf2", timestamp: at(4), trigger: "refusal", direction: "retry", scope: "session", original_model: "claude-opus-5", fallback_model: "claude-sonnet-5", request_id: null, retracted_message_uuids: ["a3", "u3"], content: "" }, memory, "live");
    const removed = retracted.updates.filter(update => update.kind === "remove").map(update => (update as { itemId: string }).itemId);
    expect(removed).toEqual(expect.arrayContaining(["message:a3", "reasoning:a3:0", "tool:toolu_x"]));
    expect(removed.length).toBe(3);
  });

  test("a rate limit is one standing with its onset, updated in place and retired when allowed", () => {
    const memory = createClaudeEventMemory();
    const warning = normalizeClaudeMessage({ type: "rate_limit_event", uuid: "rl1", timestamp: at(0), rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.87, resetsAt: 1_788_400_000 } }, memory, "live");
    expect(warning.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "notice:rate-limit", type: "notice", createdAt: Date.parse(at(0)), level: "warning", code: "rate-limit-warning", resetsAt: 1_788_400_000_000 }) });
    expect((warning.updates[0] as { item: { message: string } }).item.message).toBe("Approaching your 5-hour rate limit (87% used).");
    // Restating one standing is not news: the same item, at the same onset.
    const restated = normalizeClaudeMessage({ type: "rate_limit_event", uuid: "rl1b", timestamp: at(9), rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.88 } }, memory, "live");
    expect(restated.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ id: "notice:rate-limit", createdAt: Date.parse(at(0)), code: "rate-limit-warning" }) }]);
    // Hardening to a rejection updates that same item, still at its onset.
    const rejected = normalizeClaudeMessage({ type: "rate_limit_event", uuid: "rl2", timestamp: at(1), rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_788_400_000_000 } }, memory, "live");
    expect(rejected.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "notice:rate-limit", createdAt: Date.parse(at(0)), level: "error", code: "rate-limit-rejected", resetsAt: 1_788_400_000_000 }) });
    expect((rejected.updates[0] as { item: { message: string } }).item.message).toBe("Rate limit reached for your 7-day window.");
    // Allowed again retires the standing rather than appending a third row.
    const allowed = normalizeClaudeMessage({ type: "rate_limit_event", uuid: "rl3", timestamp: at(2), rate_limit_info: { status: "allowed" } }, memory, "live");
    expect(allowed.updates).toEqual([{ kind: "remove", itemId: "notice:rate-limit" }]);
    // Routine allowed events with nothing to clear are silent.
    expect(normalizeClaudeMessage({ type: "rate_limit_event", uuid: "rl4", timestamp: at(3), rate_limit_info: { status: "allowed" } }, memory, "live").outcome).toBe("ignored");
    // A warning alone is a standing too: the next plain "allowed" retires it.
    normalizeClaudeMessage({ type: "rate_limit_event", uuid: "rl5", timestamp: at(4), rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 } }, memory, "live");
    expect(normalizeClaudeMessage({ type: "rate_limit_event", uuid: "rl6", timestamp: at(5), rate_limit_info: { status: "allowed" } }, memory, "live").updates).toEqual([{ kind: "remove", itemId: "notice:rate-limit" }]);
    // A fresh standing after a clear is a fresh onset.
    const reentered = normalizeClaudeMessage({ type: "rate_limit_event", uuid: "rl7", timestamp: at(6), rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91 } }, memory, "live");
    expect(reentered.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "notice:rate-limit", createdAt: Date.parse(at(6)) }) });
  });

  test("a refusal fallback re-attributes later usage to the fallback model and says so", () => {
    const memory = createClaudeEventMemory();
    memory.resolveModel = id => ({ "claude-sonnet-5": "sonnet", "claude-opus-5": "opus[1m]" } as Record<string, string>)[id] ?? id;
    normalizeClaudeMessage({ type: "system", subtype: "init", uuid: "i1", model: "claude-opus-5" }, memory, "live");
    const fallback = normalizeClaudeMessage({ type: "system", subtype: "model_refusal_fallback", uuid: "mf1", timestamp: at(0), trigger: "refusal", direction: "retry", scope: "session", original_model: "claude-opus-5", fallback_model: "claude-sonnet-5", request_id: null, api_refusal_category: "cyber", content: "…" }, memory, "live");
    expect(fallback.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ type: "notice", level: "warning", code: "refusal-fallback", message: "claude-opus-5 declined this request (cyber); the turn continues on claude-sonnet-5." }) }]);
    expect(memory.lastModel).toBe("sonnet");
    // Usage that follows without naming a model is the fallback's.
    const later = normalizeClaudeMessage({ type: "assistant", uuid: "a2", timestamp: at(1), message: { role: "assistant", content: [{ type: "text", text: "retried" }], usage: { input_tokens: 4, output_tokens: 1 } } }, memory, "live");
    expect(later.assistantModel?.model).toBe("sonnet");
    const carrier = later.updates.find(update => update.kind === "upsert" && update.item.type === "assistant_message" && update.item.markdown === "") as { item: { model?: { modelId: string } } };
    expect(carrier.item.model?.modelId).toBe("sonnet");
    // A subagent's local fallback leaves the session model alone.
    normalizeClaudeMessage({ type: "system", subtype: "model_refusal_fallback", uuid: "mf2", timestamp: at(2), trigger: "refusal", direction: "retry", scope: "local", original_model: "claude-sonnet-5", fallback_model: "claude-haiku-4-5-20251001", request_id: null, content: "" }, memory, "live");
    expect(memory.lastModel).toBe("sonnet");
  });

  test("recalled memories become a labelled reasoning-style row", () => {
    const memory = createClaudeEventMemory();
    const recalled = normalizeClaudeMessage({ type: "system", subtype: "memory_recall", uuid: "mr1", timestamp: at(0), mode: "select", memories: [
      { path: "/Users/x/.claude/projects/p/memory/ux-is-the-deliverable.md", scope: "personal" },
      { path: "<synthesis:team>", scope: "team", content: "The team prefers squash merges." },
    ] }, memory, "live");
    expect(recalled.updates).toEqual([{ kind: "upsert", item: { id: "memory:mr1", type: "reasoning", createdAt: Date.parse(at(0)), text: "[personal] /Users/x/.claude/projects/p/memory/ux-is-the-deliverable.md\n\n[team] <synthesis:team>\nThe team prefers squash merges.", status: "completed", label: "Recalled from memory" } }]);
    expect(normalizeClaudeMessage({ type: "system", subtype: "memory_recall", uuid: "mr2", timestamp: at(1), mode: "select", memories: [] }, memory, "live").outcome).toBe("ignored");
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

  test("Claude SDK permissions and successful results reach two devices with no page", async () => {
    const { provider, queries, workspace } = fixture();
    const session = await provider.createSession("notification-pipeline");
    const pipeline = await notificationPipeline(provider, workspace);
    try {
      await provider.prompt(session.id, { id: "turn", text: "work", delivery: "queue" });
      const decision = queries[0]!.input.options.canUseTool!("Write", { file_path: path.join(workspace, "a.txt"), content: "x" }, { signal: new AbortController().signal, toolUseID: "permission" });
      await pipeline.waitForSends(2);
      await pipeline.restartHub();
      await provider.replyPermission(session.id, "permission", "once");
      await decision;
      queries[0]!.push({ type: "result", subtype: "success", uuid: "result", session_id: session.id, is_error: false });
      await pipeline.waitForSends(4);
      expect(pipeline.opens()).toBe(2);
      expect(pipeline.sent.map(send => send.payload.kind).sort()).toEqual(["permission-pending", "permission-pending", "turn-completed", "turn-completed"]);
      expect(pipeline.sent.every(send => send.payload.url.includes(encodeURIComponent(`claude:${session.id}`)))).toBe(true);
    } finally { await pipeline.dispose(); }
  });

  test("background work keeps the session alive past its result and reports the background state", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "run it in the background", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "init", uuid: "i1", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_bash", description: "Sleep then echo" }, { task_id: "amb", task_type: "local_watch", description: "Watcher", ambient: true }] });
    query.push({ type: "system", subtype: "task_started", uuid: "ts1", session_id: session.id, timestamp: "2026-09-02T10:00:03.000Z", task_id: "b1", tool_use_id: "toolu_1", description: "Sleep then echo", task_type: "local_bash", is_backgrounded: true });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    // Not retired: the process is up for the task; the composer state says so.
    expect(provider.liveSessionCount()).toBe(1);
    expect(query.returned).toBe(false);
    const statuses = events.flatMap(event => event.updates).filter(update => update.kind === "status").map(update => (update as { status: string }).status);
    expect(statuses).toEqual(["running", "completed", "background"]);
    expect(events.flatMap(event => event.notificationTurns ?? []).map(turn => [turn.sourceId, turn.phase])).toEqual([["r1", "started"], ["r1", "background"]]);
    // Ambient ids stay out of the live list; the real task is listed.
    expect(await provider.listBackgroundTasks()).toEqual([expect.objectContaining({ conversationId: session.id, taskId: "b1", description: "Sleep then echo", taskType: "local_bash", toolUseId: "toolu_1" })]);
    // Prompting is still possible on the live session.
    await provider.prompt(session.id, { id: "r2", text: "meanwhile", delivery: "queue" });
    expect(queries).toHaveLength(1);
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:07.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "turn.background").length === 2);
    expect(provider.liveSessionCount()).toBe(1);
    stop();
    await provider.dispose();
  });

  test("the query asks for progress summaries and subagent text, and a task's facts reach the live list and the output read", async () => {
    const { provider, queries, workspace } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "run it in the background", delivery: "queue" });
    const query = queries[0]!;
    expect(query.input.options.agentProgressSummaries).toBe(true);
    expect(query.input.options.forwardSubagentText).toBe(true);
    // The CLI's own layout: <root>/tasks/<taskId>.output, with interim output.
    const tasksDir = path.join(workspace, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "bgjpa5uwy.output");
    writeFileSync(outputFile, "line one\nline two\n");
    query.push({ type: "system", subtype: "init", uuid: "i1", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    query.push({ type: "assistant", uuid: "a1", session_id: session.id, timestamp: "2026-09-02T10:00:02.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01E1fJ", name: "Bash", input: { command: "sleep 25; echo spike-done", run_in_background: true } }] } });
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "bgjpa5uwy", task_type: "local_bash", description: "sleep 25; echo spike-done" }] });
    query.push({ type: "system", subtype: "task_started", uuid: "ts1", session_id: session.id, timestamp: "2026-09-02T10:00:03.000Z", task_id: "bgjpa5uwy", tool_use_id: "toolu_01E1fJ", description: "sleep 25; echo spike-done", task_type: "local_bash", is_backgrounded: true });
    query.push({ type: "user", uuid: "u1", session_id: session.id, timestamp: "2026-09-02T10:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01E1fJ", content: `Command running in background with ID: bgjpa5uwy. Output is being written to: ${outputFile}. You will be notified when it completes.` }] }, tool_use_result: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "bgjpa5uwy" } });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.outputFile === outputFile)));
    expect(await provider.listBackgroundTasks()).toEqual([expect.objectContaining({ conversationId: session.id, taskId: "bgjpa5uwy", taskType: "local_bash", toolUseId: "toolu_01E1fJ", outputFile })]);
    // The tail is read from the end, bounded, and says the task still runs.
    expect(await provider.taskOutput(session.id, "bgjpa5uwy", { tailBytes: 9 })).toEqual({ text: "line two\n", truncated: true, settled: false });
    expect(await provider.taskOutput(session.id, "bgjpa5uwy", { tailBytes: 1024 })).toEqual({ text: "line one\nline two\n", truncated: false, settled: false });
    // More output while running is what the next refresh sees.
    appendFileSync(outputFile, "spike-done\n[exited with code 0]");
    expect((await provider.taskOutput(session.id, "bgjpa5uwy", { tailBytes: 1024 }))?.text).toBe("line one\nline two\nspike-done\n[exited with code 0]");
    // Unknown task, or a task whose file is not yet named: nothing to read.
    expect(await provider.taskOutput(session.id, "nope", { tailBytes: 1024 })).toBeNull();
    expect(await provider.taskOutput("other-session", "bgjpa5uwy", { tailBytes: 1024 })).toBeNull();
    // A named path that does not resolve to tasks/<taskId>.output is refused:
    // an agent task's "output" is a symlink to its subagent transcript.
    const subagentsDir = path.join(workspace, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(path.join(subagentsDir, "agent-ada2b9582caa230c5.jsonl"), "{}\n");
    symlinkSync(path.join(subagentsDir, "agent-ada2b9582caa230c5.jsonl"), path.join(tasksDir, "ada2b9582caa230c5.output"));
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg2", session_id: session.id, tasks: [{ task_id: "bgjpa5uwy", task_type: "local_bash", description: "sleep 25; echo spike-done" }, { task_id: "ada2b9582caa230c5", task_type: "local_agent", description: "List files" }] });
    query.push({ type: "system", subtype: "task_started", uuid: "ts2", session_id: session.id, timestamp: "2026-09-02T10:00:04.000Z", task_id: "ada2b9582caa230c5", tool_use_id: "toolu_agent", description: "List files", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent", prompt: "List the files" });
    query.push({ type: "system", subtype: "task_notification", uuid: "tn0", session_id: session.id, timestamp: "2026-09-02T10:00:05.000Z", task_id: "ada2b9582caa230c5", tool_use_id: "toolu_agent", status: "completed", output_file: path.join(tasksDir, "ada2b9582caa230c5.output"), summary: "1 file" });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === "ada2b9582caa230c5" && update.item.status === "completed")));
    expect(await provider.taskOutput(session.id, "ada2b9582caa230c5", { tailBytes: 1024 })).toBeNull();
    // A path the CLI named elsewhere (not the tasks layout) is refused too.
    mkdirSync(path.join(workspace, "elsewhere"), { recursive: true });
    writeFileSync(path.join(workspace, "elsewhere", "bgother.output"), "x");
    query.push({ type: "system", subtype: "task_started", uuid: "ts3", session_id: session.id, timestamp: "2026-09-02T10:00:06.000Z", task_id: "bgother", tool_use_id: "toolu_other", description: "other", task_type: "local_bash", is_backgrounded: true });
    query.push({ type: "user", uuid: "u2", session_id: session.id, timestamp: "2026-09-02T10:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_other", content: `Command running in background with ID: bgother. Output is being written to: ${path.join(workspace, "elsewhere", "bgother.output")}. You will be notified when it completes.` }] }, tool_use_result: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "bgother" } });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === "bgother" && update.item.outputFile !== undefined)));
    expect(await provider.taskOutput(session.id, "bgother", { tailBytes: 1024 })).toBeNull();
    // The shell task settles: the read still answers, and says so.
    query.push({ type: "system", subtype: "task_notification", uuid: "tn1", session_id: session.id, timestamp: "2026-09-02T10:00:30.000Z", task_id: "bgjpa5uwy", tool_use_id: "toolu_01E1fJ", status: "completed", output_file: outputFile, summary: "Background command completed (exit code 0)" });
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg3", session_id: session.id, tasks: [] });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === "bgjpa5uwy" && update.item.status === "completed")));
    expect(await provider.taskOutput(session.id, "bgjpa5uwy", { tailBytes: 12 })).toEqual({ text: "with code 0]", truncated: true, settled: true });
    stop();
    await provider.dispose();
  });

  // Hardening, not a reachable bug: the CLI's ids (a UUID, an alphanumeric
  // task id) hold no colon today, but the index must not depend on that.
  test("the output index keys a task by its session and id as a pair, whatever characters they hold", () => {
    expect(taskOutputKey("a:b", "c")).not.toBe(taskOutputKey("a", "b:c"));
    expect(taskOutputKey("8d4c5f1e-0b1a-4c2e-9f7a-1d2e3f4a5b6c", "bgjpa5uwy")).toBe(taskOutputKey("8d4c5f1e-0b1a-4c2e-9f7a-1d2e3f4a5b6c", "bgjpa5uwy"));
    expect(taskOutputKey("s", "t")).not.toBe(taskOutputKey("t", "s"));
  });

  test("a truncated output tail opens on a whole character", async () => {
    const { provider, queries, workspace } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "run it in the background", delivery: "queue" });
    const query = queries[0]!;
    const tasksDir = path.join(workspace, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "bgutf8abc.output");
    query.push({ type: "system", subtype: "init", uuid: "i1", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "bgutf8abc", task_type: "local_bash", description: "echo" }] });
    query.push({ type: "system", subtype: "task_started", uuid: "ts1", session_id: session.id, timestamp: "2026-09-02T10:00:03.000Z", task_id: "bgutf8abc", tool_use_id: "toolu_utf8", description: "echo", task_type: "local_bash", is_backgrounded: true });
    query.push({ type: "user", uuid: "u1", session_id: session.id, timestamp: "2026-09-02T10:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_utf8", content: `Command running in background with ID: bgutf8abc. Output is being written to: ${outputFile}. You will be notified when it completes.` }] }, tool_use_result: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "bgutf8abc" } });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.outputFile === outputFile)));
    // Two-byte characters, cut after the first byte of one: the split
    // character is dropped, the tail still says it is partial.
    writeFileSync(outputFile, "é".repeat(10));
    expect(await provider.taskOutput(session.id, "bgutf8abc", { tailBytes: 5 })).toEqual({ text: "éé", truncated: true, settled: false });
    // A four-byte emoji straddling the cut is dropped whole.
    writeFileSync(outputFile, "ab\u{1F600}cd");
    expect(await provider.taskOutput(session.id, "bgutf8abc", { tailBytes: 4 })).toEqual({ text: "cd", truncated: true, settled: false });
    // An ASCII tail is unchanged.
    writeFileSync(outputFile, "line one\nline two\n");
    expect(await provider.taskOutput(session.id, "bgutf8abc", { tailBytes: 9 })).toEqual({ text: "line two\n", truncated: true, settled: false });
    stop();
    await provider.dispose();
  });

  test("duplicate result frames leave the next accepted notification turn running", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("notification-queue");
    await provider.prompt(session.id, { id: "a", text: "one", delivery: "queue" });
    await provider.prompt(session.id, { id: "b", text: "two", delivery: "queue" });
    const result = { type: "result", subtype: "success", uuid: "result-a", session_id: session.id, is_error: false };
    queries[0]!.push(result);
    await waitFor(() => events.some(event => event.notificationTurns?.some(turn => turn.sourceId === "a" && turn.phase === "completed")));
    queries[0]!.push(result);
    queries[0]!.push({ ...result, uuid: "result-b" });
    await waitFor(() => events.some(event => event.notificationTurns?.some(turn => turn.sourceId === "b" && turn.phase === "completed")));
    expect(events.flatMap(event => event.notificationTurns ?? []).map(turn => [turn.sourceId, turn.phase])).toEqual([
      ["a", "started"], ["a", "completed"], ["b", "started"], ["b", "completed"],
    ]);
    stop();
    await provider.dispose();
  });

  test("a backgrounded subagent's frames and a fresh control session's init never start a turn", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "spawn", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "agent1", task_type: "local_agent", description: "Explore" }] });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    // The subagent keeps streaming on the same query, tagged with its parent
    // tool use: not the conversation's turn.
    query.push({ type: "assistant", uuid: "sub1", timestamp: "2026-09-02T10:00:06.000Z", session_id: session.id, parent_tool_use_id: "toolu_task", message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "exploring" }] } });
    await Bun.sleep(10);
    expect(events.some(event => event.eventType === "turn.unprompted")).toBe(false);
    // The agent settles and the set empties with no follow-up: idle, retired.
    query.push({ type: "system", subtype: "task_notification", uuid: "tn1", session_id: session.id, timestamp: "2026-09-02T10:00:08.000Z", task_id: "agent1", status: "completed", output_file: "/tmp/o", summary: "done" });
    stop();
    await provider.dispose();
  });

  // Design D8: a run known from its start edge streams into its own child
  // conversation; the parent's timeline keeps only the row that launched it.
  describe("subagent frames route to the child conversation", () => {
    const stamp = (seconds: number) => new Date(Date.UTC(2026, 8, 22, 12, 0, seconds)).toISOString();
    const AGENT_ID = "ada2b9582caa230c5";
    const LAUNCHER = "toolu_013s2jZsDCiw3cAHYTqFeSpc";
    const upsertIds = (events: NormalizedProviderEvent[], conversationId: string) =>
      events.filter(event => event.conversationId === conversationId).flatMap(event => event.updates).flatMap(update => update.kind === "upsert" ? [update.item.id] : []);
    // The run's own frames, tagged with the launching tool use as the CLI
    // forwards them (spike probe b): thinking + a tool call, a heartbeat,
    // the tool's result, then text.
    const runFrames = (sessionId: string, launcher: string) => {
      const tagged = { session_id: sessionId, parent_tool_use_id: launcher };
      return [
        { type: "assistant", uuid: "a202b083", timestamp: stamp(2), ...tagged, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "thinking", thinking: "Let me list the files." }, { type: "tool_use", id: "toolu_inner", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 10, output_tokens: 5 } } },
        { type: "tool_progress", uuid: "hb1", timestamp: stamp(3), ...tagged, tool_use_id: "toolu_inner", tool_name: "Bash", elapsed_time_seconds: 1.5 },
        { type: "user", uuid: "eb64650b", timestamp: stamp(3), ...tagged, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_inner", content: "README.md" }] }, tool_use_result: null },
        { type: "assistant", uuid: "f28f8ec7", timestamp: stamp(4), ...tagged, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "There is 1 file." }], usage: { input_tokens: 20, output_tokens: 8 } } },
      ];
    };

    test("a backgrounded agent's text, thinking, and tool frames reach its child; the parent keeps only its launching row", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      const childId = `sub:${session.id}:${AGENT_ID}`;
      await provider.prompt(session.id, { id: "r1", text: "spawn", delivery: "queue" });
      const query = queries[0]!;
      query.push({ type: "assistant", uuid: "launch", timestamp: stamp(1), session_id: session.id, parent_tool_use_id: null, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: LAUNCHER, name: "Agent", input: { description: "List files", prompt: "List the files", run_in_background: true } }] } });
      query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: AGENT_ID, task_type: "local_agent", description: "List files" }] });
      query.push({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: stamp(1), session_id: session.id, task_id: AGENT_ID, tool_use_id: LAUNCHER, description: "List files", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent", prompt: "List the files" });
      query.push({ type: "user", uuid: "launched", timestamp: stamp(1), session_id: session.id, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: LAUNCHER, content: "Async agent launched" }] }, tool_use_result: { isAsync: true, status: "async_launched", agentId: AGENT_ID, description: "List files", prompt: "List the files", outputFile: `/tmp/t/${AGENT_ID}.output` } });
      // The turn ends with the agent still running: the D9 situation, where
      // the run's frames must not read as a turn the CLI started by itself.
      query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: stamp(1), session_id: session.id, is_error: false });
      await waitFor(() => events.some(event => event.eventType === "turn.background"));
      for (const frame of runFrames(session.id, LAUNCHER)) query.push(frame);
      query.push({ type: "system", subtype: "task_progress", uuid: "tp1", timestamp: stamp(4), session_id: session.id, task_id: AGENT_ID, tool_use_id: LAUNCHER, usage: { total_tokens: 13122, tool_uses: 1, duration_ms: 4751 }, last_tool_name: "Bash" });
      query.push({ type: "system", subtype: "task_notification", uuid: "tn1", timestamp: stamp(5), session_id: session.id, task_id: AGENT_ID, tool_use_id: LAUNCHER, status: "completed", output_file: `/tmp/t/${AGENT_ID}.output`, summary: "There is 1 file." });
      await waitFor(() => events.some(event => event.conversationId === childId && event.updates.some(update => update.kind === "status" && update.status === "completed")));

      const childEvents = events.filter(event => event.conversationId === childId);
      const childUpdates = childEvents.flatMap(event => event.updates);
      // Running from the start edge, settled by the notification.
      expect(childUpdates[0]).toEqual({ kind: "status", status: "running" });
      expect(childUpdates.at(-1)).toEqual({ kind: "status", status: "completed" });
      const childItems = childUpdates.flatMap(update => update.kind === "upsert" ? [update.item] : []);
      expect(childItems.map(item => item.id)).toEqual(["reasoning:a202b083:0", "tool:toolu_inner", "usage:a202b083", "tool:toolu_inner", "tool:toolu_inner", "message:f28f8ec7", "usage:f28f8ec7"]);
      // The heartbeat found the tool in the child's own memory; the result
      // completed the row it opened.
      expect(childItems[3]).toEqual(expect.objectContaining({ type: "tool", status: "running", elapsedMs: 1500 }));
      expect(childItems[4]).toEqual(expect.objectContaining({ type: "tool", status: "completed", output: "README.md" }));
      expect(childItems[5]).toEqual(expect.objectContaining({ type: "assistant_message", markdown: "There is 1 file." }));
      // The routed events carry no attribution: the launching row's figure
      // comes from the tool result and the child transcript read, as before.
      expect(childEvents.every(event => event.assistantUsage === undefined && event.assistantModel === undefined)).toBe(true);
      // The parent: its launching row and the task row, nothing of the run.
      const parentIds = upsertIds(events, session.id);
      expect(parentIds).toContain(`tool:${LAUNCHER}`);
      expect(parentIds).toContain(`task:${AGENT_ID}`);
      expect(parentIds.filter(id => id.startsWith("reasoning:") || id === "tool:toolu_inner" || id === "message:f28f8ec7" || id === "usage:a202b083" || id === "usage:f28f8ec7")).toEqual([]);
      const launcher = events.filter(event => event.conversationId === session.id).flatMap(event => event.updates).flatMap(update => update.kind === "upsert" && update.item.id === `tool:${LAUNCHER}` ? [update.item] : []).at(-1);
      expect(launcher).toEqual(expect.objectContaining({ type: "tool", status: "completed", childConversationId: childId }));
      expect(events.some(event => event.eventType === "turn.unprompted")).toBe(false);
      // Live, the child is a session of its parent before the CLI has
      // written its transcript, and reads as empty rather than unknown.
      expect(await provider.getSession(childId)).toEqual(expect.objectContaining({ id: childId, parentId: session.id, title: "Subagent" }));
      expect((await provider.listMessages(childId, { limit: 50 })).items).toEqual([]);
      stop();
      await provider.dispose();
    });

    test("a live run is resolved from its own parent session, not by searching every live session's runs", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const first = await provider.createSession("x");
      const second = await provider.createSession("y");
      await provider.prompt(first.id, { id: "r1", text: "spawn", delivery: "queue" });
      await provider.prompt(second.id, { id: "r2", text: "spawn", delivery: "queue" });
      const runs = [[first.id, queries[0]!, "a1111111111111111"], [second.id, queries[1]!, "a2222222222222222"]] as const;
      for (const [sessionId, query, agentId] of runs) {
        query.push({ type: "system", subtype: "task_started", uuid: `ts-${agentId}`, timestamp: stamp(1), session_id: sessionId, task_id: agentId, description: "List files", subagent_type: "general-purpose", task_type: "local_agent", prompt: "List the files" });
      }
      const childOf = (sessionId: string, agentId: string) => `sub:${sessionId}:${agentId}`;
      for (const [sessionId, , agentId] of runs) {
        await waitFor(() => events.some(event => event.conversationId === childOf(sessionId, agentId) && event.eventType === "subagent.started"));
      }
      const internals = provider as unknown as {
        live: Map<string, { children: Map<string, unknown> }>;
        liveChild(id: string): { parentSessionId: string; child: { id: string } } | undefined;
      };
      // The first session's runs must not be consulted to find the second's.
      const firstRuns = internals.live.get(first.id)!.children;
      let consulted = 0;
      const values = firstRuns.values.bind(firstRuns);
      firstRuns.values = () => { consulted += 1; return values(); };
      const secondChild = childOf(second.id, runs[1][2]);
      expect(internals.liveChild(secondChild)).toEqual({ parentSessionId: second.id, child: expect.objectContaining({ id: secondChild }) });
      expect(consulted).toBe(0);
      expect(await provider.getSession(secondChild)).toEqual(expect.objectContaining({ id: secondChild, parentId: second.id }));
      firstRuns.values = values;
      expect(internals.liveChild(childOf(first.id, runs[0][2]))?.parentSessionId).toBe(first.id);
      // Malformed, of an unknown session, or of a run the session never
      // started: none of them names a live run.
      expect(internals.liveChild(`sub:${first.id}`)).toBeUndefined();
      expect(internals.liveChild(`${first.id}:${runs[0][2]}`)).toBeUndefined();
      expect(internals.liveChild(`sub:${first.id}:${runs[0][2]}:extra`)).toBeUndefined();
      expect(internals.liveChild(childOf("00000000-0000-0000-0000-000000000000", runs[0][2]))).toBeUndefined();
      expect(internals.liveChild(childOf(first.id, runs[1][2]))).toBeUndefined();
      stop();
      await provider.dispose();
    });

    test("a foreground agent routes the same way and settles on its sync result; the launching row keeps the result's attribution", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      const agentId = "adcea0e635b291813";
      const childId = `sub:${session.id}:${agentId}`;
      await provider.prompt(session.id, { id: "r1", text: "spawn", delivery: "queue" });
      const query = queries[0]!;
      query.push({ type: "assistant", uuid: "launch", timestamp: stamp(1), session_id: session.id, parent_tool_use_id: null, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: "toolu_fg", name: "Agent", input: { description: "List files", prompt: "List the files" } }] } });
      query.push({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: stamp(1), session_id: session.id, task_id: agentId, tool_use_id: "toolu_fg", description: "List files", subagent_type: "general-purpose", is_backgrounded: false, task_type: "local_agent", prompt: "List the files" });
      for (const frame of runFrames(session.id, "toolu_fg")) query.push(frame);
      await waitFor(() => upsertIds(events, childId).includes("message:f28f8ec7"));
      expect(events.filter(event => event.conversationId === childId).flatMap(event => event.updates)[0]).toEqual({ kind: "status", status: "running" });
      // No task frames this time (an older CLI): the sync result ends the run.
      query.push({ type: "user", uuid: "done", timestamp: stamp(6), session_id: session.id, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: [{ type: "text", text: "There is 1 file." }] }] }, tool_use_result: { agentId, agentType: "general-purpose", content: [{ type: "text", text: "There is 1 file." }], resolvedModel: "claude-haiku-4-5-20251001", usage: { input_tokens: 100, output_tokens: 20 }, totalDurationMs: 4000, totalTokens: 120, totalToolUseCount: 1 } });
      await waitFor(() => events.some(event => event.conversationId === childId && event.updates.some(update => update.kind === "status" && update.status === "completed")));
      const parentIds = upsertIds(events, session.id);
      // A foreground run has no task row; its launching row carries the
      // result's model and usage, and nothing of the run itself.
      expect(parentIds.filter(id => id.startsWith("task:") || id === "tool:toolu_inner" || id === "message:f28f8ec7" || id.startsWith("reasoning:"))).toEqual([]);
      const launcher = events.filter(event => event.conversationId === session.id).flatMap(event => event.updates).flatMap(update => update.kind === "upsert" && update.item.id === "tool:toolu_fg" ? [update.item] : []).at(-1);
      expect(launcher).toEqual(expect.objectContaining({ status: "completed", childConversationId: childId, model: "claude-haiku-4-5-20251001", usage: expect.objectContaining({ input: 100, output: 20 }) }));
      stop();
      await provider.dispose();
    });

    // A Skill fork (spike Q3, Surprise 5): frames under the Skill tool use
    // from the first moment, no task edge, and the fork's agent id only in
    // the tool result that ends it.
    const FORK_AGENT = "aaeeab292f002e3d7";
    const forkFrames = (sessionId: string) => [
      { type: "assistant", uuid: "fork1", timestamp: stamp(2), session_id: sessionId, parent_tool_use_id: "toolu_skill", message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "thinking", thinking: "Reading the diff." }, { type: "text", text: "Reviewing." }, { type: "tool_use", id: "toolu_diff", name: "Bash", input: { command: "git diff HEAD" } }] } },
      { type: "user", uuid: "fork2", timestamp: stamp(3), session_id: sessionId, parent_tool_use_id: "toolu_skill", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_diff", content: "+1 -1" }] }, tool_use_result: null },
    ];
    const skillCall = (sessionId: string) => ({ type: "assistant", uuid: "skill", timestamp: stamp(1), session_id: sessionId, parent_tool_use_id: null, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "code-review" } }] } });

    test("a skill fork's frames are held until its result names it, then fill the child in arrival order", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      await provider.prompt(session.id, { id: "r1", text: "review", delivery: "queue" });
      const query = queries[0]!;
      const forkChildId = `sub:${session.id}:${FORK_AGENT}`;
      query.push(skillCall(session.id));
      for (const frame of forkFrames(session.id)) query.push(frame);
      await waitFor(() => upsertIds(events, session.id).filter(id => id === "tool:toolu_diff").length === 2);
      // While the fork has no name the parent's rows are exactly what they
      // were before D10 — its tool row, opened and completed, its text and
      // thinking dropped — and no child has been heard of.
      expect(upsertIds(events, session.id).filter(id => id === "message:fork1" || id.startsWith("reasoning:"))).toEqual([]);
      expect(events.some(event => event.conversationId?.startsWith("sub:"))).toBe(false);
      expect(await provider.getSession(forkChildId)).toBeNull();
      const parentBefore = upsertIds(events, session.id);

      query.push({ type: "user", uuid: "forked", timestamp: stamp(4), session_id: session.id, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_skill", content: "Based on my analysis..." }] }, tool_use_result: { success: true, commandName: "code-review", status: "forked", agentId: FORK_AGENT, result: "Based on my analysis..." } });
      await waitFor(() => events.some(event => event.conversationId === forkChildId && event.updates.some(update => update.kind === "status" && update.status === "completed")));

      const childUpdates = events.filter(event => event.conversationId === forkChildId).flatMap(event => event.updates);
      // Running, then everything the fork streamed while nameless, then the
      // settle: the transcript is complete before the status closes it.
      expect(childUpdates[0]).toEqual({ kind: "status", status: "running" });
      expect(childUpdates.at(-1)).toEqual({ kind: "status", status: "completed" });
      expect(childUpdates.flatMap(update => update.kind === "upsert" ? [update.item.id] : []))
        .toEqual(["reasoning:fork1:0", "tool:toolu_diff", "message:fork1", "tool:toolu_diff"]);
      expect(childUpdates.flatMap(update => update.kind === "upsert" && update.item.id === "tool:toolu_diff" ? [update.item] : []).at(-1))
        .toEqual(expect.objectContaining({ type: "tool", name: "Bash", status: "completed", output: "+1 -1" }));
      // Replayed into the child only: the parent gained nothing but the
      // launching row this result completes.
      expect(upsertIds(events, session.id)).toEqual([...parentBefore, "tool:toolu_skill"]);
      const launcher = events.filter(event => event.conversationId === session.id).flatMap(event => event.updates).flatMap(update => update.kind === "upsert" && update.item.id === "tool:toolu_skill" ? [update.item] : []).at(-1);
      expect(launcher).toEqual(expect.objectContaining({ type: "tool", name: "Skill", status: "completed", childConversationId: forkChildId }));
      expect(await provider.getSession(forkChildId)).toEqual(expect.objectContaining({ id: forkChildId, parentId: session.id }));
      stop();
      await provider.dispose();
    });

    test("frames held for a tool use that never forks are dropped unsent", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      await provider.prompt(session.id, { id: "r1", text: "review", delivery: "queue" });
      const query = queries[0]!;
      query.push(skillCall(session.id));
      for (const frame of forkFrames(session.id)) query.push(frame);
      await waitFor(() => upsertIds(events, session.id).filter(id => id === "tool:toolu_diff").length === 2);
      // An ordinary skill load: the result names no agent, so there is no
      // child the held frames could belong to.
      query.push({ type: "user", uuid: "loaded", timestamp: stamp(4), session_id: session.id, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_skill", content: "Skill loaded." }] }, tool_use_result: { success: true, commandName: "code-review" } });
      await waitFor(() => upsertIds(events, session.id).filter(id => id === "tool:toolu_skill").length === 2);
      await query.return();
      await Bun.sleep(10);
      expect(events.some(event => event.conversationId?.startsWith("sub:"))).toBe(false);
      // The parent kept the fork's tool row, as it does today.
      expect(upsertIds(events, session.id).filter(id => id === "tool:toolu_diff").length).toBe(2);
      stop();
      await provider.dispose();
    });

    // Claude Code answers each tool use in a frame of its own, parallel calls
    // included (a `/simplify` run's four parallel Agent launches settled in
    // four frames); the frame's one structured result names no tool use, so
    // a frame that answered several could not say whose run it names.
    test("a frame answering several tool uses names no run from its one structured result", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      await provider.prompt(session.id, { id: "r1", text: "review", delivery: "queue" });
      const query = queries[0]!;
      const forkChildId = `sub:${session.id}:${FORK_AGENT}`;
      query.push(skillCall(session.id));
      query.push({ type: "assistant", uuid: "other", timestamp: stamp(1), session_id: session.id, parent_tool_use_id: null, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: "toolu_other", name: "Bash", input: { command: "ls" } }] } });
      for (const frame of forkFrames(session.id)) query.push(frame);
      await waitFor(() => upsertIds(events, session.id).filter(id => id === "tool:toolu_diff").length === 2);
      query.push({ type: "user", uuid: "both", timestamp: stamp(4), session_id: session.id, parent_tool_use_id: null, message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_other", content: "README.md" },
        { type: "tool_result", tool_use_id: "toolu_skill", content: "Based on my analysis..." },
      ] }, tool_use_result: { success: true, commandName: "code-review", status: "forked", agentId: FORK_AGENT, result: "Based on my analysis..." } });
      const completed = (id: string) => events.filter(event => event.conversationId === session.id).flatMap(event => event.updates)
        .flatMap(update => update.kind === "upsert" && update.item.id === id && update.item.type === "tool" && update.item.status === "completed" ? [update.item] : []).at(-1);
      await waitFor(() => completed("tool:toolu_other") !== undefined && completed("tool:toolu_skill") !== undefined);
      // Neither row is given the run, and no run is registered under either
      // tool use while the session is live: the Bash call is not the fork,
      // and nothing says the Skill is.
      expect(completed("tool:toolu_other")).not.toHaveProperty("childConversationId");
      expect(completed("tool:toolu_skill")).not.toHaveProperty("childConversationId");
      expect(await provider.getSession(forkChildId)).toBeNull();
      await query.return();
      await Bun.sleep(10);
      expect(events.some(event => event.conversationId?.startsWith("sub:"))).toBe(false);
      stop();
      await provider.dispose();
    });

    test("a child filled from its transcript and then fed live upserts the same item ids", async () => {
      const { provider, queries, configDir, workspace } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      const childId = `sub:${session.id}:${AGENT_ID}`;
      // The transcript as the CLI writes it, record for record the frames
      // it forwards (same uuids and tool-use ids; spike probe b), plus the
      // run's prompt, which is never forwarded.
      const subagentDir = path.join(claudeProjectDir(workspace, configDir), session.id, "subagents");
      mkdirSync(subagentDir, { recursive: true });
      const stored = (frame: Record<string, unknown>) => {
        const { session_id: _session, parent_tool_use_id: _parent, tool_use_result, ...rest } = frame as Record<string, unknown> & { tool_use_result?: unknown };
        return JSON.stringify({ ...rest, parentUuid: null, isSidechain: true, agentId: AGENT_ID, ...(tool_use_result ? { toolUseResult: tool_use_result } : {}) });
      };
      writeFileSync(path.join(subagentDir, `agent-${AGENT_ID}.jsonl`), [
        JSON.stringify({ type: "user", uuid: "cc451df4", parentUuid: null, isSidechain: true, agentId: AGENT_ID, timestamp: stamp(1), message: { role: "user", content: "List the files" } }),
        ...runFrames(session.id, LAUNCHER).filter(frame => frame.type !== "tool_progress").map(stored),
      ].join("\n") + "\n");
      const snapshot = new Set((await provider.listMessages(childId, { limit: 50 })).items.map(item => item.id));
      expect(snapshot).toEqual(new Set(["message:cc451df4", "reasoning:a202b083:0", "tool:toolu_inner", "usage:a202b083", "message:f28f8ec7", "usage:f28f8ec7"]));

      await provider.prompt(session.id, { id: "r1", text: "spawn", delivery: "queue" });
      const query = queries[0]!;
      query.push({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: stamp(1), session_id: session.id, task_id: AGENT_ID, tool_use_id: LAUNCHER, description: "List files", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent" });
      for (const frame of runFrames(session.id, LAUNCHER)) query.push(frame);
      await waitFor(() => upsertIds(events, childId).includes("usage:f28f8ec7"));
      // Every live item is one the snapshot already holds: no second row
      // for a tool call, a thought, or a message the file replayed.
      for (const id of upsertIds(events, childId)) expect(snapshot.has(id)).toBe(true);
      stop();
      await provider.dispose();
    });
  });

  // Design D13, against the CLI Uatu actually runs (spike Q4/Q5, frames
  // verbatim): Claude Code marks two kinds of agent run ambient — a skill the
  // model forks and the run a typed command launches — and both are runs.
  describe("ambient agent runs are runs, never background work (D13)", () => {
    type Frame = Record<string, unknown>;
    const fork = forkedRuns.skillFork.live as Frame[];
    const typed = forkedRuns.typedCodeReview.live as Frame[];
    const FORK_AGENT = "afd1c64a374700d34";
    const SKILL_USE = "toolu_01CS76rQV6QvfD4HfdsJmk1r";
    const REVIEW_AGENT = "ad53ca64bd188affb";
    const upserts = (events: NormalizedProviderEvent[], conversationId: string) =>
      events.filter(event => event.conversationId === conversationId).flatMap(event => event.updates).flatMap(update => update.kind === "upsert" ? [update.item] : []);
    const statuses = (events: NormalizedProviderEvent[], conversationId: string) =>
      events.filter(event => event.conversationId === conversationId).flatMap(event => event.updates).flatMap(update => update.kind === "status" ? [update.status] : []);
    const neverBackground = async (provider: ClaudeProvider, events: NormalizedProviderEvent[], sessionId: string) => {
      expect(statuses(events, sessionId)).not.toContain("background");
      expect(events.some(event => event.eventType === "turn.background" || event.eventType === "background.reconciled")).toBe(false);
      expect(await provider.listBackgroundTasks()).toEqual([]);
    };

    test("a model-invoked code-review fork opens its child at task_started, and its tagged frames reach it live", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      const childId = `sub:${session.id}:${FORK_AGENT}`;
      await provider.prompt(session.id, { id: "r1", text: "review my change", delivery: "queue" });
      const query = queries[0]!;
      const [skillCall, started, ...rest] = fork;
      const notificationAt = rest.findIndex(frame => frame.subtype === "task_notification");
      const run = rest.slice(0, notificationAt);
      const [notification, forked] = rest.slice(notificationAt);
      query.push(skillCall);
      query.push(started);
      // Named at its start edge, running, before a single frame of it arrives.
      await waitFor(() => statuses(events, childId).includes("running"));
      expect(await provider.getSession(childId)).toEqual(expect.objectContaining({ id: childId, parentId: session.id }));
      expect(upserts(events, session.id).filter(item => item.id === `tool:${SKILL_USE}`).at(-1))
        .toEqual(expect.objectContaining({ type: "tool", name: "Skill", status: "running", childConversationId: childId }));
      for (const frame of run) query.push(frame);
      const lastText = run.filter(frame => frame.type === "assistant").at(-1)!.uuid as string;
      await waitFor(() => upserts(events, childId).some(item => item.id === `message:${lastText}`));
      // Live in the child: its text and its own tool call, completed by its
      // result. The parent holds nothing of the run but the Skill row.
      const childItems = upserts(events, childId);
      expect(childItems.filter(item => item.id === "tool:toolu_01UkPeqpEx1YUWZD1uAqPm6s").at(-1)).toEqual(expect.objectContaining({ type: "tool", name: "Bash", status: "completed" }));
      expect(childItems.some(item => item.type === "assistant_message" && item.markdown.startsWith("I'll run a high-effort review."))).toBe(true);
      const parentIds = new Set(upserts(events, session.id).map(item => item.id));
      expect(childItems.filter(item => parentIds.has(item.id))).toEqual([]);
      expect([...parentIds].filter(id => id.startsWith("tool:") || id.startsWith("reasoning:"))).toEqual([`tool:${SKILL_USE}`]);
      query.push(notification);
      query.push(forked);
      await waitFor(() => statuses(events, childId).includes("completed"));
      expect(upserts(events, session.id).filter(item => item.id === `tool:${SKILL_USE}`).at(-1))
        .toEqual(expect.objectContaining({ status: "completed", childConversationId: childId }));
      await neverBackground(provider, events, session.id);
      expect(upserts(events, session.id).some(item => item.type === "background_task")).toBe(false);
      stop();
      await provider.dispose();
    });

    test("a fork frame that beats its start edge still opens the child's transcript", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      const childId = `sub:${session.id}:${FORK_AGENT}`;
      await provider.prompt(session.id, { id: "r1", text: "review my change", delivery: "queue" });
      const query = queries[0]!;
      const [skillCall, started, ...rest] = fork;
      const early = rest.find(frame => frame.type === "assistant" && JSON.stringify(frame).includes("toolu_01UkPeqpEx1YUWZD1uAqPm6s"))!;
      query.push(skillCall);
      query.push(early);
      query.push(started);
      await waitFor(() => statuses(events, childId).includes("running"));
      await waitFor(() => upserts(events, childId).some(item => item.id === "tool:toolu_01UkPeqpEx1YUWZD1uAqPm6s"));
      stop();
      await provider.dispose();
    });

    test("a typed /code-review emits a foreground run row openable as its child, settled by the notification", async () => {
      const { provider, queries, configDir, workspace } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      const childId = `sub:${session.id}:${REVIEW_AGENT}`;
      await provider.prompt(session.id, { id: "r1", text: "/code-review low", delivery: "queue" });
      const query = queries[0]!;
      const [started, rateLimit, notification, synthetic, result] = typed;
      query.push(started);
      await waitFor(() => upserts(events, session.id).some(item => item.id === `task:${REVIEW_AGENT}`));
      expect(upserts(events, session.id).find(item => item.id === `task:${REVIEW_AGENT}`)).toEqual({
        id: `task:${REVIEW_AGENT}`, type: "background_task", createdAt: expect.any(Number), taskId: REVIEW_AGENT,
        description: "/code-review", taskType: "local_agent", status: "running", subagentType: "general-purpose",
        childConversationId: childId, foreground: true,
      });
      expect(statuses(events, childId)).toEqual(["running"]);
      // Openable at once, before the CLI has written a line of its transcript,
      // and readable while the CLI is still writing it (spike Q4e: live).
      expect(await provider.getSession(childId)).toEqual(expect.objectContaining({ id: childId, parentId: session.id }));
      expect((await provider.listMessages(childId, { limit: 50 })).items).toEqual([]);
      const subagents = path.join(claudeProjectDir(workspace, configDir), session.id, "subagents");
      mkdirSync(subagents, { recursive: true });
      const file = path.join(subagents, `agent-${REVIEW_AGENT}.jsonl`);
      const record = (uuid: string, second: number, message: Record<string, unknown>, type = "assistant") =>
        JSON.stringify({ type, uuid, parentUuid: null, isSidechain: true, agentId: REVIEW_AGENT, timestamp: `2026-09-24T17:08:1${second}.000Z`, message }) + "\n";
      writeFileSync(file, record("rv-1", 1, { role: "user", content: "Review the diff." }, "user"));
      expect((await provider.listMessages(childId, { limit: 50 })).items.map(item => item.id)).toEqual(["message:rv-1"]);
      appendFileSync(file, record("rv-2", 2, { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Reading the diff." }] }));
      expect((await provider.listMessages(childId, { limit: 50 })).items.map(item => item.id)).toEqual(["message:rv-1", "message:rv-2"]);

      query.push(rateLimit);
      query.push(notification);
      await waitFor(() => statuses(events, childId).includes("completed"));
      expect(upserts(events, session.id).filter(item => item.id === `task:${REVIEW_AGENT}`).at(-1))
        .toEqual(expect.objectContaining({ status: "completed", foreground: true, childConversationId: childId }));
      query.push(synthetic);
      query.push(result);
      await waitFor(() => statuses(events, session.id).includes("completed"));
      // The command's output is the timeline's record of the run (D15): its
      // text as it arrived, naming no model and spending nothing.
      const output = upserts(events, session.id).find(item => item.id === `message:${synthetic.uuid as string}`);
      expect(output).toEqual(expect.objectContaining({ type: "assistant_message", markdown: expect.stringContaining("math.ts:2") }));
      expect(upserts(events, session.id).some(item => item.id === `usage:${synthetic.uuid as string}`)).toBe(false);
      expect(events.some(event => event.assistantModel !== undefined || event.assistantUsage !== undefined)).toBe(false);
      await neverBackground(provider, events, session.id);
      stop();
      await provider.dispose();
    });

    test("a foreground run that never reports its end is settled by the turn's result", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      await provider.prompt(session.id, { id: "r1", text: "/code-review low", delivery: "queue" });
      const query = queries[0]!;
      const [started, , , synthetic, result] = typed;
      query.push(started);
      query.push(synthetic);
      query.push(result);
      await waitFor(() => statuses(events, session.id).includes("completed"));
      expect(upserts(events, session.id).filter(item => item.id === `task:${REVIEW_AGENT}`).at(-1))
        .toEqual(expect.objectContaining({ status: "stopped", foreground: true }));
      stop();
      await provider.dispose();
    });

    test("an ambient task that is not an agent run stays ignored: no row, no child", async () => {
      const { provider, queries } = fixture();
      const { events, stop } = collect(provider);
      const session = await provider.createSession("x");
      await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
      const query = queries[0]!;
      query.push({ type: "system", subtype: "task_started", uuid: "w1", session_id: session.id, task_id: "watch1", description: "Live update watcher", task_type: "local_monitor", subagent_type: "general-purpose", ambient: true, skip_transcript: true });
      query.push({ type: "system", subtype: "task_notification", uuid: "w2", session_id: session.id, task_id: "watch1", status: "completed", summary: "x", ambient: true });
      query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-24T17:08:20.000Z", session_id: session.id, is_error: false });
      await waitFor(() => statuses(events, session.id).includes("completed"));
      expect(events.filter(event => event.eventType === "system").every(event => event.outcome === "ignored" && event.updates.length === 0)).toBe(true);
      expect(events.some(event => event.conversationId?.startsWith("sub:"))).toBe(false);
      expect(await provider.getSession(`sub:${session.id}:watch1`)).toBeNull();
      await neverBackground(provider, events, session.id);
      stop();
      await provider.dispose();
    });
  });

  test("a prompt the CLI reports queued behind its follow-up keeps the session until it runs", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    query.getContextUsage = async () => ({ categories: [], totalTokens: 10, maxTokens: 200_000 });
    // The CLI answers a result while a user send is still queued behind it.
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false, queued_turn_count: 1 });
    await waitFor(() => events.some(event => event.eventType === "context.reported"));
    await Bun.sleep(10);
    expect(provider.liveSessionCount()).toBe(1);
    expect(query.returned).toBe(false);
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:09.000Z", session_id: session.id, is_error: false, queued_turn_count: 0 });
    await waitFor(() => query.returned);
    stop();
    await provider.dispose();
  });

  test("a stream that closes with a turn still queued fails that turn instead of dropping it", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    query.getContextUsage = async () => ({ categories: [], totalTokens: 10, maxTokens: 200_000 });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false, queued_turn_count: 1 });
    await waitFor(() => events.some(event => event.eventType === "context.reported"));
    await query.return();
    await waitFor(() => events.some(event => event.eventType === "result" && event.updates.some(update => update.kind === "status" && update.status === "failed")));
    expect(provider.liveSessionCount()).toBe(0);
    stop();
    await provider.dispose();
  });

  test("a task announced before any level snapshot settles when the process dies", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: "2026-09-02T10:00:01.000Z", session_id: session.id, task_id: "early", task_type: "local_bash", description: "Early job", is_backgrounded: true });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.id === "task:early")));
    await query.return();
    await waitFor(() => events.some(event => event.eventType === "result"));
    const ended = events.find(event => event.eventType === "result")!;
    expect(ended.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:early", status: "stopped", summary: "The Claude Code session ended before this task finished." }) });
    expect(ended.updates.at(-1)).toEqual({ kind: "status", status: "failed", message: "Claude Code session ended before finishing the turn" });
    stop();
    await provider.dispose();
  });

  test("a first level snapshot that names an announced task ambient withdraws its row", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    // The start edge beat the snapshot and claimed background work.
    query.push({ type: "system", subtype: "task_started", uuid: "ts1", timestamp: "2026-09-02T10:00:01.000Z", session_id: session.id, task_id: "amb", task_type: "local_bash", description: "Watcher", is_backgrounded: true });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.id === "task:amb")));
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "amb", task_type: "local_bash", description: "Watcher", ambient: true }] });
    await waitFor(() => events.some(event => event.eventType === "background.reconciled"));
    expect(events.find(event => event.eventType === "background.reconciled")!.updates).toEqual([{ kind: "remove", itemId: "task:amb" }]);
    expect(await provider.listBackgroundTasks()).toEqual([]);
    const before = events.length;
    query.push({ type: "system", subtype: "task_progress", uuid: "tp1", session_id: session.id, task_id: "amb", description: "Watcher", usage: { total_tokens: 0, tool_uses: 1, duration_ms: 500 } });
    await waitFor(() => events.length > before);
    expect(events[before]!.outcome).toBe("ignored");
    stop();
    await provider.dispose();
  });

  test("a process that dies while background work runs settles its rows and clears the state", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_bash", description: "Long job" }] });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    query.fail(new Error("child process died"));
    await waitFor(() => events.some(event => event.eventType === "session.failed"));
    const failure = events.find(event => event.eventType === "session.failed")!;
    expect(failure.updates[0]).toEqual({ kind: "upsert", item: expect.objectContaining({ id: "task:b1", type: "background_task", status: "stopped", summary: expect.stringContaining("failed before this task finished") }) });
    expect(await provider.listBackgroundTasks()).toEqual([]);
    expect(provider.liveSessionCount()).toBe(0);
    // A stop after the fact is a conflict, not a failure.
    await expect(provider.stopTask(session.id, "b1")).rejects.toBeInstanceOf(BackgroundTaskUnavailableError);
    stop();
    await provider.dispose();
  });

  test("cancelling while only background work runs does not poison the next turn's result", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "background it", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_bash", description: "Job" }] });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    // No turn is live: the cancel is a no-op on the process and latches nothing.
    await provider.interrupt(session.id);
    expect(query.interrupts).toBe(0);
    await provider.prompt(session.id, { id: "r2", text: "next", delivery: "queue" });
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:09.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.updates.some(update => update.kind === "status" && update.status === "completed")).length === 2);
    expect(events.some(event => event.updates.some(update => update.kind === "status" && update.status === "interrupted"))).toBe(false);
    stop();
    await provider.dispose();
  });

  test("a settled task wakes the CLI's own follow-up turn, which runs as a turn and then retires the session", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "background sleep", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_bash", description: "Sleep then echo" }] });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    // The spike's sequence (D9): the set empties, the task settles, then the
    // CLI starts a turn by itself — init, assistant, result.
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg2", session_id: session.id, tasks: [] });
    query.push({ type: "system", subtype: "task_notification", uuid: "tn1", session_id: session.id, timestamp: "2026-09-02T10:00:13.000Z", task_id: "b1", tool_use_id: "toolu_1", status: "completed", output_file: "/tmp/o", summary: "done" });
    query.push({ type: "system", subtype: "init", uuid: "i2", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    await waitFor(() => events.some(event => event.eventType === "turn.unprompted"));
    expect(provider.liveSessionCount()).toBe(1);
    query.push({ type: "assistant", uuid: "a2", timestamp: "2026-09-02T10:00:15.000Z", session_id: session.id, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "FINISHED done" }], usage: { input_tokens: 5, output_tokens: 2 } } });
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:16.000Z", session_id: session.id, is_error: false });
    await waitFor(() => query.returned);
    expect(provider.liveSessionCount()).toBe(0);
    const statuses = events.flatMap(event => event.updates).filter(update => update.kind === "status").map(update => (update as { status: string }).status);
    expect(statuses).toEqual(["running", "completed", "background", "running", "completed"]);
    const rows = events.flatMap(event => event.updates).filter(update => update.kind === "upsert" && update.item.type === "background_task").map(update => (update as { item: { status: string; summary?: string } }).item);
    expect(rows.at(-1)).toEqual(expect.objectContaining({ status: "completed", summary: "done" }));
    stop();
    await provider.dispose();
  });

  test("an emptied set with no follow-up returns the conversation to idle and retires after the grace window", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-grace-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    mkdirSync(claudeProjectDir(workspace, configDir), { recursive: true });
    const queries: FakeQuery[] = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
      backgroundGraceMs: 30,
      queryFactory: input => { const query = new FakeQuery(input); queries.push(query); return query; },
    });
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_bash", description: "Job" }] });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    // The user stops it; the CLI settles the row and empties the set.
    let stopped: string | undefined;
    query.stopTask = async (taskId: string) => { stopped = taskId; };
    await provider.stopTask(session.id, "b1");
    expect(stopped).toBe("b1");
    await expect(provider.stopTask(session.id, "nope")).rejects.toThrow(/no longer running/);
    query.push({ type: "system", subtype: "task_notification", uuid: "tn1", session_id: session.id, timestamp: "2026-09-02T10:00:06.000Z", task_id: "b1", status: "stopped", output_file: "/tmp/o", summary: "" });
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg2", session_id: session.id, tasks: [] });
    await waitFor(() => query.returned);
    expect(provider.liveSessionCount()).toBe(0);
    const statuses = events.flatMap(event => event.updates).filter(update => update.kind === "status").map(update => (update as { status: string }).status);
    expect(statuses).toEqual(["running", "completed", "background", "idle"]);
    const rows = events.flatMap(event => event.updates).filter(update => update.kind === "upsert" && update.item.type === "background_task").map(update => (update as { item: { status: string } }).item.status);
    expect(rows.at(-1)).toBe("stopped");
    await expect(provider.stopTask(session.id, "b1")).rejects.toThrow(/no longer running/);
    stop();
    await provider.dispose();
  });

  test("the level signal mints and settles rows for tasks whose bookends never arrived", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    // Named by the level only: a running row appears without task_started.
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "q1", task_type: "local_bash", description: "Quiet job" }] });
    await waitFor(() => events.some(event => event.eventType === "background.reconciled"));
    expect((events.find(event => event.eventType === "background.reconciled")!.updates[0] as { item: { id: string; status: string; description: string } }).item).toEqual(expect.objectContaining({ id: "task:q1", status: "running", description: "Quiet job" }));
    // Announced normally: the level adds no second row for it.
    query.push({ type: "system", subtype: "task_started", uuid: "ts2", session_id: session.id, timestamp: "2026-09-02T10:00:03.000Z", task_id: "q2", description: "Loud job", is_backgrounded: true });
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg2", session_id: session.id, tasks: [{ task_id: "q1", task_type: "local_bash", description: "Quiet job" }, { task_id: "q2", task_type: "local_bash", description: "Loud job" }] });
    await Bun.sleep(10);
    expect(events.filter(event => event.eventType === "background.reconciled")).toHaveLength(1);
    // Turned ambient: still running, so no outcome — the row just leaves.
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg3", session_id: session.id, tasks: [{ task_id: "q1", task_type: "local_bash", description: "Quiet job", ambient: true }, { task_id: "q2", task_type: "local_bash", description: "Loud job" }] });
    await waitFor(() => events.filter(event => event.eventType === "background.reconciled").length === 2);
    expect(events.filter(event => event.eventType === "background.reconciled")[1]!.updates).toEqual([{ kind: "remove", itemId: "task:q1" }]);
    expect((await provider.listBackgroundTasks()).map(task => task.taskId)).toEqual(["q2"]);
    // Its progress edges carry no ambient flag; the level's word holds.
    const before = events.length;
    query.push({ type: "system", subtype: "task_progress", uuid: "tp1", session_id: session.id, task_id: "q1", description: "Quiet job", usage: { total_tokens: 0, tool_uses: 1, duration_ms: 500 } });
    await waitFor(() => events.length > before);
    expect(events[before]!.outcome).toBe("ignored");
    // Flipped back: user work again, listed again.
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg4", session_id: session.id, tasks: [{ task_id: "q1", task_type: "local_bash", description: "Quiet job" }, { task_id: "q2", task_type: "local_bash", description: "Loud job" }] });
    await waitFor(() => events.filter(event => event.eventType === "background.reconciled").length === 3);
    expect((events.filter(event => event.eventType === "background.reconciled")[2]!.updates[0] as { item: { id: string; status: string } }).item).toEqual(expect.objectContaining({ id: "task:q1", status: "running" }));
    // Dropped by the level with no notification: settled, never stuck
    // running — but with no outcome invented, since the level carries none.
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg5", session_id: session.id, tasks: [{ task_id: "q2", task_type: "local_bash", description: "Loud job" }] });
    await waitFor(() => events.filter(event => event.eventType === "background.reconciled").length === 4);
    expect((events.filter(event => event.eventType === "background.reconciled")[3]!.updates[0] as { item: { id: string; status: string } }).item).toEqual(expect.objectContaining({ id: "task:q1", status: "stopped", summary: "The task left Claude Code's task list without reporting an outcome." }));
    // The late notification still carries the real outcome over that row.
    query.push({ type: "system", subtype: "task_notification", uuid: "tn-late", timestamp: "2026-09-02T10:00:09.000Z", session_id: session.id, task_id: "q1", status: "failed", output_file: "/tmp/q1", summary: "exit 1" });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.id === "task:q1" && (update.item as { status: string }).status === "failed")));
    stop();
    await provider.dispose();
  });

  test("a set that empties while the context report is pending leaves retirement to the grace timer", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-grace2-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    mkdirSync(claudeProjectDir(workspace, configDir), { recursive: true });
    const queries: FakeQuery[] = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
      backgroundGraceMs: 200,
      queryFactory: input => { const query = new FakeQuery(input); queries.push(query); return query; },
    });
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    let release!: (value: unknown) => void;
    query.getContextUsage = () => new Promise(resolve => { release = resolve; });
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_bash", description: "Quick job" }] });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    // The task finishes while the probe is still out; the CLI's follow-up
    // is on its way. The probe's continuation must not close the session.
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg2", session_id: session.id, tasks: [] });
    await Bun.sleep(5);
    release({ categories: [], totalTokens: 10, maxTokens: 200_000 });
    await waitFor(() => events.some(event => event.eventType === "context.reported"));
    await Bun.sleep(10);
    expect(provider.liveSessionCount()).toBe(1);
    expect(query.returned).toBe(false);
    query.getContextUsage = async () => ({ categories: [], totalTokens: 12, maxTokens: 200_000 });
    query.push({ type: "system", subtype: "init", uuid: "i2", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    await waitFor(() => events.some(event => event.eventType === "turn.unprompted"));
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:07.000Z", session_id: session.id, is_error: false });
    await waitFor(() => query.returned);
    stop();
    await provider.dispose();
  });

  test("a stream that ends inside the grace window clears the background state", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-grace3-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    mkdirSync(claudeProjectDir(workspace, configDir), { recursive: true });
    const queries: FakeQuery[] = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
      backgroundGraceMs: 10_000,
      queryFactory: input => { const query = new FakeQuery(input); queries.push(query); return query; },
    });
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_bash", description: "Quick job" }] });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg2", session_id: session.id, tasks: [] });
    await Bun.sleep(20);
    // The CLI exits cleanly with the set already empty: no row to settle,
    // but the conversation must leave background mode all the same.
    await query.return();
    await waitFor(() => events.some(event => event.eventType === "turn.background-cleared"));
    const cleared = events.find(event => event.eventType === "turn.background-cleared")!;
    expect(cleared.updates).toEqual([{ kind: "status", status: "idle" }]);
    expect(provider.liveSessionCount()).toBe(0);
    stop();
    await provider.dispose();
  });

  test("plan utilization rides the context report when the login reports limits, and never for API-key sessions", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    expect(query.input.options.includePartialMessages).toBe(true);
    query.getContextUsage = async () => ({ categories: [], totalTokens: 100, maxTokens: 200_000 });
    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({
      session: {}, subscription_type: "max", rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 37, resets_at: "2026-09-02T14:00:00.000Z" }, seven_day: { utilization: 12.4, resets_at: null } },
    });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "context.reported"));
    const report = (events.find(event => event.eventType === "context.reported")!.updates[0] as { item: { plan?: unknown; session?: unknown } }).item;
    expect(report.plan).toEqual({ subscription: "max", fiveHour: { utilization: 37, resetsAt: Date.parse("2026-09-02T14:00:00.000Z") }, sevenDay: { utilization: 12.4 } });
    expect(report.session).toBeUndefined();

    // An API-key login: no plan windows, stated as an empty plan.
    await provider.prompt(session.id, { id: "r2", text: "again", delivery: "queue" });
    const second = queries[1]!;
    second.getContextUsage = async () => ({ categories: [], totalTokens: 120, maxTokens: 200_000 });
    second.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({ session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null });
    second.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:09.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 2);
    const plain = (events.filter(event => event.eventType === "context.reported")[1]!.updates[0] as { item: { plan?: unknown } }).item;
    expect(plain.plan).toEqual({});
    stop();
    await provider.dispose();
  });

  test("a login without windows keeps reporting the conversation's totals on later turns of the same process", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    // Two prompts accepted up front: the first result retires nothing, so
    // the second turn's report comes from the same live query, where the
    // first read already found the login without plan windows.
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    await provider.prompt(session.id, { id: "r2", text: "again", delivery: "queue" });
    const query = queries[0]!;
    query.getContextUsage = async () => ({ categories: [], totalTokens: 100, maxTokens: 200_000 });
    let reads = 0;
    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => {
      reads += 1;
      return { session: { total_cost_usd: 0.5 * reads, total_api_duration_ms: 1_000 * reads, model_usage: {} }, subscription_type: null, rate_limits_available: false, rate_limits: null };
    };
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 1);
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:09.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 2);
    const reports = events.filter(event => event.eventType === "context.reported").map(event => (event.updates[0] as { item: { plan?: unknown; session?: { costUsd: number; apiDurationMs: number } } }).item);
    expect(reads).toBe(2);
    expect(reports[0]!.plan).toEqual({});
    expect(reports[0]!.session).toMatchObject({ costUsd: 0.5, apiDurationMs: 1_000 });
    // The plan stays stated as empty; the totals are the second read's, not
    // the first's carried forward and not dropped.
    expect(reports[1]!.plan).toEqual({});
    expect(reports[1]!.session).toMatchObject({ costUsd: 1, apiDurationMs: 2_000 });
    stop();
    await provider.dispose();
  });

  test("totals are summed across the fresh queries a conversation's turns resume, per model, from when this process first saw it", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    const before = Date.now();
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const first = queries[0]!;
    first.getContextUsage = async () => ({ categories: [], totalTokens: 100, maxTokens: 200_000 });
    first.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({
      session: {
        total_cost_usd: 0.5, total_api_duration_ms: 1_000, total_duration_ms: 5_000, total_lines_added: 3, total_lines_removed: 1,
        model_usage: { "claude-opus-5": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 1_000, cacheCreationInputTokens: 50, costUSD: 0.5 } },
      },
      subscription_type: null, rate_limits_available: false, rate_limits: null,
    });
    first.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 1);
    // The idle conversation's query retires; the next prompt resumes a fresh
    // one whose counters start over (SDK: "resumed sessions start fresh").
    await waitFor(() => provider.liveSessionCount() === 0);
    await provider.prompt(session.id, { id: "r2", text: "again", delivery: "queue" });
    const second = queries[1]!;
    expect(second).not.toBe(first);
    second.getContextUsage = async () => ({ categories: [], totalTokens: 120, maxTokens: 200_000 });
    second.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({
      session: {
        total_cost_usd: 0.25, total_api_duration_ms: 400, total_duration_ms: 2_000, total_lines_added: 0, total_lines_removed: 2,
        model_usage: {
          "claude-opus-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 200, cacheCreationInputTokens: 0, costUSD: 0.125 },
          "claude-haiku-4-5": { inputTokens: 30, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.125 },
        },
      },
      subscription_type: null, rate_limits_available: false, rate_limits: null,
    });
    second.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:09.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 2);
    const reports = events.filter(event => event.eventType === "context.reported").map(event => (event.updates[0] as { item: { session?: { since?: number; [field: string]: unknown } } }).item);
    const since = reports[0]!.session!.since!;
    // Observation began with the first query of this process, which the
    // adapter's user-message stamp follows: never later than the message.
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(Date.now());
    expect(reports[0]!.session).toEqual({
      costUsd: 0.5, apiDurationMs: 1_000, durationMs: 5_000, linesAdded: 3, linesRemoved: 1,
      models: [{ id: "claude-opus-5", input: 100, output: 20, cacheRead: 1_000, cacheWrite: 50, costUsd: 0.5 }],
      since,
    });
    // The second report is the conversation's sum, not the fresh query's own
    // count: scalars added, the shared model's row merged, the new one appended.
    expect(reports[1]!.session).toEqual({
      costUsd: 0.75, apiDurationMs: 1_400, durationMs: 7_000, linesAdded: 3, linesRemoved: 3,
      models: [
        { id: "claude-opus-5", input: 110, output: 25, cacheRead: 1_200, cacheWrite: 50, costUsd: 0.625 },
        { id: "claude-haiku-4-5", input: 30, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: 0.125 },
      ],
      since,
    });
    stop();
    await provider.dispose();
  });

  test("a query whose counters went down mid-life had them reset: what stood before is folded, not lost", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    await provider.prompt(session.id, { id: "r2", text: "/clear", delivery: "queue" });
    const query = queries[0]!;
    query.getContextUsage = async () => ({ categories: [], totalTokens: 100, maxTokens: 200_000 });
    const reads = [0.5, 0.25];
    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({
      session: { total_cost_usd: reads.shift(), total_api_duration_ms: 0, model_usage: {} }, subscription_type: null, rate_limits_available: false, rate_limits: null,
    });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 1);
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:09.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 2);
    const reports = events.filter(event => event.eventType === "context.reported").map(event => (event.updates[0] as { item: { session?: { costUsd: number } } }).item);
    expect(reports[0]!.session).toMatchObject({ costUsd: 0.5 });
    expect(reports[1]!.session).toMatchObject({ costUsd: 0.75 });
    stop();
    await provider.dispose();
  });

  test("an extra-usage-only read does not file the login as planless: windows on the next read of the same process still land", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    await provider.prompt(session.id, { id: "r2", text: "again", delivery: "queue" });
    const query = queries[0]!;
    query.getContextUsage = async () => ({ categories: [], totalTokens: 100, maxTokens: 200_000 });
    let reads = 0;
    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => {
      reads += 1;
      return {
        session: {}, subscription_type: "max", rate_limits_available: true,
        rate_limits: {
          ...(reads > 1 ? { five_hour: { utilization: 37, resets_at: "2026-09-02T14:00:00.000Z" } } : {}),
          extra_usage: { is_enabled: true, monthly_limit: 10_000, used_credits: 1_250, utilization: 12.5, currency: "USD" },
        },
      };
    };
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 1);
    query.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:09.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 2);
    const reports = events.filter(event => event.eventType === "context.reported").map(event => (event.updates[0] as { item: { plan?: unknown } }).item);
    expect(reads).toBe(2);
    const extraUsage = { enabled: true, usedCredits: 12.5, monthlyLimit: 100, utilization: 12.5, currency: "USD" };
    expect(reports[0]!.plan).toEqual({ subscription: "max", extraUsage });
    expect(reports[1]!.plan).toEqual({ subscription: "max", fiveHour: { utilization: 37, resetsAt: Date.parse("2026-09-02T14:00:00.000Z") }, extraUsage });
    stop();
    await provider.dispose();
  });

  test("the chooser follows Claude Code's own title, and a UatuCode rename outranks it", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-title-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    const projectDir = claudeProjectDir(workspace, configDir);
    mkdirSync(projectDir, { recursive: true });
    const queries: FakeQuery[] = [];
    const renames: Array<{ sessionId: string; title: string; dir: string }> = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
      queryFactory: input => { const query = new FakeQuery(input); queries.push(query); return query; },
      renameNativeSession: async (sessionId, title, options) => {
        renames.push({ sessionId, title, dir: options.dir });
        writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId })}\n`, { flag: "a" });
      },
    });
    expect(provider.describe().capabilities).toContain("conversation-rename");
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "Investigate the flaky build on CI", delivery: "queue" });
    // The CLI writes the transcript with the first turn and its own title.
    const file = path.join(projectDir, `${session.id}.jsonl`);
    writeFileSync(file, [
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-09-02T10:00:00.000Z", cwd: workspace, message: { role: "user", content: "Investigate the flaky build on CI" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, timestamp: "2026-09-02T10:00:01.000Z", cwd: workspace, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Looking." }] } }),
      JSON.stringify({ type: "ai-title", aiTitle: "Flaky CI build investigation", sessionId: session.id }),
    ].join("\n") + "\n");
    queries[0]!.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:02.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.sessionLifecycle?.kind === "updated" && event.sessionLifecycle.title === "Flaky CI build investigation"));
    expect((await provider.listSessions()).find(entry => entry.id === session.id)?.title).toBe("Flaky CI build investigation");
    // A user rename is recorded natively and announced; the generated title
    // no longer replaces it, even after another turn.
    const renamed = await provider.renameSession(session.id, "  CI flake hunt  ");
    expect(renamed.title).toBe("CI flake hunt");
    expect(renames).toEqual([{ sessionId: session.id, title: "CI flake hunt", dir: workspace }]);
    expect((await provider.listSessions()).find(entry => entry.id === session.id)?.title).toBe("CI flake hunt");
    await provider.prompt(session.id, { id: "r2", text: "more", delivery: "queue" });
    writeFileSync(file, `${JSON.stringify({ type: "ai-title", aiTitle: "A later generated title", sessionId: session.id })}\n`, { flag: "a" });
    queries[1]!.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:09.000Z", session_id: session.id, is_error: false });
    await waitFor(() => queries[1]!.returned);
    expect(events.some(event => event.sessionLifecycle?.kind === "updated" && event.sessionLifecycle.title === "A later generated title")).toBe(false);
    expect((await provider.listSessions()).find(entry => entry.id === session.id)?.title).toBe("CI flake hunt");
    // A session without any title keeps the prompt-derived one.
    const untitled = await provider.createSession("y");
    await provider.prompt(untitled.id, { id: "r3", text: "hello there", delivery: "queue" });
    expect((await provider.listSessions()).find(entry => entry.id === untitled.id)?.title).toBe("hello there");
    stop();
    await provider.dispose();
  });

  test("a stored session opened with a slash command is titled and replayed as the typed command", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-slash-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    const projectDir = claudeProjectDir(workspace, configDir);
    mkdirSync(projectDir, { recursive: true });
    // Claude Code stores a slash-command prompt as markup, not as typed, and
    // its own ai-title may never arrive.
    const markup = "<command-message>openspec-explore</command-message>\n<command-name>/openspec-explore</command-name>\n<command-args>why is the build slow?</command-args>";
    writeFileSync(path.join(projectDir, "slash-session.jsonl"), [
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-09-02T10:00:00.000Z", cwd: workspace, message: { role: "user", content: markup } }),
      JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, timestamp: "2026-09-02T10:00:01.000Z", cwd: workspace, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Looking." }] } }),
    ].join("\n") + "\n");
    const provider = new ClaudeProvider({
      workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
      queryFactory: input => new FakeQuery(input),
    });
    expect((await provider.listSessions()).find(entry => entry.id === "slash-session")?.title).toBe("/openspec-explore why is the build slow?");
    const page = await provider.listMessages("slash-session", { limit: 10 });
    expect(page.items.find(item => item.type === "user_message")).toEqual(expect.objectContaining({ text: "/openspec-explore why is the build slow?" }));
    await provider.dispose();
  });

  test("a retry outside the conversation's own turn names no state, and a stream frame wakes the follow-up turn", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    query.getContextUsage = async () => ({ categories: [], totalTokens: 10, maxTokens: 200_000 });
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_agent", description: "Explorer" }] });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    // The backgrounded subagent's request is retried: not this conversation's turn.
    const before = events.length;
    query.push({ type: "system", subtype: "api_retry", uuid: "r1", session_id: session.id, attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: 529, error: "overloaded" });
    await waitFor(() => events.length > before);
    expect(events.slice(before).some(event => event.updates.some(update => update.kind === "status"))).toBe(false);
    // The CLI's own follow-up starts streaming before any completed frame.
    query.push({ type: "stream_event", uuid: "se1", session_id: session.id, parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_F" } } });
    await waitFor(() => events.some(event => event.eventType === "turn.unprompted"));
    // A subagent frame does not resume a retry into a running turn either.
    stop();
    await provider.dispose();
  });

  test("a rate-limit standing outlives the process that reported it", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const first = queries[0]!;
    first.getContextUsage = async () => ({ categories: [], totalTokens: 10, maxTokens: 200_000 });
    first.push({ type: "rate_limit_event", uuid: "rl1", session_id: session.id, rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } });
    first.push({ type: "result", subtype: "error_during_execution", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: true, errors: ["rate limited"] });
    await waitFor(() => first.returned);
    await provider.prompt(session.id, { id: "r2", text: "again", delivery: "queue" });
    const second = queries[1]!;
    // The onset survived the query boundary: the second process's standing
    // is the first's, not a fresh one dated to the resume.
    const onset = events.flatMap(event => event.updates)
      .find(update => update.kind === "upsert" && update.item.id === "notice:rate-limit") as { item: { createdAt: number } };
    second.push({ type: "rate_limit_event", uuid: "rl1b", session_id: session.id, rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } });
    await waitFor(() => events.filter(event => event.updates.some(update => update.kind === "upsert" && update.item.id === "notice:rate-limit")).length > 1);
    const resumed = events.flatMap(event => event.updates)
      .filter(update => update.kind === "upsert" && update.item.id === "notice:rate-limit")
      .at(-1) as { item: { createdAt: number } };
    expect(resumed.item.createdAt).toBe(onset.item.createdAt);
    // The window reset; the next "allowed" retires the standing.
    second.push({ type: "rate_limit_event", uuid: "rl2", session_id: session.id, rate_limit_info: { status: "allowed" } });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "remove" && update.itemId === "notice:rate-limit")));
    stop();
    await provider.dispose();
  });

  test("a rename before the first turn is kept and written once the transcript exists, and a late generated title is re-read", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-rename-pending-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    const projectDir = claudeProjectDir(workspace, configDir);
    mkdirSync(projectDir, { recursive: true });
    const queries: FakeQuery[] = [];
    const renames: string[] = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
      titleRefreshDelaysMs: [20, 40],
      queryFactory: input => { const query = new FakeQuery(input); queries.push(query); return query; },
      renameNativeSession: async (sessionId, title) => {
        const file = path.join(projectDir, `${sessionId}.jsonl`);
        if (!existsSync(file)) throw new Error(`Session ${sessionId} not found in project directory`);
        renames.push(title);
        writeFileSync(file, `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId })}\n`, { flag: "a" });
      },
    });
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    // No transcript yet: the rename is kept rather than failed.
    const renamed = await provider.renameSession(session.id, "Planned work");
    expect(renamed.title).toBe("Planned work");
    expect(renames).toEqual([]);
    expect((await provider.listSessions()).find(entry => entry.id === session.id)?.title).toBe("Planned work");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const file = path.join(projectDir, `${session.id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-09-02T10:00:00.000Z", cwd: workspace, message: { role: "user", content: "go" } })}\n`);
    queries[0]!.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:02.000Z", session_id: session.id, is_error: false });
    await waitFor(() => renames.length === 1);
    expect(renames).toEqual(["Planned work"]);
    // The CLI's own title arriving now does not outrank the rename.
    writeFileSync(file, `${JSON.stringify({ type: "ai-title", aiTitle: "Generated later", sessionId: session.id })}\n`, { flag: "a" });
    await Bun.sleep(120);
    expect(events.some(event => event.sessionLifecycle?.kind === "updated" && event.sessionLifecycle.title === "Generated later")).toBe(false);

    // A conversation never renamed: the generated title that lands after
    // the result is picked up by the bounded re-read.
    const other = await provider.createSession("y");
    await provider.prompt(other.id, { id: "r2", text: "hello there", delivery: "queue" });
    const otherFile = path.join(projectDir, `${other.id}.jsonl`);
    writeFileSync(otherFile, `${JSON.stringify({ type: "user", uuid: "u2", parentUuid: null, isSidechain: false, timestamp: "2026-09-02T10:00:03.000Z", cwd: workspace, message: { role: "user", content: "hello there" } })}\n`);
    queries[1]!.push({ type: "result", subtype: "success", uuid: "res2", timestamp: "2026-09-02T10:00:04.000Z", session_id: other.id, is_error: false });
    await Bun.sleep(30);
    writeFileSync(otherFile, `${JSON.stringify({ type: "ai-title", aiTitle: "Greeting", sessionId: other.id })}\n`, { flag: "a" });
    await waitFor(() => events.some(event => event.sessionLifecycle?.kind === "updated" && event.sessionLifecycle.id === other.id && event.sessionLifecycle.title === "Greeting"));
    // Renamed before its first turn, then the workspace restarts.
    const fresh = await provider.createSession("z");
    await provider.renameSession(fresh.id, "Named before birth");
    stop();
    await provider.dispose();

    // A restart before the first turn keeps the deferred rename with the
    // pending session it names.
    const restarted = new ClaudeProvider({
      workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
      queryFactory: input => { const query = new FakeQuery(input); queries.push(query); return query; },
      renameNativeSession: async (sessionId, title) => { renames.push(`restart:${title}`); writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId })}\n`, { flag: "a" }); },
    });
    await restarted.prompt(fresh.id, { id: "r9", text: "go", delivery: "queue" });
    const freshFile = path.join(projectDir, `${fresh.id}.jsonl`);
    writeFileSync(freshFile, `${JSON.stringify({ type: "user", uuid: "u9", parentUuid: null, isSidechain: false, timestamp: "2026-09-02T10:00:10.000Z", cwd: workspace, message: { role: "user", content: "go" } })}\n`);
    queries[queries.length - 1]!.push({ type: "result", subtype: "success", uuid: "res9", timestamp: "2026-09-02T10:00:11.000Z", session_id: fresh.id, is_error: false });
    await waitFor(() => renames.includes("restart:Named before birth"));
    await restarted.dispose();

  });

  test("a session-scoped refusal fallback becomes the conversation's model; a local one does not", async () => {
    const { provider, queries } = fixture();
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x", { model: { providerId: "anthropic", modelId: "claude-opus-5" } });
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "model_refusal_fallback", uuid: "mf-local", session_id: session.id, trigger: "refusal", direction: "retry", scope: "local", original_model: "claude-opus-5", fallback_model: "claude-haiku-4-5-20251001", request_id: null, content: "" });
    query.push({ type: "system", subtype: "model_refusal_fallback", uuid: "mf1", session_id: session.id, trigger: "refusal", direction: "retry", scope: "session", original_model: "claude-opus-5", fallback_model: "claude-sonnet-5", request_id: null, api_refusal_category: "cyber", content: "…" });
    await waitFor(() => events.some(event => event.eventType === "model.fallback"));
    expect(events.filter(event => event.eventType === "model.fallback")).toHaveLength(1);
    expect(events.find(event => event.eventType === "model.fallback")!.configuration).toEqual({ model: { providerId: "anthropic", modelId: "claude-sonnet-5" } });
    expect((await provider.getConversationConfiguration(session.id)).model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5" });
    // The next process starts on the fallback, not the refused model.
    query.getContextUsage = async () => ({ categories: [], totalTokens: 10, maxTokens: 200_000 });
    query.push({ type: "result", subtype: "success", uuid: "res1", timestamp: "2026-09-02T10:00:05.000Z", session_id: session.id, is_error: false });
    await waitFor(() => query.returned);
    await provider.prompt(session.id, { id: "r2", text: "again", delivery: "queue" });
    expect(queries[1]!.input.options.model).toBe("claude-sonnet-5");
    stop();
    await provider.dispose();
  });

  test("the agent declares background tasks and asks the CLI for a per-task stop affordance", async () => {
    const { provider, queries } = fixture();
    expect(provider.describe().capabilities).toContain("background-tasks");
    expect(provider.describe().capabilities).toContain("scheduled-wakeups");
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    expect(queries[0]!.input.options.perTaskStopAffordance).toBe(true);
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
      { type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Write", ruleContent: "/workspace/*" }] },
      { type: "addRules", behavior: "allow", destination: "userSettings", rules: [{ toolName: "Write" }] },
      { type: "addRules", behavior: "deny", destination: "session", rules: [{ toolName: "Bash" }] },
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
      // The card lists what "always" will install, in Claude Code's rule
      // syntax: every session-scoped update, the deny included, apart from
      // the resource; the settings-bound one is neither listed nor sent.
      alwaysPatterns: ["Allow: Write(/workspace/*)", "Deny: Bash"],
      status: "pending",
    }) });
    expect(await provider.listPermissions!()).toEqual([expect.objectContaining({ requestId: "toolu_1", conversationId: session.id, alwaysPatterns: ["Allow: Write(/workspace/*)", "Deny: Bash"] })]);

    await provider.replyPermission(session.id, "toolu_1", "always");
    await decision;
    // Always maps to allow + the session-scoped suggestions as a set (D5):
    // the settings-bound rule is neither listed nor forwarded, and the
    // forwarded set is exactly as long as the list the card showed.
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/workspace/a.txt", content: "x" },
      updatedPermissions: [suggestions[0], suggestions[2]],
    });
    expect((result as { updatedPermissions: unknown[] }).updatedPermissions).toHaveLength(2);
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
    // Nothing session-scoped worth forwarding: the card says so with an
    // empty list rather than leaving the question open.
    expect(await provider.listPermissions!()).toEqual([expect.objectContaining({ requestId: "t1", alwaysPatterns: [] })]);
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
    // Cold: the static fallback answers (Opus 5 runs the enlarged window on its plain id).
    expect((await provider.listModels()).find(model => model.selection.modelId === "claude-opus-5")?.contextLimit).toBe(1_000_000);
    expect((await provider.listModels()).find(model => model.selection.modelId === "claude-sonnet-5")?.contextLimit).toBe(200_000);

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

    const forks: Array<{ sessionId: string; upToMessageId: string; title?: string }> = [];
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
        forks.push({ sessionId, upToMessageId: options.upToMessageId, title: options.title });
        return { sessionId: forkId };
      },
    });

    await forking.undo!(storedId);
    await forking.prompt(storedId, { id: "r-new", text: "a different direction", delivery: "queue" });
    // The fork is named after the conversation's own title, so the SDK's
    // "(fork)" bookkeeping never becomes the chooser's title.
    expect(forks).toEqual([{ sessionId: storedId, upToMessageId: "u1", title: (await forking.getSession(storedId))!.title }]);
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
    expect(newest.nextCursor).toEqual(expect.any(String));
    const older = await provider.listMessages(storedId, { limit: 10, cursor: newest.nextCursor });
    expect(older.items.map(item => item.id)).toEqual(["message:u1", "message:a1"]);

    await expect(provider.listMessages("33333333-4444-4555-8666-777777777777", { limit: 10 })).rejects.toThrow("unknown Claude conversation");
    await provider.dispose();
  });
});

describe("/usage normalization", () => {
  // The SDK's shape as of 2.1.258; the experimental method may change under
  // us, and this pins what a full answer turns into.
  const full = {
    session: {
      total_cost_usd: 1.2345, total_api_duration_ms: 42_000, total_duration_ms: 90_000, total_lines_added: 12, total_lines_removed: 3,
      model_usage: {
        "claude-opus-5[1m]": { inputTokens: 1_000, outputTokens: 200, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 4_000, webSearchRequests: 0, costUSD: 1.1, contextWindow: 1_000_000, maxOutputTokens: 32_000 },
        "claude-haiku-4-5": { inputTokens: 300, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.1345, contextWindow: 200_000, maxOutputTokens: 8_000 },
        "broken": { inputTokens: "many", outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 },
      },
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 9, resets_at: "2026-09-02T14:00:00.000Z" },
      seven_day: { utilization: 25, resets_at: "2026-09-06T21:00:00.000Z" },
      seven_day_opus: { utilization: 61, resets_at: "2026-09-06T21:00:00.000Z" },
      seven_day_sonnet: { utilization: 4, resets_at: null },
      seven_day_oauth_apps: { utilization: 0, resets_at: "2026-09-06T21:00:00.000Z" },
      model_scoped: [
        { display_name: "Fable", utilization: 83, resets_at: "2026-09-06T21:00:00.000Z" },
        { display_name: "", utilization: 1, resets_at: null },
        { utilization: 2 },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 10_000, used_credits: 1_250, utilization: 12.5, currency: "USD" },
    },
    behaviors: { day: { request_count: 1 }, week: { request_count: 2 } },
  };

  test("a full response yields every window, the plan name, extra usage, and session totals — never behaviors", () => {
    const plan = normalizePlanUtilization(full)!;
    expect(plan).toEqual({
      subscription: "max",
      fiveHour: { utilization: 9, resetsAt: Date.parse("2026-09-02T14:00:00.000Z") },
      sevenDay: { utilization: 25, resetsAt: Date.parse("2026-09-06T21:00:00.000Z") },
      sevenDayOpus: { utilization: 61, resetsAt: Date.parse("2026-09-06T21:00:00.000Z") },
      sevenDaySonnet: { utilization: 4 },
      sevenDayOauthApps: { utilization: 0, resetsAt: Date.parse("2026-09-06T21:00:00.000Z") },
      modelScoped: [{ label: "Fable", utilization: 83, resetsAt: Date.parse("2026-09-06T21:00:00.000Z") }],
      extraUsage: { enabled: true, monthlyLimit: 100, usedCredits: 12.5, utilization: 12.5, currency: "USD" },
    });
    expect("behaviors" in plan).toBe(false);
    expect(normalizeSessionTotals(full)).toEqual({
      costUsd: 1.2345, apiDurationMs: 42_000, durationMs: 90_000, linesAdded: 12, linesRemoved: 3,
      models: [
        { id: "claude-opus-5[1m]", input: 1_000, output: 200, cacheRead: 50_000, cacheWrite: 4_000, costUsd: 1.1 },
        { id: "claude-haiku-4-5", input: 300, output: 40, cacheRead: 0, cacheWrite: 0, costUsd: 0.1345 },
      ],
    });
  });

  test("a two-window response renders exactly as before the widening", () => {
    const plan = normalizePlanUtilization({ session: {}, subscription_type: null, rate_limits_available: true, rate_limits: { five_hour: { utilization: 37, resets_at: "2026-09-02T14:00:00.000Z" }, seven_day: { utilization: 12.4, resets_at: null } } });
    expect(plan).toEqual({ fiveHour: { utilization: 37, resetsAt: Date.parse("2026-09-02T14:00:00.000Z") }, sevenDay: { utilization: 12.4 } });
    expect(normalizeSessionTotals({ session: {} })).toBeUndefined();
  });

  test("a null rate_limits answer is no plan; a plan name alone is not a plan", () => {
    expect(normalizePlanUtilization({ session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null })).toBeUndefined();
    expect(normalizePlanUtilization({ subscription_type: "pro", rate_limits_available: true, rate_limits: {} })).toBeUndefined();
    expect(normalizePlanUtilization(null)).toBeUndefined();
    expect(normalizePlanUtilization("usage")).toBeUndefined();
  });

  test("extra-usage credits arrive in minor units and read in major ones; a null utilization is derived from the amounts", () => {
    // A Pro login with 85 € of credit and nothing spent: the wire says 8500
    // and 0, and no utilization (issue #347's companion report).
    const plan = normalizePlanUtilization({
      session: {}, subscription_type: "pro", rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 30, resets_at: null }, extra_usage: { is_enabled: true, monthly_limit: 8_500, used_credits: 0, utilization: null, currency: "EUR" } },
    });
    expect(plan!.extraUsage).toEqual({ enabled: true, usedCredits: 0, monthlyLimit: 85, utilization: 0, currency: "EUR" });
    // Partly spent, no utilization on the wire: derived from the amounts.
    expect(normalizePlanUtilization({
      rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: true, monthly_limit: 8_500, used_credits: 2_125, utilization: null } },
    })!.extraUsage).toEqual({ enabled: true, usedCredits: 21.25, monthlyLimit: 85, utilization: 25 });
    // The wire's own utilization stands when it states one; a zero limit
    // (unlimited or unknown) derives nothing.
    expect(normalizePlanUtilization({
      rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: true, monthly_limit: 8_500, used_credits: 2_125, utilization: 26 } },
    })!.extraUsage!.utilization).toBe(26);
    expect(normalizePlanUtilization({
      rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: true, monthly_limit: 0, used_credits: 500, utilization: null } },
    })!.extraUsage).toEqual({ enabled: true, usedCredits: 5, monthlyLimit: 0 });
  });

  test("extra usage alone is a plan: the credit row survives without any time window", () => {
    const plan = normalizePlanUtilization({
      session: {}, subscription_type: "max", rate_limits_available: true,
      rate_limits: { extra_usage: { is_enabled: true, monthly_limit: 10_000, used_credits: 1_250, utilization: 12.5, currency: "USD" } },
    });
    expect(plan).toEqual({ subscription: "max", extraUsage: { enabled: true, usedCredits: 12.5, monthlyLimit: 100, utilization: 12.5, currency: "USD" } });
  });

  test("malformed fields cost the field, not the report", () => {
    const plan = normalizePlanUtilization({
      subscription_type: 7, rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: -3, resets_at: "not a date" },
        seven_day: { utilization: "half", resets_at: 1_788_400_000 },
        seven_day_opus: "lots",
        model_scoped: "Fable",
        extra_usage: { is_enabled: "yes", monthly_limit: 10_000 },
      },
    });
    expect(plan).toEqual({ sevenDay: { resetsAt: 1_788_400_000_000 } });
    expect(normalizeSessionTotals({ session: { total_cost_usd: "free" } })).toBeUndefined();
    expect(normalizeSessionTotals({ session: { total_cost_usd: 0.5, total_duration_ms: "long", model_usage: null } })).toEqual({ costUsd: 0.5, apiDurationMs: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0, models: [] });
  });
});

test("the Claude agent declares plan usage as askable", async () => {
  const { provider } = fixture();
  try {
    expect(provider.describe().capabilities).toContain("usage");
  } finally { await provider.dispose(); }
});

describe("plan usage on demand", () => {
  const plan = { subscription_type: "pro", rate_limits_available: true, rate_limits: { five_hour: { utilization: 9, resets_at: 1_800_000_000 }, seven_day: { utilization: 25, resets_at: 1_800_400_000 } } };
  const context = { categories: [{ name: "Messages", tokens: 3_000, color: "x" }], totalTokens: 3_000, maxTokens: 200_000 };
  const userRow = (id: string, text: string, cwd: string) => JSON.stringify({ type: "user", uuid: id, parentUuid: null, isSidechain: false, cwd, timestamp: "2026-09-01T12:00:00Z", message: { role: "user", content: text } }) + "\n";
  const usageOptions: unknown[] = [];
  const answer = (query: FakeQuery) => {
    query.getContextUsage = async () => context;
    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async (options?: unknown) => { usageOptions.push(options); return plan; };
  };

  test("a turn-end read becomes the workspace's last-known report and survives a restart", async () => {
    const { provider, queries, configDir, workspace } = fixture(answer);
    const { events, stop } = collect(provider);
    expect(await provider.usageReport()).toBeUndefined();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "first", delivery: "queue" });
    queries[0]!.push({ type: "result", subtype: "success", uuid: "r-1", timestamp: "2026-08-30T10:00:02.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.eventType === "context.reported"));
    const report = await provider.usageReport();
    expect(report).toEqual(expect.objectContaining({ plan: expect.objectContaining({ subscription: "pro", fiveHour: expect.objectContaining({ utilization: 9 }) }), conversationId: session.id }));
    // The behaviors scan is never asked for: the block is not carried.
    expect(usageOptions).toEqual([{ skipBehaviors: true }]);
    stop();
    await provider.dispose();
    // A restarted workspace answers from the durable file before any session starts.
    const restarted = new ClaudeProvider({ workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false, queryFactory: input => new FakeQuery(input) });
    expect(await restarted.usageReport()).toEqual(report);
    await restarted.dispose();
    // A durable file from before the field loads as it did.
    writeFileSync(path.join(workspace, ".uatu-test-state.json"), JSON.stringify({ configurations: {} }));
    const older = new ClaudeProvider({ workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false, queryFactory: input => new FakeQuery(input) });
    expect(await older.usageReport()).toBeUndefined();
    await older.dispose();
  });

  test("a live-only read answers from a running turn without touching it", async () => {
    const { provider, queries } = fixture(answer);
    const { events, stop } = collect(provider);
    expect(await provider.readUsage("live-only")).toEqual({ report: null, reason: "no-live-session" });
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "first", delivery: "queue" });
    const query = queries[0]!;
    const result = await provider.readUsage("live-only");
    expect(result.report).toEqual(expect.objectContaining({ plan: expect.objectContaining({ subscription: "pro" }), conversationId: session.id }));
    const reported = events.filter(event => event.eventType === "context.reported");
    expect(reported).toHaveLength(1);
    expect((reported[0]!.updates[0] as { item: { type: string; plan?: unknown; total: number } }).item).toEqual(expect.objectContaining({ type: "context_report", total: 3_000, plan: expect.objectContaining({ subscription: "pro" }) }));
    // The turn is still running: not retired, and its own probe still follows its result.
    expect(query.returned).toBe(false);
    query.push({ type: "result", subtype: "success", uuid: "r-1", timestamp: "2026-08-30T10:00:02.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.filter(event => event.eventType === "context.reported").length === 2);
    await waitFor(() => query.returned);
    stop();
    await provider.dispose();
  });

  test("a start read resumes the idle conversation, reads, and retires it; a racing prompt keeps it", async () => {
    let release: ((value: unknown) => void) | undefined;
    const { provider, queries, configDir, workspace } = fixture(query => {
      query.getContextUsage = async () => context;
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = () => new Promise(resolve => { release = () => resolve(plan); });
    });
    const { events, stop } = collect(provider);
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), "idle-session.jsonl"), userRow("u1", "earlier", workspace));
    const pending = provider.readUsage("start");
    await waitFor(() => queries.length === 1 && release !== undefined);
    expect(queries[0]!.input.options.resume).toBe("idle-session");
    release!(plan);
    const result = await pending;
    expect(result.report).toEqual(expect.objectContaining({ conversationId: "idle-session" }));
    expect(events.filter(event => event.conversationId === "idle-session" && event.eventType === "context.reported")).toHaveLength(1);
    expect(events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.type === "user_message"))).toBe(false);
    await waitFor(() => queries[0]!.returned);
    // A prompt that lands while the read is out joins the live session and keeps it.
    release = undefined;
    const second = provider.readUsage("start");
    await waitFor(() => queries.length === 2 && release !== undefined);
    await provider.prompt("idle-session", { id: "r2", text: "now", delivery: "queue" });
    expect(queries).toHaveLength(2);
    release!(plan);
    await second;
    expect(queries[1]!.returned).toBe(false);
    stop();
    await provider.dispose();
  });

  test("a turn that ends under an explicit read defers retirement until the read answers", async () => {
    let release: ((value: unknown) => void) | undefined;
    const { provider, queries } = fixture(query => {
      query.getContextUsage = async () => context;
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = () => new Promise(resolve => { release = () => resolve(plan); });
    });
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "first", delivery: "queue" });
    const query = queries[0]!;
    const pending = provider.readUsage("live-only");
    await waitFor(() => release !== undefined);
    // The turn ends while the read is out: its own probe runs (and hangs on
    // the same fake read), the status completes, and the session stays.
    const releaseRead = release!;
    release = undefined;
    query.push({ type: "result", subtype: "success", uuid: "r-1", timestamp: "2026-08-30T10:00:02.000Z", session_id: session.id, is_error: false });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "status" && update.status === "completed")));
    await waitFor(() => release !== undefined);
    await Bun.sleep(10);
    expect(query.returned).toBe(false);
    releaseRead(plan);
    const result = await pending;
    expect(result.report).toEqual(expect.objectContaining({ conversationId: session.id }));
    release!(plan);
    await waitFor(() => query.returned);
    stop();
    await provider.dispose();
  });

  test("a read on a session another operation started leaves that session to the operation", async () => {
    const { provider, queries, configDir, workspace } = fixture(answer);
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), "idle-session.jsonl"), userRow("u1", "earlier", workspace));
    // Another control operation has the session up (a rewind, say) with no turn on it.
    await (provider as unknown as { ensureLive(id: string): Promise<unknown> }).ensureLive("idle-session");
    expect(queries).toHaveLength(1);
    const result = await provider.readUsage("live-only");
    expect(result.report).toEqual(expect.objectContaining({ conversationId: "idle-session" }));
    await Bun.sleep(10);
    expect(queries[0]!.returned).toBe(false);
    await provider.dispose();
    expect(queries[0]!.returned).toBe(true);
  });

  test("a usage answer a newer one has overtaken is dropped rather than folded as a reset", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const { provider, queries } = fixture(query => {
      query.getContextUsage = async () => context;
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = () => new Promise(resolve => { resolvers.push(resolve); });
    });
    const { events, stop } = collect(provider);
    const costed = (cost: number) => ({ ...plan, session: { total_cost_usd: cost, model_usage: {} } });
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "first", delivery: "queue" });
    const explicit = provider.readUsage("live-only");
    await waitFor(() => resolvers.length === 1);
    // The turn ends under the explicit read: its probe asks the same query.
    queries[0]!.push({ type: "result", subtype: "success", uuid: "r-1", timestamp: "2026-08-30T10:00:02.000Z", session_id: session.id, is_error: false });
    await waitFor(() => resolvers.length === 2);
    // The newer answer lands first, the older (lower) one after.
    resolvers[1]!(costed(2));
    await waitFor(() => events.some(event => event.eventType === "context.reported"));
    resolvers[0]!(costed(1));
    const result = await explicit;
    expect(result.report).not.toBeNull();
    expect(events.filter(event => event.eventType === "context.reported")).toHaveLength(1);
    await waitFor(() => queries[0]!.returned);
    // The next query's tally adds to what was truly spent: 2, not 2 folded twice.
    const next = provider.readUsage("start");
    await waitFor(() => resolvers.length === 3);
    resolvers[2]!(costed(0.5));
    await next;
    const reports = events.filter(event => event.eventType === "context.reported");
    expect(reports).toHaveLength(2);
    expect((reports[1]!.updates[0] as { item: { session?: { costUsd: number } } }).item.session?.costUsd).toBe(2.5);
    stop();
    await provider.dispose();
  });

  test("a workspace without a conversation reads through a hidden probe that never lists", async () => {
    const { provider, queries, configDir, workspace } = fixture(answer);
    expect(await provider.listSessions()).toEqual([]);
    const result = await provider.readUsage("start");
    expect(result.report).toEqual(expect.objectContaining({ plan: expect.objectContaining({ subscription: "pro" }) }));
    expect(result.report?.conversationId).toBeUndefined();
    expect(queries).toHaveLength(1);
    const probeId = queries[0]!.input.options.sessionId!;
    expect(probeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(queries[0]!.input.options.resume).toBeUndefined();
    expect(queries[0]!.returned).toBe(true);
    // Even a transcript the CLI writes for the probe stays out of the inventory, across a restart.
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), `${probeId}.jsonl`), userRow("p1", "probe", workspace));
    expect(await provider.listSessions()).toEqual([]);
    await provider.dispose();
    const stored = JSON.parse(readFileSync(path.join(workspace, ".uatu-test-state.json"), "utf8")) as { hiddenNative: string[] };
    expect(stored.hiddenNative).toContain(probeId);
    const restarted = new ClaudeProvider({ workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false, queryFactory: input => new FakeQuery(input) });
    expect(await restarted.listSessions()).toEqual([]);
    await restarted.dispose();
  });

  test("a read that hangs times out and one the query cannot make is unavailable; the last-known report stands", async () => {
    const { provider, queries } = fixture(query => {
      query.getContextUsage = async () => context;
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = () => new Promise(() => undefined);
    }, { usageReadTimeoutMs: 20 });
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "first", delivery: "queue" });
    expect(await provider.readUsage("live-only")).toEqual({ report: null, reason: "timeout" });
    expect(await provider.usageReport()).toBeUndefined();
    queries[0]!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = undefined;
    expect(await provider.readUsage("live-only")).toEqual({ report: null, reason: "unavailable" });
    // Concurrent asks join one read.
    queries[0]!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => plan;
    const [a, b] = await Promise.all([provider.readUsage("live-only"), provider.readUsage("live-only")]);
    expect(a).toBe(b);
    expect(a.report?.plan).toEqual(expect.objectContaining({ subscription: "pro" }));
    await provider.dispose();
  });
});

test("disposing the provider mid-probe ends the probe query instead of leaving it to its timeout", async () => {
  const { provider, queries } = fixture(query => {
    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = () => new Promise(() => undefined);
  }, { usageReadTimeoutMs: 200 });
  const pending = provider.readUsage("start");
  await waitFor(() => queries.length === 1);
  expect(queries[0]!.returned).toBe(false);
  await provider.dispose();
  expect(queries[0]!.returned).toBe(true);
  expect(await pending).toEqual({ report: null, reason: expect.stringMatching(/timeout|unavailable/) });
});

describe("scheduled wakeups hold, fire, release, and lose (claude-scheduled-wakeups)", () => {
  const signal = new AbortController().signal;
  const stopHook = (query: FakeQuery, input: Record<string, unknown>) =>
    query.input.options.hooks!.Stop![0]!.hooks[0]!({ hook_event_name: "Stop", stop_hook_active: false, background_tasks: [], ...input }, undefined, { signal });
  const promptHook = (query: FakeQuery, input: Record<string, unknown>) =>
    query.input.options.hooks!.UserPromptSubmit![0]!.hooks[0]!({ hook_event_name: "UserPromptSubmit", ...input }, undefined, { signal });
  const oneShot = { id: "w1", schedule: "3 20 * * *", recurring: false, prompt: "WAKEUP check the build" };
  const recurring = { id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "CRON poll the queue" };
  const result = (sessionId: string, uuid: string) => ({ type: "result", subtype: "success", uuid, timestamp: "2026-09-24T18:01:10.000Z", session_id: sessionId, is_error: false });
  const statuses = (events: NormalizedProviderEvent[]) => events.flatMap(event => event.updates).filter(update => update.kind === "status").map(update => (update as { status: string }).status);
  const rows = (events: NormalizedProviderEvent[]) => events.flatMap(event => event.updates)
    .filter(update => update.kind === "upsert" && update.item.type === "scheduled_wakeup")
    .map(update => (update as { item: Record<string, unknown> }).item);

  // The spike's sequence for the turn that schedules: tool call, Stop (with
  // the crons), then the result.
  async function scheduled(crons: unknown[], options: { background?: boolean } = {}) {
    const context = fixture();
    const { events, stop } = collect(context.provider);
    const session = await context.provider.createSession("x");
    await context.provider.prompt(session.id, { id: "r1", text: "wake me in a minute", delivery: "queue" });
    const query = context.queries[0]!;
    query.push({ type: "system", subtype: "init", uuid: "i1", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    if (options.background) {
      query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_bash", description: "Long job" }] });
    }
    await waitFor(() => events.some(event => event.eventType !== "prompt.accepted"));
    await promptHook(query, { prompt: "wake me in a minute", prompt_id: "typed-1" });
    // The calls that made them, as the stream carries them: a ScheduleWakeup
    // (no id comes back) and a CronCreate (its result names the cron) — D10.
    query.push({ type: "assistant", uuid: "sw", session_id: session.id, message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_sw", name: "ScheduleWakeup", input: { delaySeconds: 60, prompt: oneShot.prompt } },
      { type: "tool_use", id: "toolu_cc", name: "CronCreate", input: { cron: recurring.schedule, prompt: recurring.prompt, recurring: true } },
    ] } });
    query.push({ type: "user", uuid: "cc-result", session_id: session.id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cc", content: "Scheduled recurring job c1." }] }, tool_use_result: { id: "c1", recurring: true, durable: false } });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "upsert" && update.item.id === "tool:toolu_cc" && update.item.type === "tool" && update.item.status === "completed")));
    await stopHook(query, { session_crons: crons });
    query.push(result(session.id, "res1"));
    await waitFor(() => events.some(event => event.eventType === "turn.scheduled" || event.eventType === "turn.background"));
    return { ...context, events, stop, session, query };
  }

  test("a Stop payload's crons become the session's wakeups, each a pending row", async () => {
    const { provider, events, stop, session } = await scheduled([oneShot, recurring]);
    expect(await provider.listScheduledWakeups()).toEqual([
      expect.objectContaining({ conversationId: session.id, wakeupId: "w1", prompt: oneShot.prompt, recurring: false, schedule: "3 20 * * *", nextFireAt: expect.any(Number) }),
      expect.objectContaining({ conversationId: session.id, wakeupId: "c1", recurring: true, schedule: "*/5 * * * *" }),
    ]);
    expect(rows(events)).toEqual([
      expect.objectContaining({ id: "wakeup:w1", wakeupId: "w1", status: "pending", recurring: false, nextFireAt: expect.any(Number) }),
      expect.objectContaining({ id: "wakeup:c1", wakeupId: "c1", status: "pending", recurring: true }),
    ]);
    // The typed prompt's own hook is not a wakeup turn.
    expect(events.flatMap(event => event.updates).some(update => update.kind === "upsert" && update.item.type === "user_message" && "origin" in update.item)).toBe(false);
    stop();
    await provider.dispose();
  });

  test("a result under a pending wakeup keeps the session and reports the scheduled state", async () => {
    const { provider, events, stop, query } = await scheduled([oneShot]);
    await Bun.sleep(20);
    expect(provider.liveSessionCount()).toBe(1);
    expect(query.returned).toBe(false);
    expect(statuses(events)).toEqual(["running", "completed", "scheduled"]);
    stop();
    await provider.dispose();
  });

  test("live background work outranks pending wakeups; once it clears the session stays scheduled", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-wakeup-grace-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    mkdirSync(claudeProjectDir(workspace, configDir), { recursive: true });
    const queries: FakeQuery[] = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
      backgroundGraceMs: 20,
      queryFactory: input => { const query = new FakeQuery(input); queries.push(query); return query; },
    });
    const { events, stop } = collect(provider);
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "go", delivery: "queue" });
    const query = queries[0]!;
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg1", session_id: session.id, tasks: [{ task_id: "b1", task_type: "local_bash", description: "Job" }] });
    await waitFor(() => events.some(event => event.eventType === "background.reconciled"));
    await stopHook(query, { session_crons: [oneShot] });
    query.push(result(session.id, "res1"));
    await waitFor(() => events.some(event => event.eventType === "turn.background"));
    expect(events.some(event => event.eventType === "turn.scheduled")).toBe(false);
    // The task settles with no follow-up: the grace window ends in the
    // scheduled state, not idle, and the process stays up for the wakeup.
    query.push({ type: "system", subtype: "background_tasks_changed", uuid: "bg2", session_id: session.id, tasks: [] });
    await waitFor(() => events.some(event => event.eventType === "turn.scheduled"));
    await Bun.sleep(20);
    expect(statuses(events).at(-1)).toBe("scheduled");
    expect(provider.liveSessionCount()).toBe(1);
    expect(query.returned).toBe(false);
    stop();
    await provider.dispose();
  });

  test("an emptied cron set cancels the pending rows, and the session retires at the turn's end", async () => {
    const { provider, events, stop, session, query } = await scheduled([oneShot, recurring]);
    // The agent ends its loop in a turn the user prompted (CronDelete).
    await provider.prompt(session.id, { id: "r2", text: "stop polling", delivery: "queue" });
    await promptHook(query, { prompt: "stop polling", prompt_id: "typed-2" });
    await stopHook(query, { session_crons: [] });
    query.push(result(session.id, "res2"));
    await waitFor(() => query.returned);
    expect(provider.liveSessionCount()).toBe(0);
    expect(rows(events).slice(-2)).toEqual([
      expect.objectContaining({ id: "wakeup:w1", status: "cancelled" }),
      expect.objectContaining({ id: "wakeup:c1", status: "cancelled" }),
    ]);
    expect(rows(events).slice(-2).every(row => row.nextFireAt === undefined)).toBe(true);
    // At rest, not scheduled: the second turn ends as completed and nothing holds the process.
    expect(statuses(events).slice(-2)).toEqual(["running", "completed"]);
    stop();
    await provider.dispose();
  });

  test("a fired wakeup opens its own turn, attributed to the wakeup, and a fired one-shot's row links it", async () => {
    const { provider, events, stop, session, query } = await scheduled([oneShot]);
    // The spike's fired sequence: lifecycle, UserPromptSubmit (no source on
    // this CLI), init, assistant, Stop (the one-shot gone), result.
    query.push({ type: "command_lifecycle", command_uuid: "cmd-1", state: "started", uuid: "cl1", session_id: session.id });
    await promptHook(query, { prompt: oneShot.prompt, prompt_id: "fired-1" });
    query.push({ type: "system", subtype: "init", uuid: "i2", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    await waitFor(() => events.some(event => event.eventType === "turn.unprompted"));
    const opening = events.find(event => event.eventType === "wakeup.fired")!;
    expect(opening.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ id: "message:wakeup:fired-1", type: "user_message", text: oneShot.prompt, origin: "wakeup", wakeupId: "w1" }) }]);
    query.push({ type: "assistant", uuid: "a2", timestamp: "2026-09-24T18:03:02.000Z", session_id: session.id, message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "pong" }], usage: { input_tokens: 5, output_tokens: 1 } } });
    await stopHook(query, { session_crons: [] });
    query.push(result(session.id, "res2"));
    await waitFor(() => query.returned);
    expect(rows(events).at(-1)).toEqual(expect.objectContaining({ id: "wakeup:w1", status: "fired", firedTurnId: "message:wakeup:fired-1" }));
    expect(statuses(events).slice(-3)).toEqual(["scheduled", "running", "completed"]);
    stop();
    await provider.dispose();
  });

  test("a recurring cron fires and stays pending; a typed prompt during the scheduled state is the user's", async () => {
    const { provider, events, stop, session, query } = await scheduled([recurring]);
    await promptHook(query, { prompt: recurring.prompt, prompt_id: "fired-1" });
    query.push({ type: "system", subtype: "init", uuid: "i2", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    await stopHook(query, { session_crons: [recurring] });
    query.push(result(session.id, "res2"));
    await waitFor(() => events.filter(event => event.eventType === "turn.scheduled").length === 2);
    expect(rows(events).every(row => row.status === "pending")).toBe(true);
    // The user types the cron's very text while it is pending: an accepted
    // prompt is outstanding, so its hook is theirs, not a wakeup.
    await provider.prompt(session.id, { id: "r3", text: recurring.prompt, delivery: "queue" });
    await promptHook(query, { prompt: recurring.prompt, prompt_id: "typed-3" });
    await stopHook(query, { session_crons: [recurring] });
    query.push(result(session.id, "res3"));
    await waitFor(() => events.filter(event => event.eventType === "turn.scheduled").length === 3);
    const wakeupTurns = events.flatMap(event => event.updates).filter(update => update.kind === "upsert" && update.item.type === "user_message" && (update.item as { origin?: string }).origin === "wakeup");
    expect(wakeupTurns.map(update => (update as { item: { id: string } }).item.id)).toEqual(["message:wakeup:fired-1"]);
    // The pending wakeup is still listed after the typed turn (spec).
    expect(await provider.listScheduledWakeups()).toHaveLength(1);
    stop();
    await provider.dispose();
  });

  test("a hook source is honored when the CLI sends one", async () => {
    const { provider, events, stop, query } = await scheduled([oneShot]);
    await promptHook(query, { prompt: "a peer message", prompt_id: "sys-1", source: "system" });
    await promptHook(query, { prompt: "continue the loop", prompt_id: "loop-1", source: "loop_wakeup" });
    await waitFor(() => events.some(event => event.eventType === "wakeup.fired"));
    const opened = events.filter(event => event.eventType === "wakeup.fired").flatMap(event => event.updates);
    // Only the wakeup source opens a wakeup turn; a prompt matching no cron has no wakeup id.
    expect(opened).toEqual([{ kind: "upsert", item: expect.objectContaining({ id: "message:wakeup:loop-1", origin: "wakeup" }) }]);
    expect((opened[0] as { item: Record<string, unknown> }).item.wakeupId).toBeUndefined();
    stop();
    await provider.dispose();
  });

  test("release ends a scheduled session: rows cancelled, idle, and the next prompt resumes fresh", async () => {
    const { provider, queries, events, stop, session, query } = await scheduled([oneShot, recurring]);
    await provider.release(session.id);
    expect(query.returned).toBe(true);
    expect(provider.liveSessionCount()).toBe(0);
    const released = events.find(event => event.eventType === "session.released")!;
    expect(released.updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:w1", status: "cancelled" }) },
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:c1", status: "cancelled" }) },
      { kind: "status", status: "idle" },
    ]);
    // The process is gone on purpose: nothing reads as lost afterwards.
    await Bun.sleep(10);
    expect(rows(events).some(row => row.status === "lost")).toBe(false);
    expect(await provider.listScheduledWakeups()).toEqual([]);
    // Releasing again is a no-op; the next prompt starts a fresh query.
    await provider.release(session.id);
    await provider.prompt(session.id, { id: "r2", text: "again", delivery: "queue" });
    expect(queries).toHaveLength(2);
    queries[1]!.push(result(session.id, "res2"));
    await waitFor(() => queries[1]!.returned);
    stop();
    await provider.dispose();
  });

  test("releasing more than 256 wakeups keeps every cancellation: the oldest still blocks its rebuilt fire", async () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ id: `m${index}`, schedule: "*/5 * * * *", recurring: true, prompt: `CRON job ${index}` }));
    const { provider, queries, events, stop, session } = await scheduled(many);
    await provider.release(session.id);
    // Resumed with every cron rebuilt and one more holding the session.
    const other = { id: "o1", schedule: "*/10 * * * *", recurring: true, prompt: "OTHER check" };
    await provider.prompt(session.id, { id: "r2", text: "again", delivery: "queue" });
    const next = queries[1]!;
    await promptHook(next, { prompt: "again", prompt_id: "typed-2" });
    await stopHook(next, { session_crons: [...many, other] });
    next.push(result(session.id, "res2"));
    await waitFor(() => events.filter(event => event.eventType === "turn.scheduled").length === 2);
    expect((await provider.listScheduledWakeups()).map(wakeup => wakeup.wakeupId)).toEqual(["o1"]);
    expect(await promptHook(next, { prompt: many[0]!.prompt, prompt_id: "fired-0" })).toEqual({ decision: "block", reason: expect.any(String) });
    stop();
    await provider.dispose();
  });

  test("a cancel or release whose write fails leaves nothing cancelled: the wakeup stays listed and unblocked", async () => {
    const { provider, events, stop, session, query, workspace } = await scheduled([oneShot, recurring]);
    // The state file's temporary path is a directory: every write fails.
    mkdirSync(path.join(workspace, ".uatu-test-state.json.tmp"));
    await expect(provider.cancelWakeup(session.id, "c1")).rejects.toThrow();
    await expect(provider.release(session.id)).rejects.toThrow();
    expect(events.some(event => event.eventType === "wakeup.cancelled" || event.eventType === "session.released")).toBe(false);
    expect((await provider.listScheduledWakeups()).map(wakeup => wakeup.wakeupId)).toEqual(["w1", "c1"]);
    expect(query.returned).toBe(false);
    expect(await promptHook(query, { prompt: recurring.prompt, prompt_id: "fired-1" })).toEqual({ continue: true });
    stop();
    await provider.dispose();
  });

  test("release is refused, and records nothing, when a turn starts while its cancellations are written", async () => {
    const { provider, events, stop, session, query } = await scheduled([oneShot]);
    const releasing = provider.release(session.id);
    // The CLI starts a turn of its own (its init) while the write is in flight.
    query.push({ type: "system", subtype: "init", uuid: "i2", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    await expect(releasing).rejects.toBeInstanceOf(ReleaseUnavailableError);
    expect(query.returned).toBe(false);
    expect(events.some(event => event.eventType === "session.released")).toBe(false);
    // Nothing stays cancelled: the wakeup is still held, and its fire is not blocked.
    expect((await provider.listScheduledWakeups()).map(wakeup => wakeup.wakeupId)).toEqual(["w1"]);
    await stopHook(query, { session_crons: [oneShot] });
    query.push(result(session.id, "res2"));
    await waitFor(() => events.filter(event => event.eventType === "turn.scheduled").length === 2);
    expect(await promptHook(query, { prompt: oneShot.prompt, prompt_id: "fired-1" })).toEqual({ continue: true });
    stop();
    await provider.dispose();
  });

  test("release is refused while a wakeup that passed its hook has not yet started its turn", async () => {
    const { provider, events, stop, session, query } = await scheduled([oneShot]);
    await promptHook(query, { prompt: oneShot.prompt, prompt_id: "fired-1" });
    await expect(provider.release(session.id)).rejects.toBeInstanceOf(ReleaseUnavailableError);
    // The turn runs to its Stop and the one-shot reads fired, not cancelled.
    query.push({ type: "system", subtype: "init", uuid: "i2", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    await stopHook(query, { session_crons: [] });
    query.push(result(session.id, "res2"));
    await waitFor(() => query.returned);
    expect(rows(events).at(-1)).toEqual(expect.objectContaining({ id: "wakeup:w1", status: "fired", firedTurnId: "message:wakeup:fired-1" }));
    stop();
    await provider.dispose();
  });

  test("of two pending one-shots sharing a prompt, the fire goes to the one due first", async () => {
    // Created first but due later (a fixed time half a day away, so it can never
    // share the coming minute with the every-minute one) vs. due within the minute.
    const laterHour = (new Date().getHours() + 12) % 24;
    const later = { id: "wa", schedule: `3 ${laterHour} * * *`, recurring: false, prompt: "WAKEUP same words" };
    const sooner = { id: "wb", schedule: "* * * * *", recurring: false, prompt: "WAKEUP same words" };
    const { provider, events, stop, query } = await scheduled([later, sooner]);
    await promptHook(query, { prompt: later.prompt, prompt_id: "fired-1" });
    await waitFor(() => events.some(event => event.eventType === "wakeup.fired"));
    expect(events.find(event => event.eventType === "wakeup.fired")!.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ id: "message:wakeup:fired-1", wakeupId: "wb" }) }]);
    await stopHook(query, { session_crons: [later] });
    await waitFor(() => rows(events).some(row => row.id === "wakeup:wb" && row.status !== "pending"));
    const reconciled = events.filter(event => event.eventType === "wakeups.reconciled").at(-1)!;
    expect(reconciled.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ id: "wakeup:wb", status: "fired", firedTurnId: "message:wakeup:fired-1" }) }]);
    expect((await provider.listScheduledWakeups()).map(wakeup => wakeup.wakeupId)).toEqual(["wa"]);
    stop();
    await provider.dispose();
  });

  test("a same-prompt fire the Stop proves went to the other one-shot moves there, header and all", async () => {
    // Identical schedules: nothing tells them apart at fire time.
    const first = { id: "wa", schedule: "3 20 * * *", recurring: false, prompt: "WAKEUP same words" };
    const second = { id: "wb", schedule: "3 20 * * *", recurring: false, prompt: "WAKEUP same words" };
    const { provider, events, stop, query } = await scheduled([first, second]);
    await promptHook(query, { prompt: first.prompt, prompt_id: "fired-1" });
    await waitFor(() => events.some(event => event.eventType === "wakeup.fired"));
    expect(events.find(event => event.eventType === "wakeup.fired")!.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ wakeupId: "wa" }) }]);
    // The CLI still lists wa: wb is the one that fired, and it was not cancelled.
    await stopHook(query, { session_crons: [first] });
    await waitFor(() => rows(events).some(row => row.id === "wakeup:wb" && row.status !== "pending"));
    const reconciled = events.filter(event => event.eventType === "wakeups.reconciled").at(-1)!;
    expect(reconciled.updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "message:wakeup:fired-1", type: "user_message", origin: "wakeup", wakeupId: "wb", text: first.prompt }) },
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:wb", status: "fired", firedTurnId: "message:wakeup:fired-1" }) },
    ]);
    expect((await provider.listScheduledWakeups()).map(wakeup => wakeup.wakeupId)).toEqual(["wa"]);
    stop();
    await provider.dispose();
  });

  test("release is refused while a turn runs or background work would die with it", async () => {
    const { provider, stop, session, query } = await scheduled([oneShot]);
    await provider.prompt(session.id, { id: "r2", text: "meanwhile", delivery: "queue" });
    await expect(provider.release(session.id)).rejects.toBeInstanceOf(ReleaseUnavailableError);
    query.push(result(session.id, "res2"));
    await waitFor(() => provider.liveSessionCount() === 1 && !query.returned);
    stop();
    await provider.dispose();
    const busy = await scheduled([oneShot], { background: true });
    await expect(busy.provider.release(busy.session.id)).rejects.toThrow(/background work/);
    expect(busy.provider.liveSessionCount()).toBe(1);
    busy.stop();
    await busy.provider.dispose();
  });

  test("a process that exits with wakeups pending marks them lost with the notice and returns to idle", async () => {
    const { provider, events, stop, query } = await scheduled([oneShot]);
    await query.return();
    await waitFor(() => events.some(event => event.eventType === "turn.background-cleared"));
    const cleared = events.find(event => event.eventType === "turn.background-cleared")!;
    expect(cleared.updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:w1", status: "lost", message: expect.stringContaining("did not survive its session") }) },
      { kind: "status", status: "idle" },
    ]);
    expect(await provider.listScheduledWakeups()).toEqual([]);
    stop();
    await provider.dispose();
  });

  test("a process that exits with a cron pending marks it paused, not lost, and a self-paced wakeup lost", async () => {
    const { provider, events, stop, query } = await scheduled([oneShot, recurring]);
    await query.return();
    await waitFor(() => events.some(event => event.eventType === "turn.background-cleared"));
    expect(events.find(event => event.eventType === "turn.background-cleared")!.updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:w1", status: "lost", message: expect.stringContaining("did not survive its session") }) },
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:c1", status: "paused", message: WAKEUP_PAUSED_MESSAGE }) },
      { kind: "status", status: "idle" },
    ]);
    // A paused row carries no fire time: nothing fires until a session runs.
    expect(rows(events).find(row => row.id === "wakeup:c1" && row.status === "paused")!.nextFireAt).toBeUndefined();
    stop();
    await provider.dispose();
  });

  test("a cron the resumed session rebuilt, with no call seen in this process, is a cron; a one-shot cron's pause says when it lapses", async () => {
    const rebuilt = { id: "r9", schedule: "34 21 24 9 *", recurring: false, prompt: "ONCE remind me" };
    const context = fixture();
    const { events, stop } = collect(context.provider);
    const session = await context.provider.createSession("x");
    await context.provider.prompt(session.id, { id: "r1", text: "hi", delivery: "queue" });
    const query = context.queries[0]!;
    await promptHook(query, { prompt: "hi", prompt_id: "typed-1" });
    await stopHook(query, { session_crons: [rebuilt] });
    query.push(result(session.id, "res1"));
    await waitFor(() => events.some(event => event.eventType === "turn.scheduled"));
    await query.return();
    await waitFor(() => events.some(event => event.eventType === "turn.background-cleared"));
    expect(rows(events).at(-1)).toEqual(expect.objectContaining({ id: "wakeup:r9", status: "paused", message: WAKEUP_PAUSED_ONCE_MESSAGE }));
    stop();
    await context.provider.dispose();
  });

  test("a failed process and a workspace shutdown each mark pending wakeups lost", async () => {
    const failed = await scheduled([oneShot, recurring]);
    failed.query.fail(new Error("child process died"));
    await waitFor(() => failed.events.some(event => event.eventType === "session.failed"));
    expect(failed.events.find(event => event.eventType === "session.failed")!.updates.slice(0, 2)).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:w1", status: "lost" }) },
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:c1", status: "paused" }) },
    ]);
    failed.stop();
    await failed.provider.dispose();

    const shutdown = await scheduled([oneShot, recurring]);
    await shutdown.provider.dispose();
    await waitFor(() => shutdown.events.some(event => event.eventType === "wakeups.lost"));
    expect(shutdown.events.find(event => event.eventType === "wakeups.lost")!.updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:w1", status: "lost", message: expect.stringContaining("did not survive") }) },
      { kind: "upsert", item: expect.objectContaining({ id: "wakeup:c1", status: "paused", message: WAKEUP_PAUSED_MESSAGE }) },
      { kind: "status", status: "idle" },
    ]);
    expect(shutdown.query.returned).toBe(true);
    shutdown.stop();
  });

  test("a released cron the resumed session rebuilds is blocked: no model turn, no status, no notification", async () => {
    const { provider, queries, events, stop, session } = await scheduled([recurring]);
    await provider.release(session.id);
    // The next prompt resumes the session; the CLI rebuilds the cron.
    await provider.prompt(session.id, { id: "r2", text: "something else", delivery: "queue" });
    const resumed = queries[1]!;
    await promptHook(resumed, { prompt: "something else", prompt_id: "typed-2" });
    await stopHook(resumed, { session_crons: [recurring] });
    resumed.push(result(session.id, "res2"));
    await waitFor(() => events.filter(event => event.eventType === "result").length >= 2);
    // A cancelled cron holds nothing: the turn ends and the session retires.
    await waitFor(() => resumed.returned);
    expect(events.some(event => event.eventType === "turn.scheduled" && events.indexOf(event) > events.findIndex(candidate => candidate.eventType === "session.released"))).toBe(false);
    // The row is not reopened by the rebuilt cron.
    expect(rows(events).at(-1)).toEqual(expect.objectContaining({ id: "wakeup:c1", status: "cancelled" }));
    stop();
    await provider.dispose();
  });

  test("a cancelled cron's fire is blocked at the hook and its frames are swallowed", async () => {
    const { provider, queries, events, stop, session } = await scheduled([recurring]);
    await provider.release(session.id);
    await provider.prompt(session.id, { id: "r2", text: "keep going", delivery: "queue" });
    const resumed = queries[1]!;
    await promptHook(resumed, { prompt: "keep going", prompt_id: "typed-2" });
    // Another wakeup keeps this session up, so the cancelled cron can fire in it.
    const other = { id: "o1", schedule: "*/10 * * * *", recurring: true, prompt: "OTHER check" };
    await stopHook(resumed, { session_crons: [recurring, other] });
    resumed.push(result(session.id, "res2"));
    await waitFor(() => events.filter(event => event.eventType === "turn.scheduled").length === 2);
    const before = events.length;
    // The spike's blocked fire: the hook answers block, then the CLI sends
    // init, an informational notice, and a result — no assistant frame.
    const answer = await promptHook(resumed, { prompt: recurring.prompt, prompt_id: "fired-9" });
    expect(answer).toEqual({ decision: "block", reason: expect.stringContaining("no longer fires") });
    resumed.push({ type: "system", subtype: "init", uuid: "i9", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    resumed.push({ type: "system", subtype: "informational", uuid: "n9", session_id: session.id, content: "UserPromptSubmit operation blocked by hook" });
    resumed.push(result(session.id, "res9"));
    // The next real turn still reads normally: the other wakeup fires.
    await promptHook(resumed, { prompt: other.prompt, prompt_id: "fired-10" });
    resumed.push({ type: "system", subtype: "init", uuid: "i10", session_id: session.id, model: "claude-haiku-4-5-20251001" });
    await waitFor(() => events.some(event => event.eventType === "turn.unprompted"));
    const after = events.slice(before);
    // Nothing from the blocked fire: the first events are the next real
    // turn's (its opening header, its start, its own init).
    expect(after.map(event => event.eventType)).toEqual(["wakeup.fired", "turn.unprompted", "system"]);
    expect(after.flatMap(event => event.updates).filter(update => update.kind === "status").map(update => (update as { status: string }).status)).toEqual(["running"]);
    expect(after.flatMap(event => event.notificationTurns ?? []).map(turn => turn.phase)).toEqual(["started"]);
    expect(provider.liveSessionCount()).toBe(1);
    stop();
    await provider.dispose();
  });

  test("the cancel survives a restart: a new provider blocks the rebuilt cron", async () => {
    const context = fixture();
    const { events, stop } = collect(context.provider);
    const session = await context.provider.createSession("x");
    await context.provider.prompt(session.id, { id: "r1", text: "poll", delivery: "queue" });
    const query = context.queries[0]!;
    await promptHook(query, { prompt: "poll", prompt_id: "typed-1" });
    await stopHook(query, { session_crons: [recurring] });
    query.push(result(session.id, "res1"));
    await waitFor(() => events.some(event => event.eventType === "turn.scheduled"));
    await context.provider.release(session.id);
    stop();
    await context.provider.dispose();
    // Same workspace, same state file, a fresh process.
    const queries: FakeQuery[] = [];
    const restarted = new ClaudeProvider({
      workspacePath: context.workspace, stateFile: path.join(context.workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir: context.configDir, catalogProbe: false,
      queryFactory: input => { const next = new FakeQuery(input); queries.push(next); return next; },
    });
    await restarted.prompt(session.id, { id: "r2", text: "hello again", delivery: "queue" });
    await promptHook(queries[0]!, { prompt: "hello again", prompt_id: "typed-2" });
    queries[0]!.push(result(session.id, "res2"));
    await waitFor(() => queries[0]!.returned);
    // Resumed again with the cancelled cron rebuilt and another one holding
    // the session: the cancelled one is not listed, and its fire is refused.
    const other = { id: "o1", schedule: "*/10 * * * *", recurring: true, prompt: "OTHER check" };
    const after = collect(restarted);
    await restarted.prompt(session.id, { id: "r3", text: "and again", delivery: "queue" });
    await promptHook(queries[1]!, { prompt: "and again", prompt_id: "typed-3" });
    await stopHook(queries[1]!, { session_crons: [recurring, other] });
    queries[1]!.push(result(session.id, "res3"));
    await waitFor(() => after.events.some(event => event.eventType === "turn.scheduled"));
    expect((await restarted.listScheduledWakeups()).map(wakeup => wakeup.wakeupId)).toEqual(["o1"]);
    expect(await promptHook(queries[1]!, { prompt: recurring.prompt, prompt_id: "fired-1" })).toEqual({ decision: "block", reason: expect.any(String) });
    expect(await promptHook(queries[1]!, { prompt: other.prompt, prompt_id: "fired-2" })).toEqual({ continue: true });
    after.stop();
    await restarted.dispose();
  });

  test("cancelling one of two live wakeups keeps the session scheduled for the other; the last one retires it", async () => {
    const { provider, events, stop, session, query } = await scheduled([oneShot, recurring]);
    await provider.cancelWakeup(session.id, "c1");
    await waitFor(() => events.some(event => event.eventType === "wakeup.cancelled"));
    expect(rows(events).at(-1)).toEqual(expect.objectContaining({ id: "wakeup:c1", status: "cancelled" }));
    expect((await provider.listScheduledWakeups()).map(wakeup => wakeup.wakeupId)).toEqual(["w1"]);
    expect(query.returned).toBe(false);
    expect(statuses(events).at(-1)).toBe("scheduled");
    // The CLI still lists c1 at the next Stop; it holds nothing.
    await provider.prompt(session.id, { id: "r2", text: "anything", delivery: "queue" });
    await promptHook(query, { prompt: "anything", prompt_id: "typed-2" });
    await stopHook(query, { session_crons: [oneShot, recurring] });
    query.push(result(session.id, "res2"));
    await waitFor(() => events.filter(event => event.eventType === "turn.scheduled").length === 2);
    expect((await provider.listScheduledWakeups()).map(wakeup => wakeup.wakeupId)).toEqual(["w1"]);
    await provider.cancelWakeup(session.id, "w1");
    await waitFor(() => query.returned);
    expect(statuses(events).at(-1)).toBe("idle");
    await expect(provider.cancelWakeup(session.id, "nope")).rejects.toBeInstanceOf(ScheduledWakeupUnavailableError);
    stop();
    await provider.dispose();
  });

  describe("paused crons of a conversation with no live session (D11)", () => {
    function transcriptProvider(name: keyof typeof spikeRevival.sessions, at: (records: Array<Record<string, unknown>>) => number) {
      const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-paused-")));
      const workspace = path.join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const configDir = path.join(root, "config");
      mkdirSync(claudeProjectDir(workspace, configDir), { recursive: true });
      const records = spikeRevival.sessions[name].map(record => ({ ...record, cwd: workspace })) as Array<Record<string, unknown>>;
      writeFileSync(path.join(claudeProjectDir(workspace, configDir), "resumable.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
      const created = Date.parse(String(records.find(record => (record.toolUseResult as { id?: unknown } | undefined)?.id)!.timestamp));
      const queries: FakeQuery[] = [];
      const provider = new ClaudeProvider({
        workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
        now: () => at(records) || created + 60_000,
        queryFactory: input => { const next = new FakeQuery(input); queries.push(next); return next; },
      });
      return { provider, queries, workspace, configDir };
    }

    test("a reopened conversation lists its surviving cron as paused; cancelling it needs no session and sticks", async () => {
      const { provider, queries } = transcriptProvider("delete", () => 0);
      const { events, stop } = collect(provider);
      const paused = await provider.listPausedWakeups("resumable");
      expect(paused).toEqual([expect.objectContaining({ type: "scheduled_wakeup", status: "paused", prompt: "KEEP reply with exactly the word keep", recurring: true, message: WAKEUP_PAUSED_MESSAGE })]);
      expect(paused[0]!.nextFireAt).toBeUndefined();
      await provider.cancelWakeup("resumable", paused[0]!.wakeupId);
      expect(queries).toHaveLength(0);
      await waitFor(() => events.some(event => event.eventType === "wakeup.cancelled"));
      expect(events.find(event => event.eventType === "wakeup.cancelled")!.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ id: paused[0]!.id, status: "cancelled" }) }]);
      expect(await provider.listPausedWakeups("resumable")).toEqual([]);
      await expect(provider.cancelWakeup("resumable", paused[0]!.wakeupId)).rejects.toBeInstanceOf(ScheduledWakeupUnavailableError);
      stop();
      await provider.dispose();
    });

    test("a resumed session attributes a rebuilt cron's fire before any Stop, and the first Stop settles the rest", async () => {
      const { provider, queries } = transcriptProvider("block", () => 0);
      const { events, stop } = collect(provider);
      const [paused] = await provider.listPausedWakeups("resumable");
      await provider.prompt("resumable", { id: "r1", text: "back again", delivery: "queue" });
      const query = queries[0]!;
      expect(query.input.options.resume).toBe("resumable");
      await promptHook(query, { prompt: "back again", prompt_id: "typed-1" });
      query.push(result("resumable", "res1"));
      // The rebuilt cron fires within the minute, before any Stop listed it.
      await waitFor(() => query.returned || events.some(event => event.eventType === "result"));
      await Bun.sleep(5);
      // The session retired (no Stop reported crons); resume and let it fire.
      await provider.prompt("resumable", { id: "r2", text: "once more", delivery: "queue" });
      const next = queries.at(-1)!;
      await Bun.sleep(5);
      await promptHook(next, { prompt: "once more", prompt_id: "typed-2" });
      await stopHook(next, { session_crons: [{ id: paused!.wakeupId, schedule: "* * * * *", recurring: true, prompt: paused!.prompt }] });
      next.push(result("resumable", "res2"));
      await waitFor(() => events.some(event => event.eventType === "turn.scheduled"));
      await promptHook(next, { prompt: paused!.prompt, prompt_id: "fired-1" });
      await waitFor(() => events.some(event => event.eventType === "wakeup.fired"));
      expect(events.find(event => event.eventType === "wakeup.fired")!.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ origin: "wakeup", wakeupId: paused!.wakeupId }) }]);
      stop();
      await provider.dispose();
    });

    test("a rebuilt one-shot the CLI did not restore reads as lost at the first Stop", async () => {
      const { provider, queries } = transcriptProvider("missed", () => 0);
      const { events, stop } = collect(provider);
      // Read before the fire time: the transcript says it would come back.
      const [paused] = await provider.listPausedWakeups("resumable");
      expect(paused).toEqual(expect.objectContaining({ status: "paused", recurring: false, message: WAKEUP_PAUSED_ONCE_MESSAGE }));
      await provider.prompt("resumable", { id: "r1", text: "hello", delivery: "queue" });
      const query = queries[0]!;
      await waitFor(() => query.input.options.resume === "resumable");
      await Bun.sleep(20);
      await promptHook(query, { prompt: "hello", prompt_id: "typed-1" });
      await stopHook(query, { session_crons: [] });
      query.push(result("resumable", "res1"));
      await waitFor(() => events.some(event => event.eventType === "wakeups.reconciled"));
      expect(rows(events).at(-1)).toEqual(expect.objectContaining({ id: paused!.id, status: "lost", message: expect.stringContaining("did not restore") }));
      stop();
      await provider.dispose();
    });
  });

  test("the hooks wait for the resumed session's transcript read: a first Stop before it still settles an unrestored cron", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-prime-race-")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(root, "config");
    mkdirSync(claudeProjectDir(workspace, configDir), { recursive: true });
    const records = spikeRevival.sessions.missed.map(record => ({ ...record, cwd: workspace })) as Array<Record<string, unknown>>;
    writeFileSync(path.join(claudeProjectDir(workspace, configDir), "resumable.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const created = Date.parse(String(records.find(record => (record.toolUseResult as { id?: unknown } | undefined)?.id)!.timestamp));
    const queries: FakeQuery[] = [];
    const provider = new ClaudeProvider({
      workspacePath: workspace, stateFile: path.join(workspace, ".uatu-test-state.json"), executable: "/usr/local/bin/claude", configDir, catalogProbe: false,
      now: () => created + 60_000,
      queryFactory: input => { const next = new FakeQuery(input); queries.push(next); return next; },
    });
    const { events, stop } = collect(provider);
    const [paused] = await provider.listPausedWakeups("resumable");
    expect(paused).toBeDefined();
    await provider.prompt("resumable", { id: "r1", text: "hello", delivery: "queue" });
    const query = queries[0]!;
    // No pause for the read: the CLI's hooks arrive at once.
    await Promise.all([
      promptHook(query, { prompt: "hello", prompt_id: "typed-1" }),
      stopHook(query, { session_crons: [] }),
    ]);
    query.push(result("resumable", "res1"));
    await waitFor(() => events.some(event => event.eventType === "wakeups.reconciled"));
    expect(rows(events).at(-1)).toEqual(expect.objectContaining({ id: paused!.id, status: "lost" }));
    stop();
    await provider.dispose();
  });

  test("a clipped cron prompt still matches the whole prompt it fires", () => {
    expect(wakeupPromptMatches("same", "same")).toBe(true);
    expect(wakeupPromptMatches("check the build and… [+120 chars]", "check the build and then the deploy")).toBe(true);
    expect(wakeupPromptMatches("check the build", "check the build twice")).toBe(false);
    expect(wakeupPromptMatches("… [+5 chars]", "anything")).toBe(false);
  });
});
