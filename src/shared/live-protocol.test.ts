import { describe, expect, test } from "bun:test";

import {
  buildLiveStreamQuery,
  documentContextKey,
  formatLiveEnvelope,
  formatLiveHello,
  LIVE_MAX_CURSOR_BYTES,
  LIVE_MAX_KEY_BYTES,
  LIVE_MAX_SUBSCRIPTIONS,
  liveSubscriptionId,
  liveSubscriptionsPath,
  parseLiveEnvelope,
  parseLiveHello,
  parseLiveStreamQuery,
  parseLiveSubscriptionChange,
  sanitizeWorkspaceActivity,
  WORKTREE_INVALIDATION,
  type LiveEnvelope,
  type LiveStreamQuery,
} from "./live-protocol";

// The SSE `data:` payload of one formatted frame.
function frameData(frame: string): string {
  const line = frame.split("\n").find(candidate => candidate.startsWith("data: "));
  if (!line) throw new Error(`no data line in ${JSON.stringify(frame)}`);
  return line.slice("data: ".length);
}

describe("stream query", () => {
  test("round-trips the initial subscription set with cursors", () => {
    const query: LiveStreamQuery = {
      ws: "uatu",
      activity: true,
      subs: [
        { topic: "document", key: "compareTarget=HEAD&scope=folder", cursor: "e1.4" },
        { topic: "inventory" },
        { topic: "conversation", key: "opencode:ses_abc", cursor: "eyJ2IjoxfQ" },
      ],
      reconnect: true,
    };
    expect(parseLiveStreamQuery(buildLiveStreamQuery(query))).toEqual(query);
  });

  test("an absent workspace and empty set parse as a bare harness stream", () => {
    expect(parseLiveStreamQuery(new URLSearchParams())).toEqual({ ws: null, activity: false, subs: [], reconnect: false });
  });

  test("the last entry for a key wins", () => {
    const params = new URLSearchParams({
      subs: JSON.stringify([
        { topic: "conversation", key: "a", cursor: "old" },
        { topic: "conversation", key: "a", cursor: "new" },
      ]),
    });
    expect(parseLiveStreamQuery(params)).toMatchObject({ subs: [{ topic: "conversation", key: "a", cursor: "new" }] });
  });

  test.each([
    ["an empty workspace id", new URLSearchParams({ ws: "" })],
    ["a non-JSON set", new URLSearchParams({ subs: "document=1" })],
    ["a set that is not an array", new URLSearchParams({ subs: "{}" })],
    ["the activity topic as a subscription", new URLSearchParams({ subs: JSON.stringify([{ topic: "activity" }]) })],
    ["a conversation without a key", new URLSearchParams({ subs: JSON.stringify([{ topic: "conversation" }]) })],
    ["an inventory with a key", new URLSearchParams({ subs: JSON.stringify([{ topic: "inventory", key: "x" }]) })],
    ["a non-string cursor", new URLSearchParams({ subs: JSON.stringify([{ topic: "inventory", cursor: 4 }]) })],
    ["an oversized key", new URLSearchParams({ subs: JSON.stringify([{ topic: "conversation", key: "k".repeat(LIVE_MAX_KEY_BYTES + 1) }]) })],
    ["an oversized cursor", new URLSearchParams({ subs: JSON.stringify([{ topic: "inventory", cursor: "c".repeat(LIVE_MAX_CURSOR_BYTES + 1) }]) })],
    [
      "too many subscriptions",
      new URLSearchParams({
        subs: JSON.stringify(Array.from({ length: LIVE_MAX_SUBSCRIPTIONS + 1 }, (_, index) => ({ topic: "conversation", key: `c${index}` }))),
      }),
    ],
  ])("refuses %s", (_label, params) => {
    expect(parseLiveStreamQuery(params)).toHaveProperty("error");
  });
});

