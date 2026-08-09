import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { IgnoreMatcher } from "../ignore/engine";
import { resolveWatchRoots, scanRoots } from "./roots";
import {
  attachWatcherCrashGuard,
  buildWatcherIgnorePredicate,
  canSetFileScope,
  createRefreshScheduler,
  createStatePayload,
  createWatchSession,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
} from "./watch-session";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("createStatePayload", () => {
  test("returns a well-formed payload with no startupMode field", () => {
    const payload = createStatePayload([], true, null, { kind: "folder" }, []);
    expect("startupMode" in payload).toBe(false);
    expect(payload.initialFollow).toBe(true);
    expect(payload.scope).toEqual({ kind: "folder" });
  });

  test("carries no config payload fields", () => {
    // `.uatu.json` no longer carries presentation config; the payload must
    // not resurrect the retired fields.
    const payload = createStatePayload([], true, null, { kind: "folder" }, [], true);
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

async function readSsePayload(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReturnType<typeof createStatePayload>> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE payload timeout")), 3000)),
  ]);
  const text = new TextDecoder().decode(result.value);
  const data = text.split("data: ").at(-1)?.trim();
  if (!data) throw new Error("SSE payload missing data");
  return JSON.parse(data);
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

  test("canSetFileScope rejects unknown, ignored, secret-like, and binary document ids", async () => {
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

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);

    expect(canSetFileScope(roots, readme)).toBe(true);
    expect(canSetFileScope(roots, path.join(tempDirectory, "missing.md"))).toBe(false);
    expect(canSetFileScope(roots, ignored)).toBe(false);
    expect(canSetFileScope(roots, secret)).toBe(false);
    expect(canSetFileScope(roots, binary)).toBe(false);
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

// A deterministic replacement for Date.now/setTimeout: timers fire in
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

describe("buildWatcherIgnorePredicate", () => {
  test("ignores any path with a `.git` segment between it and a watched root", () => {
    const root = "/tmp/uatu-watch-root";
    const predicate = buildWatcherIgnorePredicate([root], new Map<string, IgnoreMatcher>());

    expect(predicate(path.join(root, ".git", "index.lock"))).toBe(true);
    expect(predicate(path.join(root, ".git", "refs", "heads", "main"))).toBe(true);
    expect(predicate(path.join(root, "nested", ".git", "HEAD"))).toBe(true);
  });

  test("does not ignore regular files outside `.git/`", () => {
    const root = "/tmp/uatu-watch-root";
    const predicate = buildWatcherIgnorePredicate([root], new Map<string, IgnoreMatcher>());

    expect(predicate(path.join(root, "README.md"))).toBe(false);
    expect(predicate(path.join(root, "src", "index.ts"))).toBe(false);
    // Substring-only matchers would false-positive on `something.git/`, so
    // verify the segment-equality check distinguishes those.
    expect(predicate(path.join(root, "something.git", "file.md"))).toBe(false);
  });

  test("returns false for paths outside any watched root", () => {
    const root = "/tmp/uatu-watch-root";
    const predicate = buildWatcherIgnorePredicate([root], new Map<string, IgnoreMatcher>());

    expect(predicate("/elsewhere/.git/index.lock")).toBe(false);
    expect(predicate("/elsewhere/README.md")).toBe(false);
  });

  test("defers to the per-root IgnoreMatcher for non-`.git` paths", () => {
    const root = "/tmp/uatu-watch-root";
    const matcherCache = new Map<string, IgnoreMatcher>();
    matcherCache.set(root, {
      shouldIgnore: (rel: string) => rel === "secret.txt",
      toChokidarIgnored: () => (testPath: string) =>
        path.relative(root, testPath) === "secret.txt",
    });
    const predicate = buildWatcherIgnorePredicate([root], matcherCache);

    expect(predicate(path.join(root, "secret.txt"))).toBe(true);
    expect(predicate(path.join(root, "README.md"))).toBe(false);
  });
});

describe("attachWatcherCrashGuard", () => {
  test("attaches an `error` listener so a synthetic EINVAL does not throw", () => {
    const emitter = new EventEmitter();
    attachWatcherCrashGuard(emitter);

    const synthetic = Object.assign(new Error("synthetic"), { code: "EINVAL" });
    // Without an `error` listener, EventEmitter throws synchronously on emit.
    // The listener installed by attachWatcherCrashGuard must absorb this.
    expect(() => emitter.emit("error", synthetic)).not.toThrow();
    expect(emitter.listenerCount("error")).toBeGreaterThan(0);
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
