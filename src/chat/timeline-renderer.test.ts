import { beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ChatProjection } from "./projection";
import type { ConversationItem } from "./types";

const dom = parseHTML("<!doctype html><html><body><div id=\"items\"></div></body></html>");
beforeAll(() => {
  (globalThis as Record<string, unknown>).document = dom.document;
});

const { QueueDockRenderer, RevertedMessagesDockRenderer, TimelineRenderer, subagentEntries } = await import("./timeline-renderer");

function projectionWith(items: ConversationItem[], overrides: Partial<ChatProjection> = {}): ChatProjection {
  return {
    conversationId: "c1",
    generation: "g1",
    sequence: 1,
    cursor: "cursor",
    items,
    status: "running",
    acceptedDrafts: [],
    queued: [],
    queueRevision: 0,
    configurationRevision: 0,
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
    const customToggle = host.querySelector<HTMLInputElement>("[data-question-custom-toggle]");
    const customEditor = host.querySelector<HTMLElement>("[data-question-custom-editor]");
    const freeForm = host.querySelector<HTMLInputElement>("[data-question-custom-input]");
    expect(questionNode).not.toBeNull();
    customToggle!.checked = true;
    customEditor!.hidden = false;
    freeForm!.value = "typed answer";

    const dirty = renderer.render(host, projectionWith([{ ...assistant, markdown: "Hello world" }, question]), new Set());

    expect(dirty).toHaveLength(1);
    expect(host.querySelector('[data-chat-item-id="part:a"]')).toBe(assistantNode);
    expect(assistantNode!.textContent).toContain("Hello world");
    expect(host.querySelector('[data-chat-item-id="question:q1"]')).toBe(questionNode);
    expect(host.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!.checked).toBe(true);
    expect(host.querySelector<HTMLElement>("[data-question-custom-editor]")!.hidden).toBe(false);
    expect(host.querySelector<HTMLInputElement>("[data-question-custom-input]")!.value).toBe("typed answer");
  });

  test("keeps the assistant shell stable and adds idempotent code copy only on completion", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const assistant: ConversationItem = {
      id: "part:copy",
      type: "assistant_message",
      createdAt: 1,
      markdown: "Before\n\n```ts\nconst a = 1;\n```\n\n```sh\necho ok\n```",
    };
    renderer.render(host, projectionWith([assistant]), new Set());
    const article = host.querySelector<HTMLElement>(".chat-assistant-message")!;
    const content = article.querySelector<HTMLElement>(".chat-assistant-content")!;
    expect(article.querySelectorAll("[data-chat-copy]")).toHaveLength(0);

    renderer.render(host, projectionWith([assistant], { status: "completed" }), new Set());
    expect(host.querySelector(".chat-assistant-message")).toBe(article);
    expect(article.querySelector(".chat-assistant-content")).toBe(content);
    expect(article.querySelectorAll("[data-chat-copy='answer']")).toHaveLength(0);
    expect(article.querySelectorAll("[data-chat-copy='code']")).toHaveLength(2);
    expect([...article.querySelectorAll("pre > code")].map(code => code.textContent)).toEqual(["const a = 1;\n", "echo ok\n"]);

    renderer.render(host, projectionWith([assistant], { status: "completed" }), new Set());
    expect(article.querySelectorAll("[data-chat-copy]")).toHaveLength(2);
  });

  test("a retry or a compaction keeps a partial response open", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const assistant: ConversationItem = { id: "part:live", type: "assistant_message", createdAt: 1, markdown: "So far\n\n```sh\necho ok\n```" };
    for (const status of ["retrying", "compacting"] as const) {
      renderer.render(host, projectionWith([assistant], { status }), new Set());
      const article = host.querySelector<HTMLElement>(".chat-assistant-message")!;
      expect(article.querySelectorAll("[data-chat-copy]")).toHaveLength(0);
    }
    renderer.render(host, projectionWith([assistant], { status: "completed" }), new Set());
    expect(host.querySelectorAll("[data-chat-copy='code']")).toHaveLength(1);
  });

  test("patches cumulative completed Markdown without adding answer actions", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const assistant: ConversationItem = { id: "part:done", type: "assistant_message", createdAt: 1, completedAt: 2, markdown: "Hello" };
    renderer.render(host, projectionWith([assistant]), new Set());
    const article = host.querySelector<HTMLElement>(".chat-assistant-message")!;
    renderer.render(host, projectionWith([{ ...assistant, markdown: "Hello again" }]), new Set());
    expect(host.querySelector(".chat-assistant-message")).toBe(article);
    expect(article.querySelector("[data-chat-copy='answer']")).toBeNull();
    expect(article.querySelector(".chat-assistant-content")?.textContent).toContain("Hello again");
  });

  test("does not mark a streaming assistant complete when a steer follows it", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const assistant: ConversationItem = { id: "part:steered", type: "assistant_message", createdAt: 1, markdown: "Working" };
    const steer: ConversationItem = { id: "message:steer", type: "user_message", createdAt: 2, text: "Use the smaller approach" };

    renderer.render(host, projectionWith([assistant, steer]), new Set());
    const article = host.querySelector<HTMLElement>('[data-chat-item-id="part:steered"]')!;
    expect(article.dataset.complete).toBe("false");
    expect(article.querySelector("[data-chat-copy='answer']")).toBeNull();

    renderer.render(host, projectionWith([{ ...assistant, markdown: "Working after steer" }, steer]), new Set());
    expect(host.querySelector('[data-chat-item-id="part:steered"]')).toBe(article);
    expect(article.querySelector(".chat-assistant-content")?.textContent).toContain("Working after steer");
    expect(article.querySelector("[data-chat-copy='answer']")).toBeNull();
  });

  test("keeps a prior turn complete while the next turn is active", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const firstAnswer: ConversationItem = { id: "part:first", type: "assistant_message", createdAt: 1, markdown: "First answer\n\n```ts\nconst first = true;\n```" };
    renderer.render(host, projectionWith([firstAnswer], { status: "completed" }), new Set());
    const article = host.querySelector<HTMLElement>('[data-chat-item-id="part:first"]')!;
    const copy = article.querySelector("[data-chat-copy='code']");
    expect(copy).not.toBeNull();
    expect(article.querySelector("[data-chat-copy='answer']")).toBeNull();

    const nextPrompt: ConversationItem = { id: "message:next", type: "user_message", createdAt: 2, text: "Next question" };
    renderer.render(host, projectionWith([firstAnswer, nextPrompt], { status: "sending" }), new Set());
    expect(host.querySelector('[data-chat-item-id="part:first"]')).toBe(article);
    expect(article.dataset.complete).toBe("true");
    expect(article.querySelector("[data-chat-copy='code']")).toBe(copy);
    expect(article.querySelector("[data-chat-copy='answer']")).toBeNull();
  });

  test("renders custom answers as a synthetic peer choice with a separate hidden input", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([question]), new Set());

    const panel = host.querySelector("[data-question-panel]")!;
    const options = [...panel.querySelectorAll(".chat-question-option")];
    const toggle = panel.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
    const editor = panel.querySelector<HTMLElement>("[data-question-custom-editor]")!;
    const input = panel.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
    expect(options.map(option => option.textContent?.trim())).toEqual(["a", "b", "Type your own answer"]);
    expect(toggle.type).toBe("radio");
    expect(toggle.name).toBe("q-0");
    expect(editor.hidden).toBe(true);
    expect(input.name).toBe("q-0-custom-text");
    expect(toggle.getAttribute("aria-controls")).toBe(input.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  test("uses a checkbox for multi-select custom answers and omits custom UI when disabled", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const multi = {
      ...question,
      questions: [{ ...question.questions[0]!, multiple: true }],
    } satisfies ConversationItem;
    renderer.render(host, projectionWith([multi]), new Set());
    expect(host.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!.type).toBe("checkbox");
    expect(host.querySelectorAll(".chat-question-option")).toHaveLength(3);

    renderer.render(host, projectionWith([{ ...question, questions: [{ ...question.questions[0]!, allowFreeForm: false }] }]), new Set());
    expect(host.querySelector("[data-question-custom-toggle]")).toBeNull();
    expect(host.querySelector("[data-question-custom-input]")).toBeNull();
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
    // The outcome recedes into the summary; the form is gone.
    expect(host.querySelector(".chat-request-trace")!.textContent).toBe("Answered");
    expect(host.querySelector("details.chat-request")!.hasAttribute("open")).toBe(false);
    expect(host.querySelector("[data-question-custom-toggle]")).toBeNull();
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
    // Named, not counted: the collapsed line says what the steps acted on.
    expect(group.querySelector(".chat-activity-subject")!.textContent).toBe("Read a.ts · Read b.ts · Read c.ts");
    expect(group.querySelectorAll(".chat-group-items [data-chat-item-id]")).toHaveLength(3);
  });

  test("a usage carrier renders nothing and does not split a finished run", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    // A tool-only message's usage rides an empty assistant_message item; it
    // must feed the context readout without becoming a bubble — and without
    // cutting the run of activities around it into two groups.
    const carrier: ConversationItem = { id: "usage:m1", type: "assistant_message", createdAt: 1, markdown: "", usage: { input: 500 } };
    renderer.render(host, projectionWith([user, tool("a"), carrier, tool("b"), tool("c"), answer], { status: "idle" }), new Set());
    expect(host.querySelector('[data-chat-item-id="usage:m1"]')).toBeNull();
    expect(Array.from(host.children).map(child => child.getAttribute("data-chat-item-id")))
      .toEqual(["message:u1", "group:tool:a", "part:a1"]);
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

  test("held messages render in the queue dock, ordered, removable, and never in the timeline", () => {
    const renderer = new TimelineRenderer();
    const dock = new QueueDockRenderer();
    const host = target();
    const dockHost = target();
    const projection = projectionWith(
      [{ id: "message:u1", type: "user_message", createdAt: 1, text: "earlier" }],
      { queued: [{ id: "held-1", text: "first held", queuedAt: 2 }, { id: "held-2", text: "second held", queuedAt: 3 }] },
    );
    renderer.render(host, projection, new Set());
    dock.render(dockHost, projection.queued);
    // The timeline never contains held messages — they are not transcript
    // entries until delivered.
    expect(host.querySelector(".is-held")).toBeNull();
    const held = [...dockHost.querySelectorAll(".chat-queued-message")];
    expect(held.map(node => node.textContent)).toEqual([
      expect.stringContaining("first held"),
      expect.stringContaining("second held"),
    ]);
    expect(held[0]!.querySelector("[data-queue-remove='held-1']")).not.toBeNull();
    expect(dockHost.hidden).toBe(false);

    // Delivery drains the dock and hides it.
    dock.render(dockHost, []);
    expect(dockHost.querySelector(".chat-queued-message")).toBeNull();
    expect(dockHost.hidden).toBe(true);
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

describe("streamed output auto-opens and then lets go", () => {
  const tool = (status: string, output: string): ConversationItem => ({
    id: "tool:grep", type: "tool", createdAt: 1, name: "grep", status: status as never, input: "pattern", output,
  });

  test("a running tool with output opens itself and collapses again once it finishes", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const row = () => host.querySelector('[data-chat-item-id="tool:grep"]') as HTMLElement;

    renderer.render(host, projectionWith([tool("running", "line one")]), new Set());
    expect(row().hasAttribute("open")).toBe(true);

    // The next render reads the node's own open state back. Without marking
    // the auto-open as the stream's rather than the reader's, "open" would be
    // sticky and the finished row would never return to its compact form.
    renderer.render(host, projectionWith([tool("running", "line one\nline two")]), new Set());
    expect(row().hasAttribute("open")).toBe(true);

    renderer.render(host, projectionWith([tool("completed", "line one\nline two")], { status: "idle" }), new Set());
    expect(row().hasAttribute("open")).toBe(false);
  });

  test("a row the reader opened while it ran stays open when it finishes", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const row = () => host.querySelector('[data-chat-item-id="tool:grep"]') as HTMLElement;

    renderer.render(host, projectionWith([tool("running", "line one")]), new Set());
    // What the toggle handler in ui.ts does on any reader interaction: the row
    // stops being the stream's and becomes theirs.
    row().removeAttribute("data-auto-open");

    renderer.render(host, projectionWith([tool("completed", "line one")], { status: "idle" }), new Set());
    expect(row().hasAttribute("open")).toBe(true);
  });

  test("a row the reader closes stays closed while the tool keeps talking", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const row = () => host.querySelector('[data-chat-item-id="tool:grep"]') as HTMLElement;

    renderer.render(host, projectionWith([tool("running", "line one")]), new Set());
    expect(row().hasAttribute("open")).toBe(true);

    // What ui.ts's toggle handler does when the reader collapses the row.
    row().removeAttribute("data-auto-open");
    row().toggleAttribute("data-reader-closed", true);
    row().removeAttribute("open");

    // The auto-open rule is recomputed from status and output on every render,
    // so without a memory of the close the next chunk would reopen the row —
    // the reader could not collapse a chatty tool at all while it ran.
    renderer.render(host, projectionWith([tool("running", "line one\nline two")]), new Set());
    expect(row().hasAttribute("open")).toBe(false);
    renderer.render(host, projectionWith([tool("completed", "line one\nline two")], { status: "idle" }), new Set());
    expect(row().hasAttribute("open")).toBe(false);
  });

  test("a persisted expansion still opens a finished row with no output", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([tool("completed", "")], { status: "idle" }), new Set(["tool:grep"]));
    expect((host.querySelector('[data-chat-item-id="tool:grep"]') as HTMLElement).hasAttribute("open")).toBe(true);
  });
});