describe("subscription control body", () => {
  test("parses adds and removes", () => {
    expect(parseLiveSubscriptionChange({
      add: [{ topic: "conversation", key: "claude:s1", cursor: "c9" }],
      remove: [{ topic: "conversation", key: "claude:s0" }],
    })).toEqual({
      add: [{ topic: "conversation", key: "claude:s1", cursor: "c9" }],
      remove: [{ topic: "conversation", key: "claude:s0" }],
    });
  });

  test("a remove ignores any cursor it is handed", () => {
    expect(parseLiveSubscriptionChange({ remove: [{ topic: "inventory", cursor: "x" }] })).toEqual({ remove: [{ topic: "inventory" }] });
  });

  test.each([
    ["a non-object body", []],
    ["an unknown field", { add: [], replace: [] }],
    ["a malformed add", { add: [{ topic: "conversation" }] }],
    ["a malformed remove", { remove: "inventory" }],
  ])("refuses %s", (_label, body) => {
    expect(parseLiveSubscriptionChange(body)).toHaveProperty("error");
  });
});

describe("per-subscription transport recovery", () => {
  test.each([true, false])("opening and control subscriptions retain validated reconnect=%s", reconnect => {
    const subscription = { topic: "conversation" as const, key: "opencode:c", cursor: "same-terminal-cursor", reconnect };
    expect(parseLiveSubscriptionChange({ add: [subscription] })).toEqual({ add: [subscription] });
    expect(parseLiveStreamQuery(new URLSearchParams({ subs: JSON.stringify([subscription]) }))).toMatchObject({ subs: [subscription] });
  });
  test("omission and false remain fresh without adding any default recovery marker", () => {
    expect(parseLiveSubscriptionChange({ add: [{ topic: "conversation", key: "c" }] })).toEqual({ add: [{ topic: "conversation", key: "c" }] });
    expect(parseLiveSubscriptionChange({ add: [{ topic: "conversation", key: "c", reconnect: false }] })).toEqual({ add: [{ topic: "conversation", key: "c", reconnect: false }] });
  });
  test.each(["true", 1, 0, null, [], {}].map(reconnect => ({ reconnect })))("nonboolean reconnect %j is refused on opening and control paths", ({ reconnect }) => {
    const subscription = { topic: "conversation", key: "c", cursor: "native", reconnect };
    expect(parseLiveSubscriptionChange({ add: [subscription] })).toHaveProperty("error");
    expect(parseLiveStreamQuery(new URLSearchParams({ subs: JSON.stringify([subscription]) }))).toHaveProperty("error");
  });
  test("a present undefined recovery marker is not treated as omission", () => {
    expect(parseLiveSubscriptionChange({ add: [{ topic: "conversation", key: "c", cursor: "native", reconnect: undefined }] })).toHaveProperty("error");
  });
  test.each([undefined, null, "", 3, "x".repeat(LIVE_MAX_CURSOR_BYTES + 1)])("true recovery refuses missing, empty, malformed or oversized cursor %j", cursor => {
    const subscription = { topic: "conversation", key: "c", cursor, reconnect: true };
    expect(parseLiveSubscriptionChange({ add: [subscription] })).toHaveProperty("error");
    expect(parseLiveStreamQuery(new URLSearchParams({ subs: JSON.stringify([subscription]) }))).toHaveProperty("error");
  });
  test.each(["document", "inventory", "worktrees", "personal"])("%s cannot carry either boolean recovery marker", topic => {
    for (const reconnect of [false, true]) {
      const subscription = { topic, cursor: "native", reconnect };
      expect(parseLiveSubscriptionChange({ add: [subscription] })).toHaveProperty("error");
      expect(parseLiveStreamQuery(new URLSearchParams({ subs: JSON.stringify([subscription]) }))).toHaveProperty("error");
    }
  });
  test("the cursor bound and last-add-wins semantics also apply to recovery", () => {
    const subscription = { topic: "conversation" as const, key: "c", cursor: "x".repeat(LIVE_MAX_CURSOR_BYTES), reconnect: true };
    expect(parseLiveSubscriptionChange({ add: [subscription] })).toEqual({ add: [subscription] });
    const fresh = { topic: "conversation" as const, key: "c", cursor: subscription.cursor };
    expect(parseLiveSubscriptionChange({ add: [subscription, fresh] })).toEqual({ add: [fresh] });
  });
});

