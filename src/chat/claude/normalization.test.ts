import { describe, expect, test } from "bun:test";

import { createClaudeEventMemory, describeSessionScopedUpdates, normalizeClaudeMessage, normalizeTranscriptEntries, sessionScopedSuggestions } from "./normalization";
import { parseConversationItem } from "../validation";
import forkedRuns from "../../../tests/fixtures/claude-sdk/forked-runs-2.1.280.json";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSessionTranscript } from "./transcript";

describe("Claude tool result completion timestamps", () => {
  const call = { type: "assistant", uuid: "call-frame", timestamp: "2026-09-15T10:00:00Z", message: { content: [
    { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pwd" } },
    { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
  ] } };
  const result = (id: string, timestamp: unknown, failed = false) => ({ type: "user", uuid: `result-${id}`, timestamp, message: { content: [
    { type: "tool_result", tool_use_id: id, content: "output", is_error: failed },
  ] } });

  test("live result frames match tool_use_id and preserve start time separately", () => {
    const memory = createClaudeEventMemory();
    const started = normalizeClaudeMessage(call, memory, "live");
    for (const update of started.updates) if (update.kind === "upsert") expect(update.item).not.toHaveProperty("completedAt");
    for (const [id, timestamp, failed] of [["read-1", "2026-09-15T10:00:02Z", true], ["bash-1", "2026-09-15T10:00:04Z", false]] as const) {
      const update = normalizeClaudeMessage(result(id, timestamp, failed), memory, "live").updates[0];
      expect(update).toMatchObject({ kind: "upsert", item: { id: `tool:${id}`, createdAt: Date.parse(call.timestamp), completedAt: Date.parse(timestamp), status: failed ? "failed" : "completed" } });
      if (update?.kind === "upsert") expect(parseConversationItem(JSON.parse(JSON.stringify(update.item)))).toEqual(update.item);
    }
    const progress = normalizeClaudeMessage({ type: "tool_progress", tool_use_id: "bash-1", elapsed_time_seconds: 7, timestamp: "2026-09-15T10:00:07Z" }, memory, "live").updates[0];
    expect(progress).toMatchObject({ kind: "upsert", item: { status: "running" } });
    if (progress?.kind === "upsert") expect(progress.item).not.toHaveProperty("completedAt");
  });

  test("history uses the result entry timestamp, with distinct terminal event identities", () => {
    const frames = [call, result("read-1", "2026-09-15T10:00:02Z", true), result("bash-1", "2026-09-15T10:00:04Z")];
    const { items } = normalizeTranscriptEntries(frames.map(frame => ({
      kind: frame.type as "assistant" | "user", uuid: frame.uuid, timestamp: Date.parse(frame.timestamp as string),
      message: frame.message, parentUuid: null, isSidechain: false, parentToolUseId: null,
    })));
    expect(items).toMatchObject([
      { id: "tool:bash-1", name: "Bash", completedAt: Date.parse("2026-09-15T10:00:04Z"), status: "completed" },
      { id: "tool:read-1", name: "Read", completedAt: Date.parse("2026-09-15T10:00:02Z"), status: "failed" },
    ]);
  });

  test("older emitters, malformed timestamps and turn duration never supply a completion time", () => {
    for (const timestamp of [undefined, null, "invalid", -1, NaN, Infinity]) {
      const memory = createClaudeEventMemory();
      normalizeClaudeMessage(call, memory, "live");
      const update = normalizeClaudeMessage(result("bash-1", timestamp), memory, "live").updates[0];
      expect(update).toMatchObject({ kind: "upsert", item: { status: "completed" } });
      if (update?.kind === "upsert") expect(update.item).not.toHaveProperty("completedAt");
      const turn = normalizeClaudeMessage({ type: "result", uuid: "turn", timestamp: "2026-09-15T10:00:09Z", duration_ms: 9000 }, memory, "live");
      expect(turn.updates).toEqual([{ kind: "status", status: "completed" }]);
    }
    expect(normalizeClaudeMessage(result("", "2026-09-15T10:00:04Z"), createClaudeEventMemory(), "live").updates).toEqual([]);
  });
});

// A skill Claude Code ran as a fork (spike Q3, probe d2): the launching
// Skill row is where the fork's transcript is opened from, and the id it
// opens is named only by the result that ends the fork (design D10).
describe("a forked skill's launching row", () => {
  const skillCall = { type: "assistant", uuid: "a1", timestamp: "2026-09-22T12:00:00.000Z", message: { role: "assistant", content: [
    { type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "code-review" } },
  ] } };
  const forkedResult = (outcome: Record<string, unknown>) => ({ type: "user", uuid: "u1", timestamp: "2026-09-22T12:02:00.000Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_skill", content: "Based on my analysis..." },
  ] }, tool_use_result: outcome });

  test("the forked result names the child conversation the row opens", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage(skillCall, memory, "live");
    const settled = normalizeClaudeMessage(forkedResult({ success: true, commandName: "code-review", status: "forked", agentId: "aaeeab292f002e3d7", result: "Based on my analysis..." }), memory, "live", "57489e13");
    expect(settled.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({
      id: "tool:toolu_skill",
      type: "tool",
      name: "Skill",
      status: "completed",
      childConversationId: "sub:57489e13:aaeeab292f002e3d7",
    }) }]);
    // A fork is not a background task: it announces none and needs no row.
    expect(settled.updates.every(update => update.kind !== "upsert" || update.item.type !== "background_task")).toBe(true);
  });

  test("a skill that never forked leaves the row with no transcript to open", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage(skillCall, memory, "live");
    const settled = normalizeClaudeMessage(forkedResult({ success: true, commandName: "code-review" }), memory, "live", "57489e13");
    const item = settled.updates.flatMap(update => update.kind === "upsert" ? [update.item] : [])[0]!;
    expect(item).not.toHaveProperty("childConversationId");
  });

  // The frame's one structured result names no tool use; the CLI gives each
  // result a frame of its own, so a frame answering two cannot say whose it is.
  test("a frame answering two tool uses lends its one structured result to neither", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage(skillCall, memory, "live");
    normalizeClaudeMessage({ type: "assistant", uuid: "a2", timestamp: "2026-09-22T12:00:01.000Z", message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_other", name: "Bash", input: { command: "ls" } },
    ] } }, memory, "live");
    const settled = normalizeClaudeMessage({ type: "user", uuid: "u2", timestamp: "2026-09-22T12:02:00.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_other", content: "README.md" },
      { type: "tool_result", tool_use_id: "toolu_skill", content: "Based on my analysis..." },
    ] }, tool_use_result: { success: true, commandName: "code-review", status: "forked", agentId: "aaeeab292f002e3d7", resolvedModel: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 5 } } }, memory, "live", "57489e13");
    const items = settled.updates.flatMap(update => update.kind === "upsert" ? [update.item] : []);
    expect(items.map(item => [item.id, item.type === "tool" ? item.status : undefined])).toEqual([["tool:toolu_other", "completed"], ["tool:toolu_skill", "completed"]]);
    for (const item of items) {
      expect(item).not.toHaveProperty("childConversationId");
      expect(item).not.toHaveProperty("model");
      expect(item).not.toHaveProperty("usage");
    }
  });
});

