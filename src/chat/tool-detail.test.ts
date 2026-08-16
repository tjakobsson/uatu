import { describe, expect, test } from "bun:test";
import { deriveTodoActivities, describeToolDetail, humanizeToolName, naiveLineDiff, patchDiffLines, patchFiles, todoActivitySummary, toolSubject } from "./tool-detail";

describe("describeToolDetail", () => {
  test("classifies edit calls and diffs only the changed region", () => {
    const detail = describeToolDetail({
      name: "edit",
      input: JSON.stringify({ filePath: "src/app.ts", oldString: "a\nb\nc", newString: "a\nB\nc" }),
    });
    expect(detail).toEqual({
      kind: "edit",
      label: "Edit",
      path: "src/app.ts",
      diff: [{ sign: "-", text: "b" }, { sign: "+", text: "B" }],
    });
    expect(toolSubject(detail)).toBe("src/app.ts");
  });

  test("classifies write, read, search, and fetch calls", () => {
    expect(describeToolDetail({ name: "write", input: JSON.stringify({ filePath: "notes.md", content: "hi" }) }))
      .toEqual({ kind: "write", label: "Write", path: "notes.md", content: "hi" });
    expect(describeToolDetail({ name: "read", input: JSON.stringify({ filePath: "notes.md", offset: 10 }) }))
      .toEqual({ kind: "read", label: "Read", path: "notes.md", startLine: 10 });
    expect(describeToolDetail({ name: "grep", input: JSON.stringify({ pattern: "todo", path: "src" }) }))
      .toEqual({ kind: "search", label: "Grep", query: "todo", where: "src" });
    expect(describeToolDetail({ name: "webfetch", input: JSON.stringify({ url: "https://example.com" }) }))
      .toEqual({ kind: "fetch", label: "Fetch", url: "https://example.com" });
  });

  test("classifies todo updates with per-entry state", () => {
    const detail = describeToolDetail({
      name: "todowrite",
      input: JSON.stringify({ todos: [
        { content: "one", status: "completed" },
        { content: "two", status: "in_progress" },
        { content: "three", status: "pending" },
      ] }),
    });
    expect(detail).toEqual({ kind: "todo", label: "Todos", entries: [
      { text: "one", state: "done" },
      { text: "two", state: "active" },
      { text: "three", state: "pending" },
    ] });
  });

  test("falls back to generic for unknown tools and malformed input", () => {
    expect(describeToolDetail({ name: "mcp__server__thing", input: "{}" })).toEqual({ kind: "generic", label: "mcp__server__thing" });
    expect(describeToolDetail({ name: "edit", input: "not json" })).toEqual({ kind: "generic", label: "Edit" });
    expect(describeToolDetail({ name: "edit" })).toEqual({ kind: "generic", label: "Edit" });
  });
});

describe("humanizeToolName", () => {
  test("title-cases simple names and preserves qualified ones", () => {
    expect(humanizeToolName("read")).toBe("Read");
    expect(humanizeToolName("apply_patch")).toBe("Apply patch");
    expect(humanizeToolName("server.tool/name")).toBe("server.tool/name");
  });
});

describe("naiveLineDiff", () => {
  test("skips the common prefix and suffix", () => {
    expect(naiveLineDiff("a\nb\nc\nd", "a\nx\ny\nd")).toEqual([
      { sign: "-", text: "b" },
      { sign: "-", text: "c" },
      { sign: "+", text: "x" },
      { sign: "+", text: "y" },
    ]);
  });

  test("handles pure additions and removals", () => {
    expect(naiveLineDiff("", "new")).toEqual([{ sign: "+", text: "new" }]);
    expect(naiveLineDiff("old", "")).toEqual([{ sign: "-", text: "old" }]);
    expect(naiveLineDiff("same", "same")).toEqual([]);
  });
});


describe("OpenCode-native tool payloads", () => {
  const patchText = [
    "*** Begin Patch",
    "*** Update File: /ws/openspec/change.yaml",
    "@@",
    " schema: spec-driven",
    "+skip_specs: true",
    "*** Add File: /ws/docs/note.md",
    "+hello",
    "*** End Patch",
  ].join("\n");

  test("apply_patch reads the envelope's files and diff lines", () => {
    const detail = describeToolDetail({ name: "apply_patch", input: JSON.stringify({ patchText }) });
    expect(detail.kind).toBe("patch");
    expect(patchFiles(patchText)).toEqual(["/ws/openspec/change.yaml", "/ws/docs/note.md"]);
    expect(patchDiffLines(patchText)).toEqual([
      { sign: "+", text: "skip_specs: true" },
      { sign: "+", text: "hello" },
    ]);
    expect(toolSubject(detail)).toBe("2 files");
  });

  test("a replayed question part keeps its questions and answer", () => {
    const detail = describeToolDetail({
      name: "question",
      input: JSON.stringify({ questions: [{ question: "Archive it?", header: "Incomplete" }] }),
      output: "User answered: yes",
    });
    expect(detail).toEqual({
      kind: "question",
      label: "Question",
      asked: [{ header: "Incomplete", prompt: "Archive it?" }],
      answer: "User answered: yes",
    });
    expect(toolSubject(detail)).toBe("Incomplete");
  });

  test("a task call names the agent, its assignment, and its child session", () => {
    const detail = describeToolDetail({
      name: "task",
      input: JSON.stringify({ description: "Triage issues", subagent_type: "explore", prompt: "Go" }),
      childConversationId: "ses_child",
    });
    expect(detail).toEqual({
      kind: "agent",
      label: "Agent",
      description: "Triage issues",
      subagent: "explore",
      prompt: "Go",
      conversationId: "ses_child",
    });
    expect(toolSubject(detail)).toBe("explore · Triage issues");
  });

  test("a skill load is one fact: which skill", () => {
    const detail = describeToolDetail({ name: "skill", input: JSON.stringify({ name: "openspec-propose" }) });
    expect(detail).toEqual({ kind: "skill", label: "Skill", name: "openspec-propose" });
    expect(toolSubject(detail)).toBe("openspec-propose");
  });
});

describe("todo activity", () => {
  const entries = (states: Array<"pending" | "active" | "done">) =>
    ["one", "two", "three"].map((text, index) => ({ text, state: states[index]! }));

  test("first snapshot is a creation", () => {
    expect(deriveTodoActivities([], entries(["pending", "pending", "pending"])))
      .toEqual([{ type: "created", count: 3 }]);
  });

  test("state transitions become started, completed, and reopened", () => {
    expect(deriveTodoActivities(entries(["pending", "pending", "pending"]), entries(["active", "pending", "pending"])))
      .toEqual([{ type: "started", task: "one" }]);
    expect(deriveTodoActivities(entries(["active", "pending", "pending"]), entries(["done", "active", "pending"])))
      .toEqual([{ type: "completed", task: "one" }, { type: "started", task: "two" }]);
    expect(deriveTodoActivities(entries(["done", "pending", "pending"]), entries(["pending", "pending", "pending"])))
      .toEqual([{ type: "reopened", task: "one" }]);
  });

  test("summary names the first activity and counts the rest", () => {
    const current = entries(["done", "active", "pending"]);
    const activities = deriveTodoActivities(entries(["active", "pending", "pending"]), current);
    expect(todoActivitySummary(activities, current)).toEqual({ label: "Completed +1", task: "one" });
    expect(todoActivitySummary([], current)).toEqual({ label: "Todos 1/3" });
    expect(todoActivitySummary([{ type: "created", count: 3 }], current)).toEqual({ label: "Added 3 todos" });
  });
});
