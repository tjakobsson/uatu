import { describe, expect, test } from "bun:test";
import { OpenCodeNotificationLifecycle } from "./notification-lifecycle";
import { normalizeProviderEvent } from "./v1/normalization";
import { createOpenCodeV2Normalizer } from "./v2/normalization";

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

  test("2.x steps correlate the same way, and an interrupted execution retires them", () => {
    const lifecycle = new OpenCodeNotificationLifecycle();
    const normalize = createOpenCodeV2Normalizer("/ws");
    const observe = (type: string, data: Record<string, unknown>, created: number) => {
      const event = { id: `evt_${created}`, created, type, location: { directory: "/ws" }, data: { sessionID: "s", ...data } };
      return lifecycle.observe(event, normalize(event));
    };
    expect(observe("session.step.started", { assistantMessageID: "a", agent: "build", model: { id: "m", providerID: "p" }, started: 10 }, 11)).toEqual([{ sourceId: "a", phase: "started", createdAt: 10 }]);
    expect(observe("session.step.ended", { assistantMessageID: "a", finish: "tool-calls", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, 20)).toEqual([{ sourceId: "a", phase: "failed", createdAt: 20 }]);
    expect(observe("session.step.started", { assistantMessageID: "b", agent: "build", model: { id: "m", providerID: "p" }, started: 30 }, 31)).toHaveLength(1);
    expect(observe("session.step.ended", { assistantMessageID: "b", finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, 40)).toEqual([{ sourceId: "b", phase: "completed", createdAt: 40 }]);
    expect(observe("session.step.started", { assistantMessageID: "c", agent: "build", model: { id: "m", providerID: "p" }, started: 50 }, 51)).toHaveLength(1);
    expect(observe("session.execution.interrupted", { reason: "user" }, 60)).toEqual([{ sourceId: "c", phase: "interrupted", createdAt: 60 }]);
    expect(observe("session.step.failed", { assistantMessageID: "c", error: { type: "aborted", message: "Step interrupted" } }, 61)).toEqual([]);
    // The wire order of a Stop: the aborted step first, then the interrupt.
    // The step must not retire the turn as failed, or the interrupt has
    // nothing left to report and the user is told the turn failed.
    expect(observe("session.step.started", { assistantMessageID: "d", agent: "build", model: { id: "m", providerID: "p" }, started: 70 }, 71)).toHaveLength(1);
    expect(observe("session.step.failed", { assistantMessageID: "d", error: { type: "aborted", message: "Step interrupted" } }, 72)).toEqual([]);
    expect(observe("session.execution.interrupted", { reason: "user" }, 73)).toEqual([{ sourceId: "d", phase: "interrupted", createdAt: 73 }]);
    // A real failure still ends the turn as one.
    expect(observe("session.step.started", { assistantMessageID: "e", agent: "build", model: { id: "m", providerID: "p" }, started: 80 }, 81)).toHaveLength(1);
    expect(observe("session.step.failed", { assistantMessageID: "e", error: { type: "unknown", message: "boom" } }, 82)).toEqual([{ sourceId: "e", phase: "failed", createdAt: 82 }]);
  });
});
