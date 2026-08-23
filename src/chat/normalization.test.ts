import { describe, expect, test } from "bun:test";

import { createProviderEventMemory, normalizeProviderEvent, normalizeProviderMessage, storedMessageUsage } from "./normalization";
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
  test("enables custom question answers unless OpenCode explicitly disables them", () => {
    const allowFreeForm = (custom?: boolean) => {
      const update = normalizeProviderEvent({
        id: `question-${String(custom)}`,
        type: "question.v2.asked",
        data: {
          id: `q-${String(custom)}`,
          sessionID: "s1",
          questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "" }], ...(custom === undefined ? {} : { custom }) }],
        },
      }).updates[0];
      if (update?.kind !== "upsert" || update.item.type !== "question") throw new Error("expected normalized question");
      return update.item.questions[0]?.allowFreeForm;
    };

    expect(allowFreeForm()).toBe(true);
    expect(allowFreeForm(true)).toBe(true);
    expect(allowFreeForm(false)).toBe(false);
  });

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

    const items = messages.flatMap(message => normalizeProviderMessage(message));
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

  // The live tail the renderer shows comes from `output` being kept as the tool
  // runs: a progress event carries the content so far, and it lands on the same
  // running tool entry, updated in place rather than added as a new row.
  test("a running tool's progress content lands on its output, in place", () => {
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    const running = { id: "p1", type: "session.next.tool.progress", data: { sessionID: "s", callID: "call", timestamp: 1, name: "grep", content: [{ type: "text", text: "line one" }] } };
    const more = { id: "p2", type: "session.next.tool.progress", data: { sessionID: "s", callID: "call", timestamp: 1, name: "grep", content: [{ type: "text", text: "line one\nline two" }] } };
    for (const event of [running, more]) for (const update of normalizeProviderEvent(event).updates) projection.apply(update);
    expect(projection.items()).toEqual([
      expect.objectContaining({ type: "tool", status: "running", output: "line one\nline two" }),
    ]);
  });
});

