import { beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ChatProjection } from "./projection";
import type { ConversationItem } from "./types";

const dom = parseHTML("<!doctype html><html><body><div id=\"items\"></div></body></html>");
beforeAll(() => {
  (globalThis as Record<string, unknown>).document = dom.document;
});

const { TimelineRenderer } = await import("./timeline-renderer");

function projectionWith(items: ConversationItem[], overrides: Partial<ChatProjection> = {}): ChatProjection {
  return {
    conversationId: "c1",
    generation: "g1",
    sequence: 1,
    cursor: "cursor",
    items,
    status: "running",
    acceptedDrafts: [],
    ...overrides,
  };
}

function target(): HTMLElement {
  const node = dom.document.createElement("div");
  return node as unknown as HTMLElement;
}

const question: ConversationItem = {
  id: "question:q1",
  type: "question",
  createdAt: 2,
  requestId: "q1",
  status: "pending",
  questions: [{ prompt: "Pick one", header: "Choice", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiple: false, allowFreeForm: true }],
};

describe("TimelineRenderer", () => {
  test("streaming a delta patches only the assistant node and preserves sibling nodes", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const assistant: ConversationItem = { id: "part:a", type: "assistant_message", createdAt: 1, markdown: "Hello" };
    renderer.render(host, projectionWith([assistant, question]), new Set());

    const questionNode = host.querySelector('[data-chat-item-id="question:q1"]');
    const assistantNode = host.querySelector('[data-chat-item-id="part:a"]');
    const freeForm = host.querySelector<HTMLInputElement>('input[type="text"]');
    expect(questionNode).not.toBeNull();
    freeForm!.value = "typed answer";

    const dirty = renderer.render(host, projectionWith([{ ...assistant, markdown: "Hello world" }, question]), new Set());

    expect(dirty).toHaveLength(1);
    expect(host.querySelector('[data-chat-item-id="part:a"]')).toBe(assistantNode);
    expect(assistantNode!.textContent).toContain("Hello world");
    expect(host.querySelector('[data-chat-item-id="question:q1"]')).toBe(questionNode);
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("typed answer");
  });

  test("unchanged items are not touched when a new item is appended", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const first: ConversationItem = { id: "message:1", type: "user_message", createdAt: 1, text: "hi" };
    renderer.render(host, projectionWith([first]), new Set());
    const firstNode = host.querySelector('[data-chat-item-id="message:1"]');

    const dirty = renderer.render(host, projectionWith([first, { id: "part:b", type: "assistant_message", createdAt: 2, markdown: "yo" }]), new Set());

    expect(dirty).toHaveLength(1);
    expect(host.querySelector('[data-chat-item-id="message:1"]')).toBe(firstNode);
    expect(Array.from(host.children).map(child => child.getAttribute("data-chat-item-id"))).toEqual(["message:1", "part:b"]);
  });

  test("prepending older items keeps existing nodes and fixes order", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const recent: ConversationItem = { id: "message:2", type: "user_message", createdAt: 2, text: "recent" };
    renderer.render(host, projectionWith([recent]), new Set());
    const recentNode = host.querySelector('[data-chat-item-id="message:2"]');

    renderer.render(host, projectionWith([{ id: "message:1", type: "user_message", createdAt: 1, text: "older" }, recent]), new Set());

    expect(Array.from(host.children).map(child => child.getAttribute("data-chat-item-id"))).toEqual(["message:1", "message:2"]);
    expect(host.querySelector('[data-chat-item-id="message:2"]')).toBe(recentNode);
  });

  test("renders edit tools as a diff with a file reference", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const tool: ConversationItem = {
      id: "tool:1",
      type: "tool",
      createdAt: 1,
      name: "edit",
      status: "completed",
      input: JSON.stringify({ filePath: "docs/a.md", oldString: "one", newString: "two" }),
    };
    renderer.render(host, projectionWith([tool]), new Set());

    const node = host.querySelector('[data-chat-item-id="tool:1"]')!;
    expect(node.querySelector("summary")!.textContent).toContain("Edit");
    expect(node.querySelector("summary")!.textContent).toContain("docs/a.md");
    expect(node.querySelector(".chat-diff-line.is-del")!.textContent).toBe("- one");
    expect(node.querySelector(".chat-diff-line.is-add")!.textContent).toBe("+ two");
    expect(node.querySelector('button[data-file-ref="docs/a.md"]')).not.toBeNull();
  });

  test("resolving an interaction rebuilds its card", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([question]), new Set());
    expect(host.querySelector("form[data-question-form]")).not.toBeNull();

    renderer.render(host, projectionWith([{ ...question, status: "resolved", outcome: { kind: "answered", answers: [["a"]] } }]), new Set());

    expect(host.querySelector("form[data-question-form]")).toBeNull();
    expect(host.querySelector(".chat-request-outcome")!.textContent).toBe("Answered");
  });

  test("drafts render, update their label, and disappear when reconciled", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const draft = { requestId: "r1", messageId: "pending:r1", text: "send me" };
    renderer.render(host, projectionWith([], { acceptedDrafts: [draft] }), new Set());
    expect(host.textContent).toContain("Sending…");

    renderer.render(host, projectionWith([], { acceptedDrafts: [{ ...draft, messageId: "m1" }] }), new Set());
    expect(host.textContent).toContain("Delivered");

    renderer.render(host, projectionWith([]), new Set());
    expect(host.querySelector('[data-chat-item-id="draft-r1"]')).toBeNull();
  });

  test("switching conversations clears the previous timeline", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ id: "message:1", type: "user_message", createdAt: 1, text: "hi" }]), new Set());
    renderer.render(host, projectionWith([{ id: "message:9", type: "user_message", createdAt: 1, text: "other" }], { conversationId: "c2" }), new Set());

    expect(host.querySelector('[data-chat-item-id="message:1"]')).toBeNull();
    expect(host.querySelector('[data-chat-item-id="message:9"]')).not.toBeNull();
  });
});


