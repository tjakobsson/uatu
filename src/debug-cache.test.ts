import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createCachePaths,
  ensureCacheDir,
  formatDumpTimestamp,
  pruneOldDumps,
  resolveCacheRoot,
} from "./debug-cache";

describe("resolveCacheRoot", () => {
  test("honors XDG_CACHE_HOME when set", () => {
    expect(resolveCacheRoot({ XDG_CACHE_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/uatu");
  });

  test("falls back to ~/.cache/uatu when XDG_CACHE_HOME is unset", () => {
    expect(resolveCacheRoot({})).toBe(path.join(os.homedir(), ".cache", "uatu"));
  });

  test("treats an empty XDG_CACHE_HOME as unset", () => {
    expect(resolveCacheRoot({ XDG_CACHE_HOME: "" })).toBe(path.join(os.homedir(), ".cache", "uatu"));
  });
});

describe("createCachePaths", () => {
  test("returns deterministic per-pid paths inside the rootDir", () => {
    const paths = createCachePaths("/cache");
    expect(paths.heartbeatPath(42)).toBe("/cache/heartbeat-42");
    expect(paths.snapshotPath(42)).toBe("/cache/snapshot-42.json");
    expect(paths.ndjsonPath(42)).toBe("/cache/debug-42.ndjson");
    expect(paths.dumpPath(42, "ts", "stack.txt")).toBe("/cache/dump-42-ts.stack.txt");
    expect(paths.dumpPath(42, "ts", "fds.txt")).toBe("/cache/dump-42-ts.fds.txt");
    expect(paths.dumpPath(42, "ts", "metrics-tail.ndjson")).toBe(
      "/cache/dump-42-ts.metrics-tail.ndjson",
    );
    expect(paths.dumpPath(42, "ts", "cause.json")).toBe("/cache/dump-42-ts.cause.json");
  });
});

describe("ensureCacheDir", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-cache-"));
  });
  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  test("creates the directory recursively and is idempotent", async () => {
    const target = path.join(scratch, "a", "b", "c");
    await ensureCacheDir(target);
    await ensureCacheDir(target); // second call must not throw
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe("pruneOldDumps", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-prune-"));
  });
  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  test("removes only old dump-* files and leaves others alone", async () => {
    const oldDump = path.join(scratch, "dump-1-old.stack.txt");
    const recentDump = path.join(scratch, "dump-2-fresh.stack.txt");
    const otherFile = path.join(scratch, "snapshot-1.json");
    await fs.writeFile(oldDump, "old");
    await fs.writeFile(recentDump, "recent");
    await fs.writeFile(otherFile, "{}");

    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldDump, longAgo, longAgo);

    const result = await pruneOldDumps(scratch, 14);
    expect(result.removed).toBe(1);
    await expect(fs.stat(oldDump)).rejects.toThrow();
    await expect(fs.stat(recentDump)).resolves.toBeDefined();
    await expect(fs.stat(otherFile)).resolves.toBeDefined();
  });

  test("tolerates a missing directory without throwing", async () => {
    const result = await pruneOldDumps(path.join(scratch, "does-not-exist"));
    expect(result.removed).toBe(0);
  });
});

describe("formatDumpTimestamp", () => {
  test("produces a filesystem-safe string with no colons or dots", () => {
    const ts = formatDumpTimestamp(new Date("2026-05-09T16:07:01.054Z"));
    expect(ts).toBe("2026-05-09T16-07-01-054Z");
    expect(ts).not.toContain(":");
    expect(ts).not.toContain(".");
  });
});