// Token usage is a message-level fact, so it rides ONE item keyed by the
// message — `usage:<id>`, with empty markdown, which the renderer draws no
// bubble for. Never a text part: `message.updated` restates a growing
// cumulative figure and a message can emit several parts, so a per-part
// figure is one message's spend claimed by two items. Live and stored
// produce the same item id, so a conversation reads back as it streamed.
describe("token usage", () => {
  const tokens = { input: 12_000, output: 400, reasoning: 90, cache: { read: 8_000, write: 512 } };
  const usage = { input: 12_000, output: 400, reasoning: 90, cacheRead: 8_000, cacheWrite: 512 };

  test("a stored assistant message carries its usage once, beside its parts", () => {
    const items = normalizeProviderMessage({
      info: { id: "msg_a", sessionID: "s1", role: "assistant", providerID: "anthropic", modelID: "claude-sonnet", time: { created: 6 }, tokens },
      parts: [
        { id: "prt_one", type: "text", text: "First." },
        { id: "prt_tool", type: "tool", tool: "read", callID: "c", state: { status: "completed", input: {}, output: "ok" } },
        { id: "prt_two", type: "text", text: "Second." },
      ],
    });
    // Two text parts, one figure: neither bubble claims the message's total.
    expect(items).toEqual([
      expect.objectContaining({ id: "part:prt_one", type: "assistant_message" }),
      expect.objectContaining({ id: "tool:prt_tool" }),
      expect.objectContaining({ id: "part:prt_two", type: "assistant_message" }),
      expect.objectContaining({ id: "usage:msg_a", type: "assistant_message", markdown: "", usage, model: { providerId: "anthropic", modelId: "claude-sonnet" } }),
    ]);
    expect(items.filter(item => "usage" in item)).toHaveLength(1);
  });

  test("a message with no reported tokens carries no usage at all", () => {
    const items = normalizeProviderMessage({
      info: { id: "msg_a", sessionID: "s1", role: "assistant", time: { created: 6 } },
      parts: [{ id: "prt_one", type: "text", text: "First." }],
    });
    expect(items[0]).not.toHaveProperty("usage");
    // Nor does a tokens object the agent left empty — no component reported is
    // not the same statement as every component being zero.
    const empty = normalizeProviderMessage({
      info: { id: "msg_b", sessionID: "s1", role: "assistant", time: { created: 6 }, tokens: {} },
      parts: [{ id: "prt_two", type: "text", text: "Second." }],
    });
    expect(empty[0]).not.toHaveProperty("usage");
  });

  test("live usage arrives beside the streamed part without touching its text", () => {
    const memory = createProviderEventMemory();
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    const events = [
      { id: "1", type: "message.part.updated", data: { message: { time: 3 }, part: { id: "prt", messageID: "msg", sessionID: "s", type: "text", text: "Half an ans" } } },
      { id: "2", type: "message.part.updated", data: { message: { time: 3 }, part: { id: "prt", messageID: "msg", sessionID: "s", type: "text", text: "Half an answer, then all of it." } } },
      { id: "3", type: "message.updated", data: { info: { id: "msg", sessionID: "s", role: "assistant", time: { created: 3 }, tokens } } },
    ];
    for (const event of events) for (const update of normalizeProviderEvent(event, memory).updates) projection.apply(update);

    expect(projection.items()).toEqual([
      expect.objectContaining({ id: "part:prt", type: "assistant_message", markdown: "Half an answer, then all of it." }),
      expect.objectContaining({ id: "usage:msg", type: "assistant_message", markdown: "", usage }),
    ]);
  });

  test("a message with two text parts states its spend once, not once per part", () => {
    const memory = createProviderEventMemory();
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    // The shape that double-counted: part A, a cumulative report, part B, the
    // report restated. Attached per part, A kept the first total while B took
    // the second, so aggregating assistant usage counted one message twice.
    const events = [
      { id: "1", type: "message.part.updated", data: { part: { id: "prt_a", messageID: "msg", sessionID: "s", type: "text", text: "First." } } },
      { id: "2", type: "message.updated", data: { info: { id: "msg", sessionID: "s", role: "assistant", time: { created: 3 }, tokens: { input: 100 } } } },
      { id: "3", type: "message.part.updated", data: { part: { id: "prt_b", messageID: "msg", sessionID: "s", type: "text", text: "Second." } } },
      { id: "4", type: "message.updated", data: { info: { id: "msg", sessionID: "s", role: "assistant", time: { created: 3 }, tokens: { input: 180 } } } },
    ];
    for (const event of events) for (const update of normalizeProviderEvent(event, memory).updates) projection.apply(update);

    const carrying = projection.items().filter(item => item.type === "assistant_message" && item.usage);
    expect(carrying).toEqual([
      expect.objectContaining({ id: "usage:msg", markdown: "", usage: { input: 180 } }),
    ]);
  });

  test("usage that beats the first part needs no part to land on", () => {
    const memory = createProviderEventMemory();
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    const updated = { id: "1", type: "message.updated", data: { info: { id: "msg", sessionID: "s", role: "assistant", time: { created: 3 }, tokens } } };
    for (const update of normalizeProviderEvent(updated, memory).updates) projection.apply(update);
    // The carrier holds the figure whether or not a part ever comes; empty
    // markdown is what keeps it off the screen.
    expect(projection.items()).toEqual([
      expect.objectContaining({ id: "usage:msg", type: "assistant_message", markdown: "", usage }),
    ]);

    const part = { id: "2", type: "message.part.updated", data: { part: { id: "prt", messageID: "msg", sessionID: "s", type: "text", text: "The answer." } } };
    for (const update of normalizeProviderEvent(part, memory).updates) projection.apply(update);
    // The part arrives as itself; the figure stays where it was reported.
    expect(projection.items()).toEqual([
      expect.objectContaining({ id: "usage:msg", markdown: "", usage }),
      expect.objectContaining({ id: "part:prt", type: "assistant_message", markdown: "The answer." }),
    ]);
  });

  test("a message with no text part still reports its usage for attribution", () => {
    const memory = createProviderEventMemory();
    // A purely agentic message: tool and reasoning parts only, so no text
    // part ever registers. Its spend reaches the subagent tally through the
    // envelope, and the conversation's own readout through the carrier item.
    const updated = { id: "1", type: "message.updated", data: { info: { id: "msg", sessionID: "s", role: "assistant", time: { created: 3 }, tokens } } };
    const normalized = normalizeProviderEvent(updated, memory);
    expect(normalized.updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "usage:msg", markdown: "", usage }) },
    ]);
    expect(normalized.assistantUsage).toEqual({ messageId: "msg", usage });
  });

  test("removing a message withdraws its usage carrier and attribution key", () => {
    const memory = createProviderEventMemory();
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    const updated = { id: "1", type: "message.updated", properties: { info: { id: "msg", sessionID: "s", role: "assistant", time: { created: 3 }, tokens } } };
    for (const update of normalizeProviderEvent(updated, memory).updates) projection.apply(update);
    expect(projection.has("usage:msg")).toBe(true);

    const removed = normalizeProviderEvent({ id: "2", type: "message.removed", properties: { sessionID: "s", messageID: "msg" } }, memory);
    expect(removed.removedMessageId).toBe("msg");
    expect(removed.updates).toContainEqual({ kind: "remove", itemId: "usage:msg" });
    for (const update of removed.updates) projection.apply(update);
    expect(projection.has("usage:msg")).toBe(false);
  });

  test("a flat v2 stored record names its model as a reference, not a modelID field", () => {
    // The v2 store writes `model: { id, providerID }` where the classic store
    // wrote `modelID`. Reconstruction reads stored records, and a completed
    // attribution is banked — read only the classic field and a persisted v2
    // child restores its cost with no model label, permanently.
    expect(storedMessageUsage({ id: "msg_v2", type: "assistant", model: { id: "gpt-5.6-sol", providerID: "openai" }, tokens: { input: 5 } }))
      .toEqual({ messageId: "msg_v2", createdAt: 0, usage: { input: 5 }, model: "gpt-5.6-sol" });
    expect(storedMessageUsage({ info: { id: "msg_classic", role: "assistant", modelID: "claude-sonnet-4-5", tokens: { input: 7 } }, parts: [] }))
      .toEqual({ messageId: "msg_classic", createdAt: 0, usage: { input: 7 }, model: "claude-sonnet-4-5" });
  });

  test("a stored message with only tool parts keeps its usage on a hidden carrier", () => {
    const items = normalizeProviderMessage({
      info: { id: "msg_t", sessionID: "s1", role: "assistant", time: { created: 6 }, tokens },
      parts: [{ id: "prt_tool", type: "tool", tool: "read", callID: "c", state: { status: "completed", input: {}, output: "ok" } }],
    });
    // Reopening a conversation whose newest message was tool-only must not
    // lose the window's current fill.
    expect(items).toEqual([
      expect.objectContaining({ id: "tool:prt_tool" }),
      expect.objectContaining({ id: "usage:msg_t", type: "assistant_message", markdown: "", usage }),
    ]);
  });

  test("a user message's tokens are not read, and no memory means no usage", () => {
    const memory = createProviderEventMemory();
    const user = { id: "1", type: "message.updated", data: { info: { id: "msg_u", sessionID: "s", role: "user", time: { created: 1 }, tokens } } };
    expect(normalizeProviderEvent(user, memory).updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ type: "user_message" }) },
    ]);
    expect(normalizeProviderEvent(user, memory).updates.some(update =>
      update.kind === "upsert" && update.item.id.startsWith("usage:"))).toBe(false);

    // Called without memory (the shape most of this suite uses), an
    // assistant's usage still reports — it needs no memory to place.
    const assistant = { id: "2", type: "message.updated", data: { info: { id: "msg_a", sessionID: "s", role: "assistant", time: { created: 2 }, tokens } } };
    expect(normalizeProviderEvent(assistant).updates).toEqual([
      { kind: "upsert", item: expect.objectContaining({ id: "usage:msg_a", markdown: "", usage }) },
    ]);
  });
});