// What "Allow always" lists must be what the reply forwards. One filter
// feeds both, and these pin what that filter keeps and drops.
describe("Claude Code session-scoped permission updates", () => {
  const session = (update: Record<string, unknown>) => ({ destination: "session", ...update });

  test("rules render in Claude Code's rule syntax under the behavior they change", () => {
    expect(describeSessionScopedUpdates([
      session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "git status:*" }] }),
      session({ type: "replaceRules", behavior: "allow", rules: [{ toolName: "Read" }, { toolName: "Edit", ruleContent: "src/**" }] }),
      // Restrictive updates in the same bundle are forwarded and said too:
      // applying only the additions would leave a more permissive state
      // than Claude Code's own "always allow" produces.
      session({ type: "addRules", behavior: "deny", rules: [{ toolName: "Bash", ruleContent: "rm:*" }] }),
      session({ type: "removeRules", behavior: "allow", rules: [{ toolName: "WebFetch" }] }),
      session({ type: "addRules", behavior: "ask", rules: [{ toolName: "Write" }] }),
    ])).toEqual([
      "Allow: Bash(git status:*)",
      "Replace allow rules with: Read, Edit(src/**)",
      "Deny: Bash(rm:*)",
      "Remove allow rule: WebFetch",
      "Ask before: Write",
    ]);
  });

  test("directory grants, withdrawals, and mode switches are said in words", () => {
    expect(describeSessionScopedUpdates([
      session({ type: "addDirectories", directories: ["/tmp/work"] }),
      session({ type: "removeDirectories", directories: ["/tmp/old"] }),
      session({ type: "setMode", mode: "acceptEdits" }),
    ])).toEqual(["Working directory: /tmp/work", "Withdraw working directory: /tmp/old", "Permission mode: acceptEdits"]);
  });

  test("a suggestion bound for a settings file is neither listed nor forwarded", () => {
    const persisting = { type: "addRules", behavior: "allow", destination: "userSettings", rules: [{ toolName: "Write" }] };
    const suggestions = [persisting, session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Write" }] })];
    expect(describeSessionScopedUpdates(suggestions)).toEqual(["Allow: Write"]);
    expect(sessionScopedSuggestions(suggestions)).toEqual([suggestions[1]]);
  });

  test("malformed suggestions are dropped whole", () => {
    const suggestions = [
      session({ type: "addRules", behavior: "allow", rules: [] }),
      session({ type: "addRules", behavior: "sometimes", rules: [{ toolName: "Bash" }] }),
      session({ type: "addDirectories", directories: [] }),
      // One bad rule drops the whole suggestion: the reply would otherwise
      // forward a rule the card never showed.
      session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "git status:*" }, { toolName: 42 }] }),
      session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "" }] }),
      { destination: "session" },
      null,
      "addRules",
    ];
    expect(describeSessionScopedUpdates(suggestions)).toEqual([]);
    expect(sessionScopedSuggestions(suggestions)).toEqual([]);
  });

  test("no suggestions at all is an empty list for both", () => {
    expect(describeSessionScopedUpdates(undefined)).toEqual([]);
    expect(sessionScopedSuggestions(undefined)).toEqual([]);
  });

  test("the listed lines and the forwarded updates agree one to one", () => {
    const suggestions = [
      session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }] }),
      { type: "addRules", behavior: "allow", destination: "projectSettings", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }] },
      session({ type: "addDirectories", directories: ["/workspace"] }),
    ];
    expect(describeSessionScopedUpdates(suggestions)).toHaveLength(sessionScopedSuggestions(suggestions).length);
  });
});

