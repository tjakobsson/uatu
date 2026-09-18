import { describe, expect, test } from "bun:test";

import type { LiveEnvelope, LiveSubscription } from "../shared/live-protocol";
import { createLiveChannel, type LiveChannelSource } from "./live-channel";
import { watchWorktreeInventory, WORKTREES_CHANGED_EVENT, WORKTREES_INVALIDATED_EVENT } from "./worktree-live";

// A real channel over a scripted EventSource: what the page would hold.
function scriptedChannel() {
  const sources: Array<{ url: string; listeners: Map<string, Array<(event: Event) => void>>; closed: boolean }> = [];
  const channel = createLiveChannel({
    ws: "atlas",
    activity: true,
    openSource: url => {
      const source = { url, listeners: new Map<string, Array<(event: Event) => void>>(), closed: false };
      sources.push(source);
      const handle: LiveChannelSource = {
        addEventListener: (type, listener) => source.listeners.set(type, [...(source.listeners.get(type) ?? []), listener]),
        close: () => { source.closed = true; },
      };
      return handle;
    },
    fetcher: async () => Response.json({ ok: true }),
  });
  const emit = (index: number, type: string, data: unknown) => {
    for (const listener of sources[index]!.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  };
  return { channel, sources, emit };
}

const invalidation = (ws: string): LiveEnvelope => ({ ws, topic: "worktrees", cursor: "", event: { kind: "data", data: { type: "worktree.inventory" } } });

describe("worktree inventory invalidation", () => {
  test("rides the page's one stream, never presents a cursor, and raises both refresh events", () => {
    const { channel, sources, emit } = scriptedChannel();
    const target = new EventTarget();
    const heard: string[] = [];
    target.addEventListener(WORKTREES_CHANGED_EVENT, () => heard.push("changed"));
    target.addEventListener(WORKTREES_INVALIDATED_EVENT, () => heard.push("invalidated"));
    const stop = watchWorktreeInventory(channel, target);
    channel.connect();
    expect(sources).toHaveLength(1);
    const subs = JSON.parse(new URL(sources[0]!.url, "http://hub").searchParams.get("subs")!) as LiveSubscription[];
    expect(subs).toEqual([{ topic: "worktrees" }]);
    emit(0, "hello", { streamId: "s1" });
    emit(0, "live", invalidation("atlas"));
    expect(heard).toEqual(["changed", "invalidated"]);

    // Another workspace's invalidation is not this page's.
    emit(0, "live", invalidation("beacon"));
    expect(heard).toHaveLength(2);

    // A reconnect still presents no cursor, and its fresh invalidation
    // triggers the same authoritative refresh.
    channel.connect({ resumed: true });
    expect(sources).toHaveLength(2);
    expect(JSON.parse(new URL(sources[1]!.url, "http://hub").searchParams.get("subs")!)).toEqual([{ topic: "worktrees" }]);
    emit(1, "hello", { streamId: "s2" });
    emit(1, "live", invalidation("atlas"));
    expect(heard).toHaveLength(4);

    stop();
    emit(1, "live", invalidation("atlas"));
    expect(heard).toHaveLength(4);
    channel.dispose();
  });

  test("activity still reaches its listeners unchanged alongside the topic", () => {
    const { channel, emit } = scriptedChannel();
    const activity: unknown[] = [];
    channel.onActivity((ws, facts) => activity.push([ws, facts]));
    watchWorktreeInventory(channel, new EventTarget());
    channel.connect();
    emit(0, "hello", { streamId: "s1" });
    emit(0, "live", { ws: "beacon", topic: "activity", cursor: "1", event: { kind: "data", data: { running: true, working: true, awaiting: false } } });
    expect(activity).toEqual([["beacon", { running: true, working: true, awaiting: false }]]);
    channel.dispose();
  });
});
