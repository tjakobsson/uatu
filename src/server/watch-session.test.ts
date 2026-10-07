import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";

import { MetricsRegistry } from "../debug/metrics";
import { activeGauge, closedCounter, openedCounter, reconnectedCounter } from "../debug/stream-metrics";
import { WORKSPACE_API_REVISION } from "../shared/version";
import { DocumentStateIndex, type DocumentUpdate, type DocumentSnapshot } from "../shared/document-updates";
import { resolveWatchRoots } from "./roots";
import {
  createRefreshScheduler,
  createWatchSession,
  DOCUMENT_KEEPALIVE_MS,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
} from "./watch-session";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("initial document state", () => {
  test("returns a well-formed payload with no startupMode field", () => {
    const payload = createWatchSession([], true).getStatePayload();
    expect("startupMode" in payload).toBe(false);
    expect(payload.initialFollow).toBe(true);
    expect(payload.scope).toEqual({ kind: "folder" });
    expect(payload.workspaceApiRevision).toBe(WORKSPACE_API_REVISION);
  });

  test("carries no config payload fields", () => {
    // `.uatu.json` no longer carries presentation config; the payload must
    // not resurrect the retired fields.
    const payload = createWatchSession([], true, { terminalEnabled: true }).getStatePayload();
    expect("monoConfig" in payload).toBe(false);
    expect("terminalConfig" in payload).toBe(false);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  if (!predicate()) {
    throw new Error("condition not met within timeout");
  }
}

async function readSseFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE frame timeout")), 3000)),
  ]);
  if (result.done || !result.value) throw new Error("SSE stream ended");
  return new TextDecoder().decode(result.value);
}

