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
  createStatePayload,
  createWatchSession,
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

  test("includes monoConfig when fontFamily is set", () => {
    const payload = createStatePayload(
      [],
      true,
      null,
      { kind: "folder" },
      [],
      undefined,
      undefined,
      { fontFamily: "Berkeley Mono, monospace" },
    );
    expect(payload.monoConfig).toEqual({ fontFamily: "Berkeley Mono, monospace" });
  });

  test("omits monoConfig when fontFamily is unset", () => {
    const payload = createStatePayload(
      [],
      true,
      null,
      { kind: "folder" },
      [],
      undefined,
      undefined,
      { fontFamily: undefined },
    );
    expect("monoConfig" in payload).toBe(false);
  });

  test("omits monoConfig when no monoConfig argument is passed", () => {
    const payload = createStatePayload([], true, null, { kind: "folder" }, []);
    expect("monoConfig" in payload).toBe(false);
  });

  test("includes terminalConfig when only clipboard is set", () => {
    // Regression: the payload gate used to check fontFamily/fontSize only,
    // silently dropping a `.uatu.json` that sets just `terminal.clipboard`.
    const payload = createStatePayload(
      [],
      true,
      null,
      { kind: "folder" },
      [],
      true,
      { clipboard: "confirm" },
    );
    expect(payload.terminalConfig).toEqual({ clipboard: "confirm" });
  });

  test("omits terminalConfig when every field is unset", () => {
    const payload = createStatePayload([], true, null, { kind: "folder" }, [], true, {});
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

describe("watchSession scope", () => {
  test("pinning narrows visible roots to the selected file and unpin restores folder scope", async () => {
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

      session.setScope({ kind: "file", documentId: readme });
      await waitUntil(() => {
        const docs = session.getRoots().flatMap(root => root.docs);
        return docs.length === 1 && docs[0]?.id === readme;
      });
      expect(session.getScope()).toEqual({ kind: "file", documentId: readme });

      session.setScope({ kind: "folder" });
      await waitUntil(() => session.getRoots().flatMap(root => root.docs).length >= 2);
      expect(session.getScope()).toEqual({ kind: "folder" });
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
      JSON.stringify({ tree: { exclude: ["ignored.txt"] } }),
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

  test("unlinking the pinned file reverts scope to folder automatically", async () => {
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

      session.setScope({ kind: "file", documentId: readme });
      await waitUntil(() => {
        const docs = session.getRoots().flatMap(root => root.docs);
        return docs.length === 1 && docs[0]?.id === readme;
      });

      await unlink(readme);
      await waitUntil(
        () =>
          session.getScope().kind === "folder" &&
          session.getRoots().flatMap(root => root.docs).some(doc => doc.id === guide),
      );
      expect(session.getScope()).toEqual({ kind: "folder" });
    } finally {
      await session.stop();
    }
  });

  test("editing .uatu.json tree.exclude at runtime reapplies the new patterns", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-ignore-live-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const lockfile = path.join(tempDirectory, "package-lock.json");
    const uatuJson = path.join(tempDirectory, ".uatu.json");
    await writeFile(readme, "# Readme\n");
    await writeFile(lockfile, "{}\n");
    await writeFile(uatuJson, JSON.stringify({ tree: { exclude: [] } }));

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

      await writeFile(uatuJson, JSON.stringify({ tree: { exclude: ["package-lock.json"] } }));
      await waitUntil(
        () => session.getRoots().flatMap(root => root.docs).every(doc => doc.id !== lockfile),
        4000,
      );

      await writeFile(uatuJson, JSON.stringify({ tree: { exclude: [] } }));
      await waitUntil(
        () => session.getRoots().flatMap(root => root.docs).some(doc => doc.id === lockfile),
        4000,
      );
    } finally {
      await session.stop();
    }
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
