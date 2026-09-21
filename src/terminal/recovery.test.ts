import { describe, expect, test } from "bun:test";

import {
  RECOVERY_BUDGET_MS,
  RECOVERY_MAX_DELAY_MS,
  classifyInventoryResponse,
  recoverAttachment,
  recoveryDelayMs,
  type AttachAttemptResult,
  type InventoryRead,
  type RecoveryClock,
  type RecoveryOutcome,
  type RecoveryPhase,
} from "./recovery";

const SESSION = "11111111-1111-1111-1111-111111111111";

// A clock the test advances by hand. Timers fire in due order as the clock
// passes them; nothing sleeps.
function fakeClock() {
  let now = 1_000;
  let serial = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: RecoveryClock = {
    now: () => now,
    setTimeout(callback, delayMs) {
      const id = ++serial;
      timers.set(id, { at: now + delayMs, run: callback });
      return id;
    },
    clearTimeout(timer) {
      timers.delete(timer as number);
    },
  };
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  return {
    clock,
    flush,
    pendingDelays: () => [...timers.values()].map(timer => timer.at - now).sort((a, b) => a - b),
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at);
        timers.delete(due[0]);
        due[1].run();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

type Step =
  | { read: InventoryRead | "hang" }
  | { attach: AttachAttemptResult | "hang"; takes?: number };

// Scripted inventory reads and attach attempts, recorded with the clock
// time and the deadline each was given.
function scripted(clockOf: () => RecoveryClock, steps: Step[]) {
  const reads: number[] = [];
  const attaches: { at: number; deadline: number }[] = [];
  const phases: RecoveryPhase[] = [];
  let aborted = 0;
  const next = (): Step => {
    const step = steps.shift();
    if (!step) throw new Error("script exhausted");
    return step;
  };
  const deps = {
    clock: clockOf(),
    async readInventory(signal: AbortSignal): Promise<InventoryRead> {
      reads.push(clockOf().now());
      const step = next();
      if (!("read" in step)) throw new Error(`expected a read, script says ${JSON.stringify(step)}`);
      if (step.read === "hang") {
        return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted += 1; reject(new Error("aborted")); }));
      }
      return step.read;
    },
    async attach(deadlineMs: number, signal: AbortSignal): Promise<AttachAttemptResult> {
      attaches.push({ at: clockOf().now(), deadline: deadlineMs });
      const step = next();
      if (!("attach" in step)) throw new Error(`expected an attach, script says ${JSON.stringify(step)}`);
      if (step.attach === "hang") {
        return new Promise(resolve => signal.addEventListener("abort", () => { aborted += 1; resolve("refused"); }));
      }
      if (step.takes) {
        // The attempt consumes clock time (a readiness wait) before it
        // resolves; scheduled on the fake clock so the test controls it.
        const result = step.attach;
        return new Promise(resolve => clockOf().setTimeout(() => resolve(result), step.takes!));
      }
      return step.attach;
    },
    onPhase(phase: RecoveryPhase) {
      phases.push(phase);
    },
  };
  return { deps, reads, attaches, phases, abortedCount: () => aborted, remaining: () => steps.length };
}

async function settled(outcome: Promise<RecoveryOutcome>): Promise<RecoveryOutcome | "pending"> {
  return Promise.race([outcome, Promise.resolve("pending" as const)]);
}

const detached: InventoryRead = { kind: "ok", sessions: [{ id: SESSION, attached: false }] };
const occupied: InventoryRead = { kind: "ok", sessions: [{ id: SESSION, attached: true }] };
const missing: InventoryRead = { kind: "ok", sessions: [] };

describe("recoveryDelayMs", () => {
  test("starts at 100 ms, doubles, and caps at one second", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(recoveryDelayMs)).toEqual([100, 200, 400, 800, 1000, 1000, 1000]);
    expect(RECOVERY_MAX_DELAY_MS).toBe(1_000);
  });
});