describe("subagent entries", () => {
  const task = (id: string, extra: Partial<Extract<ConversationItem, { type: "tool" }>> = {}): ConversationItem => ({
    id: `tool:${id}`, type: "tool", createdAt: 1, name: "task", status: "completed",
    input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
    ...extra,
  });

  test("an entry carries the model and usage the adapter mirrored onto its row", () => {
    const [entry] = subagentEntries([task("a", {
      childConversationId: "child",
      model: "claude-sonnet-4-5",
      usage: { input: 1_200, output: 340, cacheRead: 800 },
    })]);
    expect(entry).toEqual({
      id: "tool:a",
      description: "Review renderer",
      subagent: "explore",
      status: "completed",
      conversationId: "child",
      model: "claude-sonnet-4-5",
      usage: { input: 1_200, output: 340, cacheRead: 800 },
    });
  });

  test("an unattributed subagent is still an entry, asserting neither figure", () => {
    const [entry] = subagentEntries([task("b")]);
    expect(entry).toEqual({ id: "tool:b", description: "Review renderer", subagent: "explore", status: "completed" });
    expect(entry).not.toHaveProperty("model");
    expect(entry).not.toHaveProperty("usage");
  });

  test("a model known before any usage is reported still names the model", () => {
    const [entry] = subagentEntries([task("c", { status: "running", model: "gpt-5" })]);
    expect(entry).toEqual(expect.objectContaining({ status: "running", model: "gpt-5" }));
    expect(entry).not.toHaveProperty("usage");
  });

  test("a long completed report renders spanning Markdown once behind a visual bound", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const report = ["**Finding one**", "```ts", ...Array.from({ length: 27 }, (_, index) => `const line${index + 1} = true;`), "```"].join("\n");
    renderer.render(host, projectionWith([task("long", { output: report })]), new Set(["tool:long"]));

    expect(host.querySelector(".chat-subagent-result strong")?.textContent).toBe("Finding one");
    const code = host.querySelectorAll(".chat-subagent-result pre code");
    expect(code).toHaveLength(1);
    expect(code[0]!.textContent).toContain("const line27 = true;");
    const more = host.querySelector(".chat-subagent-result .chat-output-more") as HTMLDetailsElement;
    expect(more.querySelector(".chat-report-expand")?.textContent).toBe("Show full report");
    expect(more.hasAttribute("open")).toBe(false);
  });

  test("a task keeps its report but hides transcript navigation when subagents are unsupported", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([task("legacy", { childConversationId: "child", output: "Report" })]), new Set(["tool:legacy"]), false);
    expect(host.textContent).toContain("Report");
    expect(host.querySelector("[data-open-conversation]")).toBeNull();
  });
});

