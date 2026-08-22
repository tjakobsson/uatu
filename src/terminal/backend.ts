// Resolves whether the embedded terminal backend can run on this process.
// Bun ships a built-in PTY (`Bun.spawn(..., { terminal: ... })`) since
// 1.3.5, available on macOS and Linux. This module's only job is to report
// availability — actual spawning lives in `terminal-pty.ts`.

import { spawnPty, type PtyProcess, type PtyOptions } from "./pty";

export type TerminalBackend = {
  available: true;
  spawn: (shell: string, args: string[], options: PtyOptions) => PtyProcess;
} | {
  available: false;
  reason: string;
};

let cached: TerminalBackend | null = null;

export async function resolveTerminalBackend(): Promise<TerminalBackend> {
  if (cached) return cached;
  cached = await detectBackend();
  return cached;
}

export async function terminalBackendAvailable(): Promise<boolean> {
  return (await resolveTerminalBackend()).available;
}

async function detectBackend(): Promise<TerminalBackend> {
  if (typeof Bun === "undefined") {
    return { available: false, reason: "not running on Bun" };
  }
  if (process.platform === "win32") {
    return { available: false, reason: "Bun PTY API does not yet support Windows" };
  }
  // The `terminal` option on Bun.spawn is the gate: Bun < 1.3.5 silently
  // ignores it and hands back pipe stdio, and we would rather fail closed
  // than pretend that is a TTY.
  //
  // This used to be answered by spawning `/bin/echo` in a PTY and waiting
  // for a byte. That probe deadlocked the Edge nightly: under Bun 1.4.0 on a
  // macOS CI runner, spawning a child that exits immediately can wedge the
  // main thread in a synchronous wait4() reaping it. The per-attempt
  // watchdog could never fire, because the event loop was blocked inside
  // native code — a bounded-looking guard that was not bounded at all. Boot
  // hung before Bun.serve ever listened.
  //
  // The version is the thing we actually wanted to test, and reading it
  // spawns nothing. It also removes the boot-time fork storm the retry loop
  // risked on the unsupported path.
  return supportsBunTerminal(Bun.version);
}

const MINIMUM_BUN_TERMINAL_VERSION = [1, 3, 5] as const;

export function supportsBunTerminal(version: string): TerminalBackend {
  // Build metadata (`+...`) does not affect precedence; a prerelease (`-...`)
  // does, and sorts below its own release.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) {
    return { available: false, reason: `unrecognized Bun version "${version}"` };
  }
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  const prerelease = match[4];

  let comparison = 0;
  for (let i = 0; i < MINIMUM_BUN_TERMINAL_VERSION.length; i += 1) {
    const difference = core[i]! - MINIMUM_BUN_TERMINAL_VERSION[i]!;
    if (difference !== 0) {
      comparison = difference;
      break;
    }
  }

  // 1.3.5-canary.1 predates 1.3.5 and may ship without the PTY
  // implementation, so fail closed on a prerelease *of the minimum itself*.
  // A prerelease of any later version is already past the gate.
  if (comparison < 0 || (comparison === 0 && prerelease !== undefined)) {
    return {
      available: false,
      reason: `Bun ${version} ignores Bun.spawn { terminal } (needs >= 1.3.5)`,
    };
  }
  return { available: true, spawn: spawnPty };
}
