// In-process registry of diagnostic counters and gauges, plus the on-disk
// snapshot writer the watchdog reads when no verbose history exists.
//
// All operations are synchronous and cheap (object property bumps) so that
// the increment sites can fire on every chokidar event / refresh / git exec
// without measurable cost. Persistence (snapshot file, opt-in NDJSON log) is
// driven by callers via `start1HzPersistence`.

import { promises as fs } from "node:fs";
import path from "node:path";

export type CounterValues = Record<string, number>;

export type Snapshot = {
  // ms-since-epoch when the snapshot was taken. The watchdog uses this to
  // age out stale snapshots when assembling a dump bundle.
  takenAtMs: number;
  pid: number;
  counters: CounterValues;
};

const NDJSON_DEFAULT_SOFT_CAP_BYTES = 10 * 1024 * 1024;

export class MetricsRegistry {
  private readonly counters: CounterValues = {};

  inc(name: string, delta = 1): void {
    this.counters[name] = (this.counters[name] ?? 0) + delta;
  }

  set(name: string, value: number): void {
    this.counters[name] = value;
  }

  get(name: string): number {
    return this.counters[name] ?? 0;
  }

  snapshot(pid: number = process.pid, now: number = Date.now()): Snapshot {
    return {
      takenAtMs: now,
      pid,
      counters: { ...this.counters },
    };
  }
}

// Atomic snapshot write: data lands at `<path>.tmp` and is renamed in place.
// The watchdog therefore never sees a partially-written file. ENOENT on the
// rename target is fine — `rename` overwrites.
export async function writeSnapshotAtomic(snapshotPath: string, snapshot: Snapshot): Promise<void> {
  const tmpPath = `${snapshotPath}.tmp`;
  const payload = JSON.stringify(snapshot);
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, snapshotPath);
}

export type NdjsonAppenderOptions = {
  // Soft cap in bytes; once exceeded the file is truncated to keep the most
  // recent half. 10MB ≈ 1h at typical line sizes.
  softCapBytes?: number;
};

export class NdjsonAppender {
  private readonly softCapBytes: number;

  constructor(
    private readonly filePath: string,
    options: NdjsonAppenderOptions = {},
  ) {
    this.softCapBytes = options.softCapBytes ?? NDJSON_DEFAULT_SOFT_CAP_BYTES;
  }

  async append(snapshot: Snapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const line = `${JSON.stringify(snapshot)}\n`;
    await fs.appendFile(this.filePath, line, "utf8");
    await this.maybeTruncate();
  }

  // Ring-buffer style: when the file exceeds the soft cap we copy the most
  // recent half to a temp file and rename it into place. Truncating at a line
  // boundary keeps the file valid NDJSON.
  private async maybeTruncate(): Promise<void> {
    let size: number;
    try {
      const stat = await fs.stat(this.filePath);
      size = stat.size;
    } catch {
      return;
    }
    if (size <= this.softCapBytes) {
      return;
    }

    const tmpPath = `${this.filePath}.trim`;
    const handle = await fs.open(this.filePath, "r");
    let renameTrimmed = true;
    try {
      const targetSize = Math.floor(this.softCapBytes / 2);
      const startOffset = size - targetSize;
      const buffer = Buffer.alloc(targetSize);
      await handle.read(buffer, 0, targetSize, startOffset);
      // Snap to the next newline so the file starts on a clean line boundary.
      // If the second half contains no newline at all, the buffer starts mid-
      // JSON-line — discard it rather than poisoning the file with invalid NDJSON.
      const firstNewline = buffer.indexOf(0x0a);
      if (firstNewline === -1) {
        renameTrimmed = false;
      } else {
        const slice = buffer.subarray(firstNewline + 1);
        await fs.writeFile(tmpPath, slice);
      }
    } finally {
      await handle.close();
    }
    if (renameTrimmed) {
      await fs.rename(tmpPath, this.filePath);
    }
  }
}

// Periodically samples non-counter signals (fd count, memory, SSE
// subscriber count) and stores them as gauges in the registry. Callers
// pass a getter for the SSE subscriber count so the registry doesn't need
// to know about the SSE layer.
export function start5sSamplingTick(
  registry: MetricsRegistry,
  getSseSubscribers: () => number,
  intervalMs = 5_000,
): { stop: () => void } {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      registry.set("sse.subscribers", getSseSubscribers());
      const mem = process.memoryUsage();
      registry.set("rss_bytes", mem.rss);
      registry.set("heap_used_bytes", mem.heapUsed);
      registry.set("fd.open", await countOpenFds());
    } catch {
      // best-effort
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  // Run once immediately so the first snapshot has values without waiting 5s.
  void tick();
  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}

async function countOpenFds(): Promise<number> {
  // /dev/fd is the cross-platform path that works on darwin and most Linux
  // distros for "this process's file descriptors". /proc/self/fd is Linux's
  // canonical alternative. We try /dev/fd first.
  for (const probePath of ["/dev/fd", "/proc/self/fd"]) {
    try {
      const entries = await fs.readdir(probePath);
      return entries.length;
    } catch {
      // fall through
    }
  }
  return 0;
}

// Helper used by both the always-on snapshot tick and the opt-in NDJSON tick.
// Caller passes a getter for the live snapshot so this module stays free of
// any global registry state.
export function start1HzSnapshotTick(
  getSnapshot: () => Snapshot,
  writeSnapshot: (s: Snapshot) => Promise<void>,
  intervalMs = 1000,
): { stop: () => void } {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await writeSnapshot(getSnapshot());
    } catch {
      // Best-effort — if the disk is full or read-only there is nothing useful
      // we can do from here, and surfacing would spam stderr.
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  // Don't keep the event loop alive on the tick alone.
  if (typeof handle.unref === "function") handle.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
