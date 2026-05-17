// Resolves the on-disk cache directory for diagnostic artifacts and exposes
// path helpers for the heartbeat file, the always-on counter snapshot, the
// opt-in NDJSON history, and the watchdog's forensic dump bundle.
//
// Layout (under `$XDG_CACHE_HOME/uatu` or `~/.cache/uatu`):
//
//   heartbeat-<pid>          — touched once per second by a healthy process
//   snapshot-<pid>.json      — most recent counter snapshot (atomic-write)
//   debug-<pid>.ndjson       — opt-in 1Hz append log when --debug is on
//   dump-<pid>-<ts>.<kind>   — forensic bundle written by the watchdog
//
// The watchdog reads `snapshot-<pid>.json` (always present) plus
// `debug-<pid>.ndjson` (only when debug was enabled) when assembling a dump.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_DUMP_RETENTION_DAYS = 14;

export type CachePaths = {
  rootDir: string;
  heartbeatPath: (pid: number) => string;
  snapshotPath: (pid: number) => string;
  ndjsonPath: (pid: number) => string;
  dumpPath: (pid: number, timestamp: string, kind: DumpKind) => string;
};

export type DumpKind = "stack.txt" | "fds.txt" | "metrics-tail.ndjson" | "cause.json";

export function resolveCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME;
  if (typeof xdg === "string" && xdg.length > 0) {
    return path.join(xdg, "uatu");
  }
  return path.join(os.homedir(), ".cache", "uatu");
}

export function createCachePaths(rootDir: string = resolveCacheRoot()): CachePaths {
  return {
    rootDir,
    heartbeatPath: pid => path.join(rootDir, `heartbeat-${pid}`),
    snapshotPath: pid => path.join(rootDir, `snapshot-${pid}.json`),
    ndjsonPath: pid => path.join(rootDir, `debug-${pid}.ndjson`),
    dumpPath: (pid, timestamp, kind) => path.join(rootDir, `dump-${pid}-${timestamp}.${kind}`),
  };
}

// Idempotent — `recursive: true` swallows EEXIST and creates parents.
export async function ensureCacheDir(rootDir: string): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
}

// Tolerant cleanup: ignores ENOENT, missing directory, and per-file unlink
// failures. The pruner runs at startup as a best-effort housekeeping pass —
// it must never block startup or surface errors that scare the user.
export async function pruneOldDumps(
  rootDir: string,
  retentionDays: number = DEFAULT_DUMP_RETENTION_DAYS,
  now: number = Date.now(),
): Promise<{ removed: number }> {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch {
    return { removed: 0 };
  }

  let removed = 0;
  await Promise.all(
    entries.map(async name => {
      if (!name.startsWith("dump-")) {
        return;
      }
      const fullPath = path.join(rootDir, name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(fullPath);
          removed += 1;
        }
      } catch {
        // File vanished mid-scan or stat failed — best-effort.
      }
    }),
  );
  return { removed };
}

// `<pid>-<isoBasic>` — `:` and `.` stripped so the result is filesystem-safe
// across darwin/linux/win32 without escaping.
export function formatDumpTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
