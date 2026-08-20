import { beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ChatProjection } from "./projection";
import type { ConversationItem } from "./types";

const dom = parseHTML("<!doctype html><html><body><div id=\"items\"></div></body></html>");
beforeAll(() => {
  (globalThis as Record<string, unknown>).document = dom.document;
});

const { TimelineRenderer, subagentEntries } = await import("./timeline-renderer");

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

  test("keeps the assistant shell stable and adds idempotent copy actions only on completion", () => {
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
    expect(article.querySelectorAll("[data-chat-copy='answer']")).toHaveLength(1);
    expect(article.querySelectorAll("[data-chat-copy='code']")).toHaveLength(2);
    expect([...article.querySelectorAll("pre > code")].map(code => code.textContent)).toEqual(["const a = 1;\n", "echo ok\n"]);

    renderer.render(host, projectionWith([assistant], { status: "completed" }), new Set());
    expect(article.querySelectorAll("[data-chat-copy]")).toHaveLength(3);
  });

  test("patches cumulative completed Markdown without replacing shell actions", () => {
    const renderer = new TimelineRenderer();
    const host = target();
    const assistant: ConversationItem = { id: "part:done", type: "assistant_message", createdAt: 1, completedAt: 2, markdown: "Hello" };
    renderer.render(host, projectionWith([assistant]), new Set());
    const article = host.querySelector<HTMLElement>(".chat-assistant-message")!;
    const answerCopy = article.querySelector("[data-chat-copy='answer']");
    renderer.render(host, projectionWith([{ ...assistant, markdown: "Hello again" }]), new Set());
    expect(host.querySelector(".chat-assistant-message")).toBe(article);
    expect(article.querySelector("[data-chat-copy='answer']")).toBe(answerCopy);
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
    expect(group.querySelector(".chat-activity-subject")!.textContent).toBe("Read ×3");
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
    renderer.render(host, projectionWith([task("legacy", { childConversationId: "child", output: "Report" })]), new Set(["tool:legacy"]), undefined, false);
    expect(host.textContent).toContain("Report");
    expect(host.querySelector("[data-open-conversation]")).toBeNull();
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

  test("states the reach of persistent approval and never calls it session-limited", () => {
    const text = renderPending().textContent ?? "";
    expect(text).toContain("later conversations");
    expect(text).toContain("until OpenCode restarts");
    // The mislabel this change exists to remove, in any of its shapes.
    expect(text).not.toContain("Allow session");
    expect(text).not.toMatch(/only (this|the current) (session|conversation)\b/i);
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
    expect(host.querySelector('[data-chat-item-id="permission:sub"]')?.textContent).toContain("Requested by a subagent");
    expect(host.querySelector('[data-chat-item-id="permission:own"]')?.textContent).not.toContain("Requested by a subagent");
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
});
