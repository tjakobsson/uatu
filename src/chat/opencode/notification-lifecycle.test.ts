import { describe, expect, test } from "bun:test";
import { OpenCodeNotificationLifecycle } from "./notification-lifecycle";
import { normalizeProviderEvent } from "./normalization";

describe("OpenCode notification execution identity", () => {
  function fixture() {
    const lifecycle = new OpenCodeNotificationLifecycle();
    return (type: string, data: Record<string, unknown>, compatibility = false) => {
      const event = { type, [compatibility ? "properties" : "data"]: { sessionID: "s", ...data } };
      return lifecycle.observe(event, normalizeProviderEvent(event));
    };
  }

  test("native final responses correlate to their own started assistant message", () => {
    const observe = fixture();
    expect(observe("session.next.step.started", { assistantMessageID: "a", timestamp: 10 })).toEqual([{ sourceId: "a", phase: "started", createdAt: 10 }]);
    expect(observe("session.next.step.ended", { assistantMessageID: "a", timestamp: 20, finish: "tool-calls" })).toEqual([{ sourceId: "a", phase: "failed", createdAt: 20 }]);
    expect(observe("session.next.step.started", { assistantMessageID: "b", timestamp: 30 })).toHaveLength(1);
    expect(observe("session.next.step.ended", { assistantMessageID: "b", timestamp: 40, finish: "stop" })).toEqual([{ sourceId: "b", phase: "completed", createdAt: 40 }]);
  });

  test("bridged duplicates and reconnect replay do not finish the next execution", () => {
    const observe = fixture();
    observe("session.next.step.started", { assistantMessageID: "a", timestamp: 10 });
    observe("session.next.step.ended", { assistantMessageID: "a", timestamp: 20, finish: "stop" });
    observe("session.next.step.started", { assistantMessageID: "b", timestamp: 30 });
    expect(observe("session.next.step.ended", { assistantMessageID: "a", timestamp: 20, finish: "stop" }, true)).toEqual([]);
    expect(observe("message.updated", { info: { id: "a", sessionID: "s", role: "assistant", finish: "stop", time: { created: 10, completed: 20 } } }, true)).toEqual([]);
    expect(observe("session.idle", {})).toEqual([]);
    expect(observe("session.status", { status: { type: "idle" } })).toEqual([]);
    expect(observe("session.next.step.ended", { assistantMessageID: "b", timestamp: 40, finish: "stop" })).toMatchObject([{ sourceId: "b", phase: "completed" }]);
  });

  test("classic messages preserve their own terminal time and reject failures", () => {
    const observe = fixture();
    const info = { id: "m", sessionID: "s", role: "assistant", parentID: "prompt", time: { created: 10 } };
    expect(observe("message.updated", { info }, true)).toMatchObject([{ sourceId: "m", phase: "started" }]);
    expect(observe("message.updated", { info: { ...info, finish: "stop", time: { created: 10, completed: 42 } } }, true)).toEqual([{ sourceId: "m", phase: "completed", createdAt: 42 }]);
    observe("message.updated", { info: { ...info, id: "failed" } }, true);
    expect(observe("message.updated", { info: { ...info, id: "failed", finish: "stop", error: { name: "aborted" }, time: { created: 10, completed: 43 } } }, true)).toMatchObject([{ phase: "failed" }]);
  });

  test("unobserved historical terminals cannot invent a live execution", () => {
    const observe = fixture();
    expect(observe("session.next.step.ended", { assistantMessageID: "old", timestamp: 20, finish: "stop" })).toEqual([]);
    expect(observe("session.next.step.started", { assistantMessageID: "old", timestamp: 10 })).toEqual([]);
    expect(observe("session.next.step.ended", { assistantMessageID: "old", timestamp: 20, finish: "stop" })).toEqual([]);
  });

  test("session failure retires known executions before any late stop", () => {
    const observe = fixture();
    observe("session.next.step.started", { assistantMessageID: "a", timestamp: 10 });
    expect(observe("session.error", { timestamp: 20, error: { name: "aborted" } })).toMatchObject([{ sourceId: "a", phase: "interrupted" }]);
    expect(observe("session.next.step.ended", { assistantMessageID: "a", timestamp: 30, finish: "stop" })).toEqual([]);
  });
});