function tool(id: string, status: "running" | "completed" = "completed", name = "read"): ConversationItem {
  return { id: `tool:${id}`, type: "tool", createdAt: 1, name, status, input: JSON.stringify({ filePath: `${id}.ts` }) };
}

describe("activity grouping", () => {
  const user: ConversationItem = { id: "message:u1", type: "user_message", createdAt: 1, text: "go" };
  const answer: ConversationItem = { id: "part:a1", type: "assistant_message", createdAt: 9, markdown: "done" };

  test("a finished run of three or more collapses behind one group line", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([user, tool("a"), tool("b"), tool("c"), answer], { status: "idle" }), new Set());

    expect(Array.from(host.children).map(child => child.getAttribute("data-chat-item-id")))
      .toEqual(["message:u1", "group:tool:a", "part:a1"]);
    const group = host.querySelector('[data-chat-item-id="group:tool:a"]')!;
    expect(group.querySelector(".chat-group-count")!.textContent).toBe("3 steps");
    expect(group.querySelector(".chat-activity-subject")!.textContent).toBe("Read ×3");
    expect(group.querySelectorAll(".chat-group-items [data-chat-item-id]")).toHaveLength(3);
  });

  test("the trailing run of a running turn stays flat", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([user, tool("a"), tool("b"), tool("c")], { status: "running" }), new Set());
    expect(host.querySelector(".chat-activity-group")).toBeNull();
  });

  test("a run with an unfinished member stays flat", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([user, tool("a"), tool("b", "running"), tool("c"), answer], { status: "running" }), new Set());
    expect(host.querySelector(".chat-activity-group")).toBeNull();
  });

  test("finishing the turn groups the run without losing member nodes", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    // Same item references across renders, as applyChatEvent produces for
    // untouched items — only the conversation status changes.
    const run = [tool("a"), tool("b"), tool("c")];
    renderer.render(host, projectionWith([user, ...run], { status: "running" }), new Set());
    const member = host.querySelector('[data-chat-item-id="tool:b"]');
    renderer.render(host, projectionWith([user, ...run], { status: "idle" }), new Set());
    const group = host.querySelector('[data-chat-item-id="group:tool:a"]');
    expect(group).not.toBeNull();
    expect(group!.querySelector('[data-chat-item-id="tool:b"]')).toBe(member);
  });

  test("a dissolved group reparents its members back to the top level", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([user, tool("a"), tool("b"), tool("c"), answer], { status: "idle" }), new Set());
    expect(host.querySelector(".chat-activity-group")).not.toBeNull();

    const split: ConversationItem = { id: "part:mid", type: "assistant_message", createdAt: 5, markdown: "between" };
    renderer.render(host, projectionWith([user, tool("a"), tool("b"), split, tool("c"), answer], { status: "idle" }), new Set());

    expect(host.querySelector(".chat-activity-group")).toBeNull();
    expect(Array.from(host.children).map(child => child.getAttribute("data-chat-item-id")))
      .toEqual(["message:u1", "tool:a", "tool:b", "part:mid", "tool:c", "part:a1"]);
  });

  test("a persisted expansion renders the group open", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([user, tool("a"), tool("b"), tool("c"), answer], { status: "idle" }), new Set(["group:tool:a"]));
    expect(host.querySelector('[data-chat-item-id="group:tool:a"]')!.hasAttribute("open")).toBe(true);
  });
});