describe("recoverAttachment", () => {
  test("a direct attach that reaches readiness is the whole recovery", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [{ attach: "ready" }]);
    const run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    expect(await run.outcome).toBe("attached");
    expect(script.reads).toEqual([]);
    expect(script.attaches).toEqual([{ at: 1_000, deadline: RECOVERY_BUDGET_MS }]);
    expect(script.phases).toEqual([{ phase: "attaching", attempt: 0 }]);
  });

  test("a departing holder released late is reattached within the budget, by an ordinary attach", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [
      { attach: "refused" },       // t=1000: the old holder still has it
      { read: occupied },          // t=1100
      { read: occupied },          // t=1300
      { read: detached },          // t=1700: released
      { attach: "ready" },
    ]);
    const run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    expect(await settled(run.outcome)).toBe("pending");
    expect(time.pendingDelays()).toEqual([100]);
    await time.advance(100);
    expect(time.pendingDelays()).toEqual([200]);
    await time.advance(200);
    expect(time.pendingDelays()).toEqual([400]);
    await time.advance(400);
    expect(await run.outcome).toBe("attached");
    expect(script.reads).toEqual([1_100, 1_300, 1_700]);
    // The second attach carries only what is left of the one budget.
    expect(script.attaches).toEqual([
      { at: 1_000, deadline: 5_000 },
      { at: 1_700, deadline: 4_300 },
    ]);
    expect(script.phases.map(phase => phase.phase)).toEqual(["attaching", "reconciling", "reconciling", "reconciling"]);
  });

  test("a PTY held throughout settles as occupied when the budget is spent, with delays capped at one second", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [
      { attach: "refused" },
      ...Array.from({ length: 7 }, (): Step => ({ read: occupied })),
    ]);
    const run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    const delays: number[] = [];
    while ((await settled(run.outcome)) === "pending") {
      const [next] = time.pendingDelays();
      if (next === undefined) break;
      delays.push(next);
      await time.advance(next);
    }
    expect(await run.outcome).toBe("occupied");
    // Seven reads at 100 + 200 + 400 + 800 + 1000 + 1000 + 1000 = 4500 ms;
    // the next full second would overrun, so the last wait is what remains
    // and the deadline settles the run without an eighth read.
    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000, 1000, 500]);
    expect(time.clock.now()).toBe(1_000 + RECOVERY_BUDGET_MS);
    // Nothing is read after the deadline, and no second budget starts.
    expect(script.reads.at(-1)!).toBeLessThan(1_000 + RECOVERY_BUDGET_MS);
    expect(script.remaining()).toBe(0);
  });

  test("an attach refused after a detached read is retried through inventory within the same budget", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [
      { attach: "refused" },
      { read: detached },
      { attach: "refused" },   // another client won the race
      { read: detached },
      { attach: "ready" },
    ]);
    const run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    await time.advance(100);
    await time.advance(200);
    expect(await run.outcome).toBe("attached");
    expect(script.attaches.map(attempt => attempt.deadline)).toEqual([5_000, 4_900, 4_700]);
  });

  test("a socket that opens but never becomes ready is bounded by the remaining budget and settles as unreachable", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [
      { attach: "silent", takes: 5_000 },
    ]);
    const run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    expect(script.attaches).toEqual([{ at: 1_000, deadline: 5_000 }]);
    await time.advance(5_000);
    expect(await run.outcome).toBe("unreachable");
    expect(script.reads).toEqual([]);
    expect(time.pendingDelays()).toEqual([]);
  });

  test("a silent attempt part-way through leaves the rest of the budget to inventory, never a fresh budget", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [
      { attach: "silent", takes: 3_000 },   // t=4000
      { read: occupied },                   // t=4100
      { read: occupied },                   // t=4300
      { read: occupied },                   // t=4700
      { read: occupied },                   // t=5500
      { read: occupied },                   // t=6000 (deadline)
    ]);
    const run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    await time.advance(3_000);
    expect(await settled(run.outcome)).toBe("pending");
    await time.advance(2_000);
    expect(await run.outcome).toBe("occupied");
    expect(script.reads.every(at => at <= 6_000)).toBe(true);
    expect(time.clock.now()).toBe(6_000);
  });

  test("a successful read that omits the PTY ends the pane; no takeover, no retry", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [{ attach: "refused" }, { read: missing }]);
    const run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    await time.advance(100);
    expect(await run.outcome).toBe("ended");
    expect(script.attaches).toHaveLength(1);
  });

  test("failed reads never imply occupancy or exit: the budget ends in a retryable state", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [
      { attach: "refused" },
      ...Array.from({ length: 8 }, (): Step => ({ read: { kind: "failed" } })),
    ]);
    const run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    await time.advance(RECOVERY_BUDGET_MS);
    expect(await run.outcome).toBe("unreachable");
  });

  test("an inventory read that outlives the budget is abandoned and the run settles", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [{ attach: "refused" }, { read: "hang" }]);
    const run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    await time.advance(100);
    expect(await settled(run.outcome)).toBe("pending");
    await time.advance(4_900);
    expect(await run.outcome).toBe("unreachable");
    expect(script.abortedCount()).toBe(1);
  });

  test("authentication and origin refusals are final immediately", async () => {
    for (const kind of ["auth-required", "origin-rejected"] as const) {
      const time = fakeClock();
      const script = scripted(() => time.clock, [{ attach: "refused" }, { read: { kind } }]);
      const run = recoverAttachment(SESSION, script.deps);
      await time.flush();
      await time.advance(100);
      expect(await run.outcome).toBe(kind);
    }
  });

  test("a takeover notice or an explicit exit during an attempt ends the run with that fact", async () => {
    for (const [result, outcome] of [["taken", "taken"], ["exit", "ended"]] as const) {
      const time = fakeClock();
      const script = scripted(() => time.clock, [{ attach: result }]);
      const run = recoverAttachment(SESSION, script.deps);
      await time.flush();
      expect(await run.outcome).toBe(outcome);
    }
  });

  test("cancellation during a wait, a read, or an attempt ends the run without further work", async () => {
    // During the wait.
    let time = fakeClock();
    let script = scripted(() => time.clock, [{ attach: "refused" }, { read: occupied }, { read: occupied }]);
    let run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    run.cancel();
    expect(await run.outcome).toBe("cancelled");
    await time.advance(1_000);
    expect(script.reads).toEqual([]);
    expect(time.pendingDelays()).toEqual([]);

    // During a read.
    time = fakeClock();
    script = scripted(() => time.clock, [{ attach: "refused" }, { read: "hang" }]);
    run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    await time.advance(100);
    run.cancel();
    expect(await run.outcome).toBe("cancelled");
    expect(script.abortedCount()).toBe(1);

    // During an attempt.
    time = fakeClock();
    script = scripted(() => time.clock, [{ attach: "hang" }]);
    run = recoverAttachment(SESSION, script.deps);
    await time.flush();
    run.cancel();
    expect(await run.outcome).toBe("cancelled");
    expect(script.abortedCount()).toBe(1);
  });

  test("a run that skips the direct attempt consults inventory first", async () => {
    const time = fakeClock();
    const script = scripted(() => time.clock, [{ read: detached }, { attach: "ready" }]);
    const run = recoverAttachment(SESSION, script.deps, { direct: false });
    await time.flush();
    expect(await run.outcome).toBe("attached");
    expect(script.phases[0]).toEqual({ phase: "reconciling", attempt: 0 });
  });
});

describe("classifyInventoryResponse", () => {
  test("maps statuses to the recovery's vocabulary and keeps only well-formed rows", () => {
    expect(classifyInventoryResponse(401, null)).toEqual({ kind: "auth-required" });
    expect(classifyInventoryResponse(403, null)).toEqual({ kind: "origin-rejected" });
    expect(classifyInventoryResponse(502, null)).toEqual({ kind: "failed" });
    expect(classifyInventoryResponse(200, { nope: true })).toEqual({ kind: "failed" });
    expect(classifyInventoryResponse(200, { sessions: [{ id: SESSION, attached: true, label: "zsh" }, { bogus: 1 }] }))
      .toEqual({ kind: "ok", sessions: [{ id: SESSION, attached: true }] });
  });
});
