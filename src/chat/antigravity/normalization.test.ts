import { describe, expect, test } from "bun:test";

import { CHAT_TEXT_SEAL, CHAT_TURN, provisionalTurn } from "../turn-liveness";
import { CHAT_VISUAL_MESSAGE } from "../visual-identity";
import type { ConversationItem } from "../types";
import { createAcpMemory, nextUserMessage, normalizeAcpUpdate, sealOpenBlock, type AcpMemory } from "./normalization";

const SESSION = "session-1";
const CWD = "/workspace";

function live(): AcpMemory {
  const memory = createAcpMemory(SESSION, CWD);
  memory.live = true;
  memory.turn = provisionalTurn();
  nextUserMessage(memory, "Prompt", 1);
  return memory;
}

const send = (memory: AcpMemory, update: Record<string, unknown>) => normalizeAcpUpdate({ sessionId: SESSION, update }, memory, 10);
const items = (result: ReturnType<typeof send>) => result.updates.flatMap(update => update.kind === "upsert" ? [update.item] : []);
const chunk = (sessionUpdate: string, text: string) => ({ sessionUpdate, content: { type: "text", text } });

describe("normalizeAcpUpdate (D5)", () => {
  test("streamed text appends to one reply that shares the turn's token and a visual identity", () => {
    const memory = live();
    send(memory, chunk("agent_message_chunk", "Hello, "));
    const [reply] = items(send(memory, chunk("agent_message_chunk", "world")));
    expect(reply).toEqual(expect.objectContaining({ id: `message:${SESSION}.a1.1`, type: "assistant_message", markdown: "Hello, world" }));
    expect((reply as Record<symbol, unknown>)[CHAT_TURN]).toBe(memory.turn);
    expect((reply as Record<symbol, unknown>)[CHAT_VISUAL_MESSAGE]).toBe(`antigravity:message:${SESSION}.a1.1`);
    expect((reply as Record<symbol, unknown>)[CHAT_TEXT_SEAL]).toBeUndefined();
  });

  test("a non-text update seals the reply's text; the next text is a new reply", () => {
    const memory = live();
    send(memory, chunk("agent_message_chunk", "Before the tool"));
    const sealed = items(send(memory, { sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress", kind: "read", title: "File README.md" }));
    expect(sealed[0]).toEqual(expect.objectContaining({ id: `message:${SESSION}.a1.1`, completedAt: 10 }));
    expect((sealed[0] as Record<symbol, unknown>)[CHAT_TEXT_SEAL]).toBe("ended");
    const [next] = items(send(memory, chunk("agent_message_chunk", "After")));
    expect(next!.id).toBe(`message:${SESSION}.a1.2`);
    expect(sealOpenBlock(memory, 11)).toHaveLength(1);
  });

  test("thoughts are reasoning rows that complete when sealed", () => {
    const memory = live();
    const [thought] = items(send(memory, chunk("agent_thought_chunk", "Thinking")));
    expect(thought).toEqual(expect.objectContaining({ id: `reasoning:${SESSION}.r1.1`, type: "reasoning", text: "Thinking", status: "running" }));
    expect(items({ updates: sealOpenBlock(memory, 12), outcome: "handled", eventType: "" })[0]).toEqual(expect.objectContaining({ status: "completed" }));
  });

  test("a command shows its output and exit code", () => {
    const memory = live();
    send(memory, { sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress", kind: "execute", title: "echo hi", rawInput: { CommandLine: "echo hi" } });
    const [command] = items(send(memory, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { output: "hi\n", exit_code: 0 } }));
    expect(command).toEqual({ id: "tool:c1", type: "command", createdAt: 10, command: "echo hi", status: "completed", completedAt: 10, output: "hi\n", exitCode: 0 });
  });

  test("a gated tool is waiting while its permission is open, and a denied one fails", () => {
    const memory = live();
    send(memory, { sessionUpdate: "tool_call", toolCallId: "w1", status: "in_progress", kind: "edit", title: "File hello.txt", locations: [{ path: "/workspace/hello.txt" }] });
    expect(items(send(memory, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "pending" }))[0]).toEqual(expect.objectContaining({ status: "pending" }));
    memory.awaitingPermission.add("w1");
    expect(items(send(memory, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "in_progress" }))[0]).toEqual(expect.objectContaining({ status: "pending" }));
    memory.awaitingPermission.delete("w1");
    const [failed] = items(send(memory, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "failed" }));
    expect(failed).toEqual(expect.objectContaining({ id: "tool:w1", type: "tool", name: "edit", status: "failed", input: JSON.stringify({ locations: ["hello.txt"] }) }));
  });

  test("an edit's diff is a file change in the workspace", () => {
    const memory = live();
    const rows = items(send(memory, { sessionUpdate: "tool_call", toolCallId: "w1", status: "completed", kind: "edit", title: "File hello.txt", content: [{ type: "diff", path: "/workspace/hello.txt", newText: "hello\n" }] }));
    expect(rows.map(row => row.type)).toEqual(["tool", "file_change"]);
    expect(rows[1]).toEqual(expect.objectContaining({ path: "hello.txt", operation: "create" }));
  });

  test("usage, titles, modes, config options and commands become their own events", () => {
    const memory = live();
    expect(items(send(memory, { sessionUpdate: "usage_update", used: 8918, size: 1048576 }))).toEqual([{ id: `context:${SESSION}`, type: "context_report", createdAt: 10, total: 8918, max: 1048576 }]);
    expect(send(memory, { sessionUpdate: "session_info_update", title: "A title" }).sessionLifecycle).toEqual({ kind: "updated", id: SESSION, directory: CWD, title: "A title", sparse: true });
    expect(send(memory, { sessionUpdate: "current_mode_update", currentModeId: "plan" }).configuration).toEqual({ mode: "plan" });
    expect(send(memory, { sessionUpdate: "config_option_update", configOptions: [{ id: "model", currentValue: "gemini-4-neon" }, { id: "thought_level", currentValue: "low" }] }).configuration)
      .toEqual({ model: { providerId: "antigravity", modelId: "gemini-4-neon" }, variant: "low" });
    expect(send(memory, { sessionUpdate: "available_commands_update", availableCommands: [] }).catalogsChanged).toBe(true);
  });

  test("an unknown update kind is unrecognized, so it is counted", () => {
    expect(send(live(), { sessionUpdate: "cursor_update" })).toEqual({ updates: [], outcome: "unrecognized", eventType: "cursor_update" });
    expect(send(live(), {} as Record<string, unknown>).outcome).toBe("unparseable");
  });

  test("replay rows are finished: user messages advance the position, replies are sealed and authoritative", () => {
    const memory = createAcpMemory(SESSION, CWD);
    const rows: ConversationItem[] = [];
    for (const update of [chunk("user_message_chunk", "First"), chunk("user_message_chunk", "A steer"), { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "" } }, chunk("agent_message_chunk", "Answer")]) {
      rows.push(...items(send(memory, update)));
    }
    expect(rows.map(row => row.id)).toEqual([`message:${SESSION}.u1`, `message:${SESSION}.u2`, `message:${SESSION}.u2`, `message:${SESSION}.a2.1`]);
    expect(rows[2]).toEqual(expect.objectContaining({ attachments: [{ name: "image", mimeType: "image/png" }] }));
    const reply = rows[3] as Record<symbol, unknown>;
    expect(reply[CHAT_TEXT_SEAL]).toBe("ended");
    expect(reply[CHAT_TURN]).toEqual({ completed: true, authority: "authoritative" });
    // Live prompts are the provider's own rows: a live echo is ignored.
    expect(send(live(), chunk("user_message_chunk", "Echo")).outcome).toBe("ignored");
  });

  test("an image in a reply is captured under antigravity:message:<id>", () => {
    const memory = live();
    const [reply] = items(send(memory, chunk("agent_message_chunk", "Here is a chart: ![chart](chart.svg)")));
    expect((reply as Record<symbol, unknown>)[CHAT_VISUAL_MESSAGE]).toBe(`antigravity:message:${SESSION}.a1.1`);
  });
});
