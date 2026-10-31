import { describe, expect, test } from "bun:test";

import { backgroundStatusLabel, runningBackgroundTasks } from "./background-tasks";
import { taskInspection } from "./task-inspection";
import type { BackgroundTaskItem, ConversationItem } from "./types";

const task = (taskId: string, status: "running" | "completed" | "failed" | "stopped", description = `Task ${taskId}`): BackgroundTaskItem => ({
  id: `task:${taskId}`, type: "background_task", createdAt: 1, taskId, description, status,
});

describe("background work in the composer", () => {
  test("verified activity is running independently of unavailable Stop proof", () => {
    const active: BackgroundTaskItem = { ...task("a", "running"), stateUncertain: true,
      activity: { kind: "working", observedAt: 10 }, control: { available: false } };
    expect(backgroundStatusLabel([active])).toBe("1 background task running · Task a");
    expect(runningBackgroundTasks([active])).toEqual([active]);
  });

  test("an ended execution without a result remains possible work but is not announced running", () => {
    const ended: BackgroundTaskItem = { ...task("a", "running"), activity: { kind: "ended", endedAt: 10 } };
    expect(runningBackgroundTasks([ended])).toEqual([ended]);
    expect(backgroundStatusLabel([ended])).toBe("Ended · result unavailable");
    expect(backgroundStatusLabel([task("b", "running"), ended])).toBe("1 background task running · 1 unresolved");
  });

  test("pending requests and ambiguous or missing evidence retain the shared truthful labels", () => {
    const pending: BackgroundTaskItem = { ...task("a", "running"), stateUncertain: true,
      activity: { kind: "needs-answer", request: { id: "request-a", kind: "question" } } };
    expect(backgroundStatusLabel([pending])).toBe("Needs your answer");
    expect(backgroundStatusLabel([{ ...task("a", "running"), activity: { kind: "session-active" } }])).toBe("Session active · task unverified");
    expect(backgroundStatusLabel([{ ...task("a", "running"), activity: { kind: "unavailable" } }])).toBe("Status unavailable · last seen unknown");
    // The composer does not own the bounded Checking presentation deadline.
    expect(backgroundStatusLabel([{ ...task("a", "running"), activity: { kind: "checking" } }])).toBe("1 background task unresolved");
  });

  test("unknown liveness is not announced as confirmed running", () => {
    expect(backgroundStatusLabel([{ ...task("a", "running"), stateUncertain: true }])).toContain("Status unavailable");
    expect(backgroundStatusLabel([task("b", "running"), { ...task("a", "running"), stateUncertain: true }])).toBe("1 background task running · 1 status unavailable");
  });
  test("only running tasks are live; settled ones have left the list", () => {
    const items: ConversationItem[] = [task("a", "running"), task("b", "completed"), task("c", "stopped"), task("d", "running"), { id: "m", type: "user_message", createdAt: 0, text: "hi" }];
    expect(runningBackgroundTasks(items).map(entry => entry.taskId)).toEqual(["a", "d"]);
  });

  test("the status names the count, and the one task's description when there is one", () => {
    expect(backgroundStatusLabel(runningBackgroundTasks([task("a", "running", "Sleep for 20 seconds then echo done")]))).toBe("1 background task running · Sleep for 20 seconds then echo done");
    expect(backgroundStatusLabel(runningBackgroundTasks([task("a", "running"), task("b", "running"), task("c", "running")]))).toBe("3 background tasks running");
    // A background state reported without a listed task still says what
    // the conversation is doing, without inventing a count.
    expect(backgroundStatusLabel([])).toBe("Background work running");
  });

  test("a foreground run (a typed command's) is never background work, running or not", () => {
    const review: BackgroundTaskItem = { ...task("review", "running", "/code-review"), taskType: "local_agent", childConversationId: "sub:parent:review", foreground: true };
    const items: ConversationItem[] = [review, task("a", "running")];
    expect(runningBackgroundTasks(items).map(entry => entry.taskId)).toEqual(["a"]);
    expect(runningBackgroundTasks([review])).toEqual([]);
    // The status line counts and names background work alone.
    expect(backgroundStatusLabel(runningBackgroundTasks([review, task("a", "running")]))).toBe("1 background task running · Task a");
  });

  test("every listed row is inspectable: an agent task opens its child transcript, a shell task its output", () => {
    const items: ConversationItem[] = [
      { ...task("agent", "running", "Review the renderer"), taskType: "local_agent", childConversationId: "sub:parent:agent", subagentType: "explore" },
      { ...task("shell", "running", "bun test"), taskType: "local_bash", outputFile: "/tmp/tasks/shell.output" },
      // An agent whose child is not yet named still opens: as a task view,
      // since there is no transcript to ask for.
      { ...task("early", "running", "Search the docs"), taskType: "local_agent" },
      task("done", "completed"),
    ];
    const rows = runningBackgroundTasks(items).map(entry => [entry.taskId, taskInspection(entry)]);
    expect(rows).toEqual([
      ["agent", { view: "transcript", conversationId: "sub:parent:agent" }],
      ["shell", { view: "output" }],
      ["early", { view: "output" }],
    ]);
    // A settled task has left the list, and is not inspectable from it.
    expect(taskInspection(task("done", "completed"))).toBeUndefined();
  });
});
