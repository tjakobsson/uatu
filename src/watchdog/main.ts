// Sibling watchdog process. Spawned by `uatu watch` at startup with a
// re-execution of the same uatu binary in `--watchdog` mode. Imports nothing
// from the chokidar / server / terminal stack so the wedge that takes down
// the parent cannot reach this process.
//
// Loop invariant: every second
//   1. `kill(parentPid, 0)` — exit cleanly if parent is gone.
//   2. `stat heartbeat` — compare mtime to the mtime seen on the previous tick.
//   3. If the mtime has not advanced for `ceil(timeout / tick)` consecutive
//      ticks, capture forensic dump and `SIGKILL` parent.
//
// Staleness is deliberately NOT derived from `Date.now() - mtime`: wall-clock
// keeps advancing while the machine sleeps, so on wake the heartbeat looks
// minutes stale even though the parent is healthy — whichever pending timer
// fired first decided whether uatu survived the wake. Tick counting only
// accumulates while the watchdog itself is running (a suspend contributes at
// most one stale tick), and the parent's own 1 Hz heartbeat advances the mtime
// within a tick of resuming, resetting the counter. A genuinely wedged parent
// freezes the mtime while the watchdog ticks the full threshold awake — same
// detection latency as before. This also makes detection immune to NTP steps
// and manual clock changes.

import { promises as fs } from "node:fs";

import {
  createCachePaths,
  ensureCacheDir,
  formatDumpTimestamp,
  type CachePaths,
} from "../debug/cache";
import { captureFds, captureStack } from "./capture";

const DEFAULT_TIMEOUT_MS = 30_000;
const TICK_INTERVAL_MS = 1_000;
const NDJSON_TAIL_LINES = 1000;

export type WatchdogArgs = {
  parentPid: number;
  heartbeatPath: string;
  cacheRoot: string;
  timeoutMs: number;
};

export function parseWatchdogArgs(argv: string[], env: NodeJS.ProcessEnv): WatchdogArgs {
  // argv layout: [parentPid, heartbeatPath, cacheRoot]
  const [parentPidRaw, heartbeatPath, cacheRoot] = argv;
  const parentPid = Number.parseInt(parentPidRaw ?? "", 10);
  if (!Number.isFinite(parentPid) || parentPid <= 0) {
    throw new Error(`watchdog: invalid parentPid ${parentPidRaw}`);
  }
  if (!heartbeatPath) {
    throw new Error("watchdog: missing heartbeatPath argument");
  }
  if (!cacheRoot) {
    throw new Error("watchdog: missing cacheRoot argument");
  }
  const fromEnv = env.UATU_HEARTBEAT_TIMEOUT_MS;
  const timeoutMs = parseTimeout(fromEnv) ?? DEFAULT_TIMEOUT_MS;
  return { parentPid, heartbeatPath, cacheRoot, timeoutMs };
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user — count as
    // alive. ESRCH means it's gone.
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export async function runWatchdog(args: WatchdogArgs): Promise<number> {
  const { parentPid, heartbeatPath, cacheRoot, timeoutMs } = args;
  const paths = createCachePaths(cacheRoot);
  await ensureCacheDir(cacheRoot);

  // The configured timeout keeps its wall-clock meaning while the system is
  // awake: one stale tick ≈ one second of observed non-advancing heartbeat.
  const requiredStaleTicks = Math.max(1, Math.ceil(timeoutMs / TICK_INTERVAL_MS));
  // mtime observed on the previous tick; null until the first successful stat.
  let lastMtimeMs: number | null = null;
  // Consecutive ticks the mtime has been observed NOT to advance.
  let staleTicks = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!isProcessAlive(parentPid)) {
      return 0;
    }

    let mtimeMs: number;
    try {
      const stat = await fs.stat(heartbeatPath);
      mtimeMs = stat.mtimeMs;
    } catch {
      // Heartbeat file missing — treat as a hard signal that the parent has
      // failed to start up properly. Wait one more tick before declaring,
      // because there's a tiny window between watchdog spawn and the first
      // heartbeat write. Does not advance the stale counter: there is no
      // mtime to compare against.
      await sleep(TICK_INTERVAL_MS);
      continue;
    }

    if (lastMtimeMs === null || mtimeMs !== lastMtimeMs) {
      // First observation, or the heartbeat advanced — the parent is alive.
      lastMtimeMs = mtimeMs;
      staleTicks = 0;
    } else {
      staleTicks += 1;
    }

    if (staleTicks >= requiredStaleTicks) {
      const now = Date.now();
      await captureAndKill(parentPid, paths, now - mtimeMs, now, staleTicks);
      return 0;
    }

    await sleep(TICK_INTERVAL_MS);
  }
}

