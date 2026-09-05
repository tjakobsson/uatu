import { expect, test } from "bun:test";
import { createRefreshQueue } from "./refresh-queue";

function gate() {
  return Promise.withResolvers<void>();
}
test("slow refreshes coalesce later intent and drain continuously without overlap", async () => {
  const gates = [gate(), gate(), gate()];
  const calls: (string | null)[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const queue = createRefreshQueue(async id => {
    const index = calls.push(id) - 1;
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await gates[index]!.promise;
    --inFlight;
  });
  const completion = queue.request("first");
  await Promise.resolve();
  queue.request("middle");
  queue.request(null);
  queue.request("latest");
  expect(calls).toEqual(["first"]);
  gates[0]!.resolve();
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toEqual(["first", "latest"]);
  queue.request(null);
  gates[1]!.resolve();
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toEqual(["first", "latest", null]);
  gates[2]!.resolve();
  await completion;
  expect(maxInFlight).toBe(1);
});
test("failure drains retained events and permits later retries", async () => {
  const first = gate();
  const calls: (string | null)[] = [];
  const queue = createRefreshQueue(async id => {
    calls.push(id);
    if (calls.length === 1) await first.promise;
  });
  const failed = queue.request("bad");
  await Promise.resolve();
  queue.request("retained");
  first.reject(new Error("scan failed"));
  await expect(failed).rejects.toThrow("scan failed");
  expect(calls).toEqual(["bad", "retained"]);
  await queue.request("retry");
  expect(calls).toEqual(["bad", "retained", "retry"]);
});
test("stop drops pending and future requests", async () => {
  const first = gate();
  const calls: (string | null)[] = [];
  const queue = createRefreshQueue(async id => { calls.push(id); await first.promise; });
  const completion = queue.request("active");
  await Promise.resolve();
  queue.request("pending");
  queue.stop();
  first.resolve();
  await completion;
  await queue.request("after stop");
  expect(calls).toEqual(["active"]);
});

test("startup completes while a later reconciliation remains in flight", async () => {
  const first = gate();
  const later = gate();
  let calls = 0;
  const queue = createRefreshQueue(async () => { await (++calls === 1 ? first.promise : later.promise); });
  const startup = queue.request(null);
  const reconciliation = queue.request("newer");
  first.resolve();
  await startup;
  expect(calls).toBe(2);
  later.resolve();
  await reconciliation;
});
