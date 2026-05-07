// Resolves whether the embedded terminal backend can run on this process.
// Bun ships a built-in PTY (`Bun.spawn(..., { terminal: ... })`) since
// 1.3.5, available on macOS and Linux. This module's only job is to report
// availability — actual spawning lives in `terminal-pty.ts`.

import { spawnPty, type PtyProcess, type PtyOptions } from "./terminal-pty";

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

async function probeBunTerminal(): Promise<TerminalBackend> {
  try {
    const probe = await new Promise<boolean>(resolve => {
      let saw = false;
      const watchdog = setTimeout(() => resolve(saw), 750);
      try {
        const proc = Bun.spawn(["/bin/echo", "uatu-pty-probe"], {
          terminal: {
            cols: 80,
            rows: 24,
            data() {
              saw = true;
            },
          },
        } as Parameters<typeof Bun.spawn>[1]);
        void proc.exited.then(() => {
          clearTimeout(watchdog);
          resolve(saw);
        });
      } catch {
        clearTimeout(watchdog);
        resolve(false);
      }
    });
    if (!probe) {
      return {
        available: false,
        reason: "Bun.spawn { terminal } did not deliver data within probe deadline",
      };
    }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { available: true, spawn: spawnPty };
}