describe("Claude normalization: what it skips, it reports", () => {
  const at = "2026-09-24T10:00:00Z";

  test("unknown content blocks are skipped by type while the known blocks still render", () => {
    const memory = createClaudeEventMemory();
    const normalized = normalizeClaudeMessage({ type: "assistant", uuid: "a1", timestamp: at, message: { id: "msg_1", content: [
      { type: "redacted_thinking", data: "opaque-secret" },
      { type: "text", text: "Here is the answer." },
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } },
    ] } }, memory, "live");
    expect(normalized.outcome).toBe("handled");
    expect(normalized.skippedBlocks).toEqual(["redacted_thinking", "server_tool_use"]);
    const items = normalized.updates.flatMap(update => update.kind === "upsert" ? [update.item] : []);
    expect(items.map(item => item.id)).toEqual(["tool:toolu_1", "message:a1"]);
    // Types only: the skipped payload never rides the event.
    expect(JSON.stringify(normalized)).not.toContain("opaque-secret");
  });

  test("a message of known blocks reports nothing skipped", () => {
    const normalized = normalizeClaudeMessage({ type: "assistant", uuid: "a2", timestamp: at, message: { content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "ok" },
    ] } }, createClaudeEventMemory(), "live");
    expect(normalized.skippedBlocks).toBeUndefined();
  });

  test("a user frame reports blocks beside its tool results that no reader handles", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "assistant", uuid: "a3", timestamp: at, message: { content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: {} }] } }, memory, "live");
    const normalized = normalizeClaudeMessage({ type: "user", uuid: "u3", timestamp: at, message: { content: [
      { type: "tool_result", tool_use_id: "toolu_2", content: "file" },
      { type: "document", source: { type: "text", data: "private" } },
    ] } }, memory, "live");
    expect(normalized.outcome).toBe("handled");
    expect(normalized.skippedBlocks).toEqual(["document"]);
  });

  test("unknown blocks are reported even when the user frame itself is dropped", () => {
    const memory = createClaudeEventMemory();
    // A live echo is dropped whole (the provider minted the message), and a
    // stored record of nothing readable is dropped too; both still report.
    const echo = normalizeClaudeMessage({ type: "user", uuid: "u4", timestamp: at, message: { content: [{ type: "text", text: "hi" }, { type: "document", source: {} }] } }, memory, "live");
    expect(echo.outcome).toBe("ignored");
    expect(echo.skippedBlocks).toEqual(["document"]);
    const stored = normalizeClaudeMessage({ type: "user", uuid: "u5", timestamp: at, message: { content: [{ type: "search_result" }] } }, memory, "stored");
    expect(stored.outcome).toBe("ignored");
    expect(stored.skippedBlocks).toEqual(["search_result"]);
    // A stored task notification settles its row and still reports what it skipped.
    const notified = normalizeClaudeMessage({ type: "user", uuid: "u6", timestamp: at, origin: "task-notification", message: { content: [
      { type: "text", text: "<task-notification><task-id>t1</task-id><status>completed</status><summary>done</summary></task-notification>" },
      { type: "document", source: {} },
    ] } }, memory, "stored");
    expect(notified.outcome).toBe("handled");
    expect(notified.skippedBlocks).toEqual(["document"]);
  });

  test("a recognized message whose payload throws is unparseable and the next message still normalizes", () => {
    const memory = createClaudeEventMemory();
    const broken = { type: "assistant", uuid: "a4", timestamp: at, get message(): unknown { throw new Error("broken payload"); } };
    expect(normalizeClaudeMessage(broken, memory, "live")).toEqual({ updates: [], eventType: "assistant", outcome: "unparseable" });
    const next = normalizeClaudeMessage({ type: "assistant", uuid: "a5", timestamp: at, message: { content: [{ type: "text", text: "still here" }] } }, memory, "live");
    expect(next.outcome).toBe("handled");
    expect(JSON.stringify(next.updates)).toContain("still here");
  });

  test("an unmatched system subtype is unrecognized under its subtype unless deliberately ignored", () => {
    const memory = createClaudeEventMemory();
    const noFallback = normalizeClaudeMessage({ type: "system", subtype: "model_refusal_no_fallback", uuid: "s1", timestamp: at }, memory, "live");
    expect(noFallback.outcome).toBe("unrecognized");
    expect(noFallback.eventType).toBe("system.model_refusal_no_fallback");
    const hook = normalizeClaudeMessage({ type: "system", subtype: "hook_started", uuid: "s2", timestamp: at, hook_id: "h", hook_name: "n", hook_event: "Stop" }, memory, "live");
    expect(hook.outcome).toBe("ignored");
    expect(hook.eventType).toBe("system");
    // An init that names no model has nothing to configure; it is not new vocabulary.
    expect(normalizeClaudeMessage({ type: "system", subtype: "init", uuid: "s3", timestamp: at }, memory, "live").outcome).toBe("ignored");
  });
});

