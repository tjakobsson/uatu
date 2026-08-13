import { describe, expect, test } from "bun:test";

import type { CloneProcess, CloneProcessFactory, CloneProcessStart } from "./clone-process";
import { CloneJobManager, type CloneJobEvent, type CloneJobTimer } from "./clone-jobs";
import type { WorkspaceEntry } from "./registry";

class FakeTimer implements CloneJobTimer {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, milliseconds: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + milliseconds, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.now = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
      await tick();
    }
    this.now = target;
    await tick();
  }
}

class FakeProcess implements CloneProcess {
  readonly pid = 1;
  readonly writes: string[] = [];
  terminateCalls = 0;
  private resolveExit!: (code: number) => void;
  private terminateBarrier: Promise<void> = Promise.resolve();
  private releaseTerminate?: () => void;
  readonly exited = new Promise<number>(resolve => {
    this.resolveExit = resolve;
  });

  writeLine(value: string): void {
    this.writes.push(value);
  }

  async terminate(): Promise<void> {
    this.terminateCalls += 1;
    await this.terminateBarrier;
    this.resolveExit(143);
  }

  exit(code: number): void {
    this.resolveExit(code);
  }

  holdTerminate(): void {
    this.terminateBarrier = new Promise(resolve => {
      this.releaseTerminate = resolve;
    });
  }

  releaseHeldTerminate(): void {
    this.releaseTerminate?.();
  }
}