const streamStates = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, DocumentStateIndex>();
async function readSsePayload(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<DocumentSnapshot> {
  let index = streamStates.get(reader);
  if (!index) streamStates.set(reader, index = new DocumentStateIndex());
  for (;;) {
    const text = await readSseFrame(reader);
    if (text.startsWith(":")) continue;
    const data = JSON.parse(text.split("data: ").at(-1)!.trim()) as DocumentUpdate;
    // A context normalization is delivered as a fresh baseline.
    if (data.kind === "snapshot") streamStates.set(reader, index = new DocumentStateIndex());
    expect(index.apply(data)).toBe("applied");
    if (data.kind === "patch" && !data.upserts.length && !data.removals.length) continue;
    return index.snapshot()!;
  }
}

describe("watchSession scope", () => {
  test("different callers project folder and file scopes without mutating each other", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-pin-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const guide = path.join(tempDirectory, "guide.md");
    await writeFile(readme, "# Readme\n");
    await writeFile(guide, "# Guide\n");

    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true },
    );

    try {
      await session.start();
      await waitUntil(() => session.getRoots().some(root => root.docs.length >= 2));

      const pinned = { scope: { kind: "file" as const, documentId: readme }, compareTarget: "base" as const };
      const folder = { scope: { kind: "folder" as const }, compareTarget: "last-commit" as const };
      expect(session.getRoots(pinned).flatMap(root => root.docs).map(doc => doc.id)).toEqual([readme]);
      expect(session.getRoots(folder).flatMap(root => root.docs).map(doc => doc.id).sort()).toEqual([guide, readme].sort());
      expect(session.getStatePayload(null, pinned).scope).toEqual(pinned.scope);
      expect(session.getStatePayload(null, folder).compareTarget).toBe("last-commit");
    } finally {
      await session.stop();
    }
  });

  test("concurrent SSE subscribers retain independent contexts after refresh", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-context-sse-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const guide = path.join(tempDirectory, "guide.md");
    await writeFile(readme, "# Readme\n");
    await writeFile(guide, "# Guide\n");
    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true },
    );

    try {
      await session.start();
      const pinnedContext = { scope: { kind: "file" as const, documentId: readme }, compareTarget: "last-commit" as const };
      const folderContext = { scope: { kind: "folder" as const }, compareTarget: "base" as const };
      const pinnedReader = session.eventsResponse(pinnedContext).body!.getReader();
      const folderReader = session.eventsResponse(folderContext).body!.getReader();
      const [pinnedInitial, folderInitial] = await Promise.all([
        readSsePayload(pinnedReader),
        readSsePayload(folderReader),
      ]);
      expect(pinnedInitial.scope).toEqual(pinnedContext.scope);
      expect(pinnedInitial.compareTarget).toBe("last-commit");
      expect(pinnedInitial.roots.flatMap(root => root.docs).map(doc => doc.id)).toEqual([readme]);
      expect(folderInitial.scope).toEqual(folderContext.scope);
      expect(folderInitial.compareTarget).toBe("base");
      expect(folderInitial.roots.flatMap(root => root.docs)).toHaveLength(2);

      await writeFile(readme, "# Readme changed\n");
      const [pinnedRefresh, folderRefresh] = await Promise.all([
        readSsePayload(pinnedReader),
        readSsePayload(folderReader),
      ]);
      expect(pinnedRefresh.scope).toEqual(pinnedContext.scope);
      expect(pinnedRefresh.compareTarget).toBe("last-commit");
      expect(folderRefresh.scope).toEqual(folderContext.scope);
      expect(folderRefresh.compareTarget).toBe("base");
      await Promise.all([pinnedReader.cancel(), folderReader.cancel()]);
    } finally {
      await session.stop();
    }
  });

  test("an idle document stream emits keepalive comments and no state events", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-keepalive-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true, keepaliveIntervalMs: 20 },
    );

    try {
      await session.start();
      const reader = session.eventsResponse().body!.getReader();
      const initial = await readSseFrame(reader);
      expect(initial.startsWith("event: state")).toBe(true);

      // Nothing on disk changes, so every subsequent frame must be a comment.
      for (let index = 0; index < 3; index += 1) {
        const frame = await readSseFrame(reader);
        expect(frame).toBe(": keepalive\n\n");
      }
      await reader.cancel();
    } finally {
      await session.stop();
    }
  });

  test("cancelling a document stream releases its subscriber and stops its keepalive", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-keepalive-cancel-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true, keepaliveIntervalMs: 10 },
    );

    try {
      await session.start();
      const reader = session.eventsResponse().body!.getReader();
      await readSseFrame(reader);
      expect(session.getSseSubscriberCount()).toBe(1);
      await reader.cancel();
      expect(session.getSseSubscriberCount()).toBe(0);
      // A leaked interval would keep enqueueing into a released controller;
      // the count staying at zero across several cadences proves it stopped.
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(session.getSseSubscriberCount()).toBe(0);
    } finally {
      await session.stop();
    }
  });

  test("stopping the session releases keepalive timers for every subscriber", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-keepalive-stop-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true, keepaliveIntervalMs: 10 },
    );

    await session.start();
    const reader = session.eventsResponse().body!.getReader();
    await readSseFrame(reader);
    await session.stop();
    expect(session.getSseSubscriberCount()).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(session.getSseSubscriberCount()).toBe(0);
    await reader.cancel().catch(() => undefined);
  });

  test("document stream metrics move through open, reconnect, and release", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-stream-metrics-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    const metrics = new MetricsRegistry();
    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true, metrics },
    );

    try {
      await session.start();
      const first = session.eventsResponse().body!.getReader();
      await readSseFrame(first);
      expect(metrics.get(openedCounter("document"))).toBe(1);
      expect(metrics.get(activeGauge("document"))).toBe(1);
      expect(metrics.get(reconnectedCounter("document"))).toBe(0);

      // The same client coming back after losing its stream.
      const second = session.eventsResponse(undefined, { reconnect: true }).body!.getReader();
      await readSseFrame(second);
      expect(metrics.get(openedCounter("document"))).toBe(2);
      expect(metrics.get(reconnectedCounter("document"))).toBe(1);
      expect(metrics.get(activeGauge("document"))).toBe(2);

      await first.cancel();
      expect(metrics.get(closedCounter("document", "cancelled"))).toBe(1);
      expect(metrics.get(activeGauge("document"))).toBe(1);

      await session.stop();
      // The workspace shutting the stream down is a completion, not a client
      // cancellation — the distinction is the point of separate counters.
      expect(metrics.get(closedCounter("document", "completed"))).toBe(1);
      expect(metrics.get(activeGauge("document"))).toBe(0);
      await second.cancel().catch(() => undefined);
    } finally {
      await session.stop();
    }
  });

  test("the production keepalive cadence matches the Chat streams", () => {
    expect(DOCUMENT_KEEPALIVE_MS).toBe(15_000);
  });

  test("file scopes reject unknown, ignored, secret-like, and binary document ids", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-pin-invalid-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const ignored = path.join(tempDirectory, "ignored.txt");
    const secret = path.join(tempDirectory, ".env.local");
    const binary = path.join(tempDirectory, "logo.png");
    await writeFile(
      path.join(tempDirectory, ".uatu.json"),
      JSON.stringify({ ignore: { exclude: ["ignored.txt"] } }),
    );
    await writeFile(readme, "# Readme\n");
    await writeFile(ignored, "ignored\n");
    await writeFile(secret, "TOKEN=secret\n");
    await writeFile(binary, "not really png");

    const session = createWatchSession([{ kind: "dir", absolutePath: tempDirectory }], false, { collectRepositories: async () => [] });
    try {
      await session.start();
      const pinned = (id: string) => session.getStatePayload(null, { scope: { kind: "file", documentId: id }, compareTarget: "base" }).scope.kind === "file";
      expect(pinned(readme)).toBe(true);
      for (const id of [path.join(tempDirectory, "missing.md"), ignored, secret, binary]) expect(pinned(id)).toBe(false);
    } finally { await session.stop(); }
  });

  test("an SSE pin stays widened after its file is unlinked and recreated", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-pin-unlink-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const guide = path.join(tempDirectory, "guide.md");
    await writeFile(readme, "# Readme\n");
    await writeFile(guide, "# Guide\n");

    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true },
    );

    try {
      await session.start();
      await waitUntil(() => session.getRoots().some(root => root.docs.length >= 2));

      const pinned = { scope: { kind: "file" as const, documentId: readme }, compareTarget: "base" as const };
      const reader = session.eventsResponse(pinned).body!.getReader();
      expect((await readSsePayload(reader)).scope).toEqual(pinned.scope);

      await unlink(readme);
      await waitUntil(() => session.getUnscopedRoots().flatMap(root => root.docs).every(doc => doc.id !== readme));
      const widened = await readSsePayload(reader);
      expect(widened.scope).toEqual({ kind: "folder" });
      expect(widened.roots.flatMap(root => root.docs).some(doc => doc.id === guide)).toBe(true);

      await writeFile(readme, "# Readme recreated\n");
      await waitUntil(() => session.getUnscopedRoots().flatMap(root => root.docs).some(doc => doc.id === readme));
      const recreated = await readSsePayload(reader);
      expect(recreated.scope).toEqual({ kind: "folder" });
      expect(recreated.roots.flatMap(root => root.docs).map(doc => doc.id).sort()).toEqual([guide, readme].sort());
      await reader.cancel();
    } finally {
      await session.stop();
    }
  });

  test("editing .uatu.json ignore.exclude at runtime reapplies the new patterns", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-ignore-live-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const lockfile = path.join(tempDirectory, "package-lock.json");
    const uatuJson = path.join(tempDirectory, ".uatu.json");
    await writeFile(readme, "# Readme\n");
    await writeFile(lockfile, "{}\n");
    await writeFile(uatuJson, JSON.stringify({ ignore: { exclude: [] } }));

    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true },
    );

    try {
      await session.start();
      await waitUntil(() =>
        session.getRoots().flatMap(root => root.docs).some(doc => doc.id === lockfile),
      );

      await writeFile(uatuJson, JSON.stringify({ ignore: { exclude: ["package-lock.json"] } }));
      await waitUntil(
        () => session.getRoots().flatMap(root => root.docs).every(doc => doc.id !== lockfile),
        4000,
      );

      await writeFile(uatuJson, JSON.stringify({ ignore: { exclude: [] } }));
      await waitUntil(
        () => session.getRoots().flatMap(root => root.docs).some(doc => doc.id === lockfile),
        4000,
      );
    } finally {
      await session.stop();
    }
  });
});