describe("task progress renders one presentation updated in place", () => {
  const list = (entries: Array<{ text: string; status: "pending" | "in_progress" | "completed"; activeText?: string }>): ConversationItem => ({
    id: "task-progress",
    type: "task_progress",
    createdAt: 5,
    entries,
  });

  test("many updates keep a single element reflecting current states", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([list([
      { text: "Read the code", status: "completed" },
      { text: "Fix the bug", status: "in_progress", activeText: "Fixing the bug" },
      { text: "Run tests", status: "pending" },
    ])]), new Set());
    expect(host.querySelectorAll(".chat-task-progress")).toHaveLength(1);
    expect(host.querySelector(".chat-task-progress-count")?.textContent).toBe("1/3");
    // In-progress rows show their active label.
    expect(host.textContent).toContain("Fixing the bug");
    expect(host.textContent).not.toContain("Fix the bug");

    renderer.render(host, projectionWith([list([
      { text: "Read the code", status: "completed" },
      { text: "Fix the bug", status: "completed" },
      { text: "Run tests", status: "in_progress" },
    ])]), new Set());
    expect(host.querySelectorAll(".chat-task-progress")).toHaveLength(1);
    expect(host.querySelector(".chat-task-progress-count")?.textContent).toBe("2/3");
    expect(host.querySelectorAll(".chat-task.is-completed")).toHaveLength(2);
  });
});

describe("dialogs and elicitations reuse the question card", () => {
  test("a dialog card says who asks, offers the kind's choices, and keeps the raw request", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{
      ...question,
      id: "question:dl-1",
      requestId: "dl-1",
      source: "dialog",
      intro: "Claude Code asks how to continue after claude-opus-5 declined this request.",
      schema: { dialogKind: "refusal_fallback_prompt", payload: { fallbackModel: "claude-sonnet-5" } },
      questions: [{ prompt: "Opus declined.", header: "Refusal", options: [{ label: "Retry on claude-sonnet-5", description: "" }, { label: "Edit the prompt", description: "" }], multiple: false, allowFreeForm: false }],
    }]), new Set());
    const card = host.querySelector('[data-chat-item-id="question:dl-1"]')!;
    expect(card.getAttribute("data-question-source")).toBe("dialog");
    expect(card.querySelector("summary")?.textContent).toContain("Dialog");
    expect(card.querySelector(".chat-request-intro")?.textContent).toContain("declined this request");
    expect([...card.querySelectorAll("[data-question-provider-option]")].map(input => input.getAttribute("value"))).toEqual(["Retry on claude-sonnet-5", "Edit the prompt"]);
    // No free-form entry for a fixed vocabulary.
    expect(card.querySelector("[data-question-custom-toggle]")).toBeNull();
    expect(card.querySelector(".chat-request-raw pre")?.textContent).toContain("refusal_fallback_prompt");
  });

  test("an elicitation card links out, renders schema fields as steps, and drops the raw request once resolved", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const elicitation: ConversationItem = {
      ...question,
      id: "question:el-1",
      requestId: "el-1",
      source: "elicitation",
      intro: "github asks: Sign in to continue",
      link: "https://example.com/auth",
      schema: { type: "object", properties: { username: { type: "string" } } },
      questions: [
        { prompt: "Your login", header: "GitHub username", options: [], multiple: false, allowFreeForm: true },
        { prompt: "Log everything?", header: "verbose", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiple: false, allowFreeForm: false },
      ],
    };
    renderer.render(host, projectionWith([elicitation]), new Set());
    const card = host.querySelector('[data-chat-item-id="question:el-1"]')!;
    expect(card.querySelector("summary")?.textContent).toContain("Input requested");
    const link = card.querySelector<HTMLAnchorElement>(".chat-request-link a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/auth");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(card.querySelectorAll("[data-question-panel]")).toHaveLength(2);
    expect(card.querySelector("[data-question-custom-input]")).not.toBeNull();
    expect(card.querySelector(".chat-request-raw")).not.toBeNull();

    renderer.render(host, projectionWith([{ ...elicitation, status: "resolved", outcome: { kind: "answered", answers: [["octocat"], ["No"]] } } as ConversationItem]), new Set());
    const resolved = host.querySelector('[data-chat-item-id="question:el-1"]')!;
    expect(resolved.querySelector(".chat-request-trace")?.textContent).toBe("Answered");
    expect(resolved.querySelector(".chat-request-raw")).toBeNull();
  });
});