describe("both OpenCode event naming generations", () => {
  function apply(events: Array<Record<string, unknown>>) {
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    for (const event of events) {
      for (const update of normalizeProviderEvent(event).updates) projection.apply(update);
    }
    return projection;
  }

  // The exact bridged shape observed in the OpenCode 1.18 binary:
  // action → permission, resources → patterns, save → always.
  const classicAsked = {
    id: "e1",
    type: "permission.asked",
    properties: { id: "perm_1", sessionID: "s", permission: "skill", patterns: ["review-code"], always: [], metadata: {} },
  };
  const v2Asked = {
    id: "e2",
    type: "permission.v2.asked",
    data: { id: "perm_1", sessionID: "s", action: "skill", resources: ["review-code"] },
  };

  test("a classic permission ask renders as a pending request", () => {
    const items = apply([classicAsked]).items();
    expect(items).toEqual([expect.objectContaining({
      id: "permission:perm_1",
      type: "permission",
      requestId: "perm_1",
      action: "skill",
      resources: ["review-code"],
      status: "pending",
    })]);
  });

  // OpenCode attaches an edit's pending change on the permission's
  // `metadata.diff` — a `@@`-hunk unified diff, the shape observed in the
  // 1.18 binary. A permission without one carries no diff.
  test("an edit permission keeps its pending diff, a plain one carries none", () => {
    const edit = { id: "e3", type: "permission.v2.asked", data: { id: "perm_2", sessionID: "s", action: "edit", resources: ["src/app.ts"], metadata: { diff: "@@ -1 +1 @@\n-old\n+new" } } };
    const [item] = apply([edit]).items();
    expect(item).toEqual(expect.objectContaining({ id: "permission:perm_2", diff: "@@ -1 +1 @@\n-old\n+new" }));

    const [plain] = apply([v2Asked]).items();
    expect(plain).not.toHaveProperty("diff");
  });

  test("the same request under both generations settles as one entry, either order", () => {
    for (const order of [[v2Asked, classicAsked], [classicAsked, v2Asked]]) {
      const items = apply(order).items();
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual(expect.objectContaining({
        id: "permission:perm_1",
        action: "skill",
        resources: ["review-code"],
        status: "pending",
      }));
    }
  });

  test("a classic reply resolves the entry its ask created", () => {
    const items = apply([
      classicAsked,
      { id: "e3", type: "permission.replied", properties: { sessionID: "s", requestID: "perm_1", reply: "once" } },
    ]).items();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({
      status: "resolved",
      outcome: "approved-once",
      // The reply carries no action or resources; the merge keeps the ask's.
      action: "skill",
      resources: ["review-code"],
    }));
  });

  test("a classic question ask renders and resolves", () => {
    const asked = {
      id: "q1",
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID: "s",
        questions: [{ prompt: "Proceed?", header: "Skill", options: [{ label: "Yes" }, { label: "No" }] }],
      },
    };
    const pending = apply([asked]).items();
    expect(pending).toEqual([expect.objectContaining({ id: "question:que_1", type: "question", status: "pending" })]);

    const resolved = apply([
      asked,
      { id: "q2", type: "question.replied", properties: { sessionID: "s", requestID: "que_1", answers: [["Yes"]] } },
    ]).items();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual(expect.objectContaining({
      status: "resolved",
      outcome: { kind: "answered", answers: [["Yes"]] },
    }));
  });

  test("a classic question rejection records the rejection", () => {
    const items = apply([
      { id: "q1", type: "question.asked", properties: { id: "que_2", sessionID: "s", questions: [{ prompt: "Go?", options: [] }] } },
      { id: "q2", type: "question.rejected", properties: { sessionID: "s", requestID: "que_2" } },
    ]).items();
    expect(items[0]).toEqual(expect.objectContaining({ status: "resolved", outcome: { kind: "rejected" } }));
  });

  test("classic interaction events are recognized, not counted as discards", () => {
    for (const event of [classicAsked, { id: "q", type: "question.asked", properties: { id: "q1", sessionID: "s", questions: [] } }]) {
      expect(normalizeProviderEvent(event).outcome).toBe("handled");
    }
  });
});

