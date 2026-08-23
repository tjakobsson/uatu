import { describe, expect, test } from "bun:test";

import type { CloneProcess, CloneProcessFactory, CloneProcessStart } from "./clone-process";
import { CloneJobManager, type CloneJobEvent, type CloneJobTimer } from "./clone-jobs";
import type { ResolvedCloneCredential } from "./credential-context";
import { OnboardingError } from "./onboarding";
import { PathReservationCoordinator } from "./path-reservations";
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
  private terminateError?: Error;
  private remainingTerminateFailures = 0;
  readonly exited = new Promise<number>(resolve => {
    this.resolveExit = resolve;
  });

  writeLine(value: string): boolean {
    this.writes.push(value);
    return true;
  }

  async terminate(): Promise<void> {
    this.terminateCalls += 1;
    await this.terminateBarrier;
    if (this.terminateError && (this.remainingTerminateFailures < 0 || this.remainingTerminateFailures-- > 0)) {
      throw this.terminateError;
    }
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

  failTerminate(error: Error): void {
    this.terminateError = error;
    this.remainingTerminateFailures = -1;
  }

  failTerminateTimes(error: Error, count: number): void {
    this.terminateError = error;
    this.remainingTerminateFailures = count;
  }

  allowTerminate(): void {
    this.terminateError = undefined;
    this.remainingTerminateFailures = 0;
  }
}

