/**
 * Process handling shared by agent runtimes that own a child process: a
 * long-lived server (OpenCode's `opencode serve`) or a per-conversation stdio
 * child. Spawning stays with each runtime, so its stdio choices (ignored or
 * piped stdin, which streams are captured) are its own; this module only
 * stops a child and keeps a bounded copy of what it printed.
 */

/** The part of a spawned child this module needs; a Bun subprocess has it. */
export type SpawnedProcess = {
  pid: number;
  exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
};

export type KillGroup = (pid: number, signal: NodeJS.Signals | 0) => void;

export type ManagedProcessOptions = {
  // Awaited after the child has exited, so a terminated child's last output
  // is in the capture before termination reports done.
  capture?: BoundedTextCapture;
  termGraceMs: number;
  // Signals the child's process group. The child must have been spawned as
  // a group leader (`detached` off Windows); Windows signals the child itself.
  killGroup?: KillGroup;
  sleep?: (milliseconds: number) => Promise<void>;
  // What decides SIGKILL once the grace period ends. `leader` (the default,
  // OpenCode's): only whether the child itself is still running, and the
  // capture is then awaited without a bound. `group`, for a child that starts
  // its own workers (a per-conversation stdio agent): whether any member of
  // its process group is still alive, even after the child itself exited,
  // and every wait after SIGTERM is bounded, so termination always ends:
  // a capture still open at its deadline is released.
  escalation?: "leader" | "group";
};

/**
 * Stops a child: SIGTERM to its process group, the grace period, then
 * SIGKILL. Idempotent: every caller joins the one termination.
 *
 * In `group` mode termination ends at most three grace periods after it
 * starts: the grace, a bounded wait for the child to exit after SIGKILL, and
 * a bounded wait for the capture, which a member that left the group could
 * otherwise hold open forever.
 */
export class ManagedProcess {
  readonly capture: BoundedTextCapture | undefined;
  private readonly killGroup: KillGroup;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly termGraceMs: number;
  private readonly escalation: "leader" | "group";
  private terminating: Promise<void> | null = null;

  constructor(private readonly child: SpawnedProcess, options: ManagedProcessOptions) {
    this.capture = options.capture;
    this.killGroup = options.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.termGraceMs = options.termGraceMs;
    this.escalation = options.escalation ?? "leader";
  }

  terminate(): Promise<void> {
    this.terminating ??= this.escalation === "group" ? this.terminateGroupOnce() : this.terminateOnce();
    return this.terminating;
  }

  private async terminateOnce(): Promise<void> {
    signalProcess(this.child, this.killGroup, "SIGTERM");
    if (!await settlesWithin(this.child.exited, this.termGraceMs, this.sleep)) {
      signalProcess(this.child, this.killGroup, "SIGKILL");
      await this.child.exited.catch(() => undefined);
    }
    await this.capture?.done;
  }

  private async terminateGroupOnce(): Promise<void> {
    signalProcess(this.child, this.killGroup, "SIGTERM");
    // One grace period from SIGTERM, shared by the child and its group.
    const graceEnded = this.sleep(this.termGraceMs);
    const childExited = await Promise.race([
      this.child.exited.then(() => true, () => true),
      graceEnded.then(() => false),
    ]);
    if (childExited && this.groupAlive()) await graceEnded;
    if (!childExited || this.groupAlive()) {
      signalProcess(this.child, this.killGroup, "SIGKILL");
      await settlesWithin(this.child.exited, this.termGraceMs, this.sleep);
    }
    // A member that left the group can hold the pipe open past SIGKILL;
    // stop reading it then, so no reader or pipe outlives termination.
    if (this.capture && !await settlesWithin(this.capture.done, this.termGraceMs, this.sleep)) this.capture.release();
  }

  // Whether any process is left in the child's group. Windows has no groups
  // here, so only the child itself counts there.
  private groupAlive(): boolean {
    if (process.platform === "win32") return false;
    try {
      this.killGroup(this.child.pid, 0);
      return true;
    } catch (error) {
      // EPERM means a member exists that this process may not signal.
      return (error as { code?: unknown } | null)?.code !== "ESRCH";
    }
  }
}

export function signalProcess(child: SpawnedProcess, killGroup: KillGroup, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") child.kill(signal);
    else killGroup(child.pid, signal);
  } catch {
    // The child may have exited between state inspection and signaling.
  }
}

/** Whether the promise settles, either way, before the sleep ends. */
export async function settlesWithin(promise: Promise<unknown>, milliseconds: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    sleep(milliseconds).then(() => false),
  ]);
}

/**
 * The last `limit` bytes of a stream, for diagnostics, or with
 * `retain: "start"` its first `limit` bytes (a version probe's answer leads
 * its output); either way the stream is read to its end. The snapshot is
 * decoded, stripped of control characters other than tab, newline and
 * carriage return, and trimmed, then passed through the optional scrubber,
 * which is where a runtime redacts secrets its child might echo.
 */
export class BoundedTextCapture {
  private bytes = new Uint8Array();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private released = false;
  private attached = false;
  private resolveDone!: () => void;
  readonly done = new Promise<void>(resolve => {
    this.resolveDone = resolve;
  });

  constructor(private readonly limit: number, private readonly scrub?: (text: string) => string, private readonly retain: "start" | "end" = "end") {}

  // For a stream that will never arrive, so `done` still settles.
  close(): void {
    this.resolveDone();
  }

  consume(stream: ReadableStream<Uint8Array>): void {
    // One stream per capture, and released is terminal: a stream that
    // arrives after the first, or after release, is cancelled, best effort
    // and never awaited, and is not locked or read.
    if (this.released || this.attached) {
      try {
        void stream.cancel().catch(() => undefined);
      } catch {
        // A stream that cannot be cancelled is simply left alone.
      }
      return;
    }
    this.attached = true;
    // Runs synchronously up to its first read, so `release()` right after
    // this call finds the reader.
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        // Inside the try: a stream that is already locked yields nothing
        // and still settles `done`, as it did before the capture took a reader.
        reader = stream.getReader();
        this.reader = reader;
        for (;;) {
          const { value, done } = await reader.read();
          // Released while this read was answered: the snapshot is frozen
          // from the moment release() returns.
          if (done || this.reader !== reader) break;
          if (this.retain === "start" && this.bytes.length >= this.limit) continue;
          const combined = new Uint8Array(this.bytes.length + value.length);
          combined.set(this.bytes);
          combined.set(value, this.bytes.length);
          this.bytes = combined.length <= this.limit ? combined
            : this.retain === "start" ? combined.slice(0, this.limit) : combined.slice(combined.length - this.limit);
        }
      } catch {
        // Preserve the diagnostics collected before the stream closed.
      } finally {
        reader?.releaseLock();
        if (this.reader === reader) this.reader = null;
        this.resolveDone();
      }
    })();
  }

  /**
   * Stops reading before the stream ends, keeping the bytes collected so
   * far. On return the stream is cancelled and unlocked and `done` has
   * settled. Cancelling closes the stream at once and frees the pipe; the
   * source's own cancellation is not awaited, so one that never settles
   * cannot hold the caller. Terminal: a later `consume()` reads nothing.
   */
  release(): void {
    this.released = true;
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    this.resolveDone();
  }

  /** The bytes kept, decoded as they are, without the snapshot's cleanup. */
  text(): string {
    return new TextDecoder().decode(this.bytes);
  }

  snapshot(): string {
    const text = new TextDecoder().decode(this.bytes).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
    return this.scrub ? this.scrub(text) : text;
  }
}