describe("compaction and revert stop the transcript from lying", () => {
  function items(event: Record<string, unknown>) {
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    for (const update of normalizeProviderEvent(event).updates) projection.apply(update);
    return projection.items();
  }

  test("a compacted conversation says so instead of appearing to lose content", () => {
    expect(items({ id: "c1", type: "session.next.compaction.started", data: { sessionID: "s" } })[0])
      .toEqual(expect.objectContaining({ type: "notice", level: "info", message: expect.stringContaining("Compacting") }));

    expect(items({ id: "c2", type: "session.next.compaction.ended", data: { sessionID: "s", summary: "Summarized 40 turns" } })[0])
      .toEqual(expect.objectContaining({ type: "notice", message: "Summarized 40 turns" }));

    // No summary in the payload still explains what happened.
    expect(items({ id: "c3", type: "session.next.compaction.ended", data: { sessionID: "s" } })[0])
      .toEqual(expect.objectContaining({ type: "notice", message: expect.stringContaining("compacted") }));
  });

  test("reverted work is not presented as current", () => {
    for (const [type, fragment] of [
      ["session.next.revert.staged", "pending reversal"],
      ["session.next.revert.committed", "no longer applies"],
      ["session.next.revert.cleared", "apply again"],
    ] as const) {
      expect(items({ id: type, type, data: { sessionID: "s" } })[0])
        .toEqual(expect.objectContaining({ type: "notice", level: "warning", message: expect.stringContaining(fragment) }));
    }
  });

  test("compaction delta is intentionally ignored, not counted as a discard", () => {
    expect(normalizeProviderEvent({ id: "d", type: "session.next.compaction.delta", data: { sessionID: "s" } }).outcome).toBe("ignored");
    // While a genuinely unknown type stays countable.
    expect(normalizeProviderEvent({ id: "x", type: "session.next.something.new", data: { sessionID: "s" } }).outcome).toBe("unrecognized");
  });
});

