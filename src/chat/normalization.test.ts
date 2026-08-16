import { describe, expect, test } from "bun:test";

import { normalizeProviderEvent, normalizeProviderMessage } from "./normalization";
import { ConversationReplay } from "./replay";
import { ProviderTextReconciler } from "./text-reconciler";
import { ConversationProjection } from "./adapter";

describe("OpenCode classic message store", () => {
  test("normalizes { info, parts } messages that the v2 store returns empty", () => {
    const user = normalizeProviderMessage({
      info: { id: "msg_u", sessionID: "s1", role: "user", time: { created: 5 } },
      parts: [{ id: "prt_1", type: "text", text: "Fix the timeline" }],
    });
    expect(user).toEqual([{ id: "message:msg_u", type: "user_message", createdAt: 5, text: "Fix the timeline" }]);

    const assistant = normalizeProviderMessage({
      info: { id: "msg_a", sessionID: "s1", role: "assistant", time: { created: 6 }, snapshot: { files: ["src/chat/ui.ts"] } },
      parts: [
        { id: "prt_start", type: "step-start" },
        { id: "prt_text", type: "text", text: "Rendering **incrementally**." },
        { id: "prt_tool", type: "tool", tool: "glob", callID: "call_1", state: { status: "completed", input: { pattern: "src/chat/*" }, output: "one\ntwo" } },
        { id: "prt_finish", type: "step-finish" },
      ],
    });
    expect(assistant).toEqual([
      expect.objectContaining({ id: "part:prt_text", type: "assistant_message", markdown: "Rendering **incrementally**." }),
      expect.objectContaining({ id: "tool:prt_tool", type: "tool", name: "glob", status: "completed", input: JSON.stringify({ pattern: "src/chat/*" }), output: "one\ntwo" }),
      expect.objectContaining({ type: "file_change", path: "src/chat/ui.ts" }),
    ]);
  });

  test("treats classic time.end as completion so replayed history is not stuck running", () => {
    const [reasoning] = normalizeProviderMessage({
      info: { id: "msg_r", role: "assistant", time: { created: 1 } },
      parts: [{ id: "prt_r", type: "reasoning", text: "considered", time: { start: 1, end: 2 } }],
    });
    expect(reasoning).toEqual(expect.objectContaining({ type: "reasoning", status: "completed" }));

    const [live] = normalizeProviderMessage({
      info: { id: "msg_l", role: "assistant", time: { created: 1 } },
      parts: [{ id: "prt_l", type: "reasoning", text: "thinking", time: { start: 1 } }],
    });
    expect(live).toEqual(expect.objectContaining({ type: "reasoning", status: "running" }));
  });


  test("reasoning parts take the message timestamp so replay keeps part order", () => {
    // A part-level timestamp would sort reasoning past the text and tool
    // parts it ran between when history is ordered by createdAt.
    const [reasoning] = normalizeProviderMessage({
      info: { id: "msg_o", role: "assistant", time: { created: 100 } },
      parts: [{ id: "prt_o", type: "reasoning", text: "why", time: { start: 900, end: 950 } }],
    });
    expect(reasoning).toEqual(expect.objectContaining({ type: "reasoning", createdAt: 100 }));
  });

  test("a task tool part carries its child session id", () => {
    const [task] = normalizeProviderMessage({
      info: { id: "msg_t", role: "assistant", time: { created: 1 } },
      parts: [{ id: "prt_t", type: "tool", tool: "task", state: {
        status: "completed",
        input: { description: "Review", subagent_type: "explore", prompt: "go" },
        metadata: { sessionId: "ses_child", parentSessionId: "ses_parent" },
      } }],
    });
    expect(task).toEqual(expect.objectContaining({ type: "tool", name: "task", childConversationId: "ses_child" }));
  });

  test("ignores messages with an unknown role rather than throwing", () => {
    expect(normalizeProviderMessage({ info: { id: "msg_x", role: "tool", time: { created: 1 } }, parts: [] })).toEqual([]);
  });
});