describe("group summaries name what the steps acted on", () => {
  const bash = (id: string, createdAt: number, command: string): ConversationItem => ({ id, type: "tool", createdAt, name: "Bash", status: "completed", input: JSON.stringify({ command }), output: "ok" });

  test("a finished run of Bash rows reads their commands", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      bash("tool:1", 1, "./hello.sh"),
      bash("tool:2", 2, "ls -la"),
      { id: "tool:3", type: "tool", createdAt: 3, name: "Read", status: "completed", input: JSON.stringify({ file_path: "README.md" }), output: "# Hi" },
    ], { status: "completed" }), new Set());
    const group = host.querySelector(".chat-activity-group")!;
    expect(group.querySelector(".chat-activity-subject")?.textContent).toBe("Bash ./hello.sh · Bash ls -la · Read README.md");
    // Each row still names its own command as the subject.
    expect(host.querySelector('[data-chat-item-id="tool:1"] .chat-activity-subject')?.textContent).toBe("./hello.sh");
    expect(host.querySelector('[data-chat-item-id="tool:1"] .chat-tool-command')?.textContent).toBe("./hello.sh");
  });

  test("a long run names the first three and counts the rest by kind", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      bash("tool:1", 1, "./hello.sh"),
      bash("tool:2", 2, "ls -la"),
      bash("tool:3", 3, "date"),
      bash("tool:4", 4, "cat notes.md"),
      bash("tool:5", 5, "whoami"),
      { id: "tool:6", type: "tool", createdAt: 6, name: "Read", status: "completed", input: JSON.stringify({ file_path: "README.md" }), output: "# Hi" },
    ], { status: "completed" }), new Set());
    expect(host.querySelector(".chat-activity-group .chat-activity-subject")?.textContent).toBe("Bash ./hello.sh · Bash ls -la · Bash date · Bash ×2 · Read");
  });

  test("reasoning steps are counted, never named, so the commands keep the named slots", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const thought = (id: string, createdAt: number): ConversationItem => ({ id, type: "reasoning", createdAt, text: "hmm", status: "completed" });
    renderer.render(host, projectionWith([
      thought("reasoning:1", 1),
      bash("tool:1", 2, "./hello.sh"),
      thought("reasoning:2", 3),
      bash("tool:2", 4, "ls -la"),
      thought("reasoning:3", 5),
      { id: "tool:3", type: "tool", createdAt: 6, name: "Read", status: "completed", input: JSON.stringify({ file_path: "README.md" }), output: "# Hi" },
      thought("reasoning:4", 7),
    ], { status: "completed" }), new Set());
    expect(host.querySelector(".chat-activity-group > summary .chat-activity-subject")?.textContent).toBe("Bash ./hello.sh · Bash ls -la · Read README.md · Thought ×4");
  });

  test("a backgrounded command says so in its body", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ id: "tool:bg", type: "tool", createdAt: 1, name: "Bash", status: "completed", input: JSON.stringify({ command: "sleep 20 && echo done", description: "Wait then report", run_in_background: true }), output: "Command running in background" }]), new Set());
    const row = host.querySelector('[data-chat-item-id="tool:bg"]')!;
    expect(row.querySelector(".chat-tool-meta")?.textContent).toBe("Wait then report · started in the background");
  });
});

describe("recalled memory rows and coded notices", () => {
  test("a memory recall renders as a labelled reasoning-style row and collapses into groups like reasoning", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const recalled: ConversationItem = { id: "memory:1", type: "reasoning", createdAt: 1, text: "[personal] ~/.claude/memory/ux.md", status: "completed", label: "Recalled from memory" };
    renderer.render(host, projectionWith([recalled]), new Set());
    expect(host.querySelector('[data-chat-item-id="memory:1"] summary > span')?.textContent).toBe("Recalled from memory");
    expect(host.querySelector('[data-chat-item-id="memory:1"] pre')?.textContent).toBe("[personal] ~/.claude/memory/ux.md");
    renderer.render(host, projectionWith([
      recalled,
      { id: "reasoning:1", type: "reasoning", createdAt: 2, text: "hmm", status: "completed" },
      { id: "tool:1", type: "tool", createdAt: 3, name: "Read", status: "completed", input: JSON.stringify({ file_path: "a.ts" }), output: "x" },
    ], { status: "completed" }), new Set());
    expect(host.querySelector(".chat-activity-group > summary .chat-activity-subject")?.textContent).toBe("Read a.ts · Recalled from memory · Thought");
  });

  test("a coded notice carries its code for the surface to react to", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ id: "notice:rl", type: "notice", createdAt: 1, level: "error", message: "Rate limit reached for your 5-hour window.", code: "rate-limit-rejected", resetsAt: 1_788_400_000_000 }]), new Set());
    const notice = host.querySelector('[data-chat-item-id="notice:rl"]')!;
    expect(notice.getAttribute("data-notice-code")).toBe("rate-limit-rejected");
    // The reset time is the reader's clock, appended where the notice shows.
    expect(notice.textContent).toMatch(/^Rate limit reached for your 5-hour window\. Resets \d.*\.$/);
    expect(notice.getAttribute("role")).toBe("alert");
  });
});