describe("interaction items name the conversation that owns them", () => {
  // Answers are addressed to the owner, so an item without one would send a
  // reply to whichever conversation happened to be on screen.
  const events = [
    { id: "e", type: "permission.v2.asked", data: { id: "p1", sessionID: "s9", action: "bash", resources: ["ls"] } },
    { id: "e", type: "permission.asked", properties: { id: "p2", sessionID: "s9", permission: "bash", patterns: ["ls"] } },
    { id: "e", type: "permission.v2.replied", data: { sessionID: "s9", requestID: "p1", reply: "once" } },
    { id: "e", type: "permission.replied", properties: { sessionID: "s9", requestID: "p2", reply: "once" } },
    { id: "e", type: "question.v2.asked", data: { id: "q1", sessionID: "s9", questions: [] } },
    { id: "e", type: "question.asked", properties: { id: "q2", sessionID: "s9", questions: [] } },
    { id: "e", type: "question.v2.replied", data: { sessionID: "s9", requestID: "q1", answers: [["a"]] } },
    { id: "e", type: "question.rejected", properties: { sessionID: "s9", requestID: "q2" } },
  ];

  test("every event path stamps the owner, in both naming generations", () => {
    for (const event of events) {
      const updates = normalizeProviderEvent(event).updates;
      expect(updates.length).toBeGreaterThan(0);
      for (const update of updates) {
        if (update.kind !== "upsert") continue;
        expect(update.item).toEqual(expect.objectContaining({ conversationId: "s9" }));
      }
    }
  });
});