describe("activity summary", () => {
  test("keeps exactly the four facts and drops everything else", () => {
    expect(sanitizeWorkspaceActivity({ running: true, working: true, awaiting: false, finished: false, title: "secret", conversationId: "c1" }))
      .toEqual({ running: true, working: true, awaiting: false, finished: false });
    expect(sanitizeWorkspaceActivity({ running: true, working: false, awaiting: false, finished: true }))
      .toEqual({ running: true, working: false, awaiting: false, finished: true });
  });

  test("a missing finished fact reads as false, so a three-fact summary still parses", () => {
    expect(sanitizeWorkspaceActivity({ running: true, working: true, awaiting: false })).toEqual({ running: true, working: true, awaiting: false, finished: false });
  });

  test("a workspace that is not running is neither working, awaiting, nor finished", () => {
    expect(sanitizeWorkspaceActivity({ running: false, working: true, awaiting: true, finished: true })).toEqual({ running: false, working: false, awaiting: false, finished: false });
  });

  test("anything that is not a literal true reads as false", () => {
    expect(sanitizeWorkspaceActivity({ running: "yes", working: 1, finished: "true" })).toEqual({ running: false, working: false, awaiting: false, finished: false });
    expect(sanitizeWorkspaceActivity(null)).toEqual({ running: false, working: false, awaiting: false, finished: false });
  });
});

describe("frames", () => {
  test("an envelope survives formatting and parsing for every event kind", () => {
    const envelopes: LiveEnvelope[] = [
      { ws: "uatu", topic: "document", key: "scope=folder", cursor: "e1.1", event: { kind: "data", data: { generatedAt: 1 } } },
      { ws: "uatu", topic: "inventory", cursor: "e2.0", event: { kind: "ready" } },
      { ws: "uatu", topic: "conversation", key: "opencode:s", cursor: "c", event: { kind: "resync", data: { type: "resync" } } },
      { ws: "uatu", topic: "conversation", key: "opencode:s", cursor: "", event: { kind: "resync" } },
      { ws: "other", topic: "activity", cursor: "a.3", event: { kind: "unavailable" } },
    ];
    for (const envelope of envelopes) {
      const frame = formatLiveEnvelope(envelope);
      expect(frame.startsWith("event: live\n")).toBe(true);
      expect(frame.endsWith("\n\n")).toBe(true);
      expect(parseLiveEnvelope(frameData(frame))).toEqual(envelope);
    }
  });

  test.each([
    ["non-JSON", "not json"],
    ["an unknown topic", JSON.stringify({ ws: "u", topic: "terminal", cursor: "", event: { kind: "ready" } })],
    ["an unknown event kind", JSON.stringify({ ws: "u", topic: "inventory", cursor: "", event: { kind: "close" } })],
    ["a missing cursor", JSON.stringify({ ws: "u", topic: "inventory", event: { kind: "ready" } })],
    ["a non-string key", JSON.stringify({ ws: "u", topic: "conversation", key: 3, cursor: "", event: { kind: "ready" } })],
    ["a missing event", JSON.stringify({ ws: "u", topic: "inventory", cursor: "" })],
  ])("drops %s", (_label, raw) => {
    expect(parseLiveEnvelope(raw)).toBeNull();
  });

  test("hello carries only the stream id", () => {
    const frame = formatLiveHello({ streamId: "abc" });
    expect(frame.startsWith("event: hello\n")).toBe(true);
    expect(parseLiveHello(frameData(frame))).toEqual({ streamId: "abc" });
    expect(parseLiveHello(JSON.stringify({ streamId: "" }))).toBeNull();
    expect(parseLiveHello("nope")).toBeNull();
  });
});

