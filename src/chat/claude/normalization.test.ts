import { describe, expect, test } from "bun:test";

import { createClaudeEventMemory, describeSessionScopedUpdates, normalizeClaudeMessage, normalizeTranscriptEntries, sessionScopedSuggestions } from "./normalization";
import { parseConversationItem } from "../validation";

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