describe("user message attachments", () => {
  test("v2 user files echo verbatim uris that recover the issued id", () => {
    const items = normalizeProviderMessage({
      id: "msg_1",
      type: "user",
      time: { created: 5 },
      text: "look",
      files: [
        { uri: "file:///state/uatu/attachments/ab/11111111-2222-4333-8444-555555555555.png", mime: "image/png", name: "shot.png" },
        { uri: "file:///somewhere/else/readme.png", mime: "image/png", name: "unlinked.png" },
      ],
    });
    expect(items).toEqual([{
      id: "message:msg_1",
      type: "user_message",
      createdAt: 5,
      text: "look",
      attachments: [
        { id: "11111111-2222-4333-8444-555555555555", name: "shot.png", mimeType: "image/png" },
        // Not an issued-id basename: an id-less placeholder reference.
        { name: "unlinked.png", mimeType: "image/png" },
      ],
    }]);
  });

  test("a v2 user message without files carries no attachments key", () => {
    const [item] = normalizeProviderMessage({ id: "msg_2", type: "user", time: { created: 1 }, text: "plain" });
    expect(item).not.toHaveProperty("attachments");
  });

  test("classic stored file parts degrade to placeholders without passing bytes through", () => {
    const items = normalizeProviderMessage({
      info: { id: "msg_3", role: "user", time: { created: 7 } },
      parts: [
        { type: "text", text: "see attached" },
        { type: "file", mime: "image/png", filename: "probe.png", url: "data:image/png;base64,AAAA" },
      ],
    });
    expect(items).toEqual([{
      id: "message:msg_3",
      type: "user_message",
      createdAt: 7,
      text: "see attached",
      attachments: [{ name: "probe.png", mimeType: "image/png" }],
    }]);
    expect(JSON.stringify(items)).not.toContain("base64");
  });
});

describe("durable-store user messages (post-turn classic form)", () => {
  test("synthetic captions stay out of the text and give the attachment its id back", () => {
    // The exact shape a live session's durable store held after a real turn:
    // real text, a synthetic Read caption carrying the stored path, and the
    // file part rewritten to an inline data: URL.
    const items = normalizeProviderMessage({
      info: { id: "msg_9", role: "user", time: { created: 3 } },
      parts: [
        { type: "text", text: "Reply with the single word ok." },
        { type: "text", synthetic: true, text: 'Called the Read tool with the following input: {"filePath":"/Users/x/.local/state/uatu/attachments/14adeeded8179012/eb638c39-4073-490b-b957-f5d5d1544a48.png"}' },
        { type: "file", url: "data:image/png;base64,AAAA", mime: "image/png", filename: "live-check.png" },
      ],
    });
    expect(items).toEqual([{
      id: "message:msg_9",
      type: "user_message",
      createdAt: 3,
      text: "Reply with the single word ok.",
      attachments: [{ id: "eb638c39-4073-490b-b957-f5d5d1544a48", name: "live-check.png", mimeType: "image/png" }],
    }]);
    expect(JSON.stringify(items)).not.toContain("base64");
    expect(JSON.stringify(items)).not.toContain("Read tool");
  });

  test("a file part without any caption stays an id-less placeholder", () => {
    const items = normalizeProviderMessage({
      info: { id: "msg_10", role: "user", time: { created: 3 } },
      parts: [
        { type: "text", text: "see attached" },
        { type: "file", url: "data:image/png;base64,AAAA", mime: "image/png", filename: "orphan.png" },
      ],
    });
    expect(items[0]).toEqual(expect.objectContaining({
      attachments: [{ name: "orphan.png", mimeType: "image/png" }],
    }));
  });

  test("captions pair with file parts in order across multiple attachments", () => {
    const caption = (uuid: string) => ({ type: "text", synthetic: true, text: `Called the Read tool with the following input: {"filePath":"/state/a/${uuid}.webp"}` });
    const items = normalizeProviderMessage({
      info: { id: "msg_11", role: "user", time: { created: 3 } },
      parts: [
        { type: "text", text: "two images" },
        caption("11111111-2222-4333-8444-555555555555"),
        caption("22222222-2222-4333-8444-555555555555"),
        { type: "file", url: "data:image/webp;base64,AAAA", mime: "image/webp", filename: "one.webp" },
        { type: "file", url: "data:image/webp;base64,AAAA", mime: "image/webp", filename: "two.webp" },
      ],
    });
    expect((items[0] as { attachments?: unknown }).attachments).toEqual([
      { id: "11111111-2222-4333-8444-555555555555", name: "one.webp", mimeType: "image/webp" },
      { id: "22222222-2222-4333-8444-555555555555", name: "two.webp", mimeType: "image/webp" },
    ]);
  });
});