describe("identities and paths", () => {
  test("subscription ids never collide across topics or keys", () => {
    const ids = [
      liveSubscriptionId({ topic: "document" }),
      liveSubscriptionId({ topic: "document", key: "scope=folder" }),
      liveSubscriptionId({ topic: "inventory" }),
      liveSubscriptionId({ topic: "conversation", key: "a" }),
      liveSubscriptionId({ topic: "conversation", key: "b" }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the document key keeps only the watch-context parameters, in canonical order", () => {
    const key = documentContextKey(new URLSearchParams("documentId=d1&t=token&scope=file&compareTarget=main&reconnect=1"));
    expect(key).toBe("compareTarget=main&scope=file&documentId=d1");
    expect(documentContextKey(new URLSearchParams("scope=file&documentId=d1&compareTarget=main"))).toBe(key);
  });

  test("a document key for a deeply pinned file fits the key bound; cursors keep theirs", () => {
    expect(LIVE_MAX_KEY_BYTES).toBe(4_096);
    expect(LIVE_MAX_CURSOR_BYTES).toBe(1_024);
    // documentId is an absolute path, URL-encoded into the key ("/" becomes
    // "%2F"), so a pinned file a few dozen directories deep passes 512 bytes.
    const documentId = `/Users/someone/src/${Array.from({ length: 60 }, (_, index) => `directory-${index}`).join("/")}/README.md`;
    const key = documentContextKey(new URLSearchParams({ compareTarget: "last-commit", scope: "file", documentId }));
    expect(new TextEncoder().encode(key).byteLength).toBeGreaterThan(512);
    const subscription = { topic: "document" as const, key, cursor: "e1.4" };
    expect(parseLiveStreamQuery(buildLiveStreamQuery({ ws: "uatu", activity: false, subs: [subscription], reconnect: false })))
      .toEqual({ ws: "uatu", activity: false, subs: [subscription], reconnect: false });
    expect(parseLiveSubscriptionChange({ add: [subscription] })).toEqual({ add: [subscription] });
    // Exactly at the bound is accepted; one byte past it is not.
    expect(parseLiveSubscriptionChange({ add: [{ topic: "document", key: "k".repeat(LIVE_MAX_KEY_BYTES) }] })).not.toHaveProperty("error");
    expect(parseLiveSubscriptionChange({ add: [{ topic: "document", key: "k".repeat(LIVE_MAX_KEY_BYTES + 1) }] })).toHaveProperty("error");
  });

  test("the control path encodes the stream id", () => {
    expect(liveSubscriptionsPath("a/b")).toBe("/api/hub/live/a%2Fb/subscriptions");
  });
});

describe("worktrees topic", () => {
  test("subscribes without a key, and a presented cursor is dropped", () => {
    expect(parseLiveSubscriptionChange({ add: [{ topic: "worktrees", cursor: "abc" }] })).toEqual({ add: [{ topic: "worktrees" }] });
    expect(parseLiveSubscriptionChange({ add: [{ topic: "worktrees", key: "x" }] })).toEqual({ error: "worktrees subscription takes no key" });
    const query = parseLiveStreamQuery(new URLSearchParams({ ws: "a", subs: JSON.stringify([{ topic: "worktrees", cursor: "c" }]) }));
    expect(query).toEqual({ ws: "a", activity: false, subs: [{ topic: "worktrees" }], reconnect: false });
  });

  test("an invalidation envelope parses", () => {
    expect(parseLiveEnvelope(JSON.stringify({ ws: "a", topic: "worktrees", cursor: "", event: { kind: "data", data: WORKTREE_INVALIDATION } })))
      .toEqual({ ws: "a", topic: "worktrees", cursor: "", event: { kind: "data", data: { type: "worktree.inventory" } } });
  });
});
