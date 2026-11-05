import { expect, test } from "bun:test";
import { HistoryReuse, historyPageCursor, historyPageEnd } from "./history-reuse";

test("shares concurrent reads, reuses verified versions, and isolates conversations", async () => {
  const cache = new HistoryReuse<number>();
  let calls = 0;
  const load = async () => ++calls;
  expect(await Promise.all([cache.read("a", "1", load), cache.read("a", "1", load)])).toEqual([1, 1]);
  expect(await cache.read("a", "1", load)).toBe(1);
  expect(await cache.read("b", "1", load)).toBe(2);
  expect(await cache.read("a", "2", load)).toBe(3);
  const other = new HistoryReuse<number>();
  expect(await other.read("a", "2", load)).toBe(4);
});

test("uncertain freshness shares only in-flight work", async () => {
  const cache = new HistoryReuse<number>();
  let calls = 0;
  const load = async () => ++calls;
  expect(await Promise.all([cache.read("a", undefined, load), cache.read("a", undefined, load)])).toEqual([1, 1]);
  expect(await cache.read("a", undefined, load)).toBe(2);
  expect(cache.size).toBe(0);
});

test("evicts by both limits and bypasses oversized entries", async () => {
  const cache = new HistoryReuse<string>(30, 2);
  await cache.read("a", "1", async () => "aaa");
  await cache.read("b", "1", async () => "bbb");
  await cache.read("c", "1", async () => "ccc");
  expect(cache.size).toBe(2);
  await cache.read("d", "1", async () => "1234567890");
  expect(cache.retainedBytes).toBeLessThanOrEqual(30);
  expect(cache.size).toBe(1);
  await cache.read("large", "1", async () => "x".repeat(100));
  expect(cache.size).toBe(1);
});

test("invalidation and disposal prevent late reads from repopulating retention", async () => {
  const cache = new HistoryReuse<string>();
  let resolve!: (value: string) => void;
  const pending = cache.read("a", "1", () => new Promise<string>(done => { resolve = done; }));
  await Promise.resolve();
  cache.invalidate("a");
  resolve("old");
  await pending;
  expect(cache.size).toBe(0);
  await cache.read("a", "2", async () => "new");
  cache.dispose();
  expect(cache.retainedBytes).toBe(0);
  await expect(cache.read("a", "2", async () => "bad")).rejects.toThrow("disposed");
});

test("peek reads only exact qualified retained versions without loaders, accounting or LRU changes", async () => {
  const cache = new HistoryReuse<object>(10_000, 2), value = { proof: "first" };
  let calls = 0;
  await cache.read("a", "1", async () => { calls++; return value; });
  await cache.read("b", "1", async () => { calls++; return { proof: "second" }; });
  const bytes = cache.retainedBytes;
  expect(cache.peek("a", undefined)).toBeUndefined(); expect(cache.peek("a", "2")).toBeUndefined(); expect(cache.peek("absent", "1")).toBeUndefined();
  expect(cache.peek("a", "1")).toBe(value);
  expect(cache.retainedBytes).toBe(bytes); expect(cache.size).toBe(2); expect(calls).toBe(2);
  await cache.read("c", "1", async () => { calls++; return { proof: "third" }; });
  expect(cache.peek("a", "1")).toBeUndefined(); expect(cache.peek("b", "1")).toEqual({ proof: "second" });
  cache.invalidate("b"); expect(cache.peek("b", "1")).toBeUndefined();
  cache.dispose(); expect(cache.peek("c", "1")).toBeUndefined(); expect(cache.size).toBe(0); expect(cache.retainedBytes).toBe(0); expect(calls).toBe(3);
});

test("peek ignores pending reads and cannot retain invalidated or disposed late results", async () => {
  const cache = new HistoryReuse<string>();
  let resolve!: (value: string) => void, calls = 0;
  const load = () => { calls++; return new Promise<string>(done => { resolve = done; }); };
  const pending = cache.read("a", "1", load); await Promise.resolve();
  expect(cache.peek("a", "1")).toBeUndefined(); expect(cache.size).toBe(0); expect(cache.retainedBytes).toBe(0); expect(calls).toBe(1);
  const peer = cache.read("a", "1", load);
  cache.invalidate("a"); resolve("old"); await Promise.all([pending, peer]); expect(calls).toBe(1);
  expect(cache.peek("a", "1")).toBeUndefined(); expect(cache.size).toBe(0);
  const disposed = cache.read("a", "2", load); await Promise.resolve(); cache.dispose(); resolve("late"); await disposed;
  expect(cache.peek("a", "2")).toBeUndefined(); expect(cache.retainedBytes).toBe(0); expect(calls).toBe(2);
});

test("page cursors reject changed versions and legacy offsets explicitly", () => {
  const cursor = historyPageCursor(10, "version-a");
  expect(historyPageEnd(cursor, "version-a", 20)).toBe(10);
  expect(() => historyPageEnd(cursor, "version-b", 20)).toThrow("history changed");
  expect(() => historyPageEnd("10", "version-a", 20)).toThrow("history changed");
});

test("shared waiters cancel independently; the last departure cancels I/O and permits retry", async () => {
  const cache = new HistoryReuse<string>();
  const first = new AbortController(), second = new AbortController();
  let captured!: () => void, release!: (value: string) => void, transport!: AbortSignal;
  const started = new Promise<void>(resolve => { captured = resolve; });
  const load = (signal: AbortSignal) => { transport = signal; captured(); return new Promise<string>(resolve => { release = resolve; }); };
  const a = cache.readShared("a", "1", load, first.signal); void a.catch(() => undefined);
  await started;
  const b = cache.readShared("a", "1", load, second.signal); void b.catch(() => undefined);
  first.abort(); await expect(a).rejects.toThrow();
  expect(transport.aborted).toBe(false);
  second.abort(); await expect(b).rejects.toThrow();
  expect(transport.aborted).toBe(true);
  const replacement = cache.readShared("a", "1", async () => "current", new AbortController().signal);
  release("abandoned");
  expect(await replacement).toBe("current");
  expect(cache.peek("a", "1")).toBe("current");
  cache.dispose();
});

for (const ending of ["version", "invalidate", "dispose"] as const) test(`shared ${ending} fences late owners without removing a newer pending read`, async () => {
  const cache = new HistoryReuse<string>();
  let releaseOld!: (value: string) => void, releaseNew!: (value: string) => void;
  const old = cache.readShared("a", "1", () => new Promise<string>(resolve => { releaseOld = resolve; }), new AbortController().signal);
  void old.catch(() => undefined);
  await Promise.resolve();
  if (ending === "dispose") {
    cache.dispose();
    await expect(old).rejects.toThrow();
    releaseOld("late");
    expect(cache.peek("a", "1")).toBeUndefined();
    expect(cache.size).toBe(0);
    return;
  }
  if (ending === "invalidate") cache.invalidate("a");
  const version = ending === "version" ? "2" : "1";
  let loads = 0;
  const currentLoad = () => { loads++; return new Promise<string>(resolve => { releaseNew = resolve; }); };
  const current = cache.readShared("a", version, currentLoad, new AbortController().signal);
  await Promise.resolve();
  releaseOld("late"); await old;
  expect(cache.peek("a", "1")).toBeUndefined();
  const peer = cache.readShared("a", version, currentLoad, new AbortController().signal);
  expect(loads).toBe(1);
  releaseNew("current");
  expect(await Promise.all([current, peer])).toEqual(["current", "current"]);
  expect(cache.peek("a", version)).toBe("current");
  cache.dispose();
});
