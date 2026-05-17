// Thin adapter over Bun's built-in `Bun.spawn(..., { terminal })` PTY API
// (added in Bun 1.3.5). Matches the small surface our `terminal-server.ts`
// uses, so the upstream code stays unchanged when we swapped away from
// `node-pty`. Keep this surface stable — the rest of the terminal stack
// imports it.
//
// Why an adapter at all: Bun's API is `data(t, bytes)` callback + Promise
// `.exited`, which is a perfectly good shape but doesn't match the
// "register N listeners" pattern terminal-server.ts grew up with. The
// adapter routes a single Bun callback through to a list of listeners and
// turns `proc.exited` into onExit notifications.
//
// Bytes pass through verbatim. We deliberately do NOT UTF-8 decode here:
// kernel `read()` boundaries land mid-codepoint constantly when TUIs emit
// dense multi-byte runs (e.g. `─` = E2 94 80), and `TextDecoder.decode`
// without `{ stream: true }` would substitute U+FFFD for the orphaned
// bytes. Even with stream:true, a module-level decoder would mix partial-
// codepoint state across sessions. The right consumer of the byte stream
// is xterm.js, whose `term.write(Uint8Array)` has a built-in stateful
// UTF-8 decoder designed for exactly this pattern.

export type PtyOptions = {
  cwd: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
};

export type PtyProcess = {
  pid: number;
  onData(listener: (data: Uint8Array) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal: number | null }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

export function spawnPty(shell: string, args: string[], options: PtyOptions): PtyProcess {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal: number | null }) => void>();
  let exited = false;
  let exitInfo: { exitCode: number; signal: number | null } | null = null;

  const proc = Bun.spawn([shell, ...args], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data(_terminal, bytes) {
        if (dataListeners.size === 0) return;
        for (const listener of dataListeners) listener(bytes);
      },
    },
  } as Parameters<typeof Bun.spawn>[1]);

  // `proc.exited` resolves to the numeric exit code (or null on signal).
  // Bun also exposes `proc.signalCode` for the named signal once it's exited.
  void proc.exited.then(code => {
    exited = true;
    exitInfo = {
      exitCode: typeof code === "number" ? code : 0,
      signal: typeof code === "number" ? null : (code ?? null),
    };
    for (const listener of exitListeners) listener(exitInfo);
  });

  const proc2 = proc as unknown as { terminal?: { write(d: string): void; resize(c: number, r: number): void; close(): void }; pid: number; kill(sig?: string | number): void };

  return {
    get pid() {
      return proc2.pid;
    },
    onData(listener: (data: Uint8Array) => void) {
      dataListeners.add(listener);
      return {
        dispose() {
          dataListeners.delete(listener);
        },
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      // Fire immediately if the process has already exited — keeps consumer
      // callers from racing with proc.exited resolution.
      if (exited && exitInfo) listener(exitInfo);
      return {
        dispose() {
          exitListeners.delete(listener);
        },
      };
    },
    write(data) {
      try {
        proc2.terminal?.write(data);
      } catch {
        // Process may have just exited; the exit handler will follow.
      }
    },
    resize(cols, rows) {
      try {
        proc2.terminal?.resize(cols, rows);
      } catch {
        // Resize after exit is harmless.
      }
    },
    kill(signal) {
      try {
        proc2.kill(signal ?? "SIGHUP");
      } catch {
        // Already dead.
      }
    },
  };
}