async function captureAndKill(
  parentPid: number,
  paths: CachePaths,
  ageMs: number,
  detectedAtMs: number,
  staleTicks: number,
): Promise<void> {
  const timestamp = formatDumpTimestamp();
  const stackPath = paths.dumpPath(parentPid, timestamp, "stack.txt");
  const fdsPath = paths.dumpPath(parentPid, timestamp, "fds.txt");
  const metricsTailPath = paths.dumpPath(parentPid, timestamp, "metrics-tail.ndjson");
  const causePath = paths.dumpPath(parentPid, timestamp, "cause.json");

  // Run captures in parallel — both have their own time caps.
  const [stack, fds] = await Promise.all([captureStack(parentPid), captureFds(parentPid)]);

  await Promise.all([
    fs.writeFile(stackPath, stack.contents, "utf8"),
    fs.writeFile(fdsPath, fds.contents, "utf8"),
    writeMetricsTail(parentPid, paths, metricsTailPath),
  ]);

  const cause = {
    reason: "stale-heartbeat",
    pid: parentPid,
    ageMs,
    // Consecutive watchdog ticks the mtime was observed frozen. A real hang
    // has staleTicks ≈ ceil(timeout / tick) with ageMs to match; ageMs far
    // exceeding staleTicks × tick means wall-clock jumped (sleep, clock step).
    staleTicks,
    detectedAtMs,
    platform: process.platform,
    stackCaptured: !stack.partial,
    fdsCaptured: !fds.partial,
  };
  await fs.writeFile(causePath, JSON.stringify(cause, null, 2), "utf8");

  // Force-kill. SIGKILL on POSIX, default kill on Windows (Bun/Node maps to
  // TerminateProcess). We don't try SIGTERM first — a wedged process won't
  // service it, and the dump is already captured.
  try {
    if (process.platform === "win32") {
      process.kill(parentPid);
    } else {
      process.kill(parentPid, "SIGKILL");
    }
  } catch {
    // Already gone — fine.
  }
}

async function writeMetricsTail(
  parentPid: number,
  paths: CachePaths,
  outPath: string,
): Promise<void> {
  // Prefer the live NDJSON if present (richer history); fall back to the
  // single snapshot file.
  const ndjsonPath = paths.ndjsonPath(parentPid);
  try {
    const tail = await readNdjsonTail(ndjsonPath, NDJSON_TAIL_LINES);
    await fs.writeFile(outPath, tail, "utf8");
    return;
  } catch {
    // Fall through to snapshot.
  }
  try {
    const snapshot = await fs.readFile(paths.snapshotPath(parentPid), "utf8");
    await fs.writeFile(outPath, snapshot, "utf8");
  } catch {
    await fs.writeFile(outPath, "[no metrics history available]\n", "utf8");
  }
}

async function readNdjsonTail(filePath: string, lines: number): Promise<string> {
  const data = await fs.readFile(filePath, "utf8");
  const allLines = data.split("\n");
  const tail = allLines.slice(-lines - 1); // slack for trailing empty line
  return tail.join("\n");
}

function sleep(ms: number): Promise<void> {
  // Do NOT unref the timer. The watchdog has no other event-loop activity
  // (no servers, no watchers); unref'ing would let Bun exit immediately
  // when nothing else holds the loop open, which would silently shut down
  // the watchdog and leave the parent unprotected.
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
