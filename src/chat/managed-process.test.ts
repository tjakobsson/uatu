import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { BoundedTextCapture, ManagedProcess, settlesWithin, type SpawnedProcess } from "./managed-process";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

function lockedStream(): ReadableStream<Uint8Array> {
  const locked = stream("held elsewhere");
  locked.getReader();
  return locked;
}

// A child whose response to each signal the test decides.
function fakeChild(onSignal: (signal: NodeJS.Signals | 0, exit: (code: number) => void) => void) {
  const exit = deferred<number | null>();
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  const child: SpawnedProcess = { pid: 4242, exited: exit.promise, kill() { throw new Error("the group is signalled, not the child"); } };
  const killGroup = (pid: number, signal: NodeJS.Signals | 0) => {
    signals.push({ pid, signal });
    onSignal(signal, exit.resolve);
  };
  return { child, signals, killGroup, exit };
}

// Real children this file spawned, each in its own process group. Killed
// here whatever the test did, so a failed readiness read or a termination
// that never settles cannot leave them running.
const spawned: Array<{ pid: number; exited: Promise<unknown> }> = [];

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone: the usual case.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([child.exited, new Promise(resolve => { timer = setTimeout(resolve, 5_000); })]);
    clearTimeout(timer);
  }
});

// Off Windows only: there ManagedProcess signals the child itself, never the
// injected group signaller these fixtures settle through.
describe.skipIf(process.platform === "win32")("ManagedProcess", () => {
  test("SIGTERM to the process group; a child that exits within the grace is never killed", async () => {
    const sleeps: number[] = [];
    const { child, signals, killGroup } = fakeChild((signal, exit) => { if (signal === "SIGTERM") exit(143); });
    // The grace never ends on its own: the exit must win the race.
    const managed = new ManagedProcess(child, { killGroup, termGraceMs: 500, sleep: milliseconds => { sleeps.push(milliseconds); return new Promise(() => {}); } });
    await managed.terminate();
    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(sleeps).toEqual([500]);
  });

  test("a child that outlives the grace period is sent SIGKILL, and termination waits for its exit", async () => {
    let killed = false;
    const { child, signals, killGroup } = fakeChild((signal, exit) => {
      if (signal === "SIGKILL") setTimeout(() => { killed = true; exit(137); }, 0);
    });
    const managed = new ManagedProcess(child, { killGroup, termGraceMs: 500, sleep: async () => {} });
    await managed.terminate();
    expect(signals.map(entry => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(killed).toBe(true);
  });

  test("concurrent and repeated calls join one termination", async () => {
    const { child, signals, killGroup } = fakeChild((signal, exit) => { if (signal === "SIGTERM") exit(143); });
    const managed = new ManagedProcess(child, { killGroup, termGraceMs: 500, sleep: () => new Promise(() => {}) });
    const first = managed.terminate();
    expect(managed.terminate()).toBe(first);
    await Promise.all([first, managed.terminate()]);
    await managed.terminate();
    expect(signals).toHaveLength(1);
  });

  test("termination waits for the capture to drain", async () => {
    let closeOutput!: () => void;
    let drained = false;
    const output = new ReadableStream<Uint8Array>({ start(controller) { closeOutput = () => { drained = true; controller.close(); }; } });
    const capture = new BoundedTextCapture(1024);
    capture.consume(output);
    const { child, killGroup } = fakeChild((signal, exit) => {
      if (signal !== "SIGTERM") return;
      exit(143);
      setTimeout(closeOutput, 0);
    });
    const managed = new ManagedProcess(child, { capture, killGroup, termGraceMs: 500, sleep: () => new Promise(() => {}) });
    expect(managed.capture).toBe(capture);
    await managed.terminate();
    expect(drained).toBe(true);
  });

  test("a child already gone when signalled does not fail termination", async () => {
    const exit = deferred<number | null>();
    const managed = new ManagedProcess({ pid: 4242, exited: exit.promise, kill() {} }, {
      killGroup: () => {
        exit.resolve(0);
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
      termGraceMs: 500,
      sleep: () => new Promise(() => {}),
    });
    await managed.terminate();
  });

  // A per-conversation stdio child is spawned with piped stdin; nothing
  // here assumes the child's stdin is ignored.
  test("stops a real piped-stdin child in its own group, escalating past an ignored SIGTERM", async () => {
    for (const script of ["trap '' TERM; echo ready; while :; do sleep 1; done", "echo ready; exec sleep 30"]) {
      const child = Bun.spawn(["/bin/sh", "-c", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
      spawned.push(child);
      // Signal only once the shell has installed its trap and said so.
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      reader.releaseLock();
      const capture = new BoundedTextCapture(1024);
      capture.consume(child.stderr);
      const ignoresTerm = script.startsWith("trap");
      // The cooperative child's own exit ends its grace, never a timer; the
      // one that ignores SIGTERM gets a short real grace.
      const managed = new ManagedProcess(child, ignoresTerm
        ? { capture, termGraceMs: 200 }
        : { capture, termGraceMs: 200, sleep: () => child.exited.then(() => undefined) });
      await managed.terminate();
      expect(child.signalCode).toBe(ignoresTerm ? "SIGKILL" : "SIGTERM");
    }
  }, 15_000);
});

// A group whose leader and remaining members the test controls: signal 0
// reports whether any member is left, as `kill(-pid, 0)` does.
function fakeGroup(onSignal: (signal: NodeJS.Signals, group: { exitLeader(code: number): void; emptyGroup(): void }) => void) {
  const exit = deferred<number | null>();
  let members = true;
  const signals: Array<NodeJS.Signals | 0> = [];
  const group = { exitLeader: (code: number) => exit.resolve(code), emptyGroup: () => { members = false; } };
  const killGroup = (_pid: number, signal: NodeJS.Signals | 0) => {
    if (signal === 0) {
      if (!members) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      return;
    }
    signals.push(signal);
    onSignal(signal, group);
  };
  const child: SpawnedProcess = { pid: 4242, exited: exit.promise, kill() { throw new Error("the group is signalled, not the child"); } };
  return { child, killGroup, signals: () => signals };
}

const WORKER = "trap '' TERM; echo worker-stderr >&2; echo worker-ready; while :; do sleep 1; done";
// The leader exits on SIGTERM; its worker, in the same group, ignores it and
// holds the leader's stderr open.
const LEADER = `/bin/sh -c "${WORKER}" & wait`;

// Hands `source` to a capture one chunk per read. `arrived` settles on the
// first read after `text` was handed over, so the capture has stored those
// bytes; `ended` says the source closed by itself, `cancelled` that the
// capture gave up on it.
function observed(source: ReadableStream<Uint8Array>, text: string) {
  const reader = source.getReader();
  let seen = "";
  let arrive!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const state = { ended: false, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (seen.includes(text)) arrive();
      const { value, done } = await reader.read();
      if (done) {
        state.ended = true;
        controller.close();
        return;
      }
      seen += new TextDecoder().decode(value);
      controller.enqueue(value);
    },
    cancel(reason) {
      state.cancelled = true;
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return { stream, arrived, state };
}

async function readUntil(stream: ReadableStream<Uint8Array>, text: string): Promise<void> {
  const reader = stream.getReader();
  let seen = "";
  while (!seen.includes(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${JSON.stringify(text)}; saw ${JSON.stringify(seen)}`);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
}

describe.skipIf(process.platform === "win32")("ManagedProcess group escalation", () => {
  test("by default only the leader decides: a leader gone on SIGTERM is not followed by SIGKILL", async () => {
    const { child, killGroup, signals } = fakeGroup((signal, group) => { if (signal === "SIGTERM") group.exitLeader(143); });
    await new ManagedProcess(child, { killGroup, termGraceMs: 500, sleep: () => new Promise(() => {}) }).terminate();
    expect(signals()).toEqual(["SIGTERM"]);
  });

  test("group mode kills a group that outlives its leader once the grace ends", async () => {
    const sleeps: number[] = [];
    const { child, killGroup, signals } = fakeGroup((signal, group) => {
      if (signal === "SIGTERM") group.exitLeader(143);
      if (signal === "SIGKILL") group.emptyGroup();
    });
    await new ManagedProcess(child, { killGroup, termGraceMs: 500, escalation: "group", sleep: async milliseconds => { sleeps.push(milliseconds); } }).terminate();
    expect(signals()).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sleeps[0]).toBe(500);
  });

  test("group mode stops at SIGTERM when the whole group leaves within the grace", async () => {
    const { child, killGroup, signals } = fakeGroup((signal, group) => {
      if (signal !== "SIGTERM") return;
      group.emptyGroup();
      group.exitLeader(143);
    });
    await new ManagedProcess(child, { killGroup, termGraceMs: 500, escalation: "group", sleep: () => new Promise(() => {}) }).terminate();
    expect(signals()).toEqual(["SIGTERM"]);
  });

  test("group mode ends even when nothing exits and the capture never drains", async () => {
    const capture = new BoundedTextCapture(1024);
    capture.consume(new ReadableStream<Uint8Array>({ start() {} }));
    const { child, killGroup, signals } = fakeGroup(() => {});
    await new ManagedProcess(child, { capture, killGroup, termGraceMs: 500, escalation: "group", sleep: async () => {} }).terminate();
    expect(signals()).toEqual(["SIGTERM", "SIGKILL"]);
    // Released at its deadline, so nothing is left waiting on it.
    await capture.done;
  });

  test("group mode ends even when the stream's own cancellation never settles", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => new Promise<void>(() => {}),
    }, { highWaterMark: 0 });
    const capture = new BoundedTextCapture(1024);
    capture.consume(stream);
    const { child, killGroup } = fakeGroup(() => {});
    await new ManagedProcess(child, { capture, killGroup, termGraceMs: 500, escalation: "group", sleep: async () => {} }).terminate();
    await capture.done;
    expect(stream.locked).toBe(false);
  });

  test("a real leader that exits on SIGTERM leaves a worker holding stderr; group mode kills it and drains", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", LEADER], { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
    spawned.push(child);
    await readUntil(child.stdout, "worker-ready");
    const stderr = observed(child.stderr, "worker-stderr");
    const capture = new BoundedTextCapture(1024);
    capture.consume(stderr.stream);
    await stderr.arrived;
    const release = spyOn(capture, "release");
    const signals: Array<NodeJS.Signals | 0> = [];
    const killGroup = (pid: number, signal: NodeJS.Signals | 0) => {
      if (signal !== 0) signals.push(signal);
      process.kill(-pid, signal);
    };
    // The grace ends only once the leader has exited, so SIGKILL can reach
    // nothing but the worker; the bounds after it are generous, so the
    // worker's actual end of stderr, not a timer, decides the drain.
    let sleeps = 0;
    const sleep = () => sleeps++ === 0
      ? child.exited.then(() => undefined)
      : new Promise<void>(resolve => { (setTimeout(resolve, 60_000) as unknown as { unref?: () => void }).unref?.(); });
    await new ManagedProcess(child, { capture, killGroup, sleep, termGraceMs: 200, escalation: "group" }).terminate();
    expect(child.signalCode).toBe("SIGTERM");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    // Drained, not released at the deadline: the worker's stderr closed
    // because SIGKILL reached it.
    expect(stderr.state).toEqual({ ended: true, cancelled: false });
    expect(release).not.toHaveBeenCalled();
    expect(capture.snapshot()).toBe("worker-stderr");
  }, 15_000);

  test("a real worker SIGKILL cannot reach bounds termination and releases its stderr pipe", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", LEADER], { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
    spawned.push(child);
    await readUntil(child.stdout, "worker-ready");
    const capture = new BoundedTextCapture(1024);
    capture.consume(child.stderr);
    let drained = false;
    void capture.done.then(() => { drained = true; });
    // Models a member that left the group: its SIGKILL never arrives. The
    // afterEach hook kills it.
    const killGroup = (pid: number, signal: NodeJS.Signals | 0) => { if (signal !== "SIGKILL") process.kill(-pid, signal); };
    await new ManagedProcess(child, { capture, killGroup, termGraceMs: 200, escalation: "group" }).terminate();
    // The worker still runs, yet nothing reads or holds its stderr any more.
    expect(process.kill(-child.pid, 0)).toBe(true);
    expect(drained).toBe(true);
    expect(child.stderr.locked).toBe(false);
    // Termination can return before Bun has reported the leader's exit.
    await child.exited;
    expect(child.signalCode).toBe("SIGTERM");
  }, 15_000);
});

describe("settlesWithin", () => {
  test("a settled promise, either way, wins; a pending one loses to the sleep", async () => {
    const never = () => new Promise<void>(() => {});
    expect(await settlesWithin(Promise.resolve(1), 10, never)).toBe(true);
    expect(await settlesWithin(Promise.reject(new Error("exit failed")), 10, never)).toBe(true);
    expect(await settlesWithin(new Promise(() => {}), 10, async () => {})).toBe(false);
  });
});

describe("BoundedTextCapture", () => {
  test("release stops reading an open stream, unlocks it and keeps what was collected", async () => {
    let pulls = 0;
    let secondPull!: () => void;
    const pulledAgain = new Promise<void>(resolve => { secondPull = resolve; });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        // The first read gets bytes; the next proves they were stored and
        // then never answers, as a pipe a live writer holds open.
        if (pulls === 1) controller.enqueue(new TextEncoder().encode("before"));
        else secondPull();
        return pulls === 1 ? undefined : new Promise<void>(() => {});
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const capture = new BoundedTextCapture(1024);
    capture.consume(stream);
    await pulledAgain;
    capture.release();
    await capture.done;
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
    expect(capture.snapshot()).toBe("before");
  });

  test("a read answered just before release adds nothing afterwards", async () => {
    let pulls = 0;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let secondPull!: () => void;
    const pulledAgain = new Promise<void>(resolve => { secondPull = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        source = controller;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode("before"));
        else secondPull();
        return pulls === 1 ? undefined : new Promise<void>(() => {});
      },
    }, { highWaterMark: 0 });
    const capture = new BoundedTextCapture(1024);
    capture.consume(stream);
    // "before" is stored and the next read is waiting.
    await pulledAgain;
    // Answer that read, then release before its continuation can run.
    source.enqueue(new TextEncoder().encode("after"));
    capture.release();
    expect(capture.snapshot()).toBe("before");
    await Promise.resolve();
    await capture.done;
    expect(capture.snapshot()).toBe("before");
  });

  test("release is terminal: a stream consumed afterwards is cancelled, never locked or read", async () => {
    let cancelled = false;
    let pulled = false;
    const late = new ReadableStream<Uint8Array>({
      pull() { pulled = true; return new Promise<void>(() => {}); },
      // Never settles: consume() must not wait on it.
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 });
    const capture = new BoundedTextCapture(1024);
    capture.release();
    capture.consume(late);
    await capture.done;
    expect(late.locked).toBe(false);
    expect(cancelled).toBe(true);
    expect(pulled).toBe(false);
    expect(capture.snapshot()).toBe("");
  });

  test("a second stream is cancelled, never locked or read, and release still frees the first", async () => {
    let firstPulls = 0;
    let firstCancelled = false;
    let secondPull!: () => void;
    const pulledAgain = new Promise<void>(resolve => { secondPull = resolve; });
    const first = new ReadableStream<Uint8Array>({
      pull(controller) {
        firstPulls += 1;
        if (firstPulls === 1) controller.enqueue(new TextEncoder().encode("first"));
        else secondPull();
        return firstPulls === 1 ? undefined : new Promise<void>(() => {});
      },
      cancel() { firstCancelled = true; },
    }, { highWaterMark: 0 });
    let secondPulled = false;
    let secondCancelled = false;
    const second = new ReadableStream<Uint8Array>({
      pull() { secondPulled = true; return new Promise<void>(() => {}); },
      // Never settles: consume() must not wait on it.
      cancel() { secondCancelled = true; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 });
    const capture = new BoundedTextCapture(1024);
    let drained = false;
    void capture.done.then(() => { drained = true; });
    capture.consume(first);
    // "first" is stored and its next read is pending.
    await pulledAgain;
    capture.consume(second);
    expect(second.locked).toBe(false);
    expect(secondCancelled).toBe(true);
    expect(secondPulled).toBe(false);
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(capture.snapshot()).toBe("first");
    // Shutdown reaches the stream the capture actually reads.
    capture.release();
    await capture.done;
    expect(firstCancelled).toBe(true);
    expect(first.locked).toBe(false);
    expect(capture.snapshot()).toBe("first");
  });

  test("a stream that is already locked yields nothing and still settles", async () => {
    const stream = lockedStream();
    const capture = new BoundedTextCapture(1024);
    expect(() => capture.consume(stream)).not.toThrow();
    await capture.done;
    expect(capture.snapshot()).toBe("");
    capture.release();
  });

  test("release settles a capture that never got a stream", async () => {
    const capture = new BoundedTextCapture(1024);
    capture.release();
    await capture.done;
  });

  test("keeps the last limit bytes of a stream", async () => {
    const capture = new BoundedTextCapture(8);
    capture.consume(stream("prefix-", "x".repeat(20), "-tail"));
    await capture.done;
    expect(capture.snapshot()).toBe("xxx-tail");
  });

  test("strips control characters other than tab, newline and carriage return, then trims", async () => {
    const capture = new BoundedTextCapture(1024);
    capture.consume(stream("  \u001b[31mred\u0007\tone\r\ntwo\u0000  \n"));
    await capture.done;
    expect(capture.snapshot()).toBe("[31mred\tone\r\ntwo");
  });

  test("the scrubber sees the decoded text and its result is the snapshot", async () => {
    const seen: string[] = [];
    const capture = new BoundedTextCapture(1024, text => { seen.push(text); return text.replaceAll("hunter2", "[redacted]"); });
    capture.consume(stream("password=hunter2\n"));
    await capture.done;
    expect(capture.snapshot()).toBe("password=[redacted]");
    expect(seen).toEqual(["password=hunter2"]);
  });

  test("close settles a capture that never gets a stream, and a failing stream keeps what it delivered", async () => {
    const unused = new BoundedTextCapture(1024);
    unused.close();
    await unused.done;
    expect(unused.snapshot()).toBe("");

    const failing = new BoundedTextCapture(1024);
    failing.consume(new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("before"));
        controller.error(new Error("pipe broke"));
      },
    }));
    await failing.done;
    expect(failing.snapshot()).toBe("before");
  });
});
