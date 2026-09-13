import { describe, expect, test } from "bun:test";

import { fetchWithinBudget, type BoundedFetchTimers } from "./bounded-fetch";

function fakeTimers() {
  const scheduled: { id: number; run: () => void }[] = [];
  let nextId = 1;
  const timers: BoundedFetchTimers = {
    setTimeout(callback) {
      const id = nextId++;
      scheduled.push({ id, run: callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer) {
      const index = scheduled.findIndex(entry => entry.id === (timer as unknown as number));
      if (index >= 0) scheduled.splice(index, 1);
    },
  };
  return { timers, pending: () => scheduled.length, elapse: () => scheduled.shift()!.run() };
}

describe("fetchWithinBudget", () => {
  test("a request the network never answers rejects once the budget passes", async () => {
    const clock = fakeTimers();
    const outcome = fetchWithinBudget(() => new Promise(() => {}), "/api/state", 15_000, response => response.text(), clock.timers)
      .then(() => "answered", (error: Error) => error.message);
    clock.elapse();
    expect(await outcome).toContain("unanswered after 15000 ms");
  });

  test("the fetcher is told to abort, so a real request stops consuming the connection", async () => {
    const clock = fakeTimers();
    let signal: AbortSignal | undefined;
    const outcome = fetchWithinBudget((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    }, "/api/state", 1_000, response => response.text(), clock.timers).catch(() => undefined);
    clock.elapse();
    await outcome;
    expect(signal?.aborted).toBe(true);
  });

  test("headers that arrive with a body that never does still reject within the budget", async () => {
    // A proxy answering 200 and then going quiet: the request has "answered"
    // but the read has not, and it is the read the recovery is waiting on.
    const clock = fakeTimers();
    const stalled = new Response(new ReadableStream({ start() {} }));
    const outcome = fetchWithinBudget(async () => stalled, "/api/state", 15_000, response => response.json(), clock.timers)
      .then(() => "read", (error: Error) => error.message);
    clock.elapse();
    expect(await outcome).toContain("unanswered after 15000 ms");
    expect(clock.pending()).toBe(0);
  });

  test("a failing read rejects with its own error", async () => {
    const clock = fakeTimers();
    await expect(fetchWithinBudget(async () => new Response("not json"), "/api/state", 1_000, response => response.json(), clock.timers))
      .rejects.toThrow();
    expect(clock.pending()).toBe(0);
  });

  test("an answer within the budget resolves and cancels the timer", async () => {
    const clock = fakeTimers();
    const body = await fetchWithinBudget(async () => new Response("ok"), "/api/state", 1_000, response => response.text(), clock.timers);
    expect(body).toBe("ok");
    expect(clock.pending()).toBe(0);
  });

  test("a failing request rejects with its own error, not the budget's", async () => {
    const clock = fakeTimers();
    await expect(fetchWithinBudget(async () => { throw new Error("offline"); }, "/api/state", 1_000, response => response.text(), clock.timers))
      .rejects.toThrow("offline");
    expect(clock.pending()).toBe(0);
  });
});
