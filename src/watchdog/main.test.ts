import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseWatchdogArgs, runWatchdog } from "./main";

describe("parseWatchdogArgs", () => {
  test("parses parentPid + paths from positional argv", () => {
    const args = parseWatchdogArgs(["12345", "/tmp/heart", "/tmp/cache"], {});
    expect(args.parentPid).toBe(12345);
    expect(args.heartbeatPath).toBe("/tmp/heart");
    expect(args.cacheRoot).toBe("/tmp/cache");
    expect(args.timeoutMs).toBe(30_000);
  });

  test("UATU_HEARTBEAT_TIMEOUT_MS overrides the default timeout", () => {
    const args = parseWatchdogArgs(["1", "/h", "/c"], { UATU_HEARTBEAT_TIMEOUT_MS: "5000" });
    expect(args.timeoutMs).toBe(5_000);
  });

  test("invalid values fall back to the default", () => {
    const args = parseWatchdogArgs(["1", "/h", "/c"], { UATU_HEARTBEAT_TIMEOUT_MS: "bogus" });
    expect(args.timeoutMs).toBe(30_000);
  });

  test("rejects missing or malformed arguments", () => {
    expect(() => parseWatchdogArgs([], {})).toThrow();
    expect(() => parseWatchdogArgs(["abc", "/h", "/c"], {})).toThrow();
    expect(() => parseWatchdogArgs(["1", "", "/c"], {})).toThrow();
    expect(() => parseWatchdogArgs(["1", "/h", ""], {})).toThrow();
  });
});

describe("runWatchdog (parent-gone path)", () => {
  let cacheRoot: string;
  beforeEach(async () => {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-wd-"));
  });
  afterEach(async () => {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  test("exits cleanly when the parent pid is unreachable", async () => {
    // PID 999999999 is far above any real PID and effectively guaranteed to
    // be unreachable on a normal system. The watchdog must exit on the first
    // tick with code 0 and never produce a dump.
    const heartbeatPath = path.join(cacheRoot, "heartbeat-fake");
    const code = await runWatchdog({
      parentPid: 999_999_999,
      heartbeatPath,
      cacheRoot,
      timeoutMs: 30_000,
    });
    expect(code).toBe(0);
    const entries = await fs.readdir(cacheRoot);
    const dumps = entries.filter(name => name.startsWith("dump-"));
    expect(dumps).toHaveLength(0);
  });
});

describe("runWatchdog (stale-heartbeat path)", () => {
  let cacheRoot: string;
  beforeEach(async () => {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-wd-stale-"));
  });
  afterEach(async () => {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  // `sample <pid> 5` runs for 5s; capture cap is 10s; `lsof` is fast; total
  // wall-time for stale-detect → dump → kill is bounded by the slower
  // capture. Allow generous headroom so test isn't flaky on cold disk.
  const STALE_PATH_TIMEOUT_MS = 30_000;

  test(
    "writes a forensic dump bundle when heartbeat is stale and parent is alive",
    async () => {
    // Spawn a victim child that writes its pid then sleeps. We point the
    // watchdog at it with a stale heartbeat, expect the watchdog to dump and
    // SIGKILL it.
    const victim = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const pid = victim.pid;
    expect(typeof pid).toBe("number");

    // A heartbeat that is never refreshed. Its absolute age is irrelevant —
    // staleness is "mtime did not advance across consecutive ticks", so a
    // freshly-written-then-frozen file triggers exactly like an ancient one.
    const heartbeatPath = path.join(cacheRoot, `heartbeat-${pid}`);
    await fs.writeFile(heartbeatPath, "");

    try {
      const code = await runWatchdog({
        parentPid: pid as number,
        heartbeatPath,
        cacheRoot,
        // Tiny timeout → 1 required stale tick: the first tick records the
        // mtime, the second observes it frozen and declares the hang.
        timeoutMs: 100,
      });
      expect(code).toBe(0);

      const entries = await fs.readdir(cacheRoot);
      const dumps = entries.filter(name => name.startsWith(`dump-${pid}-`));
      expect(dumps.some(n => n.endsWith(".cause.json"))).toBe(true);
      expect(dumps.some(n => n.endsWith(".stack.txt"))).toBe(true);
      expect(dumps.some(n => n.endsWith(".fds.txt"))).toBe(true);
      expect(dumps.some(n => n.endsWith(".metrics-tail.ndjson"))).toBe(true);

      const causeFile = dumps.find(n => n.endsWith(".cause.json"))!;
      const cause = JSON.parse(await fs.readFile(path.join(cacheRoot, causeFile), "utf8"));
      expect(cause.reason).toBe("stale-heartbeat");
      expect(cause.pid).toBe(pid);
      expect(typeof cause.ageMs).toBe("number");
      // timeoutMs=100 → ceil(100/1000) = 1 required consecutive stale tick.
      expect(cause.staleTicks).toBe(1);
      expect(cause.platform).toBe(process.platform);
    } finally {
      try {
        victim.kill();
      } catch {
        // Already killed by the watchdog.
      }
    }
    },
    STALE_PATH_TIMEOUT_MS,
  );
});

describe("runWatchdog (sleep-wake path)", () => {
  // ~3.5s of watchdog ticks + spawn/teardown; generous headroom like the
  // stale-path test above.
  const WAKE_PATH_TIMEOUT_MS = 30_000;
  let cacheRoot: string;
  beforeEach(async () => {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-wd-wake-"));
  });
  afterEach(async () => {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  test(
    "an ancient heartbeat that resumes advancing does not trigger a kill",
    async () => {
      // Simulates waking from system sleep: the heartbeat mtime is minutes in
      // the past (wall-clock advanced while everything was suspended), but the
      // parent is healthy and resumes touching it. Under the old wall-clock
      // check (`now - mtime > timeout`) the watchdog would dump + SIGKILL on
      // its first post-wake tick; under tick counting it must not.
      const victim = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const pid = victim.pid;

      const heartbeatPath = path.join(cacheRoot, `heartbeat-${pid}`);
      await fs.writeFile(heartbeatPath, "");
      const longAgo = new Date(Date.now() - 600_000); // "slept" for 10 minutes
      await fs.utimes(heartbeatPath, longAgo, longAgo);

      // Post-wake parent heartbeat: touch the mtime faster than the watchdog
      // ticks so every tick observes an advance. Explicit forward-marching
      // timestamps sidestep filesystem mtime granularity.
      let fakeNow = Date.now();
      const refresher = setInterval(() => {
        fakeNow += 1_000;
        const stamp = new Date(fakeNow);
        void fs.utimes(heartbeatPath, stamp, stamp).catch(() => undefined);
      }, 200);

      try {
        // timeoutMs=1000 → 1 required stale tick: the most trigger-happy
        // configuration. Give the watchdog several ticks to (wrongly) declare
        // a hang, then remove the victim so the watchdog exits via the
        // parent-gone path.
        const run = runWatchdog({
          parentPid: pid,
          heartbeatPath,
          cacheRoot,
          timeoutMs: 1_000,
        });
        await new Promise(resolve => setTimeout(resolve, 3_500));
        victim.kill();
        const code = await run;
        expect(code).toBe(0);

        const entries = await fs.readdir(cacheRoot);
        const dumps = entries.filter(name => name.startsWith("dump-"));
        expect(dumps).toHaveLength(0);
      } finally {
        clearInterval(refresher);
        try {
          victim.kill();
        } catch {
          // Already gone.
        }
      }
    },
    WAKE_PATH_TIMEOUT_MS,
  );
});