// A deterministic replacement for the scheduler clock (performance.now/
// setTimeout in production): timers fire in
// timestamp order as the clock is advanced, with `now` reflecting each
// timer's due time while its callback runs.
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  return {
    clock: {
      now: () => now,
      setTimer(fn: () => void, delayMs: number) {
        const id = nextId++;
        timers.set(id, { at: now + delayMs, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer(timer: ReturnType<typeof setTimeout>) {
        timers.delete(timer as unknown as number);
      },
    },
    advanceTo(target: number) {
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

describe("createRefreshScheduler", () => {
  test("a short burst that ends before the debounce elapses fires exactly once", () => {
    const { clock, advanceTo } = createFakeClock();
    const fires: Array<{ at: number; changedId: string | null }> = [];
    const scheduler = createRefreshScheduler(
      changedId => fires.push({ at: clock.now(), changedId }),
      clock,
    );

    for (const at of [0, 100, 200]) {
      advanceTo(at);
      scheduler.schedule(`file-${at}`);
    }
    advanceTo(1000);

    expect(fires).toEqual([{ at: 200 + REFRESH_DEBOUNCE_MS, changedId: "file-200" }]);
  });

  test("a sustained sub-debounce event stream refreshes within the max-wait bound", () => {
    const { clock, advanceTo } = createFakeClock();
    const fires: Array<{ at: number; changedId: string | null }> = [];
    const scheduler = createRefreshScheduler(
      changedId => fires.push({ at: clock.now(), changedId }),
      clock,
    );

    // Events every 100 ms for 5 s — each one faster than the 150 ms trailing
    // debounce, so without the cap no refresh would ever fire mid-stream.
    let batchStartedAt: number | null = null;
    const batchStarts: number[] = [];
    let fired = 0;
    for (let at = 0; at < 5000; at += 100) {
      advanceTo(at);
      if (fires.length > fired) {
        fired = fires.length;
        batchStartedAt = null;
      }
      if (batchStartedAt === null) {
        batchStartedAt = at;
        batchStarts.push(at);
      }
      scheduler.schedule(`file-${at}`);
    }
    advanceTo(10_000);

    // Two capped refreshes during the churn, one trailing refresh after it.
    expect(fires.map(fire => fire.at)).toEqual([
      REFRESH_MAX_WAIT_MS,
      2 * REFRESH_MAX_WAIT_MS,
      4900 + REFRESH_DEBOUNCE_MS,
    ]);
    // Every refresh lands within the bound of its batch's first event.
    for (const [index, fire] of fires.entries()) {
      expect(fire.at - batchStarts[index]!).toBeLessThanOrEqual(REFRESH_MAX_WAIT_MS);
    }
    // Last-writer-wins nomination is preserved across the capped fires.
    expect(fires.map(fire => fire.changedId)).toEqual(["file-1900", "file-3900", "file-4900"]);
  });

  test("cancel discards the pending timer and nomination", () => {
    const { clock, advanceTo } = createFakeClock();
    const fires: Array<string | null> = [];
    const scheduler = createRefreshScheduler(changedId => fires.push(changedId), clock);

    scheduler.schedule("file-a");
    scheduler.cancel();
    advanceTo(10_000);
    expect(fires).toEqual([]);

    // A schedule after cancel starts a fresh batch with a fresh nomination.
    scheduler.schedule(null);
    advanceTo(20_000);
    expect(fires).toEqual([null]);
  });
});

describe("createWatchSession watcher resilience", () => {
  test("a synthetic EINVAL on the underlying watcher does not crash the host", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-watcher-resilience-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");

    const entries = await resolveWatchRoots([tempDirectory], tempDirectory);
    const session = createWatchSession(entries, true, { respectGitignore: false });
    await session.start();

    try {
      const internal = (session as unknown as {
        _internalWatcher(): NodeJS.EventEmitter | null;
      })._internalWatcher();
      expect(internal).not.toBeNull();

      const synthetic = Object.assign(new Error("synthetic EINVAL on .git/index.lock"), {
        code: "EINVAL",
        errno: -22,
      });
      expect(() => internal!.emit("error", synthetic)).not.toThrow();
      expect(session.getRoots()).toBeDefined();
    } finally {
      await session.stop();
    }
  });
});

test("a slow classification cannot publish after stop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-ordered-"));
  tempDirectories.push(dir);
  const file = path.join(dir, "a.unknown");
  await writeFile(file, "# A\n");
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const session = createWatchSession([{ kind: "dir", absolutePath: dir }], false, {
    classify: async () => {
      if (++calls >= 2) await gate;
      return "text";
    },
  });
  try {
    await session.start();
    const before = session.getStatePayload();
    expect(calls).toBe(1);
    session._internalWatcher()!.emit("all", "change", file);
    await waitUntil(() => calls >= 2);
    await session.stop();
    release();
    await gate;
    await Promise.resolve();
    expect(session.getRoots()).toEqual(before.roots);
    expect(calls).toBeGreaterThanOrEqual(2);
  } finally {
    release();
    await session.stop();
  }
});

test("failed recovery retains the allowed inventory and concurrent retries share one replacement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-recovery-"));
  tempDirectories.push(dir);
  const file = path.join(dir, "README.md");
  await writeFile(file, "# Retained\n");
  let refuse = false;
  let observations = 0;
  const session = createWatchSession([{ kind: "dir", absolutePath: dir }], false, {
    usePolling: true, collectRepositories: async () => [],
    watch: (...args: Parameters<typeof chokidar.watch>) => {
      observations++;
      if (refuse) throw new Error("controlled observation failure");
      return chokidar.watch(...args);
    },
  });
  try {
    await session.start();
    const before = session.getRoots();
    refuse = true;
    await expect(session.recover()).rejects.toThrow("controlled observation failure");
    expect(session.getRoots()).toEqual(before);
    expect(session.getStatePayload().discovery.status).toBe("error");
    refuse = false;
    await Promise.all([session.recover(), session.recover()]);
    expect(observations).toBe(3);
    expect(session.getStatePayload().discovery.status).toBe("ready");
    expect(session.findDocument(file)?.name).toBe("README.md");
  } finally { await session.stop(); }
});

