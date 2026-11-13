import { expect, test } from "bun:test";
import { hasVerifiedBlockingWork } from "./blocking-work";
import type { BackgroundTaskItem, ConversationItem } from "./types";

test("only live running tools or confirmed foreground workers are blocking evidence", () => {
  const worker: BackgroundTaskItem = { id: "worker", type: "background_task", taskId: "task", toolUseId: "launch", createdAt: 1, description: "worker", status: "running", foreground: true };
  const tool: ConversationItem = { id: "tool:launch", type: "tool", name: "task", status: "running", createdAt: 1 };
  expect(hasVerifiedBlockingWork("running", [tool])).toBe(true);
  expect(hasVerifiedBlockingWork("running", [worker])).toBe(true);
  expect(hasVerifiedBlockingWork("running", [])).toBe(false);
  expect(hasVerifiedBlockingWork("completed", [tool, worker])).toBe(false);
  expect(hasVerifiedBlockingWork("running", [{ ...tool, status: "pending" } as ConversationItem])).toBe(false);
  for (const changed of [{ ...worker, foreground: false }, { ...worker, stateUncertain: true }, { ...worker, status: "completed" as const }, { ...worker, status: "failed" as const }]) {
    expect(hasVerifiedBlockingWork("running", [tool, changed])).toBe(false);
  }
});
