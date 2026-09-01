import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import spike from "../../../tests/fixtures/claude-sdk/spike-messages.json";
import type { NormalizedProviderEvent } from "../provider";
import { createClaudeEventMemory, normalizeClaudeMessage } from "./normalization";
import { ClaudeProvider, type ClaudeQueryHandle, type ClaudeQueryInput, type ClaudeUserEnvelope } from "./provider";
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
    executable: "/usr/local/bin/claude",
    configDir,
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
    query.push({ type: "assistant", uuid: "a-1", timestamp: "2026-08-30T10:00:01.000Z", session_id: session.id, message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "pong" }] } });
    query.push({ type: "result", subtype: "success", uuid: "r-1", timestamp: "2026-08-30T10:00:02.000Z", session_id: session.id, is_error: false, usage: { input_tokens: 5, output_tokens: 2 } });
    await waitFor(() => events.some(event => event.updates.some(update => update.kind === "status" && update.status === "completed")));
    const texts = events.flatMap(event => event.updates).filter(update => update.kind === "upsert").map(update => (update as { item: { id: string } }).item.id);
    expect(texts).toContain("message:a-1");
    expect(texts).toContain("usage:r-1");
    // The turn retitled the pending conversation from its first prompt.
    expect(events.some(event => event.sessionLifecycle?.kind === "updated" && event.sessionLifecycle.title === "reply pong")).toBe(true);
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

  test("modes exclude bypass without the operator opt-in and include it with it", async () => {
    const { provider } = fixture();
    expect((await provider.listModes()).map(mode => mode.name)).toEqual(["default", "acceptEdits", "plan"]);
    await provider.dispose();

    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-bypass-")));
    mkdirSync(path.join(root, "ws"), { recursive: true });
    const optedIn = new ClaudeProvider({
      workspacePath: path.join(root, "ws"),
      executable: "/bin/claude",
      configDir: path.join(root, "cfg"),
      offerBypassPermissions: true,
      queryFactory: input => new FakeQuery(input),
    });
    expect((await optedIn.listModes()).map(mode => mode.name)).toContain("bypassPermissions");
    await optedIn.dispose();
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
    expect(await provider.getConversationConfiguration(session.id)).toEqual({
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

  test("the implement intent leaves planning for the default mode", async () => {
    const { provider, queries } = fixture();
    const session = await provider.createSession("x");
    await provider.prompt(session.id, { id: "r1", text: "plan it", delivery: "queue", mode: "plan" });
    const query = queries[0]!;
    const decision = query.input.options.canUseTool!("ExitPlanMode", { plan: "steps" }, { signal: new AbortController().signal, toolUseID: "p1" });
    await Bun.sleep(5);
    await provider.replyPermission(session.id, "p1", "once", "implement");
    await decision;
    expect((await provider.getConversationConfiguration(session.id)).mode).toBe("default");
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
      executable: "/bin/claude",
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

    await expect(provider.undo!(storedId)).rejects.toThrow("no longer available");
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
      executable: "/bin/claude",
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