test("a policy edit during recovery is applied before recovery settles", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-policy-recovery-"));
  tempDirectories.push(dir);
  const file = path.join(dir, "notes.md");
  const config = path.join(dir, ".uatu.json");
  await writeFile(file, "# Notes\n");
  await writeFile(config, JSON.stringify({ ignore: { exclude: [] } }));
  const replacementReady = Promise.withResolvers<void>();
  let releaseReplacement = () => {};
  let observations = 0;
  const session = createWatchSession([{ kind: "dir", absolutePath: dir }], false, {
    usePolling: true, collectRepositories: async () => [],
    watch: (...args: Parameters<typeof chokidar.watch>) => {
      const watcher = chokidar.watch(...args);
      if (++observations === 2) {
        const emit = watcher.emit.bind(watcher);
        watcher.emit = (event, ...values) => {
          if (event === "ready") {
            releaseReplacement = () => { emit(event, ...values); };
            replacementReady.resolve();
            return true;
          }
          return emit(event, ...values);
        };
      }
      return watcher;
    },
  });
  try {
    await session.start();
    const original = session._internalWatcher()!;
    await writeFile(config, JSON.stringify({ ignore: { exclude: ["notes.md"] } }));
    const recovery = session.recover();
    await replacementReady.promise;
    expect(session.findDocument(file)).toBeUndefined();
    await writeFile(config, JSON.stringify({ ignore: { exclude: [] } }));
    // Deliver the newer policy event while the replacement's ready callback
    // is held, rather than racing the watcher against a fixed delay.
    original.emit("all", "change", config);
    releaseReplacement();
    await recovery;
    expect(session.getDiscoveryState().status).toBe("ready");
    expect(session.findDocument(file)?.name).toBe("notes.md");
    expect(observations).toBeGreaterThanOrEqual(3);
  } finally {
    releaseReplacement();
    await session.stop();
  }
}, 15000);

