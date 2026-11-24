import { describe, expect, test } from "bun:test";
import { PushQueue } from "./push-queue";

describe("PushQueue", () => {
  test("values pushed with nobody reading are banked and read in order", async () => {
    const queue = new PushQueue<number>();
    queue.push(1);
    queue.push(2);
    expect(await queue.take()).toEqual({ value: 1, done: false });
    expect(await queue.take()).toEqual({ value: 2, done: false });
  });

  test("a waiting read gets the next push, and waiting reads are served in order", async () => {
    const queue = new PushQueue<string>();
    const first = queue.take();
    const second = queue.take();
    queue.push("a");
    queue.push("b");
    expect(await first).toEqual({ value: "a", done: false });
    expect(await second).toEqual({ value: "b", done: false });
  });

  test("close ends waiting reads, keeps banked values readable, then ends every read and drops later pushes", async () => {
    const waiting = new PushQueue<number>();
    const read = waiting.take();
    waiting.close();
    expect(await read).toEqual({ value: undefined, done: true });

    const banked = new PushQueue<number>();
    banked.push(1);
    banked.close();
    banked.push(2);
    expect(await banked.take()).toEqual({ value: 1, done: false });
    expect(await banked.take()).toEqual({ value: undefined, done: true });
    expect(await banked.take()).toEqual({ value: undefined, done: true });
  });

  test("an offer reports true once a read takes it, false when close comes first, and a withdrawn offer is never read", async () => {
    const waiting = new PushQueue<string>();
    const read = waiting.take();
    expect(await waiting.offer("a")).toBe(true);
    expect(await read).toEqual({ value: "a", done: false });

    const banked = new PushQueue<string>();
    let settled: boolean | undefined;
    const taken = banked.offer("b").then(value => { settled = value; return value; });
    await Promise.resolve();
    expect(settled).toBeUndefined();
    expect(await banked.take()).toEqual({ value: "b", done: false });
    expect(await taken).toBe(true);

    const closing = new PushQueue<string>();
    closing.push("plain");
    const refused = closing.offer("offered");
    closing.close();
    expect(await refused).toBe(false);
    // A plain push stays readable after close; the withdrawn offer does not.
    expect(await closing.take()).toEqual({ value: "plain", done: false });
    expect(await closing.take()).toEqual({ value: undefined, done: true });
    expect(await closing.offer("late")).toBe(false);
  });

  test("detachWaiters ends only the reads in progress: banked values and later pushes stay for the next reader", async () => {
    const queue = new PushQueue<number>();
    const first = queue.take();
    const second = queue.take();
    queue.detachWaiters();
    expect(await first).toEqual({ value: undefined, done: true });
    expect(await second).toEqual({ value: undefined, done: true });
    queue.push(1);
    queue.push(2);
    // Nothing is waiting, so detaching leaves the bank alone.
    queue.detachWaiters();
    expect(await queue.take()).toEqual({ value: 1, done: false });
    const next = queue.take();
    expect(await next).toEqual({ value: 2, done: false });
    const later = queue.take();
    queue.push(3);
    expect(await later).toEqual({ value: 3, done: false });
  });

  test("a for-await consumer that stops early closes the queue", async () => {
    const queue = new PushQueue<number>();
    queue.push(1);
    queue.push(2);
    for await (const value of queue) {
      expect(value).toBe(1);
      break;
    }
    queue.push(3);
    expect(await queue.take()).toEqual({ value: 2, done: false });
    expect(await queue.take()).toEqual({ value: undefined, done: true });
  });

  test("a pushed undefined is a value: a later read receives it, not the next value", async () => {
    const queue = new PushQueue<number | undefined>();
    queue.push(undefined);
    queue.push(1);
    expect(await queue.take()).toEqual({ value: undefined, done: false });
    expect(await queue.take()).toEqual({ value: 1, done: false });
  });
});
