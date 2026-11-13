import { expect, test } from "bun:test";
import { HoldToQueue } from "./hold-to-queue";

function fixture() {
  let identity: string | null = "conversation:draft:attachments:configuration";
  const deliveries: string[] = [];
  const hold = new HoldToQueue(() => identity, delivery => deliveries.push(delivery));
  return { hold, deliveries, invalidate: () => { identity = "other"; }, block: () => { identity = null; } };
}
test("release before the 500ms arming boundary steers once without a later queue", () => {
  for (const duration of [0, 249, 250, 499]) {
    const { hold, deliveries } = fixture();
    expect(hold.begin(7, 0)).toBe(true);
    hold.release(7, duration); hold.check(3000); hold.release(7, 3001);
    expect(deliveries).toEqual(["steer"]);
  }
});
test("intentional early hold release cancels rather than steering", () => {
  for (const duration of [500, 800, 1999, 2499]) {
    const { hold, deliveries } = fixture();
    hold.begin(7, 0); hold.release(7, duration); hold.check(3000);
    expect(deliveries).toEqual([]);
  }
});
test("holding queues automatically exactly once before release", () => {
  const { hold, deliveries } = fixture();
  hold.begin(7, 100); hold.check(2599);
  expect(deliveries).toEqual([]);
  hold.check(2600); hold.check(2700); hold.release(7, 2800);
  expect(deliveries).toEqual(["queue"]);
});
test("countdown starts at zero after arming and runs for a further two seconds", () => {
  const { hold } = fixture();
  hold.begin(7, 100);
  for (const [now, progress] of [[100, 0], [599, 0], [600, 0], [1100, 0.25], [2100, 0.75], [2599, 0.9995], [2600, 1]] as const) {
    expect(hold.progress(now)).toBe(progress);
  }
});
test("release at the queue boundary consumes the gesture before later checks", () => {
  const { hold, deliveries } = fixture();
  hold.begin(7, 0); hold.release(7, 2500); hold.check(2500); hold.release(7, 2501);
  expect(deliveries).toEqual(["queue"]);
});
test("cancellation, draft/selection mutation and active locks invalidate timers", () => {
  for (const change of ["cancel", "invalidate", "block"] as const) {
    const fixture_ = fixture();
    fixture_.hold.begin(7, 0);
    if (change === "cancel") fixture_.hold.cancel(); else fixture_[change]();
    fixture_.hold.check(3000); fixture_.hold.release(7, 3100);
    expect(fixture_.deliveries).toEqual([]);
  }
});
test("invalid state before arming never falls back to a tap", () => {
  for (const change of ["cancel", "invalidate", "block"] as const) {
    const fixture_ = fixture();
    fixture_.hold.begin(7, 0);
    if (change === "cancel") fixture_.hold.cancel(); else fixture_[change]();
    fixture_.hold.release(7, 499); fixture_.hold.check(3000);
    expect(fixture_.deliveries).toEqual([]);
  }
});
test("second pointers cannot replace a gesture or release it", () => {
  const { hold, deliveries } = fixture();
  hold.begin(7, 0); expect(hold.begin(8, 10)).toBe(false);
  hold.release(8, 100); expect(deliveries).toEqual([]);
  hold.release(7, 120); expect(deliveries).toEqual(["steer"]);
});
