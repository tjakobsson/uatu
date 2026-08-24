import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  ConversationInventoryTracker,
  SerializedInventoryReconciler,
  dedupeConversationInventory,
  isConversationChooserActivationKey,
  patchConversationOptions,
  retainedPresentationConversationIds,
} from "./inventory-reconciler";
import type { ConversationSummary } from "./types";

function conversation(id: string, title = id): ConversationSummary {
  return { id, title, createdAt: 1, updatedAt: 1, status: "idle" };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

describe("conversation inventory reconciliation", () => {
  test("deduplicates ids while retaining authoritative order", () => {
    expect(dedupeConversationInventory([
      conversation("second"),
      conversation("first"),
      conversation("second", "duplicate"),
    ]).map(item => [item.id, item.title])).toEqual([
      ["second", "second"],
      ["first", "first"],
    ]);
  });

  test("uses the first list as a silent baseline and ignores an unchanged initial stream signal", () => {
    const tracker = new ConversationInventoryTracker();
    expect(tracker.reconcile([conversation("one"), conversation("two")])).toEqual({ unseenCount: 0, increased: false });
    expect(tracker.reconcile([conversation("one"), conversation("two")])).toEqual({ unseenCount: 0, increased: false });

    expect(tracker.reconcile([conversation("three"), conversation("one"), conversation("two")])).toEqual({ unseenCount: 1, increased: true });
    expect([...tracker.unseenIds]).toEqual(["three"]);
  });

  test("marks local creation known before reconciliation and drops removed ids from both sets", () => {
    const tracker = new ConversationInventoryTracker();
    tracker.reconcile([conversation("one")]);
    tracker.noteLocalCreation("local");
    tracker.reconcile([conversation("local"), conversation("remote"), conversation("one")]);
    expect([...tracker.unseenIds]).toEqual(["remote"]);

    tracker.reconcile([conversation("one")]);
    expect([...tracker.knownIds]).toEqual(["one"]);
    expect([...tracker.unseenIds]).toEqual([]);
  });

  test("removes local creation from unseen when its stream signal wins the response race", () => {
    const tracker = new ConversationInventoryTracker();
    tracker.reconcile([conversation("one")]);
    tracker.reconcile([conversation("local"), conversation("one")]);
    expect(tracker.noteLocalCreation("local")).toBe(true);
    expect([...tracker.unseenIds]).toEqual([]);
  });

  test("acknowledges only the current unseen set", () => {
    const tracker = new ConversationInventoryTracker();
    tracker.reconcile([conversation("one")]);
    tracker.reconcile([conversation("two"), conversation("one")]);
    expect(tracker.acknowledge()).toBe(true);
    expect(tracker.acknowledge()).toBe(false);
    tracker.reconcile([conversation("three"), conversation("two"), conversation("one")]);
    expect([...tracker.unseenIds]).toEqual(["three"]);
  });

  test("runs one request at a time with one dirty trailing request", async () => {
    const requests = [deferred<ConversationSummary[]>(), deferred<ConversationSummary[]>()];
    const applied: string[][] = [];
    let fetches = 0;
    const reconciler = new SerializedInventoryReconciler(
      () => requests[fetches++]!.promise,
      inventory => applied.push(inventory.map(item => item.id)),
      error => { throw error; },
    );

    const complete = reconciler.request();
    await Promise.resolve();
    expect(fetches).toBe(1);
    void reconciler.request();
    void reconciler.request();
    requests[0]!.resolve([conversation("one"), conversation("one")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetches).toBe(2);
    requests[1]!.resolve([conversation("two"), conversation("one")]);
    await complete;
    expect(applied).toEqual([["one"], ["two", "one"]]);
  });

  test("discards an in-flight list superseded by a local mutation", async () => {
    const stale = deferred<ConversationSummary[]>();
    const current = deferred<ConversationSummary[]>();
    let fetches = 0;
    const applied: string[][] = [];
    const reconciler = new SerializedInventoryReconciler(
      () => [stale.promise, current.promise][fetches++]!,
      inventory => applied.push(inventory.map(item => item.id)),
      error => { throw error; },
    );

    const complete = reconciler.request();
    await Promise.resolve();
    void reconciler.supersede();
    stale.resolve([conversation("before-local-create")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([]);
    expect(fetches).toBe(2);
    current.resolve([conversation("local"), conversation("before-local-create")]);
    await complete;
    expect(applied).toEqual([["local", "before-local-create"]]);
  });

  test("does not replace the prior inventory after failure and remains retryable", async () => {
    const applied: string[][] = [["retained"]];
    const failures: unknown[] = [];
    let attempt = 0;
    const reconciler = new SerializedInventoryReconciler(
      async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("offline");
        return [conversation("recovered")];
      },
      inventory => applied.push(inventory.map(item => item.id)),
      error => failures.push(error),
    );

    await reconciler.request();
    expect(applied).toEqual([["retained"]]);
    expect(failures).toHaveLength(1);
    await reconciler.request();
    expect(applied).toEqual([["retained"], ["recovered"]]);
  });

  test("patches keyed options without replacing the selected option", () => {
    const { document } = parseHTML("<select><option value='one'>One</option><option value='two'>Two</option></select>");
    const select = document.querySelector<HTMLSelectElement>("select")!;
    let selectedValue = "one";
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => selectedValue,
      set: value => { selectedValue = String(value); },
    });
    const selectedOption = select.options[0]!;

    patchConversationOptions(select, [conversation("two", "Renamed"), conversation("one", "One")], item => item.title);
    expect(Array.from(select.options).map(option => [option.value, option.text])).toEqual([
      ["two", "Renamed"],
      ["one", "One"],
    ]);
    expect(select.options[1]).toBe(selectedOption);
    expect(select.value).toBe("one");

    patchConversationOptions(select, [conversation("one", "One")], item => item.title);
    expect(Array.from(select.options).map(option => option.value)).toEqual(["one"]);
    expect(select.options[0]).toBe(selectedOption);
  });

  test("retains a missing selected id even before its projection loads", () => {
    expect([...retainedPresentationConversationIds([conversation("available")], null, "deleted")]).toEqual([
      "available",
      "deleted",
    ]);
  });

  test("recognizes pointer-equivalent native select keyboard activation", () => {
    const key = (value: string, overrides: Partial<KeyboardEvent> = {}) => isConversationChooserActivationKey({
      key: value,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      ...overrides,
    });
    expect(key("Enter")).toBe(true);
    expect(key("ArrowDown")).toBe(true);
    expect(key("a")).toBe(true);
    expect(key("Tab")).toBe(false);
    expect(key("Escape")).toBe(false);
    expect(key("a", { metaKey: true })).toBe(false);
  });
});