describe("presentation details", () => {
  test("reasoning reads Thinking while streaming and Thought with its time once done", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ id: "part:r", type: "reasoning", createdAt: 1, text: "hmm", status: "running" }], { status: "running" }), new Set());
    expect(host.querySelector("summary")!.textContent).toContain("Thinking");
    renderer.render(host, projectionWith([{ id: "part:r", type: "reasoning", createdAt: 1, text: "hmm", status: "completed", durationMs: 7_000 }], { status: "idle" }), new Set());
    expect(host.querySelector("summary")!.textContent).toContain("Thought for 7s");
  });

  test("finished reasoning without provider timing reads Thought, not Thinking", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ id: "part:r", type: "reasoning", createdAt: 1, text: "hmm", status: "completed" }], { status: "idle" }), new Set());
    const summary = host.querySelector("summary")!.textContent!;
    expect(summary).toContain("Thought");
    expect(summary).not.toContain("Thinking");
  });

  test("a finished turn reports how long it worked", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      { id: "message:u1", type: "user_message", createdAt: 1_000, text: "go" },
      { id: "status:1", type: "turn_status", createdAt: 8_000, status: "completed" },
    ], { status: "idle" }), new Set());
    expect(host.textContent).toContain("worked 7s");
  });

  test("a queued message is visibly held", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ id: "message:u1", type: "user_message", createdAt: 1, text: "later" }]), new Set(), new Set(["message:u1"]));
    expect(host.querySelector(".chat-user-message.is-queued")).not.toBeNull();
    expect(host.textContent).toContain("Queued");
  });

  test("todo updates read as activity, not a reprinted list", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const write = (id: string, states: string[]): ConversationItem => ({
      id: `tool:${id}`, type: "tool", createdAt: 1, name: "todowrite", status: "completed",
      input: JSON.stringify({ todos: ["one", "two"].map((content, index) => ({ content, status: states[index] })) }),
    });
    renderer.render(host, projectionWith([
      write("t1", ["pending", "pending"]),
      write("t2", ["completed", "in_progress"]),
    ], { status: "idle" }), new Set());
    const summaries = Array.from(host.querySelectorAll("summary")).map(node => node.textContent);
    expect(summaries[0]).toContain("Added 2 todos");
    expect(summaries[1]).toContain("Completed");
    expect(summaries[1]).toContain("one");
  });

  test("a multi-question form steps through tabs", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const multi: ConversationItem = {
      id: "question:m1", type: "question", createdAt: 1, requestId: "m1", status: "pending",
      questions: [
        { prompt: "P1", header: "Scope", options: [{ label: "A", description: "" }], multiple: true, allowFreeForm: false },
        { prompt: "P2", header: "Depth", options: [{ label: "X", description: "" }], multiple: false, allowFreeForm: false },
      ],
    };
    renderer.render(host, projectionWith([multi]), new Set());
    expect(host.querySelectorAll("[data-question-tab]")).toHaveLength(2);
    const panels = Array.from(host.querySelectorAll<HTMLElement>("[data-question-panel]"));
    expect(panels[0]!.hasAttribute("hidden")).toBe(false);
    expect(panels[1]!.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector("[data-question-primary]")!.textContent).toBe("Next");
    expect(host.querySelector('input[type="checkbox"]')).not.toBeNull();
  });
});