function fixture(overrides: {
  maxReplayBytes?: number;
  maxInputBytes?: number;
  inactivityMs?: number;
  lifetimeMs?: number;
  retentionMs?: number;
  reservations?: PathReservationCoordinator;
  onboarding?: boolean;
  personalState?: boolean;
} = {}) {
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
  const assigned: string[] = [];
  const unassigned: string[] = [];
  const runtimeSections: string[] = [];
  let registerError: Error | undefined;
  let removeError: Error | undefined;
  let startError: Error | undefined;
  let stopError: Error | undefined;
  let assignError: Error | undefined;
  let unassignError: Error | undefined;
  let startBarrier: Promise<void> | undefined;
  let releaseStart: (() => void) | undefined;
  let stopBarrier: Promise<void> | undefined;
  let releaseStop: (() => void) | undefined;
  const registry = {
    byPath(target: string) {
      return [...registered.values()].find(entry => entry.path === target);
    },
    async register(target: string) {
      if (registerError) throw registerError;
      const entry = { id: "repo", path: target, backend: "local" as const, displayName: "repo" };
      registered.set(entry.id, entry);
      return entry;
    },
    async remove(id: string) {
      removed.push(id);
      if (removeError) throw removeError;
      return registered.delete(id);
    },
  };
  // Mirrors SessionManager's per-workspace lifecycle queue: operations for
  // one workspace serialize, and the failure/stop hooks run inside their
  // owning operation, before the queue is released.
  const lifecycle = new Map<string, Promise<unknown>>();
  const enqueue = <T,>(id: string, operation: () => Promise<T>): Promise<T> => {
    const previous = lifecycle.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    lifecycle.set(id, next.then(() => undefined, () => undefined));
    return next;
  };
  const sessions = {
    start(id: string, onFailure?: () => Promise<void>) {
      return enqueue(id, async () => {
        started.push(id);
        await startBarrier;
        if (startError) {
          await onFailure?.();
          throw startError;
        }
      });
    },
    stop(id: string, onStopped?: () => Promise<void>) {
      return enqueue(id, async () => {
        stopped.push(id);
        await stopBarrier;
        if (stopError) throw stopError;
        await onStopped?.();
        return true;
      });
    },
    runExclusive<T>(id: string, operation: () => Promise<T>) {
      return enqueue(id, operation);
    },
  };
  const onboardingCalls: Array<{ path: string; displayName: string; authentication: Array<{ credentialId: string; host: string }>; signing: string | null; start?: boolean }> = [];
  const assignmentsRemoved: string[] = [];
  let onboardingError: Error | undefined;
  const onboarding = overrides.onboarding ? {
    async configureCloned(options: typeof onboardingCalls[number]) {
      if (onboardingError) {
        // A committed-entry error models the journal-clear failure: both
        // stores committed before the throw.
        const committed = onboardingError instanceof OnboardingError ? onboardingError.committedEntry : undefined;
        if (committed) registered.set(committed.id, committed);
        throw onboardingError;
      }
      onboardingCalls.push(options);
      const entry = { id: "repo", path: options.path, backend: "local" as const, displayName: options.displayName };
      registered.set(entry.id, entry);
      // Mirrors the coordinator's lifecycle-protected in-commit start: a
      // failure preserves the committed stopped registration.
      let startedInCommit = false;
      let startError: string | null = null;
      if ((options as { start?: boolean }).start) {
        try {
          await sessions.start(entry.id);
          startedInCommit = true;
        } catch (error) {
          startError = error instanceof Error ? error.message : String(error);
        }
      }
      return { entry, started: startedInCommit, startError };
    },
    async removeWorkspaceAssignments(workspaceId: string) {
      assignmentsRemoved.push(workspaceId);
    },
  } : undefined;
  const forgetFlow: Array<{ id: string; order: string[] }> = [];
  const personalState = overrides.personalState ? {
    async forgetWorkspace(
      workspaceId: string,
      removeRegistryEntry: () => Promise<boolean>,
      finalizeCommittedForget: () => Promise<void> = async () => {},
    ) {
      const order: string[] = ["journal"];
      if (!(await removeRegistryEntry())) throw new Error(`unknown workspace: ${workspaceId}`);
      order.push("registry");
      await finalizeCommittedForget();
      order.push("finalize");
      forgetFlow.push({ id: workspaceId, order });
      return true;
    },
  } : undefined;
  let id = 0;
  const manager = new CloneJobManager({
    processFactory,
    registry,
    sessions,
    onboarding,
    personalState,
    credentials: {
      // Mirrors the stored resolver: an SSH-selected job re-resolves inside
      // the runtime section and must get a live credential back.
      async resolve(_remote: string, credentialId?: string) {
        if (!credentialId) return undefined;
        return { ...selectedCredential, credentialId };
      },
      async assign(workspaceId) {
        if (assignError) throw assignError;
        assigned.push(workspaceId);
      },
      async unassign(workspaceId) {
        if (unassignError) throw unassignError;
        unassigned.push(workspaceId);
      },
      async runExclusive<T>(operation: () => Promise<T>) {
        runtimeSections.push("enter");
        try {
          return await operation();
        } finally {
          runtimeSections.push("exit");
        }
      },
    },
    timer,
    id: () => `job-${++id}`,
    inactivityMs: overrides.inactivityMs ?? 100,
    lifetimeMs: overrides.lifetimeMs ?? 1_000,
    retentionMs: overrides.retentionMs ?? 50,
    maxReplayBytes: overrides.maxReplayBytes ?? 1_000,
    maxInputBytes: overrides.maxInputBytes ?? 20,
    reservations: overrides.reservations,
  });
  return {
    manager, timer, processes, starts, registered, removed, started, stopped, assigned, unassigned, sessions, runtimeSections,
    onboardingCalls, assignmentsRemoved, forgetFlow,
    failOnboarding(error: Error) { onboardingError = error; },
    failRegister(error: Error) { registerError = error; },
    failRemove(error: Error) { removeError = error; },
    failStart(error: Error) { startError = error; },
    failStop(error: Error) { stopError = error; },
    failAssign(error: Error) { assignError = error; },
    failUnassign(error: Error) { unassignError = error; },
    holdStart() {
      startBarrier = new Promise(resolve => {
        releaseStart = resolve;
      });
    },
    releaseHeldStart() { releaseStart?.(); },
    holdStop() {
      stopBarrier = new Promise(resolve => {
        releaseStop = resolve;
      });
    },
    releaseHeldStop() { releaseStop?.(); },
  };
}

const selectedCredential: ResolvedCloneCredential = {
  credentialId: "ssh-1",
  host: "github.com",
  process: {
    type: "ssh",
    host: "github.com",
    sshPath: "/managed/ssh",
    agentSocket: "/managed/agent.sock",
    publicKeyPath: "/managed/ssh-1.pub",
  },
};

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

  test("shares hierarchy-aware reservations across clone managers", async () => {
    const reservations = new PathReservationCoordinator();
    const first = fixture({ reservations });
    const second = fixture({ reservations });
    const { jobId } = first.manager.create("alice", "remote", "/tmp/shared/group/repo");

    expect(() => second.manager.create("bob", "remote", "/tmp/shared/group")).toThrow("already reserved");
    expect(() => second.manager.create("bob", "remote", "/tmp/shared/group/repo/nested")).toThrow("already reserved");
    expect(() => second.manager.create("bob", "remote", "/tmp/shared/group/repo-two")).not.toThrow();

    await tick();
    await first.manager.cancel("alice", jobId);
    expect(() => second.manager.create("bob", "remote", "/tmp/shared/group/repo/nested")).not.toThrow();
    await second.manager.close();
  });
});

