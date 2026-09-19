import { expect, test } from "bun:test";
import { ClaudeNotificationLifecycle } from "./notification-lifecycle";

test("duplicate results cannot advance a queued prompt", () => {
  const lifecycle = new ClaudeNotificationLifecycle();
  expect(lifecycle.accept("a", 1)).toEqual([{ sourceId: "a", phase: "started", createdAt: 1 }]);
  expect(lifecycle.accept("b", 2)).toEqual([]);
  expect(lifecycle.finish("result-a", "completed", 3)).toEqual([
    { sourceId: "a", phase: "completed", createdAt: 3 }, { sourceId: "b", phase: "started", createdAt: 3 },
  ]);
  expect(lifecycle.hasResult("result-a")).toBe(true);
  expect(lifecycle.finish("result-a", "completed", 4)).toEqual([]);
  expect(lifecycle.finish("result-b", "completed", 5)).toEqual([{ sourceId: "b", phase: "completed", createdAt: 5 }]);
});

test("background and cancellation retain the final outcome rather than preliminary completed status", () => {
  const lifecycle = new ClaudeNotificationLifecycle();
  lifecycle.accept("a", 1);
  expect(lifecycle.finish("result-a", "background", 2)).toMatchObject([{ sourceId: "a", phase: "background" }]);
  expect(lifecycle.beginFollowup("followup-a", 3)).toMatchObject([{ sourceId: "followup-a", phase: "started" }]);
  expect(lifecycle.accept("b", 4)).toEqual([]);
  expect(lifecycle.finish("result-followup", "completed", 5)).toMatchObject([{ sourceId: "followup-a", phase: "completed" }, { sourceId: "b", phase: "started" }]);
  expect(lifecycle.finish("result-b", "interrupted", 6)).toMatchObject([{ sourceId: "b", phase: "interrupted" }]);
});

test("a result with no observed execution does not invent a completion", () => {
  expect(new ClaudeNotificationLifecycle().finish("historical", "completed", 1)).toEqual([]);
});