describe("background task rows and tool elapsed time", () => {
  const settled = (status: "completed" | "failed" | "stopped", createdAt: number): ConversationItem => ({
    id: `task:${status}`, type: "background_task", createdAt, taskId: status, description: "Sleep for 20 seconds then echo done", taskType: "local_bash", toolUseId: "toolu_1", status, summary: status === "completed" ? "done" : status === "failed" ? "exit 1" : undefined,
  });

  test("a running task is not a timeline row; a settled one names its outcome and summary", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      { id: "task:live", type: "background_task", createdAt: 1, taskId: "live", description: "Still running", status: "running", progress: "Using Bash" },
      settled("completed", 2),
    ], { status: "background" }), new Set());
    expect(host.querySelector('[data-chat-item-id="task:live"]')).toBeNull();
    const row = host.querySelector('[data-chat-item-id="task:completed"]')!;
    expect(row.querySelector("summary > span")?.textContent).toBe("Background task finished");
    expect(row.querySelector(".chat-activity-subject")?.textContent).toBe("Sleep for 20 seconds then echo done");
    expect(row.querySelector(".chat-task-summary")?.textContent).toBe("done");
    expect(row.className).toContain("is-completed");
  });

  test("failed and stopped tasks read as such and join activity groups", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([settled("failed", 1), settled("stopped", 2), { id: "tool:x", type: "tool", createdAt: 3, name: "Read", status: "completed", input: JSON.stringify({ file_path: "out.txt" }), output: "done" }], { status: "completed" }), new Set());
    expect(host.querySelector(".chat-activity-group > summary .chat-activity-subject")?.textContent).toBe("Background task failed Sleep for 20 seconds then echo done · Background task stopped Sleep for 20 seconds then echo done · Read out.txt");
    expect(host.querySelector('[data-chat-item-id="task:failed"] .chat-activity-status')?.textContent).toBe("failed");
    expect(host.querySelector('[data-chat-item-id="task:stopped"] .chat-activity-status')?.textContent).toBe("stopped");
    expect(host.querySelector('[data-chat-item-id="task:stopped"]')?.className).toContain("is-cancelled");
  });

  test("a running tool with a reported elapsed time states it in place; reasoning rows do not", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const tool: ConversationItem = { id: "tool:slow", type: "tool", createdAt: 1, name: "Bash", status: "running", input: JSON.stringify({ command: "sleep 30" }) };
    renderer.render(host, projectionWith([tool]), new Set());
    expect(host.querySelector('[data-chat-item-id="tool:slow"] .chat-activity-status')?.textContent).toBe("running");
    renderer.render(host, projectionWith([{ ...tool, elapsedMs: 12_400 }]), new Set());
    expect(host.querySelector('[data-chat-item-id="tool:slow"] .chat-activity-status')?.textContent).toBe("running · 12s");
    renderer.render(host, projectionWith([{ ...tool, status: "completed", output: "ok" }]), new Set());
    expect(host.querySelector('[data-chat-item-id="tool:slow"] .chat-activity-status')?.textContent).toBe("completed");
    renderer.render(host, projectionWith([{ id: "reasoning:1", type: "reasoning", createdAt: 1, text: "hmm", status: "running" }]), new Set());
    expect(host.querySelector('[data-chat-item-id="reasoning:1"] .chat-activity-status')?.textContent).toBe("running");
  });
});

describe("compaction markers and context reports", () => {
  const tool = (id: string, createdAt: number): ConversationItem => ({ id, type: "tool", createdAt, name: "Bash", status: "completed", input: JSON.stringify({ command: `echo ${id}` }), output: id });

  test("a compaction renders as a labelled boundary with the reported figures", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      tool("tool:a", 1),
      { id: "compaction:1", type: "compaction", createdAt: 2, trigger: "auto", preTokens: 180_000, postTokens: 40_000 },
      tool("tool:b", 3),
    ], { status: "completed" }), new Set());
    const marker = host.querySelector(".chat-compaction")!;
    expect(marker.textContent).toBe("Context compacted · 180,000 → 40,000 tokens");
    expect(marker.getAttribute("role")).toBe("status");
    // Between the two runs, with the earlier content still above it.
    const ids = [...host.querySelectorAll("[data-chat-item-id]")].map(node => node.getAttribute("data-chat-item-id"));
    expect(ids).toEqual(["tool:a", "compaction:1", "tool:b"]);
  });

  test("a manual compaction without figures still names itself", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ id: "compaction:2", type: "compaction", createdAt: 2, trigger: "manual" }]), new Set());
    expect(host.querySelector(".chat-compaction")?.textContent).toBe("Context compacted on request");
  });

  test("a context report is data for the readout, never a row, and never splits a group", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      tool("tool:a", 1),
      { id: "context:report:1", type: "context_report", createdAt: 2, total: 9_697, max: 1_000_000 },
      tool("tool:b", 3),
      tool("tool:c", 4),
    ], { status: "completed" }), new Set());
    expect(host.querySelector('[data-chat-item-id="context:report:1"]')).toBeNull();
    expect(host.querySelectorAll(".chat-activity-group")).toHaveLength(1);
  });
});

describe("plan approvals carry the plan and agent-provided intents", () => {
  const plan: ConversationItem = {
    id: "permission:plan1",
    type: "permission",
    createdAt: 3,
    requestId: "plan1",
    action: "Review the plan",
    resources: [],
    status: "pending",
    plan: "## Plan\n\n1. Do the **thing**",
    choices: [
      { id: "implement", label: "Approve and implement" },
      { id: "implement-and-restore", label: "Approve, then return to acceptEdits", description: "Go back afterwards" },
    ],
  };

  test("renders the plan as markdown with one button per intent plus Reject", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([plan]), new Set());
    expect(host.querySelector(".chat-request-plan")?.innerHTML).toContain("<strong>thing</strong>");
    const choiceButtons = [...host.querySelectorAll("[data-permission-choice]")];
    expect(choiceButtons.map(button => button.getAttribute("data-permission-choice"))).toEqual(["implement", "implement-and-restore"]);
    // The generic approve pair is replaced; rejecting stays universal.
    const outcomes = [...host.querySelectorAll("[data-permission-outcome]")].map(button => button.getAttribute("data-permission-outcome"));
    expect(outcomes).toEqual(["rejected"]);
    expect(host.textContent).not.toContain("Allow always");
  });

  test("a resolved choice card recedes to the chosen intent's label", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ ...plan, status: "resolved", outcome: "approved-once", choiceId: "implement-and-restore" } as ConversationItem]), new Set());
    expect(host.querySelector(".chat-request-trace")?.textContent).toBe("Approve, then return to acceptEdits");
    expect(host.querySelector(".chat-request-plan")).toBeNull();
  });
});