describe("CloneJobManager state machine", () => {
  test("registers only after clone success, starts, and reports success", async () => {
    const f = fixture();
    const { jobId } = f.manager.create("alice", "remote", "/tmp/repo", { start: true });
    await tick();
    expect(f.registered.size).toBe(0);
    const events: CloneJobEvent[] = [];
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    f.processes[0].exit(0);
    await tick();
    expect(f.processes[0].terminateCalls).toBeGreaterThan(0);
    expect(f.started).toEqual(["repo"]);
    expect(events.filter(event => event.type === "phase").map(event => event.data.phase)).toEqual([
      "cloning", "registering", "starting",
    ]);
    expect(events.at(-1)?.data).toEqual({ status: "succeeded", workspaceId: "repo", target: "/tmp/repo", running: true });
  });

  test("passes the selected credential to Git and retains its assignment only after registration", async () => {
    const f = fixture();
    const { jobId } = f.manager.create("alice", "git@github.com:acme/repo.git", "/tmp/selected", {
      credential: selectedCredential,
      retainAssignment: true,
      start: true,
    });
    const events: CloneJobEvent[] = [];
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    await tick();
    expect(f.starts[0].credential).toEqual(selectedCredential.process);
    expect(f.assigned).toEqual([]);

    f.processes[0].exit(0);
    await tick();
    expect(f.assigned).toEqual(["repo"]);
    expect(f.started).toEqual(["repo"]);
    expect(f.unassigned).toEqual([]);
    expect(events.at(-1)?.data).toMatchObject({ status: "succeeded", workspaceId: "repo" });
  });

  test("rolls retained assignment and registration back when session startup fails", async () => {
    const f = fixture();
    f.failStart(new Error("backend unavailable"));
    const { jobId } = f.manager.create("alice", "git@github.com:acme/repo.git", "/tmp/selected-fail", {
      credential: selectedCredential,
      retainAssignment: true,
      start: true,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    expect(f.assigned).toEqual(["repo"]);
    expect(f.unassigned).toEqual(["repo"]);
    expect(f.removed).toEqual(["repo"]);
    expect(f.registered.size).toBe(0);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toMatchObject({ status: "start-failed" });
  });

  test("a selected SSH clone holds the credential runtime section for its whole process lifetime", async () => {
    const f = fixture();
    const { jobId } = f.manager.create("alice", "git@github.com:acme/repo.git", "/tmp/gated", {
      credential: selectedCredential,
    });
    await tick();
    // The section opened before the spawn and stays held while the clone
    // runs, so an ssh-agent override defers instead of retiring the socket
    // mid-clone.
    expect(f.runtimeSections).toEqual(["enter"]);
    expect(f.starts).toHaveLength(1);
    f.processes[0].exit(0);
    await tick();
    expect(f.runtimeSections).toEqual(["enter", "exit"]);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toMatchObject({ status: "succeeded" });

    // Unselected clones never enter the section.
    const plain = fixture();
    plain.manager.create("alice", "remote", "/tmp/ungated");
    await tick();
    plain.processes[0].exit(0);
    await tick();
    expect(plain.runtimeSections).toEqual([]);
  });

  test("a queued assignment observes failed-start rollback, not the doomed registration", async () => {
    const f = fixture();
    f.failStart(new Error("backend unavailable"));
    f.holdStart();
    const { jobId } = f.manager.create("alice", "git@github.com:acme/repo.git", "/tmp/assign-race", {
      credential: selectedCredential,
      retainAssignment: true,
      start: true,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();
    expect(f.started).toEqual(["repo"]);

    // A credential assignment request queued while the start is failing must
    // run after the in-lifecycle rollback — never against the registration
    // the rollback is about to remove.
    let sawRegistration: boolean | undefined;
    const queued = f.sessions.runExclusive("repo", async () => {
      sawRegistration = f.registered.has("repo");
    });
    f.releaseHeldStart();
    await queued;
    await tick();

    expect(sawRegistration).toBe(false);
    expect(f.removed).toEqual(["repo"]);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toMatchObject({ status: "start-failed" });
  });

  test("cancellation rollback runs inside the stop lifecycle, ahead of queued assignments", async () => {
    const f = fixture();
    f.holdStart();
    const { jobId } = f.manager.create("alice", "git@github.com:acme/repo.git", "/tmp/cancel-race", {
      credential: selectedCredential,
      retainAssignment: true,
      start: true,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    const cancelling = f.manager.cancel("alice", jobId);
    f.holdStop();
    f.releaseHeldStart();
    await tick();
    expect(f.stopped).toEqual(["repo"]);

    let sawRegistration: boolean | undefined;
    const queued = f.sessions.runExclusive("repo", async () => {
      sawRegistration = f.registered.has("repo");
    });
    f.releaseHeldStop();
    await queued;

    expect(sawRegistration).toBe(false);
    expect(await cancelling).toBe("cancelled");
    expect(f.unassigned).toEqual(["repo"]);
    expect(f.removed).toEqual(["repo"]);
  });

  test("restores a retained assignment when registration rollback fails", async () => {
    const f = fixture();
    f.failStart(new Error("backend unavailable"));
    f.failRemove(new Error("registry is read-only"));
    const { jobId } = f.manager.create("alice", "git@github.com:acme/repo.git", "/tmp/selected-rollback-fail", {
      credential: selectedCredential,
      retainAssignment: true,
      start: true,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    expect(f.assigned).toEqual(["repo", "repo"]);
    expect(f.unassigned).toEqual(["repo"]);
    expect(f.registered.has("repo")).toBe(true);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toMatchObject({
      status: "start-failed",
      error: expect.stringContaining("registry is read-only"),
    });
  });

  test("rolls registration back when retained assignment persistence fails", async () => {
    const f = fixture();
    f.failAssign(new Error("credential state is read-only"));
    const { jobId } = f.manager.create("alice", "git@github.com:acme/repo.git", "/tmp/assign-fail", {
      credential: selectedCredential,
      retainAssignment: true,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    expect(f.started).toEqual([]);
    expect(f.removed).toEqual(["repo"]);
    expect(f.registered.size).toBe(0);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toMatchObject({
      status: "register-failed",
      error: "credential state is read-only",
    });
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
    const { jobId } = f.manager.create("alice", "remote", "/tmp/cleanup-fail", { start: true });
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
    expect(() => f.manager.create("bob", "remote", "/tmp/cleanup-fail")).not.toThrow();
    await f.manager.close();
  });

  test("failed process-group cleanup is a terminal cleanup failure", async () => {
    const f = fixture();
    const events: CloneJobEvent[] = [];
    const { jobId } = f.manager.create("alice", "remote", "/tmp/process-cleanup-fail");
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    await tick();
    f.processes[0].failTerminate(new Error("descendant survived SIGKILL"));

    expect(await f.manager.cancel("alice", jobId)).toBe("cleanup-failed");
    expect(events.at(-1)?.data).toMatchObject({
      status: "cleanup-failed",
      error: expect.stringContaining("descendant survived SIGKILL"),
    });
    expect(() => f.manager.create("bob", "remote", "/tmp/process-cleanup-fail")).toThrow("already reserved");
    const callsAfterFailure = f.processes[0].terminateCalls;
    await f.timer.advance(50);
    expect(f.manager.has("alice", jobId)).toBe(true);
    f.processes[0].failTerminateTimes(new Error("descendant still present"), 1);
    await f.manager.close();
    expect(f.processes[0].terminateCalls).toBe(callsAfterFailure + 2);
  });

  test("an unreaped process retains its shared hierarchy reservation", async () => {
    const reservations = new PathReservationCoordinator();
    const f = fixture({ reservations });
    const { jobId } = f.manager.create("alice", "remote", "/tmp/shared-retained/repo");
    await tick();
    f.processes[0].failTerminate(new Error("process survived"));

    expect(await f.manager.cancel("alice", jobId)).toBe("cleanup-failed");
    expect(reservations.acquire(["/tmp/shared-retained"])).toBeUndefined();

    f.processes[0].failTerminateTimes(new Error("still alive"), 1);
    await f.manager.close();
    expect(reservations.acquire(["/tmp/shared-retained"])).toBeDefined();
  });

  test("failed registration rollback after cancellation reports cleanup failure", async () => {
    const f = fixture();
    f.holdStart();
    f.failRemove(new Error("registry is read-only"));
    const events: CloneJobEvent[] = [];
    const { jobId } = f.manager.create("alice", "remote", "/tmp/rollback-fail", { start: true });
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    await tick();
    f.processes[0].exit(0);
    await tick();

    const cancelling = f.manager.cancel("alice", jobId);
    f.releaseHeldStart();

    expect(await cancelling).toBe("cleanup-failed");
    expect(f.registered.has("repo")).toBe(true);
    expect(f.stopped).toEqual(["repo"]);
    expect(events.at(-1)?.data).toMatchObject({
      status: "cleanup-failed",
      error: expect.stringContaining("registry is read-only"),
    });
    expect(() => f.manager.create("bob", "remote", "/tmp/rollback-fail")).not.toThrow();
    await f.manager.close();
  });

  test("shutdown bounds retries for a permanently unreapable process group", async () => {
    const f = fixture();
    const { jobId } = f.manager.create("alice", "remote", "/tmp/unreapable");
    await tick();
    f.processes[0].failTerminate(new Error("zombie process group"));
    expect(await f.manager.cancel("alice", jobId)).toBe("cleanup-failed");
    const callsAfterFailure = f.processes[0].terminateCalls;

    await expect(f.manager.close()).rejects.toThrow("failed to terminate all clone processes");

    expect(f.processes[0].terminateCalls).toBe(callsAfterFailure + 2);
  });

  test("shutdown attempts every process before reporting permanent termination failures", async () => {
    const f = fixture();
    const first = f.manager.create("alice", "remote", "/tmp/unreapable-one");
    const second = f.manager.create("alice", "remote", "/tmp/unreapable-two");
    await tick();
    f.processes[0].failTerminate(new Error("first process group survived"));
    f.processes[1].failTerminate(new Error("second process group survived"));
    expect(await f.manager.cancel("alice", first.jobId)).toBe("cleanup-failed");
    expect(await f.manager.cancel("alice", second.jobId)).toBe("cleanup-failed");
    const callsBeforeClose = f.processes.map(process => process.terminateCalls);

    let failure: unknown;
    try {
      await f.manager.close();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(error => String(error))).toEqual([
      expect.stringContaining("first process group survived"),
      expect.stringContaining("second process group survived"),
    ]);
    expect(f.processes.map(process => process.terminateCalls)).toEqual(callsBeforeClose.map(calls => calls + 2));
  });

  test("rolls registration back on start failure without deleting the target", async () => {
    const f = fixture();
    f.failStart(new Error("no session URL"));
    const events: CloneJobEvent[] = [];
    const { jobId } = f.manager.create("alice", "remote", "/tmp/keep-checkout", { start: true });
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    await tick();
    f.processes[0].exit(0);
    await tick();
    expect(f.removed).toEqual(["repo"]);
    expect(f.registered.size).toBe(0);
    expect(events.at(-1)?.data).toEqual({ status: "start-failed", target: "/tmp/keep-checkout", error: "no session URL" });
  });

  test("does not adopt or roll back a registration created during cloning", async () => {
    const f = fixture();
    const events: CloneJobEvent[] = [];
    const target = "/tmp/already-registered";
    const { jobId } = f.manager.create("alice", "remote", target);
    f.manager.subscribe("alice", jobId, 0, event => events.push(event));
    await tick();
    f.registered.set("existing", { id: "existing", path: target, backend: "local", displayName: "existing" });
    f.processes[0].exit(0);
    await tick();

    expect(f.started).toEqual([]);
    expect(f.removed).toEqual([]);
    expect(f.registered.has("existing")).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({ status: "register-failed", error: expect.stringContaining("already registered") });
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

  test("removes echoed input from live and replay output across chunk boundaries", async () => {
    const f = fixture();
    const { jobId } = f.manager.create("alice", "remote", "/tmp/redacted");
    await tick();
    const live: string[] = [];
    f.manager.subscribe("alice", jobId, 0, event => {
      if (event.type === "output") live.push(event.data.output);
    });
    const secret = "split-response";
    expect(f.manager.input("alice", jobId, secret)).toBe("accepted");
    f.starts[0].onOutput("before split-");
    f.starts[0].onOutput("response after");
    f.processes[0].exit(1);
    await tick();

    expect(live.join("")).toContain("before ");
    expect(live.join("")).toContain(" after");
    expect(live.join("")).not.toContain(secret);
    expect(JSON.stringify(capture(f.manager, "alice", jobId))).not.toContain(secret);
  });

  test.each(["exit", "disconnect"] as const)("drops a possible secret prefix on clone %s", async outcome => {
    const f = fixture();
    const { jobId } = f.manager.create("alice", "remote", `/tmp/redacted-${outcome}`);
    await tick();
    const live: string[] = [];
    f.manager.subscribe("alice", jobId, 0, event => {
      if (event.type === "output") live.push(event.data.output);
    });
    expect(f.manager.input("alice", jobId, "submitted-secret")).toBe("accepted");
    f.starts[0].onOutput("safe output\nsubmitted-sec");

    if (outcome === "exit") {
      f.processes[0].exit(1);
      await tick();
    } else {
      await f.manager.cancel("alice", jobId);
    }

    expect(live.join("")).toBe("safe output\n");
    expect(JSON.stringify(capture(f.manager, "alice", jobId))).not.toContain("submitted-sec");
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

describe("CloneJobManager onboarding coordination", () => {
  test("a successful clone finishes stopped by default with independent names and retained selections", async () => {
    const f = fixture({ onboarding: true });
    const { jobId } = f.manager.create("alice", "remote", "/tmp/payments-service", {
      displayName: "Payments API",
      retainedAuthentication: [{ credentialId: "workspace-auth", host: "github.com" }],
      signing: "sign-key",
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    expect(f.onboardingCalls).toEqual([{
      path: "/tmp/payments-service",
      displayName: "Payments API",
      authentication: [{ credentialId: "workspace-auth", host: "github.com" }],
      signing: "sign-key",
      start: false,
    }]);
    expect(f.started).toEqual([]);
    expect(f.registered.get("repo")?.displayName).toBe("Payments API");
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toEqual({
      status: "succeeded", workspaceId: "repo", target: "/tmp/payments-service", running: false,
    });
  });

  test("the workspace display name defaults from the checkout folder when omitted", async () => {
    const f = fixture({ onboarding: true });
    f.manager.create("alice", "remote", "/tmp/my-checkout");
    await tick();
    f.processes[0].exit(0);
    await tick();
    expect(f.onboardingCalls[0]?.displayName).toBe("my-checkout");
  });

  test("selecting a clone credential retains nothing implicitly", async () => {
    const f = fixture({ onboarding: true });
    const { jobId } = f.manager.create("alice", "git@github.com:acme/repo.git", "/tmp/no-retain", {
      credential: selectedCredential,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    expect(f.onboardingCalls[0]?.authentication).toEqual([]);
    expect(f.onboardingCalls[0]?.signing).toBeNull();
    expect(f.assigned).toEqual([]);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toMatchObject({ status: "succeeded", running: false });
  });

  test("an explicitly requested start runs after commit and reports a running workspace", async () => {
    const f = fixture({ onboarding: true });
    const { jobId } = f.manager.create("alice", "remote", "/tmp/started", { start: true });
    await tick();
    f.processes[0].exit(0);
    await tick();
    expect(f.started).toEqual(["repo"]);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toEqual({
      status: "succeeded", workspaceId: "repo", target: "/tmp/started", running: true,
    });
  });

  test("a failed requested start preserves the committed configuration", async () => {
    const f = fixture({ onboarding: true });
    f.failStart(new Error("assigned credential is locked"));
    const { jobId } = f.manager.create("alice", "remote", "/tmp/preserved", {
      retainedAuthentication: [{ credentialId: "workspace-auth", host: "github.com" }],
      start: true,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    expect(f.registered.has("repo")).toBe(true);
    expect(f.removed).toEqual([]);
    expect(f.assignmentsRemoved).toEqual([]);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toEqual({
      status: "start-failed",
      target: "/tmp/preserved",
      error: "assigned credential is locked",
      workspaceId: "repo",
    });
  });

  test("cancellation during a requested start rolls registration and retained assignments back", async () => {
    const f = fixture({ onboarding: true });
    f.holdStart();
    const { jobId } = f.manager.create("alice", "remote", "/tmp/cancelled", {
      retainedAuthentication: [{ credentialId: "workspace-auth", host: "github.com" }],
      start: true,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    const cancelling = f.manager.cancel("alice", jobId);
    f.releaseHeldStart();
    expect(await cancelling).toBe("cancelled");
    expect(f.assignmentsRemoved).toEqual(["repo"]);
    expect(f.removed).toEqual(["repo"]);
    expect(f.registered.size).toBe(0);
  });

  test("a failed registration removal during cancellation keeps retained assignments intact", async () => {
    const f = fixture({ onboarding: true });
    f.holdStart();
    f.failRemove(new Error("registry is read-only"));
    const { jobId } = f.manager.create("alice", "remote", "/tmp/retained-rollback", {
      retainedAuthentication: [{ credentialId: "workspace-auth", host: "github.com" }],
      start: true,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    const cancelling = f.manager.cancel("alice", jobId);
    f.releaseHeldStart();
    expect(await cancelling).toBe("cleanup-failed");
    // The registration removal failed (and the registry rolled itself
    // back), so the workspace must keep its full committed configuration —
    // never registered with its assignments silently stripped.
    expect(f.registered.has("repo")).toBe(true);
    expect(f.assignmentsRemoved).toEqual([]);
  });

  test("a committed onboarding whose journal fails to clear reports the preserved workspace", async () => {
    const f = fixture({ onboarding: true });
    const committed = { id: "repo", path: "/tmp/committed", backend: "local" as const, displayName: "Repo" };
    f.failOnboarding(new OnboardingError(
      "recovery-required",
      "workspace onboarding committed but its journal could not be cleared; restart the Hub to reconcile",
      { committedEntry: committed },
    ));
    const { jobId } = f.manager.create("alice", "remote", "/tmp/committed", {
      retainedAuthentication: [{ credentialId: "workspace-auth", host: "github.com" }],
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    // Both stores committed; a register-failed here would be false.
    expect(f.registered.has("repo")).toBe(true);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toEqual({
      status: "succeeded", workspaceId: "repo", target: "/tmp/committed", running: false,
    });
  });

  test("a committed journal-clear failure with a requested start reports the stopped workspace", async () => {
    const f = fixture({ onboarding: true });
    const committed = { id: "repo", path: "/tmp/committed-start", backend: "local" as const, displayName: "Repo" };
    f.failOnboarding(new OnboardingError("recovery-required", "journal could not be cleared", { committedEntry: committed }));
    const { jobId } = f.manager.create("alice", "remote", "/tmp/committed-start", { start: true });
    await tick();
    f.processes[0].exit(0);
    await tick();

    expect(f.started).toEqual([]);
    const result = capture(f.manager, "alice", jobId).at(-1)?.data as { status: string; workspaceId?: string };
    expect(result.status).toBe("start-failed");
    expect(result.workspaceId).toBe("repo");
  });

  test("cancellation rollback forgets through the durable personal-state record", async () => {
    // Registry removal and retained-assignment removal must be one
    // recoverable operation: the pending-forget record survives a crash
    // between them and startup recovery finishes the assignment cleanup.
    const f = fixture({ onboarding: true, personalState: true });
    f.holdStart();
    const { jobId } = f.manager.create("alice", "remote", "/tmp/durable-cancel", {
      retainedAuthentication: [{ credentialId: "workspace-auth", host: "github.com" }],
      start: true,
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    const cancelling = f.manager.cancel("alice", jobId);
    f.releaseHeldStart();
    expect(await cancelling).toBe("cancelled");
    expect(f.forgetFlow).toEqual([{ id: "repo", order: ["journal", "registry", "finalize"] }]);
    expect(f.assignmentsRemoved).toEqual(["repo"]);
    expect(f.registered.size).toBe(0);
  });

  test("a coordinator commit failure reports registration failure without a workspace", async () => {
    const f = fixture({ onboarding: true });
    f.failOnboarding(new Error("credential assignment failed: unknown credential"));
    const { jobId } = f.manager.create("alice", "remote", "/tmp/commit-fail", {
      retainedAuthentication: [{ credentialId: "missing", host: "github.com" }],
    });
    await tick();
    f.processes[0].exit(0);
    await tick();

    expect(f.registered.size).toBe(0);
    expect(f.started).toEqual([]);
    expect(capture(f.manager, "alice", jobId).at(-1)?.data).toMatchObject({
      status: "register-failed",
      error: expect.stringContaining("unknown credential"),
    });
  });
});

function capture(manager: CloneJobManager, owner: string, jobId: string): CloneJobEvent[] {
  const events: CloneJobEvent[] = [];
  manager.subscribe(owner, jobId, 0, event => events.push(event));
  return events;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