describe("OpenCode v2 normalization", () => {
  test("normalizes recorded projected message shapes without exposing provider objects", () => {
    const messages = [
      { id: "u1", type: "user", time: { created: 1 }, text: "Implement chat", metadata: { private: true } },
      {
        id: "a1",
        type: "assistant",
        time: { created: 2, completed: 9 },
        error: { type: "unknown", message: "late warning" },
        snapshot: { files: ["src/chat/adapter.ts"] },
        content: [
          { id: "p1", type: "text", text: "Implemented **chat**." },
          { id: "r1", type: "reasoning", text: "Verify boundaries", time: { created: 3, completed: 4 } },
          { id: "t1", type: "tool", name: "read", time: { created: 4 }, state: { status: "completed", input: { path: "src/app.ts" }, content: [{ type: "text", text: "source" }], structured: {} } },
          { id: "t2", type: "tool", name: "bash", time: { created: 5 }, state: { status: "error", input: { command: "bun test" }, content: [{ type: "text", text: "failed" }], structured: {}, error: { type: "unknown", message: "exit 1" } } },
        ],
      },
      { id: "s1", type: "shell", callID: "c1", command: "bun test", output: "ok", time: { created: 10, completed: 11 } },
      { id: "n1", type: "system", text: "Context updated", time: { created: 12 } },
    ];

    const items = messages.flatMap(normalizeProviderMessage);
    expect(items.map(item => item.type)).toEqual([
      "user_message", "assistant_message", "reasoning", "tool", "command", "notice", "file_change", "command", "notice",
    ]);
    expect(items.find(item => item.type === "assistant_message")).toEqual(expect.objectContaining({ markdown: "Implemented **chat**." }));
    expect(items.find(item => item.type === "tool")).toEqual(expect.objectContaining({ status: "completed", output: "source" }));
    expect(items.filter(item => item.type === "command")).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "bun test", status: "failed" }),
      expect.objectContaining({ command: "bun test", status: "completed" }),
    ]));
    expect(JSON.stringify(items)).not.toContain("private");
  });

  test("normalizes recorded native events for files, interactions, status, warnings, and errors", () => {
    const fixtures = [
      { id: "file-event", type: "session.next.step.ended", data: { sessionID: "s1", timestamp: 1, assistantMessageID: "m1", files: ["a.ts"] } },
      { id: "permission-event", type: "permission.v2.asked", data: { id: "p1", sessionID: "s1", action: "shell", resources: ["bun test"] } },
      { id: "question-event", type: "question.v2.asked", data: { id: "q1", sessionID: "s1", questions: [{ question: "Which tests?", header: "Tests", options: [{ label: "Unit", description: "Fast" }], multiple: true, custom: true }] } },
      { id: "retry-event", type: "session.next.retried", data: { sessionID: "s1", timestamp: 4, message: "Rate limited" } },
      { id: "error-event", type: "session.error", data: { sessionID: "s1", error: { data: { message: "Provider failed" } } } },
      { id: "idle-event", type: "session.idle", data: { sessionID: "s1" } },
    ];
    const normalized = fixtures.flatMap(fixture => normalizeProviderEvent(fixture).updates);
    expect(normalized.map(update => update.kind === "upsert" ? update.item.type : update.kind)).toEqual([
      "file_change", "permission", "question", "notice", "notice", "status", "status",
    ]);
    const question = normalized.find(update => update.kind === "upsert" && update.item.type === "question");
    expect(question).toEqual(expect.objectContaining({ item: expect.objectContaining({
      questions: [expect.objectContaining({ multiple: true, allowFreeForm: true })],
    }) }));
  });
});

describe("provider text reconciliation", () => {
  test("deduplicates overlap, replay, and a cumulative update arriving after a delta", () => {
    const text = new ProviderTextReconciler();
    expect(text.incremental("part", " world")).toBe(" world");
    expect(text.cumulative("part", "hello world")).toBe("");
    expect(text.value("part")).toBe("hello world");
    expect(text.incremental("part", " world")).toBe("");
    expect(text.cumulative("part", "hello world!")).toBe("!");
    expect(text.value("part")).toBe("hello world!");
  });

  test("a question resolution without its asked event is dropped, not published empty", () => {
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    const replied = { id: "1", type: "question.v2.replied", data: { sessionID: "s", requestID: "que_1", answers: [["Yes"]] } };
    for (const update of normalizeProviderEvent(replied).updates) projection.apply(update);
    // No renderable content and empty questions fail client validation — the
    // orphan resolution must neither publish nor enter the snapshot.
    expect(projection.items()).toEqual([]);

    const asked = { id: "2", type: "question.v2.asked", data: { sessionID: "s", id: "que_2", questions: [{ question: "Go?", header: "Next", options: [{ label: "Yes" }] }] } };
    const resolved = { id: "3", type: "question.v2.replied", data: { sessionID: "s", requestID: "que_2", answers: [["Yes"]] } };
    for (const event of [asked, resolved]) for (const update of normalizeProviderEvent(event).updates) projection.apply(update);
    expect(projection.items()).toEqual([expect.objectContaining({
      type: "question",
      status: "resolved",
      questions: [expect.objectContaining({ prompt: "Go?" })],
    })]);
  });

  test("a repeated identical delta with no intervening cumulative is legitimate text", () => {
    const text = new ProviderTextReconciler();
    expect(text.incremental("part", "line one")).toBe("line one");
    expect(text.incremental("part", "\n\n")).toBe("\n\n");
    expect(text.incremental("part", "\n\n")).toBe("\n\n");
    expect(text.incremental("part", "line")).toBe("line");
    expect(text.incremental("part", "line")).toBe("line");
    expect(text.value("part")).toBe("line one\n\n\n\nlineline");
  });

  test("updates one projected text and tool identity in place under replay", () => {
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    const textEvents = [
      { id: "1", type: "session.next.text.delta", data: { sessionID: "s", textID: "p", timestamp: 1, delta: "Hello" } },
      { id: "2", type: "session.next.text.ended", data: { sessionID: "s", textID: "p", timestamp: 1, text: "Hello world" } },
      { id: "3", type: "session.next.text.delta", data: { sessionID: "s", textID: "p", timestamp: 1, delta: " world" } },
    ];
    for (const event of textEvents) for (const update of normalizeProviderEvent(event).updates) projection.apply(update);
    const tool = { id: "4", type: "session.next.tool.called", data: { sessionID: "s", callID: "call", timestamp: 2, name: "read", input: { path: "a" } } };
    const completed = { id: "5", type: "session.next.tool.success", data: { sessionID: "s", callID: "call", timestamp: 2, name: "read", content: [{ type: "text", text: "ok" }] } };
    for (const event of [tool, tool, completed, tool]) for (const update of normalizeProviderEvent(event).updates) projection.apply(update);

    expect(projection.items()).toEqual([
      expect.objectContaining({ type: "assistant_message", markdown: "Hello world" }),
      expect.objectContaining({ type: "tool", status: "completed", output: "ok" }),
    ]);
    expect(projection.replay.latestCursor()).not.toBe("");
  });
});