// Spike Q4/Q5 (CLI 2.1.280), frames verbatim: what a typed command and a
// forked skill leave in the parent's timeline (design D13, D15).
describe("forked runs and typed command output", () => {
  type Frame = Record<string, unknown>;
  const typed = forkedRuns.typedCodeReview.live as Frame[];
  const stored = forkedRuns.typedCodeReview.stored as Frame[];
  const fork = forkedRuns.skillFork.live as Frame[];
  const synthetic = typed.find(frame => frame.type === "assistant")!;
  const PARENT = "005827e7-6bd9-4ba2-881e-58bd08fc57ed";

  test("the command output frame renders its text but names no model and spends nothing", () => {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "system", subtype: "init", uuid: "i1", session_id: PARENT, model: "claude-haiku-4-5" }, memory, "live", PARENT);
    const normalized = normalizeClaudeMessage(synthetic, memory, "live", PARENT);
    expect(normalized.updates).toEqual([{ kind: "upsert", item: {
      id: `message:${synthetic.uuid as string}`, type: "assistant_message", createdAt: Date.parse(synthetic.timestamp as string),
      markdown: "math.ts:2 — function named `add` now returns subtraction (`a - b`) instead of addition, inverting the function's contract",
      completedAt: Date.parse(synthetic.timestamp as string),
    } }]);
    expect(normalized.assistantModel).toBeUndefined();
    expect(normalized.assistantUsage).toBeUndefined();
    // The conversation's model is still the one the session named.
    expect(memory.lastModel).toBe("claude-haiku-4-5");
  });

  test("the stored command output renders on reopen as the live one did; the caveat does not show", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "uatu-local-command-"));
    try {
      const file = path.join(dir, `${PARENT}.jsonl`);
      writeFileSync(file, stored.map(record => JSON.stringify(record)).join("\n") + "\n");
      const { entries } = await readSessionTranscript(file);
      const { items, accounting } = normalizeTranscriptEntries(entries, PARENT);
      const live = normalizeClaudeMessage(synthetic, createClaudeEventMemory(), "live", PARENT).updates[0];
      // The typed command as the person's message, then the command's
      // output — the same item, under the same id, the live frame produced.
      expect(items.map(item => item.type)).toEqual(["user_message", "assistant_message"]);
      expect(items[0]).toEqual(expect.objectContaining({ type: "user_message", text: "/code-review low" }));
      expect(live?.kind === "upsert" ? live.item : undefined).toEqual(items[1]);
      expect(accounting).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stored local command record with no output markup shows nothing; stdout alone is kept", () => {
    const entry = (uuid: string, content: string) => ({ kind: "system" as const, subtype: "local_command", content, uuid, timestamp: 1, message: {}, parentUuid: null, isSidechain: false, parentToolUseId: null });
    const { items } = normalizeTranscriptEntries([
      entry("a", "<command-name>/memory</command-name>\n<command-message>memory</command-message>\n<command-args></command-args>"),
      entry("b", "<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n<forked-skill-launch>{\"agentId\":\"x\"}</forked-skill-launch>"),
      entry("c", "<local-command-stdout></local-command-stdout>"),
    ]);
    expect(items).toEqual([expect.objectContaining({ id: "message:b", markdown: "Running in the background as @code-review" })]);
  });

  test("a typed command's run is a foreground run row from start to settle, never a background one", () => {
    const memory = createClaudeEventMemory();
    const [started, , notification] = typed;
    const start = normalizeClaudeMessage(started, memory, "live", PARENT);
    expect(start.outcome).toBe("handled");
    expect(start.updates).toEqual([{ kind: "upsert", item: {
      id: "task:ad53ca64bd188affb", type: "background_task", createdAt: expect.any(Number), taskId: "ad53ca64bd188affb",
      description: "/code-review", taskType: "local_agent", status: "running", subagentType: "general-purpose",
      childConversationId: `sub:${PARENT}:ad53ca64bd188affb`, foreground: true,
    } }]);
    if (start.updates[0]?.kind === "upsert") expect(parseConversationItem(JSON.parse(JSON.stringify(start.updates[0].item)))).toEqual(start.updates[0].item);
    // The notification repeats the ambient flag but not the task type: the
    // run is known by its id.
    const settled = normalizeClaudeMessage(notification, memory, "live", PARENT);
    expect(settled.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({ id: "task:ad53ca64bd188affb", status: "completed", summary: "/code-review", foreground: true }) }]);
    expect(memory.tasks.size).toBe(0);
    expect(memory.ambientTasks.size).toBe(0);
  });

  test("a forked skill's start edge opens its Skill row and mints no task row", () => {
    const memory = createClaudeEventMemory();
    const [skillCall, started] = fork;
    normalizeClaudeMessage(skillCall, memory, "live", "a4e9f74a-4d3f-425f-8711-f960e689b514");
    const start = normalizeClaudeMessage(started, memory, "live", "a4e9f74a-4d3f-425f-8711-f960e689b514");
    expect(start.updates).toEqual([{ kind: "upsert", item: expect.objectContaining({
      id: "tool:toolu_01CS76rQV6QvfD4HfdsJmk1r", type: "tool", name: "Skill", status: "running",
      childConversationId: "sub:a4e9f74a-4d3f-425f-8711-f960e689b514:afd1c64a374700d34",
    }) }]);
    const notification = fork.find(frame => frame.subtype === "task_notification")!;
    expect(normalizeClaudeMessage(notification, memory, "live", "a4e9f74a-4d3f-425f-8711-f960e689b514").updates).toEqual([]);
    expect(memory.tasks.size).toBe(0);
  });
});

