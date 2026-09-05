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

test("page cursors reject changed versions and legacy offsets explicitly", () => {
  const cursor = historyPageCursor(10, "version-a");
  expect(historyPageEnd(cursor, "version-a", 20)).toBe(10);
  expect(() => historyPageEnd(cursor, "version-b", 20)).toThrow("history changed");
  expect(() => historyPageEnd("10", "version-a", 20)).toThrow("history changed");
});
