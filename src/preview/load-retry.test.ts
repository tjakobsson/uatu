import { describe, expect, test } from "bun:test";

import { createDocumentLoadRetry, isTransientDocumentFailure, type DocumentLoadRetryTimers } from "./load-retry";

function fakeTimers() {
  const pending = new Map<number, { callback: () => void; delay: number }>();
  let next = 1;
  const timers: DocumentLoadRetryTimers = {
    setTimeout: (callback, delay) => {
      const id = next++;
      pending.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: timer => { pending.delete(timer as unknown as number); },
  };
  return {
    timers,
    delays: () => [...pending.values()].map(entry => entry.delay),
    fire: () => {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.callback();
    },
  };
}

describe("isTransientDocumentFailure", () => {
  test("a server failure or no answer is transient", () => {
    expect(isTransientDocumentFailure(null)).toBe(true);
    expect(isTransientDocumentFailure(500)).toBe(true);
    expect(isTransientDocumentFailure(503)).toBe(true);
  });

  test("what the server says about the document itself is final", () => {
    expect(isTransientDocumentFailure(404)).toBe(false);
    expect(isTransientDocumentFailure(415)).toBe(false);
    expect(isTransientDocumentFailure(400)).toBe(false);
  });
});

describe("createDocumentLoadRetry", () => {
  test("retries on the schedule, then gives up", () => {
    const clock = fakeTimers();
    const retry = createDocumentLoadRetry({ delays: [10, 20], timers: clock.timers });
    let runs = 0;
    const run = () => { runs += 1; };

    expect(retry.failed("a", run)).toBe(true);
    expect(clock.delays()).toEqual([10]);
    clock.fire();
    expect(runs).toBe(1);

    expect(retry.failed("a", run)).toBe(true);
    expect(clock.delays()).toEqual([20]);
    clock.fire();
    expect(runs).toBe(2);

    expect(retry.failed("a", run)).toBe(false);
    expect(clock.delays()).toEqual([]);
  });

  test("a different document or selection starts over", () => {
    const clock = fakeTimers();
    const retry = createDocumentLoadRetry({ delays: [10, 20], timers: clock.timers });
    retry.failed("a", () => {});
    retry.failed("a", () => {});
    expect(clock.delays()).toEqual([20]);

    expect(retry.failed("b", () => {})).toBe(true);
    // The pending retry for "a" is replaced, not stacked.
    expect(clock.delays()).toEqual([10]);
  });

  test("settling cancels the pending retry and resets the count", () => {
    const clock = fakeTimers();
    const retry = createDocumentLoadRetry({ delays: [10, 20], timers: clock.timers });
    let runs = 0;
    retry.failed("a", () => { runs += 1; });
    retry.settle();
    expect(clock.delays()).toEqual([]);
    clock.fire();
    expect(runs).toBe(0);

    retry.failed("a", () => {});
    expect(clock.delays()).toEqual([10]);
  });
});