describe("permission choices state the authority they grant", () => {
  const permission: ConversationItem = {
    id: "permission:p1",
    type: "permission",
    createdAt: 3,
    requestId: "p1",
    action: "skill",
    resources: ["review-code"],
    status: "pending",
  };

  function renderPending(): HTMLElement {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([permission]), new Set());
    return host;
  }

  test("offers all three choices, and the persistent one keeps its wire value", () => {
    const host = renderPending();
    const outcomes = [...host.querySelectorAll("[data-permission-outcome]")]
      .map(node => (node as HTMLElement).dataset.permissionOutcome);
    expect(outcomes).toEqual(["approved-once", "approved-session", "rejected"]);

    // The transported value is unchanged — only the human-facing text moved.
    const persistent = host.querySelector('[data-permission-outcome="approved-session"]') as HTMLElement;
    expect(persistent.textContent).toBe("Allow always");
  });

  test("states the owning agent's reach of persistent approval and never calls it session-limited", () => {
    // OpenCode's own verified sentence, carried on its descriptor.
    const renderer = new TimelineRenderer();
    renderer.permissionScopeNote = "“Allow always” also covers later conversations, and similar requests — until OpenCode restarts.";
    const host = target();
    renderer.render(host, projectionWith([permission]), new Set());
    const text = host.textContent ?? "";
    expect(text).toContain("later conversations");
    expect(text).toContain("until OpenCode restarts");
    // The mislabel this change exists to remove, in any of its shapes.
    expect(text).not.toContain("Allow session");
    expect(text).not.toMatch(/only (this|the current) (session|conversation)\b/i);
  });

  test("a Claude Code card states Claude Code's reach and never names another agent", () => {
    const renderer = new TimelineRenderer();
    renderer.permissionScopeNote = "“Allow always” also covers similar requests for the rest of this turn. Nothing is saved to your settings.";
    const host = target();
    renderer.render(host, projectionWith([permission]), new Set());
    const scope = host.querySelector(".chat-request-scope")!.textContent ?? "";
    expect(scope).toContain("rest of this turn");
    expect(host.textContent).not.toContain("OpenCode");
    // Changing the declared sentence re-renders the card with the new one.
    renderer.permissionScopeNote = "Something else entirely.";
    renderer.render(host, projectionWith([permission]), new Set());
    expect(host.querySelector(".chat-request-scope")!.textContent).toBe("Something else entirely.");
  });

  test("an agent that declares no scope sentence gets no scope line, not another agent's", () => {
    const host = renderPending();
    expect(host.querySelector(".chat-request-scope")).toBeNull();
    expect(host.textContent).not.toContain("OpenCode");
  });

  test("a pending edit permission shows its diff where the choices are; a plain one shows none", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ ...permission, diff: "@@ -1 +1 @@\n-old line\n+new line" }]), new Set());
    const change = host.querySelector(".chat-request-change .chat-diff");
    expect(change).not.toBeNull();
    expect(change!.textContent).toContain("- old line");
    expect(change!.textContent).toContain("+ new line");
    // The diff sits with the approve/reject actions, in the same card.
    expect(host.querySelector(".chat-request .chat-request-actions")).not.toBeNull();

    const bare = target();
    renderer.render(bare, projectionWith([permission]), new Set());
    expect(bare.querySelector(".chat-request-change")).toBeNull();
  });

  test("a resolved edit permission does not re-show its diff", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ ...permission, status: "resolved", outcome: "approved-once", diff: "@@ -1 +1 @@\n-a\n+b" }]), new Set());
    expect(host.querySelector(".chat-request-change")).toBeNull();
    expect(host.querySelector(".chat-request-trace")!.textContent).toBe("Allowed once");
  });

  test("a resolved request states its outcome without offering choices again", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([{ ...permission, status: "resolved", outcome: "approved-session" }]), new Set());
    expect(host.querySelectorAll("[data-permission-outcome]")).toHaveLength(0);
    // Receded: the outcome is stated in words in the summary trace, the card is
    // closed, and the resources it named are still in the collapsed body.
    expect(host.querySelector(".chat-request-trace")!.textContent).toBe("Allowed always");
    expect(host.querySelector("details.chat-request")!.hasAttribute("open")).toBe(false);
    expect(host.querySelector("details.chat-request ul code")!.textContent).toContain("review-code");
  });

  test("a resolved card the reader opened stays open when the item is republished", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const row = () => host.querySelector("details.chat-request") as HTMLElement;
    renderer.render(host, projectionWith([{ ...permission, status: "resolved", outcome: "approved-once" }]), new Set());
    expect(row().hasAttribute("open")).toBe(false);

    // The reader opens the receded card to audit what was granted.
    row().setAttribute("open", "");
    // A resync republishes the same resolved item with fresh object identity;
    // that is not a new resolution, and it must not snap the audit shut.
    renderer.render(host, projectionWith([{ ...permission, status: "resolved", outcome: "approved-once" }]), new Set());
    expect(row().hasAttribute("open")).toBe(true);

    // The pending→resolved transition is what recedes: a card that resolves
    // while open starts closed.
    const fresh = target();
    renderer.render(fresh, projectionWith([permission]), new Set());
    const pendingRow = fresh.querySelector("details.chat-request") as HTMLElement;
    expect(pendingRow.hasAttribute("open")).toBe(true);
    renderer.render(fresh, projectionWith([{ ...permission, status: "resolved", outcome: "rejected" }]), new Set());
    expect((fresh.querySelector("details.chat-request") as HTMLElement).hasAttribute("open")).toBe(false);
  });
});

