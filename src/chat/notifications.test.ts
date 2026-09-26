import { describe, expect, test } from "bun:test";
import { AgentNotificationTracker, NOTIFICATION_HOLD_LIMIT_MS, NOTIFICATION_LIFETIME_MS, NOTIFICATION_PENDING_RETENTION_MS, notificationIdentity, qualifyNotificationEvent, type AgentNotificationEvent, type NotificationSourceEvent } from "./notifications";

function fixture() {
  const events: AgentNotificationEvent[] = [];
  let now = 1000;
  return { events, advance: (ms: number) => { now += ms; }, tracker: new AgentNotificationTracker({ emit: event => events.push(event), now: () => now }) };
}

function turn(conversationId: string, sourceId: string, phase: Extract<NotificationSourceEvent, { type: "turn" }>["phase"], extra: Partial<NotificationSourceEvent> = {}): NotificationSourceEvent {
  return { type: "turn", origin: "live", conversationId, sourceId, phase, child: false, createdAt: 1000, ...extra } as NotificationSourceEvent;
}

function question(sourceId: string, pending = true): NotificationSourceEvent {
  return { type: "interaction", origin: "live", conversationId: "one", sourceId, kind: "question-pending", pending, createdAt: 1000 };
}

describe("agent notification occurrences", () => {
  test("a completion identifies its turn while another conversation continues", () => {
    const { tracker, events } = fixture();
    tracker.observe(turn("one", "a", "started"));
    tracker.observe(turn("two", "b", "started"));
    tracker.observe(turn("one", "a", "completed"));
    expect(events).toEqual([{ type: "notification", notification: {
      id: notificationIdentity("one", "turn-completed", "a"), conversationId: "one", sourceId: "a", kind: "turn-completed", createdAt: 1000,
    } }]);
  });

  test("duplicate completion cannot finish the next turn", () => {
    const { tracker, events } = fixture();
    tracker.observe(turn("one", "a", "started"));
    tracker.observe(turn("one", "a", "completed"));
    tracker.observe(turn("one", "b", "started"));
    tracker.observe(turn("one", "a", "completed"));
    tracker.observe(turn("one", "a", "started"));
    tracker.observe(turn("one", "a", "completed"));
    expect(events).toHaveLength(1);
    tracker.observe(turn("one", "b", "completed"));
    expect(events).toHaveLength(2);
  });

  test("distinct pending requests survive aggregate awaiting already being true", () => {
    const { tracker, events } = fixture();
    tracker.observe(question("a"));
    tracker.observe(question("a"));
    tracker.observe(question("b"));
    expect(events).toHaveLength(2);
    tracker.observe(question("a", false));
    tracker.observe(question("a"));
    expect(events).toHaveLength(3);
    expect(tracker.pendingSnapshot().map(event => event.sourceId)).toEqual(["b"]);
    expect(events[2]).toEqual({ type: "resolved", id: notificationIdentity("one", "question-pending", "a"), conversationId: "one" });
  });

  test("an identified delayed completion belongs to its own execution even after the next starts", () => {
    const { tracker, events } = fixture();
    tracker.observe(turn("one", "a", "started"));
    tracker.observe(turn("one", "b", "started"));
    tracker.observe(turn("one", "a", "completed"));
    expect(events).toMatchObject([{ notification: { sourceId: "a" } }]);
    tracker.observe(turn("one", "b", "completed"));
    expect(events).toMatchObject([{ notification: { sourceId: "a" } }, { notification: { sourceId: "b" } }]);
  });

  test("failure, cancellation, and background are not successful turns", () => {
    const { tracker, events } = fixture();
    for (const phase of ["failed", "interrupted", "background"] as const) {
      tracker.observe(turn("one", phase, "started"));
      tracker.observe(turn("one", phase, phase));
      tracker.observe(turn("one", phase, "completed"));
    }
    expect(events).toEqual([]);
  });

  test("history, child completion, and an unknown terminal frame do not notify", () => {
    const { tracker, events } = fixture();
    tracker.observe({ ...question("history"), origin: "history" });
    tracker.observe(turn("one", "history", "started", { origin: "history" }));
    tracker.observe(turn("one", "history", "completed", { origin: "history" }));
    tracker.observe(turn("child", "a", "started", { child: true }));
    tracker.observe(turn("child", "a", "completed", { child: true }));
    tracker.observe(turn("one", "unknown", "completed"));
    expect(events).toEqual([]);
  });

  test("permissions and questions qualify consistently across agents", () => {
    const { tracker, events } = fixture();
    tracker.observe(question("same"));
    tracker.observe({ ...question("same"), kind: "permission-pending" } as NotificationSourceEvent);
    tracker.observe(question("same", false));
    const opencode = events.map(event => qualifyNotificationEvent("opencode", event));
    const claude = events.map(event => qualifyNotificationEvent("claude", event));
    expect(opencode[0]).not.toEqual(claude[0]);
    expect(opencode[0]).toMatchObject({ notification: { conversationId: "opencode:one" } });
    expect(opencode[2]).toMatchObject({ id: (opencode[0] as Extract<AgentNotificationEvent, { type: "notification" }>).notification.id });
    expect(notificationIdentity("a:b", "question-pending", "c")).not.toBe(notificationIdentity("a", "question-pending", "b:c"));
  });

  test("resolution without a pending frame still cancels a retained delivery", () => {
    const { tracker, events } = fixture();
    tracker.observe(question("lost", false));
    tracker.observe(question("lost"));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("resolved");
  });

  test("a request answered after the push lifetime but within the hold limit still announces its resolution", () => {
    const { tracker, advance, events } = fixture();
    tracker.observe(question("slow"));
    advance(NOTIFICATION_LIFETIME_MS * 4);
    expect(tracker.pendingSnapshot().map(item => item.sourceId)).toEqual(["slow"]);
    tracker.observe(question("slow", false));
    expect(events.map(event => event.type)).toEqual(["notification", "resolved"]);
  });

  test("a question released at the hold limit still announces an answer given during its delivery lifetime", () => {
    const { tracker, advance, events } = fixture();
    tracker.observe(question("late"));
    advance(NOTIFICATION_HOLD_LIMIT_MS + NOTIFICATION_LIFETIME_MS - 1);
    tracker.observe(question("late", false));
    expect(events.map(event => event.type)).toEqual(["notification", "resolved"]);
  });

  test("expired pending snapshots do not reset request timestamps", () => {
    const { tracker, advance, events } = fixture();
    tracker.observe(question("old"));
    advance(NOTIFICATION_PENDING_RETENTION_MS + 1);
    expect(tracker.pendingSnapshot()).toEqual([]);
    tracker.observe(question("old"));
    expect(events).toHaveLength(1);
  });

  test("deleting a conversation resolves its pending alerts", () => {
    const { tracker, events } = fixture();
    tracker.observe(question("a"));
    tracker.observe(turn("one", "turn", "started"));
    tracker.forgetConversation("one");
    tracker.observe(turn("one", "turn", "completed"));
    expect(events.map(event => event.type)).toEqual(["notification", "resolved"]);
    expect(tracker.pendingSnapshot()).toEqual([]);
  });
});