function fixture(overrides: { maxReplayBytes?: number; maxInputBytes?: number; inactivityMs?: number; lifetimeMs?: number; retentionMs?: number } = {}) {
  const timer = new FakeTimer();
  const processes: FakeProcess[] = [];
  const starts: CloneProcessStart[] = [];
  const processFactory: CloneProcessFactory = {
    start(options) {
      starts.push(options);
      const proc = new FakeProcess();
      processes.push(proc);
      return proc;
    },
  };
  const registered = new Map<string, WorkspaceEntry>();
  const removed: string[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  let registerError: Error | undefined;
  let startError: Error | undefined;
  let stopError: Error | undefined;
  let startBarrier: Promise<void> | undefined;
  let releaseStart: (() => void) | undefined;
  const registry = {
    async register(target: string) {
      if (registerError) throw registerError;
      const entry = { id: "repo", path: target, backend: "local" as const };
      registered.set(entry.id, entry);
      return entry;
    },
    async remove(id: string) {
      removed.push(id);
      return registered.delete(id);
    },
  };
  const sessions = {
    async start(id: string) {
      started.push(id);
      await startBarrier;
      if (startError) throw startError;
    },
    async stop(id: string) {
      stopped.push(id);
      if (stopError) throw stopError;
      return true;
    },
  };
  let id = 0;
  const manager = new CloneJobManager({
    processFactory,
    registry,
    sessions,
    timer,
    id: () => `job-${++id}`,
    inactivityMs: overrides.inactivityMs ?? 100,
    lifetimeMs: overrides.lifetimeMs ?? 1_000,
    retentionMs: overrides.retentionMs ?? 50,
    maxReplayBytes: overrides.maxReplayBytes ?? 1_000,
    maxInputBytes: overrides.maxInputBytes ?? 20,
  });
  return {
    manager, timer, processes, starts, registered, removed, started, stopped,
    failRegister(error: Error) { registerError = error; },
    failStart(error: Error) { startError = error; },
    failStop(error: Error) { stopError = error; },
    holdStart() {
      startBarrier = new Promise(resolve => {
        releaseStart = resolve;
      });
    },
    releaseHeldStart() { releaseStart?.(); },
  };
}

describe("CloneJobManager ownership and replay", () => {
  test("uses owner-scoped ids, replays after an event id, and cleans subscribers", async () => {
    const f = fixture();
    const { jobId } = f.manager.create("alice", "remote", "/tmp/../tmp/repo");
    await tick();
    const live: CloneJobEvent[] = [];
    const unsubscribe = f.manager.subscribe("alice", jobId, 0, event => live.push(event));
    expect(unsubscribe).not.toBeNull();
    expect(f.manager.subscribe("bob", jobId, 0, () => undefined)).toBeNull();
    f.starts[0].onOutput("one");
    unsubscribe?.();
    f.starts[0].onOutput("two");
    expect(live.some(event => event.type === "output" && event.data.output === "one")).toBe(true);
    expect(live.some(event => event.type === "output" && event.data.output === "two")).toBe(false);

    const replay: CloneJobEvent[] = [];
    f.manager.subscribe("alice", jobId, 1, event => replay.push(event));
    expect(replay.filter(event => event.type === "output").map(event => event.data.output)).toEqual(["one", "two"]);
    expect(f.manager.input("bob", jobId, "secret")).toBe("not-found");
    expect(await f.manager.cancel("bob", jobId)).toBe("not-found");
    await f.manager.cancel("alice", jobId);
  });

  test("bounds retained output while live subscribers receive every chunk", async () => {
    const f = fixture({ maxReplayBytes: 5 });
    const { jobId } = f.manager.create("alice", "remote", "/tmp/repo");
    await tick();
    const live: string[] = [];
    f.manager.subscribe("alice", jobId, 0, event => {
      if (event.type === "output") live.push(event.data.output);
    });
    f.starts[0].onOutput("1234");
    f.starts[0].onOutput("5678");
    expect(live).toEqual(["1234", "5678"]);
    const replay: string[] = [];
    f.manager.subscribe("alice", jobId, 0, event => {
      if (event.type === "output") replay.push(event.data.output);
    });
    expect(replay).toEqual(["5678"]);
    await f.manager.cancel("alice", jobId);
  });

  test("normalizes reservations and releases targets after every outcome", async () => {
    const f = fixture();
    const first = f.manager.create("alice", "remote", "/tmp/a/../repo");
    expect(() => f.manager.create("bob", "remote", "/tmp/repo")).toThrow("already reserved");
    await tick();
    f.processes[0].exit(1);
    await tick();
    expect(() => f.manager.create("bob", "remote", "/tmp/repo")).not.toThrow();
    await f.manager.cancel("bob", "job-2");
    expect(await f.manager.cancel("alice", first.jobId)).toBe("terminal");
  });
});

describe("CloneJobManager state machine", () => {
  test("registers only after clone success, starts, and reports success", async () => {
    const f = fixture();
    const { jobId } = f.manager.create("alice", "remote", "/tmp/repo");
    await tick();
    expect(f.registered.size).toBe(0);
    const events: CloneJobEvent[] = [];
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    f.processes[0].exit(0);
    await tick();
    expect(f.started).toEqual(["repo"]);
    expect(events.filter(event => event.type === "phase").map(event => event.data.phase)).toEqual([
      "cloning", "registering", "starting",
    ]);
    expect(events.at(-1)?.data).toEqual({ status: "succeeded", workspaceId: "repo", target: "/tmp/repo" });
  });

  test("reports clone and registration failures without starting", async () => {
    const clone = fixture();
    const cloneEvents: CloneJobEvent[] = [];
    const cloneJob = clone.manager.create("alice", "remote", "/tmp/clone-fail");
    clone.manager.subscribe("alice", cloneJob.jobId, 0, event => cloneEvents.push(event));
    await tick();
    clone.processes[0].exit(2);
    await tick();
    expect(clone.registered.size).toBe(0);
    expect(cloneEvents.at(-1)?.data).toMatchObject({ status: "clone-failed" });

    const registration = fixture();
    registration.failRegister(new Error("disk full"));
    const registrationEvents: CloneJobEvent[] = [];
    const registrationJob = registration.manager.create("alice", "remote", "/tmp/register-fail");
    registration.manager.subscribe("alice", registrationJob.jobId, 0, event => registrationEvents.push(event));
    await tick();
    registration.processes[0].exit(0);
    await tick();
    expect(registration.started).toEqual([]);
    expect(registrationEvents.at(-1)?.data).toMatchObject({ status: "register-failed", error: "disk full" });
  });

  test("a cancel racing failed-clone cleanup remains the terminal result", async () => {
    const f = fixture();
    const events: CloneJobEvent[] = [];
    const { jobId } = f.manager.create("alice", "remote", "/tmp/cancel-failed-clone");
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    await tick();
    f.processes[0].holdTerminate();
    f.processes[0].exit(2);
    await tick();

    const cancelling = f.manager.cancel("alice", jobId);
    f.processes[0].releaseHeldTerminate();

    expect(await cancelling).toBe("cancelled");
    expect(events.at(-1)?.data).toMatchObject({ status: "cancelled" });
  });

  test("failed cleanup after cancellation keeps the started workspace tracked", async () => {
    const f = fixture();
    f.holdStart();
    f.failStop(new Error("backend refused stop"));
    const events: CloneJobEvent[] = [];
    const { jobId } = f.manager.create("alice", "remote", "/tmp/cleanup-fail");
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    await tick();
    f.processes[0].exit(0);
    await tick();

    const cancelling = f.manager.cancel("alice", jobId);
    f.releaseHeldStart();

    expect(await cancelling).toBe("cleanup-failed");
    expect(f.registered.has("repo")).toBe(true);
    expect(f.removed).toEqual([]);
    expect(f.stopped).toEqual(["repo"]);
    expect(events.at(-1)?.data).toMatchObject({ status: "cleanup-failed", error: expect.stringContaining("backend refused stop") });
  });

  test("rolls registration back on start failure without deleting the target", async () => {
    const f = fixture();
    f.failStart(new Error("no session URL"));
    const events: CloneJobEvent[] = [];
    const { jobId } = f.manager.create("alice", "remote", "/tmp/keep-checkout");
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    await tick();
    f.processes[0].exit(0);
    await tick();
    expect(f.removed).toEqual(["repo"]);
    expect(f.registered.size).toBe(0);
    expect(events.at(-1)?.data).toEqual({ status: "start-failed", target: "/tmp/keep-checkout", error: "no session URL" });
  });
});

describe("CloneJobManager input, timers, and cleanup", () => {
  test("accepts one bounded line only while cloning and never retains or emits it", async () => {
    const f = fixture({ maxInputBytes: 6 });
    const { jobId } = f.manager.create("alice", "remote", "/tmp/repo");
    await tick();
    expect(f.manager.input("alice", jobId, "secret")).toBe("accepted");
    expect(f.manager.input("alice", jobId, "too-long")).toBe("too-large");
    expect(f.processes[0].writes).toEqual(["secret"]);
    const replay = JSON.stringify(capture(f.manager, "alice", jobId));
    expect(replay).not.toContain("secret");
    f.processes[0].exit(0);
    await tick();
    expect(f.manager.input("alice", jobId, "later")).toBe("inactive");
  });

  test("input and output reset inactivity; inactivity and lifetime time out and terminate", async () => {
    const inactivity = fixture({ inactivityMs: 10, lifetimeMs: 100 });
    const a = inactivity.manager.create("alice", "remote", "/tmp/a");
    await tick();
    await inactivity.timer.advance(8);
    inactivity.starts[0].onOutput("still alive");
    await inactivity.timer.advance(8);
    expect(inactivity.manager.input("alice", a.jobId, "yes")).toBe("accepted");
    await inactivity.timer.advance(9);
    expect(inactivity.processes[0].terminateCalls).toBe(0);
    await inactivity.timer.advance(1);
    expect(inactivity.processes[0].terminateCalls).toBeGreaterThan(0);
    expect(capture(inactivity.manager, "alice", a.jobId).at(-1)?.data).toMatchObject({ status: "timed-out", reason: "inactivity" });

    const lifetime = fixture({ inactivityMs: 100, lifetimeMs: 10 });
    const b = lifetime.manager.create("alice", "remote", "/tmp/b");
    await tick();
    lifetime.starts[0].onOutput("activity");
    await lifetime.timer.advance(10);
    expect(capture(lifetime.manager, "alice", b.jobId).at(-1)?.data).toMatchObject({ status: "timed-out", reason: "lifetime" });
  });

  test("cancellation is idempotent, close rejects creation, and terminal jobs expire", async () => {
    const f = fixture({ retentionMs: 10 });
    const { jobId } = f.manager.create("alice", "remote", "/tmp/repo");
    await tick();
    expect(await f.manager.cancel("alice", jobId)).toBe("cancelled");
    expect(await f.manager.cancel("alice", jobId)).toBe("terminal");
    expect(f.processes[0].terminateCalls).toBeGreaterThan(0);
    await f.timer.advance(10);
    expect(f.manager.subscribe("alice", jobId, 0, () => undefined)).toBeNull();

    const active = f.manager.create("alice", "remote", "/tmp/other");
    await tick();
    await f.manager.close();
    expect(capture(f.manager, "alice", active.jobId).at(-1)?.data).toMatchObject({ status: "cancelled" });
    expect(() => f.manager.create("alice", "remote", "/tmp/nope")).toThrow("closed");
  });
});

function capture(manager: CloneJobManager, owner: string, jobId: string): CloneJobEvent[] {
  const events: CloneJobEvent[] = [];
  manager.subscribe(owner, jobId, 0, event => events.push(event));
  return events;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
