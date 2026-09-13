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
    const outcome = fetchWithinBudget(() => new Promise(() => {}), "/api/state", 15_000, clock.timers)
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
    }, "/api/state", 1_000, clock.timers).catch(() => undefined);
    clock.elapse();
    await outcome;
    expect(signal?.aborted).toBe(true);
  });

  test("an answer within the budget resolves and cancels the timer", async () => {
    const clock = fakeTimers();
    const response = await fetchWithinBudget(async () => new Response("ok"), "/api/state", 1_000, clock.timers);
    expect(await response.text()).toBe("ok");
    expect(clock.pending()).toBe(0);
  });

  test("a failing request rejects with its own error, not the budget's", async () => {
    const clock = fakeTimers();
    await expect(fetchWithinBudget(async () => { throw new Error("offline"); }, "/api/state", 1_000, clock.timers))
      .rejects.toThrow("offline");
    expect(clock.pending()).toBe(0);
  });
});