describe("a request's state is visible without reading it", () => {
  const base = { type: "permission" as const, action: "bash", resources: ["rm -rf build"] };
  function stack(): HTMLElement {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      { ...base, id: "permission:done", createdAt: 1, requestId: "done", status: "resolved", outcome: "approved-once" },
      { ...base, id: "permission:queued", createdAt: 2, requestId: "queued", status: "pending" },
      { ...base, id: "permission:active", createdAt: 3, requestId: "active", status: "pending" },
    ]), new Set());
    return host;
  }

  test("each state is carried as data, so styling and counting cannot disagree", () => {
    const host = stack();
    const states = [...host.querySelectorAll("[data-request-state]")]
      .map(node => (node as HTMLElement).dataset.requestState);
    // Newest pending is answerable; the older pending one waits its turn.
    expect(states).toEqual(["resolved", "queued", "needs-answer"]);
  });

  test("the distinction is not colour alone", () => {
    const host = stack();
    const active = host.querySelector('[data-chat-item-id="permission:active"]')!;
    const queued = host.querySelector('[data-chat-item-id="permission:queued"]')!;
    const resolved = host.querySelector('[data-chat-item-id="permission:done"]')!;
    expect(active.querySelector(".chat-request-badge")?.textContent).toBe("Needs your answer");
    expect(queued.querySelector(".chat-request-badge")?.textContent).toBe("Waiting its turn");
    expect(resolved.querySelector(".chat-request-badge")).toBeNull();
  });

  test("a queued request is never described as obsolete", () => {
    const queued = stack().querySelector('[data-chat-item-id="permission:queued"]')!;
    const text = queued.textContent ?? "";
    expect(text).toContain("Waiting its turn");
    for (const lie of ["Superseded", "superseded", "obsolete", "Resolved"]) {
      expect(text).not.toContain(lie);
    }
  });

  test("questions carry the same states as permissions", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      { ...question, id: "question:older", createdAt: 1, requestId: "older" },
      { ...question, id: "question:newer", createdAt: 2, requestId: "newer" },
    ]), new Set());
    const states = [...host.querySelectorAll("[data-request-state]")]
      .map(node => (node as HTMLElement).dataset.requestState);
    expect(states).toEqual(["queued", "needs-answer"]);
    expect(host.querySelector('[data-chat-item-id="question:older"]')?.textContent).toContain("Waiting its turn");
  });
});

describe("requests owned by different conversations do not block each other", () => {
  const perm = { type: "permission" as const, action: "bash", resources: ["ls"], status: "pending" as const };

  test("each owner gets its own answerable request", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      // The parent's own older request, then its newer one, then a subagent's.
      { ...perm, id: "permission:own-old", createdAt: 1, requestId: "own-old" },
      { ...perm, id: "permission:own-new", createdAt: 2, requestId: "own-new" },
      { ...perm, id: "permission:child", createdAt: 3, requestId: "child", conversationId: "sub-1" },
    ]), new Set());
    const state = (id: string) => (host.querySelector(`[data-chat-item-id="${id}"]`) as HTMLElement).dataset.requestState;
    // The parent's newest is answerable, and so is the subagent's — one does
    // not consume the other's slot.
    expect(state("permission:own-new")).toBe("needs-answer");
    expect(state("permission:child")).toBe("needs-answer");
    expect(state("permission:own-old")).toBe("queued");
  });

  test("timestamp ties resolve by id, matching the server's admission rule", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    // Reconciled requests share one Date.now(); provider order put the
    // server-losing candidate LAST, which array order would wrongly enable.
    renderer.render(host, projectionWith([
      { ...perm, id: "permission:req-b", createdAt: 5, requestId: "req-b" },
      { ...perm, id: "permission:req-a", createdAt: 5, requestId: "req-a" },
    ]), new Set());
    const state = (id: string) => (host.querySelector(`[data-chat-item-id="${id}"]`) as HTMLElement).dataset.requestState;
    // requirePending breaks the tie toward the greater id — the UI must too,
    // or every enabled answer is refused as stale.
    expect(state("permission:req-b")).toBe("needs-answer");
    expect(state("permission:req-a")).toBe("queued");
  });

  test("a surfaced subagent request says who is asking", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      { ...perm, id: "permission:own", createdAt: 1, requestId: "own" },
      { ...perm, id: "permission:sub", createdAt: 2, requestId: "sub", conversationId: "child-1" },
    ]), new Set());
    // The decision reaches the user's other conversations, so who is asking is
    // part of what they need to decide.
    expect(host.querySelector('[data-chat-item-id="permission:sub"]')?.textContent).toContain("Requested by Subagent.");
    expect(host.querySelector('[data-chat-item-id="permission:own"]')?.textContent).not.toContain("Requested by");
  });

  test("a single-owner timeline behaves exactly as before", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    renderer.render(host, projectionWith([
      { ...perm, id: "permission:a", createdAt: 1, requestId: "a", conversationId: "c1" },
      { ...perm, id: "permission:b", createdAt: 2, requestId: "b", conversationId: "c1" },
    ]), new Set());
    const states = [...host.querySelectorAll("[data-request-state]")].map(n => (n as HTMLElement).dataset.requestState);
    expect(states).toEqual(["queued", "needs-answer"]);
  });
});

describe("foreign request origins", () => {
  const childId = "child-1";
  const task: ConversationItem = {
    id: "tool:agent", type: "tool", createdAt: 1, name: "task", status: "completed",
    input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
    childConversationId: childId,
  };
  const permission: ConversationItem = {
    id: "permission:child", type: "permission", createdAt: 2, requestId: "child-permission",
    conversationId: childId, action: "bash", resources: ["bun test"], status: "pending",
  };

  test("pending and resolved permission and question cards retain labelled transcript controls", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const resolvedQuestion: ConversationItem = {
      ...question, id: "question:child", conversationId: childId, status: "resolved",
      outcome: { kind: "answered", answers: [["a"]] },
    };
    renderer.render(host, projectionWith([task, permission, resolvedQuestion]), new Set());

    for (const id of ["permission:child", "question:child"]) {
      const card = host.querySelector(`[data-chat-item-id="${id}"]`)!;
      expect(card.querySelector(".chat-request-origin")?.textContent).toContain("Requested by explore · Review renderer.");
      expect(card.querySelector<HTMLButtonElement>("[data-open-conversation]")?.dataset.openConversation).toBe(childId);
    }
  });

  test("late task attribution replaces the generic fallback without changing the request", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const childQuestion = { ...question, conversationId: childId } satisfies ConversationItem;
    renderer.render(host, projectionWith([childQuestion]), new Set());
    const fallback = host.querySelector('[data-chat-item-id="question:q1"]')!;
    expect(fallback.querySelector(".chat-request-origin")?.textContent).toContain("Requested by Subagent.");

    renderer.render(host, projectionWith([childQuestion, task]), new Set());
    const attributed = host.querySelector('[data-chat-item-id="question:q1"]')!;
    expect(attributed).not.toBe(fallback);
    expect(attributed.querySelector(".chat-request-origin")?.textContent).toContain("Requested by explore · Review renderer.");
  });

  test("escapes hostile child IDs in transcript controls", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const hostile = `child\"><img src=x onerror="globalThis.pwned=true">`;
    renderer.render(host, projectionWith([
      { ...task, childConversationId: hostile },
      { ...permission, conversationId: hostile },
    ]), new Set());

    const control = host.querySelector<HTMLButtonElement>("[data-open-conversation]")!;
    expect(control.dataset.openConversation).toBe(hostile);
    expect(host.querySelector("img")).toBeNull();
  });

  test("own requests have no origin and capability-disabled foreign requests have no dead control", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const ownQuestion = { ...question, conversationId: "c1" } satisfies ConversationItem;
    renderer.render(host, projectionWith([task, ownQuestion, permission]), new Set(), false);

    const own = host.querySelector('[data-chat-item-id="question:q1"]')!;
    const foreign = host.querySelector('[data-chat-item-id="permission:child"]')!;
    expect(own.querySelector(".chat-request-origin")).toBeNull();
    expect(own.querySelector("[data-open-conversation]")).toBeNull();
    expect(foreign.querySelector(".chat-request-origin")?.textContent).toBe("Requested by a subagent of this conversation.");
    expect(foreign.querySelector("[data-open-conversation]")).toBeNull();
  });
});

