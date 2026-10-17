import { expect, test } from "bun:test";
import { HoldToQueue } from "./hold-to-queue";

function fixture() {
  let identity: string | null = "conversation:draft:attachments:configuration";
  const deliveries: string[] = [];
  const hold = new HoldToQueue(() => identity, delivery => deliveries.push(delivery));
  return { hold, deliveries, invalidate: () => { identity = "other"; }, block: () => { identity = null; } };
}
test("quick tap steers once and never queues on a later timer", () => {
  const { hold, deliveries } = fixture();
  expect(hold.begin(7, 0)).toBe(true);
  hold.release(7, 249); hold.check(3000); hold.release(7, 3001);
  expect(deliveries).toEqual(["steer"]);
});
test("intentional early hold release cancels rather than steering", () => {
  for (const duration of [250, 800, 1999]) {
    const { hold, deliveries } = fixture();
    hold.begin(7, 0); hold.release(7, duration); hold.check(3000);
    expect(deliveries).toEqual([]);
  }
});
test("holding queues automatically exactly once before release", () => {
  const { hold, deliveries } = fixture();
  hold.begin(7, 100); hold.check(2099);
  expect(deliveries).toEqual([]);
  hold.check(2100); hold.check(2200); hold.release(7, 2300);
  expect(deliveries).toEqual(["queue"]);
});
test("cancellation, draft/selection mutation and active locks invalidate timers", () => {
  for (const change of ["cancel", "invalidate", "block"] as const) {
    const fixture_ = fixture();
    fixture_.hold.begin(7, 0);
    if (change === "cancel") fixture_.hold.cancel(); else fixture_[change]();
    fixture_.hold.check(2100); fixture_.hold.release(7, 2200);
    expect(fixture_.deliveries).toEqual([]);
  }
});
test("second pointers cannot replace a gesture or release it", () => {
  const { hold, deliveries } = fixture();
  hold.begin(7, 0); expect(hold.begin(8, 10)).toBe(false);
  hold.release(8, 100); expect(deliveries).toEqual([]);
  hold.release(7, 120); expect(deliveries).toEqual(["steer"]);
});
