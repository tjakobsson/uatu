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
  // The `terminal` option on Bun.spawn is the gate. Older Bun versions
  // (<1.3.5) silently ignore it; we'd rather fail closed than spawn a
  // pipe-stdio child and pretend it's a TTY. Cheapest probe: try a short
  // sentinel and confirm the data callback fires within a tight deadline.
  return await probeBunTerminal();
}

// One delivered PTY byte proves Bun's terminal backend works. But Bun
// occasionally DROPS that byte when many children spawn at once: the child
// runs to a clean exit yet the `data` callback never fires (observed ~50% of
// the time when several servers boot together, e.g. the parallel e2e suite).
// A single probe therefore reports a perfectly good PTY as unavailable. So we
// retry: any attempt that delivers a byte proves availability; only when
// *every* attempt within the budget comes up empty do we conclude the runtime
// ignores the `terminal` option (Bun < 1.3.5) and fail closed.
//
// On that unsupported path every probe exits immediately without data, so the
// fast-exit shortcut below would let the loop respawn `/bin/echo` thousands of
// times within the budget — a boot-time fork storm. PROBE_RETRY_DELAY_MS paces
// the loop so the spawn rate stays bounded (~budget/delay attempts) while the
// happy path still returns on its first successful probe.
const PROBE_BUDGET_MS = 3000;
const PROBE_ATTEMPT_MS = 750;
const PROBE_RETRY_DELAY_MS = 100;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function probeBunTerminal(): Promise<TerminalBackend> {
  const deadline = performance.now() + PROBE_BUDGET_MS;
  let attempts = 0;
  try {
    do {
      attempts++;
      const sawData = await new Promise<boolean>(resolve => {
        let settled = false;
        const settle = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          resolve(value);
        };
        const watchdog = setTimeout(() => settle(false), PROBE_ATTEMPT_MS);
        const proc = Bun.spawn(["/bin/echo", "uatu-pty-probe"], {
          terminal: {
            cols: 80,
            rows: 24,
            data() {
              settle(true);
            },
          },
        } as Parameters<typeof Bun.spawn>[1]);
        // If the child exits without delivering a byte, this attempt missed.
        // Fail it fast — after a turn of the event loop so a trailing `data`
        // event still counts — so the loop can retry instead of burning the
        // full per-attempt deadline.
        void proc.exited.then(() => setTimeout(() => settle(false), 0));
      });
      if (sawData) return { available: true, spawn: spawnPty };
      if (performance.now() + PROBE_RETRY_DELAY_MS >= deadline) break;
      await delay(PROBE_RETRY_DELAY_MS);
    } while (performance.now() < deadline);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    available: false,
    reason: `Bun.spawn { terminal } delivered no data across ${attempts} probe(s)`,
  };
}
