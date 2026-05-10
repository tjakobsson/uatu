// Integration test for the heartbeat + snapshot plumbing that cli.ts wires
// together via start1HzSnapshotTick. This test reuses the same building
// blocks (registry, atomic snapshot writer, fs.utimes) directly to keep the
// test fast (no chokidar / server) while still observing real fs behavior.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCachePaths } from "./debug-cache";
import {
  MetricsRegistry,
  start1HzSnapshotTick,
  writeSnapshotAtomic,
} from "./debug-metrics";

describe("heartbeat + snapshot integration", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-heart-"));
  });
  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  test("heartbeat mtime advances and snapshot stays valid JSON across ticks", async () => {
    const paths = createCachePaths(scratch);
    const heartbeatPath = paths.heartbeatPath(process.pid);
    const snapshotPath = paths.snapshotPath(process.pid);

    const registry = new MetricsRegistry();
    let counter = 0;

    await fs.writeFile(heartbeatPath, "");

    const tick = start1HzSnapshotTick(
      () => {
        registry.set("tick.counter", ++counter);
        return registry.snapshot();
      },
      async snapshot => {
        await fs.utimes(heartbeatPath, new Date(), new Date());
        await writeSnapshotAtomic(snapshotPath, snapshot);
      },
      // Speed the test up — the production cadence is 1Hz but the contract is
      // independent of the interval.
      50,
    );

    try {
      const initialMtime = (await fs.stat(heartbeatPath)).mtimeMs;
      await new Promise(resolve => setTimeout(resolve, 200));
      const advancedMtime = (await fs.stat(heartbeatPath)).mtimeMs;
      expect(advancedMtime).toBeGreaterThan(initialMtime);

      const snapshotJson = await fs.readFile(snapshotPath, "utf8");
      const parsed = JSON.parse(snapshotJson);
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.counters["tick.counter"]).toBeGreaterThan(0);

      // Take a second reading after another interval and verify the counter
      // advanced — ensures the tick is still firing and writes are atomic.
      await new Promise(resolve => setTimeout(resolve, 200));
      const second = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
      expect(second.counters["tick.counter"]).toBeGreaterThan(parsed.counters["tick.counter"]);
    } finally {
      tick.stop();
    }
  });
});
