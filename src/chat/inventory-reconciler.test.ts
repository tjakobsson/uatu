import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  ConversationInventoryTracker,
  SerializedInventoryReconciler,
  UNDATED_GROUP,
  conversationActivitySuffix,
  conversationDayGroup,
  dedupeConversationInventory,
  isConversationChooserActivationKey,
  patchConversationOptions,
  retainedPresentationConversationIds,
} from "./inventory-reconciler";
import type { ConversationSummary } from "./types";

function conversation(id: string, title = id, updatedAt = 1): ConversationSummary {
  return { id, title, createdAt: 1, updatedAt, status: "idle" };
}

// Local wall-clock instants, so every case holds in whatever zone runs it.
const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute).getTime();
const layout = (select: HTMLSelectElement) => Array.from(select.children).map(child => child.tagName === "OPTGROUP"
  ? [(child as HTMLOptGroupElement).label, Array.from(child.children).map(option => (option as HTMLOptionElement).value)]
  : (child as HTMLOptionElement).value);

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

  test("dispatches the fetch before request() returns", async () => {
    let fetched = 0;
    const reconciler = new SerializedInventoryReconciler(
      async () => { fetched += 1; return []; },
      () => undefined,
      () => undefined,
    );
    // Recovery closes old streams, requests, then reopens streams — and
    // needs the request on the wire before the replacements are created.
    const pending = reconciler.request();
    expect(fetched).toBe(1);
    await pending;
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

  test("a conversation is filed under the local day of its last activity", () => {
    const now = at(9, 25, 15);
    expect(conversationDayGroup(conversation("a", "a", at(9, 25, 0, 5)), now)).toEqual({ key: "2026-09-25", label: "Today" });
    expect(conversationDayGroup(conversation("b", "b", at(9, 24, 23, 55)), now)).toEqual({ key: "2026-09-24", label: "Yesterday" });
    const older = conversationDayGroup(conversation("c", "c", at(9, 20)), now);
    expect(older.key).toBe("2026-09-20");
    expect(older.label).toBe(`${new Date(at(9, 20)).toLocaleDateString([], { weekday: "short" })} 2026-09-20`);
    expect(conversationDayGroup(conversation("d", "d", at(12, 30, 12, 0, 2025)), now).label).toEndWith(" 2025-12-30");
  });

  test("an agent clock ahead of the reader is today, and a missing time is undated", () => {
    const now = at(9, 25, 23, 59);
    expect(conversationDayGroup(conversation("ahead", "ahead", at(9, 26, 0, 1)), now)).toEqual({ key: "2026-09-25", label: "Today" });
    expect(conversationActivitySuffix(conversation("ahead", "ahead", at(9, 26, 0, 1)), now)).toBe(" · 23:59");
    expect(conversationDayGroup(conversation("zero", "zero", 0), now)).toBe(UNDATED_GROUP);
    expect(conversationActivitySuffix(conversation("zero", "zero", 0), now)).toBe("");
    expect(conversationActivitySuffix(conversation("t", "t", at(9, 24, 14, 32)), now)).toBe(" · 14:32");
  });

  test("groups options under one heading per day, newest first, and keeps option elements", () => {
    const now = at(9, 25, 15);
    const { document } = parseHTML("<select><option value='' data-chat-inventory-placeholder>Select</option><option value='old'>Old</option></select>");
    const select = document.querySelector<HTMLSelectElement>("select")!;
    const oldOption = select.options[1]!;
    const group = (item: ConversationSummary) => conversationDayGroup(item, now);
    const list = [
      conversation("new", "New", at(9, 25, 14)),
      conversation("earlier-today", "Earlier today", at(9, 25, 9)),
      conversation("old", "Old", at(9, 24, 20)),
      conversation("undated", "Undated one", 0),
    ];
    patchConversationOptions(select, list, item => item.title, group);
    expect(layout(select)).toEqual(["", ["Today", ["new", "earlier-today"]], ["Yesterday", ["old"]], ["Undated", ["undated"]]]);
    expect(select.querySelector("option[value='old']")).toBe(oldOption);

    // Activity moves a conversation to today; the emptied day's heading goes.
    const today = select.querySelector("optgroup")!;
    patchConversationOptions(select, [conversation("old", "Old", at(9, 25, 14, 30)), ...list.slice(0, 2)], item => item.title, group);
    expect(layout(select)).toEqual(["", ["Today", ["old", "new", "earlier-today"]]]);
    expect(select.querySelector("optgroup")).toBe(today);
    expect(select.querySelector("option[value='old']")).toBe(oldOption);
  });

  test("a list with no dated conversation stays flat, and midnight relabels the headings", () => {
    const { document } = parseHTML("<select></select>");
    const select = document.querySelector<HTMLSelectElement>("select")!;
    patchConversationOptions(select, [conversation("a"), conversation("b")], item => item.title, item => conversationDayGroup(item, at(9, 25)));
    expect(layout(select)).toEqual(["a", "b"]);

    const list = [conversation("a", "a", at(9, 25, 10))];
    patchConversationOptions(select, list, item => item.title, item => conversationDayGroup(item, at(9, 25, 23)));
    expect(layout(select)).toEqual([["Today", ["a"]]]);
    patchConversationOptions(select, list, item => item.title, item => conversationDayGroup(item, at(9, 26, 0, 1)));
    expect(layout(select)).toEqual([["Yesterday", ["a"]]]);
  });
});