test("repository failure preserves file progress for scoped subscribers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-complete-"));
  tempDirectories.push(dir);
  const file = path.join(dir, "a.md");
  await writeFile(file, "# A\n");
  let fail = false;
  const repoGate = Promise.withResolvers<void>();
  let collecting = false;
  const session = createWatchSession([{ kind: "dir", absolutePath: dir }], false, {
    collectRepositories: async (_entries, _roots, target) => {
      if (fail) {
        collecting = true;
        if (target === "base") throw new Error("controlled repository failure");
        await repoGate.promise;
      }
      return [];
    },
  });
  try {
    await session.start();
    await waitUntil(() => session.getStatePayload().repositoryState.status === "ready");
    const before = session.getStatePayload();
    const context = { scope: { kind: "file" as const, documentId: file }, compareTarget: "last-commit" as const };
    const pinned = session.eventsResponse(context).body!.getReader();
    const folder = session.eventsResponse().body!.getReader();
    await Promise.all([readSsePayload(pinned), readSsePayload(folder)]);
    fail = true;
    session._internalWatcher()!.emit("all", "change", file);
    await waitUntil(() => collecting);
    session._internalWatcher()!.emit("all", "change", file);
    const [scoped, unscoped] = await Promise.all([readSsePayload(pinned), readSsePayload(folder)]);
    expect(scoped.scope).toEqual(context.scope);
    expect(scoped.compareTarget).toBe("last-commit");
    expect(unscoped.scope).toEqual({ kind: "folder" });
    expect(scoped.roots[0]!.docs[0]!.revision).toBeGreaterThan(before.roots[0]!.docs[0]!.revision);
    expect(unscoped.roots).toEqual(scoped.roots);
    expect(unscoped.changedId).toBe(file);
    fail = false;
    repoGate.resolve();
    await Promise.all([pinned.cancel(), folder.cancel()]);
  } finally {
    repoGate.resolve();
    await session.stop();
  }
});
