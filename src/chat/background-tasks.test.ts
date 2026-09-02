import { describe, expect, test } from "bun:test";

import { backgroundStatusLabel, runningBackgroundTasks } from "./background-tasks";
import type { ConversationItem } from "./types";

const task = (taskId: string, status: "running" | "completed" | "failed" | "stopped", description = `Task ${taskId}`): ConversationItem => ({
  id: `task:${taskId}`, type: "background_task", createdAt: 1, taskId, description, status,
});

describe("background work in the composer", () => {
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
});