describe("reversible-history controls", () => {
  test("renders Revert only when the main timeline declares the capability", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const item: ConversationItem = { id: "message:user", type: "user_message", createdAt: 1, text: "try this" };
    renderer.render(host, projectionWith([item]), new Set());
    expect(host.querySelector("[data-history-revert]")).toBeNull();

    renderer.render(host, projectionWith([item]), new Set(), true, true);
    const button = host.querySelector<HTMLButtonElement>("[data-history-revert]")!;
    expect(button.dataset.historyRevert).toBe("message:user");
    expect(button.getAttribute("aria-label")).toBe("Revert message");
  });

  test("reconciles escaped hidden turns and hides the dock when restored", () => {
    const shell = document.createElement("details");
    const label = document.createElement("span");
    const items = document.createElement("div");
    shell.append(label, items);
    const renderer = new RevertedMessagesDockRenderer(shell, label, items);
    renderer.render([
      { id: 'message:\"one', text: "first <turn>" },
      { id: "message:two", text: "second turn" },
    ]);

    expect(shell.hidden).toBe(false);
    expect(label.textContent).toBe("2 reverted messages");
    expect(items.querySelectorAll("[data-history-restore]")).toHaveLength(2);
    expect(items.querySelector("img")).toBeNull();
    expect(items.textContent).toContain("first <turn>");

    renderer.render([]);
    expect(shell.hidden).toBe(true);
    expect(items.childElementCount).toBe(0);
  });
});

describe("tool output is streamed live and bounded when finished", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  test("a running tool shows its tail live and opens itself", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const item: ConversationItem = { id: "tool:t1", type: "tool", createdAt: 1, name: "bash", status: "running", output: lines(30) };
    renderer.render(host, projectionWith([item]), new Set());
    const row = host.querySelector('[data-chat-item-id="tool:t1"]') as HTMLDetailsElement;
    expect(row.hasAttribute("open")).toBe(true);
    // The tail is shown; earlier lines are elided without rescanning to count them.
    expect(host.querySelector(".chat-tool-stream")!.textContent).toContain("line 30");
    expect(host.querySelector(".chat-tool-stream")!.textContent).not.toContain("line 1\n");
    expect(host.querySelector(".chat-output-elided")!.textContent).toBe("Earlier output omitted");
  });

  test("a finished tool bounds long output behind a show-more, keeping the rest", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const item: ConversationItem = { id: "tool:t2", type: "tool", createdAt: 1, name: "bash", status: "completed", output: lines(30) };
    renderer.render(host, projectionWith([item]), new Set());
    // Preview shown, the rest behind a native show-more that still holds it.
    expect(host.querySelector(".chat-tool-stream")).toBeNull();
    const more = host.querySelector(".chat-output-more") as HTMLDetailsElement;
    expect(more.querySelector("summary")!.textContent).toContain("Show 18 more lines");
    expect(more.hasAttribute("open")).toBe(false);
    expect(more.textContent).toContain("line 30");
  });

  test("a finished tool with short output shows it whole", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const item: ConversationItem = { id: "tool:t3", type: "tool", createdAt: 1, name: "bash", status: "completed", output: lines(4) };
    renderer.render(host, projectionWith([item]), new Set());
    expect(host.querySelector(".chat-output-more")).toBeNull();
    expect(host.querySelector('[data-chat-item-id="tool:t3"] pre')!.textContent).toContain("line 4");
  });

  test("a running shell update keeps one keyed row and only its bounded tail", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const command = (output: string): ConversationItem => ({
      id: "tool:shell", type: "command", createdAt: 1, command: "bun test", status: "running", output,
    });

    renderer.render(host, projectionWith([command(lines(20))]), new Set());
    renderer.render(host, projectionWith([command(lines(30))]), new Set());

    expect(host.querySelectorAll('[data-chat-item-id="tool:shell"]')).toHaveLength(1);
    const stream = host.querySelector(".chat-tool-stream")!;
    expect(stream.textContent!.split("\n")).toHaveLength(12);
    expect(stream.textContent).toContain("line 30");
    expect(stream.textContent).not.toContain("line 18\n");
  });

  test("a fast-completed shell retains inspectable output behind the existing bound", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const item: ConversationItem = {
      id: "tool:fast-shell", type: "command", createdAt: 1, command: "bun test", status: "completed", output: lines(30), exitCode: 0,
    };
    renderer.render(host, projectionWith([item], { status: "idle" }), new Set());

    expect(host.querySelectorAll('[data-chat-item-id="tool:fast-shell"]')).toHaveLength(1);
    expect(host.querySelector('[data-chat-item-id="tool:fast-shell"] .chat-activity-status')!.textContent).toBe("completed");
    const more = host.querySelector(".chat-output-more") as HTMLDetailsElement;
    expect(more.querySelector("summary")!.textContent).toContain("Show 18 more lines");
    expect(more.hasAttribute("open")).toBe(false);
    expect(more.textContent).toContain("line 30");
  });
});