// The frames a turn without a login produced on CLI 2.1.281 (2026-10-03, an
// isolated config directory): a synthetic assistant message naming the
// login error, then an error result with the same words.
describe("Claude login failures", () => {
  const failedLogin = {
    type: "assistant",
    uuid: "login-frame",
    timestamp: "2026-10-03T10:00:00Z",
    error: "authentication_failed",
    message: { id: "synthetic-1", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
  };
  const failedResult = { type: "result", subtype: "success", uuid: "login-result", timestamp: "2026-10-03T10:00:01Z", is_error: true, result: "Not logged in · Please run /login", terminal_reason: "api_error" };

  test("the synthetic message becomes a login-failure notice with the CLI's words, and the failed status does not repeat them", () => {
    const memory = createClaudeEventMemory();
    const notice = normalizeClaudeMessage(failedLogin, memory, "live");
    expect(notice.updates).toEqual([{ kind: "upsert", item: {
      id: "notice:login:login-frame",
      type: "notice",
      createdAt: Date.parse("2026-10-03T10:00:00Z"),
      level: "error",
      code: "login-failed",
      message: "Not logged in · Please run /login",
    } }]);
    const item = notice.updates[0]!.kind === "upsert" ? notice.updates[0]!.item : null;
    expect(parseConversationItem(JSON.parse(JSON.stringify(item)))).toEqual(item!);
    expect(normalizeClaudeMessage(failedResult, memory, "live").updates).toEqual([{ kind: "status", status: "failed" }]);
    // The next failure that is not a login one says its own words again.
    expect(normalizeClaudeMessage({ ...failedResult, uuid: "other", result: "Model not found" }, memory, "live").updates).toEqual([{ kind: "status", status: "failed", message: "Model not found" }]);
  });

  test("an organization the login may not use is a login failure too", () => {
    const update = normalizeClaudeMessage({ ...failedLogin, error: "oauth_org_not_allowed" }, createClaudeEventMemory(), "live").updates[0];
    expect(update).toMatchObject({ kind: "upsert", item: { code: "login-failed" } });
  });

  test("other assistant errors keep their message as a reply", () => {
    const updates = normalizeClaudeMessage({ ...failedLogin, error: "rate_limit" }, createClaudeEventMemory(), "live").updates;
    expect(updates.some(update => update.kind === "upsert" && update.item.type === "notice")).toBe(false);
  });

  test("a stored login failure replays as the same notice", () => {
    const { items } = normalizeTranscriptEntries([{
      kind: "assistant", uuid: "login-frame", timestamp: Date.parse("2026-10-03T10:00:00Z"), error: "authentication_failed",
      message: failedLogin.message, parentUuid: null, isSidechain: false, parentToolUseId: null,
    }]);
    expect(items).toMatchObject([{ id: "notice:login:login-frame", type: "notice", code: "login-failed", message: "Not logged in · Please run /login" }]);
  });

  test("the transcript reader keeps the stored login error, as the CLI writes it", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "uatu-claude-login-"));
    try {
      const file = path.join(directory, "session.jsonl");
      writeFileSync(file, `${JSON.stringify({
        type: "assistant", uuid: "login-frame", parentUuid: null, timestamp: "2026-10-03T10:00:00Z", isSidechain: false,
        error: "authentication_failed", isApiErrorMessage: true, message: failedLogin.message,
      })}\n`);
      const { entries } = await readSessionTranscript(file);
      expect(normalizeTranscriptEntries(entries).items).toMatchObject([{ id: "notice:login:login-frame", code: "login-failed" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("re-authentication is one notice while it runs, kept as a failure if it fails, retired if it succeeds", () => {
    const memory = createClaudeEventMemory();
    const frame = (fields: Record<string, unknown>) => ({ type: "auth_status", uuid: `auth-${JSON.stringify(fields)}`, timestamp: "2026-10-03T10:00:00Z", output: [], ...fields });
    expect(normalizeClaudeMessage(frame({ isAuthenticating: true, output: ["Refreshing token"] }), memory, "live").updates).toEqual([{ kind: "upsert", item: {
      id: "notice:auth-status", type: "notice", createdAt: Date.parse("2026-10-03T10:00:00Z"), level: "info", code: "reauthenticating", message: "Refreshing token",
    } }]);
    expect(normalizeClaudeMessage(frame({ isAuthenticating: false }), memory, "live").updates).toEqual([{ kind: "remove", itemId: "notice:auth-status" }]);
    expect(normalizeClaudeMessage(frame({ isAuthenticating: false }), memory, "live")).toMatchObject({ outcome: "ignored", updates: [] });
    expect(normalizeClaudeMessage(frame({ isAuthenticating: false, error: "Token refresh failed" }), memory, "live").updates[0]).toMatchObject({ kind: "upsert", item: { id: "notice:auth-status", level: "error", code: "login-failed", message: "Token refresh failed" } });
  });
});
