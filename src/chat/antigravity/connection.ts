import { client, ndJsonStream, RequestError, type ClientConnection, type InitializeResponse, type RequestPermissionRequest, type RequestPermissionResponse } from "@agentclientprotocol/sdk";

import { BoundedTextCapture, ManagedProcess, settlesWithin } from "../managed-process";

/** agy's answer to a session call made without a usable login. */
export const AUTH_REQUIRED_CODE = -32000;

const STDERR_LIMIT_BYTES = 16 * 1024;
// Shutdown fits inside the Hub's kill deadline (SIGTERM_GRACE_MS in
// session-contract/spawn.ts, which a test holds these to): closing stdin ends agy
// within about 200 ms (design D2); after that the shared helper sends
// SIGTERM to the group and escalates to SIGKILL, waiting at most three
// TERM_GRACE_MS in all.
export const STDIN_CLOSE_GRACE_MS = 300;
export const TERM_GRACE_MS = 600;

export type AcpHandlers = {
  // Raw `session/update` params: the normalizer reads them defensively, so
  // an update kind this SDK does not know is still seen and counted.
  update(params: unknown): void;
  permission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
};

export type AcpSpawn = (argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
  pid: number;
  exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
  stdin: { write(chunk: Uint8Array): unknown; flush?(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

export type AcpProcessOptions = {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  handlers: AcpHandlers;
  spawn?: AcpSpawn;
  stdinCloseGraceMs?: number;
  termGraceMs?: number;
};

const defaultSpawn: AcpSpawn = (argv, options) => Bun.spawn(argv, {
  cwd: options.cwd,
  env: options.env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  // A group leader, so termination reaches the workers agy starts.
  detached: process.platform !== "win32",
} as Parameters<typeof Bun.spawn>[1]) as unknown as ReturnType<AcpSpawn>;

/**
 * One `agy acp` process and its ACP v1 connection (add-antigravity-chat D1,
 * D2). The client advertises no file-system or terminal capability, so agy
 * never asks UatuCode to read files or run commands for it.
 *
 * The owner holds it from spawn, before `initialize` answers, so a child
 * stuck there is still ended by `close()`. `close()` ends stdin first and
 * then escalates through the shared process helpers; a leader that exits
 * on its own has its process group reaped too, and `settled` resolves once
 * nothing it started is left.
 */
export class AcpProcess {
  readonly exited: Promise<number | null>;
  // Resolves with agy's `initialize` answer; rejects if it never comes.
  readonly ready: Promise<InitializeResponse>;
  // Resolves once the process and its group are gone, by close() or exit.
  readonly settled: Promise<void>;
  private answer: InitializeResponse | undefined;
  private closing: Promise<void> | null = null;
  private exitedFlag = false;
  private readonly managed: ManagedProcess;
  private readonly connection: ClientConnection;
  private readonly stdin: ReturnType<AcpSpawn>["stdin"];
  private readonly capture: BoundedTextCapture;
  private readonly stdinCloseGraceMs: number;

  private constructor(options: AcpProcessOptions) {
    const spawned = (options.spawn ?? defaultSpawn)([options.executable, "acp"], { cwd: options.cwd, env: options.env ?? process.env });
    this.capture = new BoundedTextCapture(STDERR_LIMIT_BYTES);
    this.capture.consume(spawned.stderr);
    this.managed = new ManagedProcess(spawned, { capture: this.capture, termGraceMs: options.termGraceMs ?? TERM_GRACE_MS, escalation: "group" });
    this.stdinCloseGraceMs = options.stdinCloseGraceMs ?? STDIN_CLOSE_GRACE_MS;
    const stdin = this.stdin = spawned.stdin;
    const output = new WritableStream<Uint8Array>({
      write: async chunk => { stdin.write(chunk); await stdin.flush?.(); },
      close: () => { try { stdin.end(); } catch { /* already closed */ } },
    });
    const app = client({ name: "uatu" })
      .onNotification("session/update", (value: unknown) => value, ({ params }) => options.handlers.update(params))
      .onRequest("session/request_permission", ({ params, signal }) => options.handlers.permission(params, signal));
    const connection = this.connection = app.connect(ndJsonStream(output, spawned.stdout));
    this.exited = spawned.exited.then(code => code, () => null);
    // A process that ends closes its connection, rejecting whatever waits,
    // and whatever it left in its group is reaped.
    const reaped = this.exited.then(async () => {
      this.exitedFlag = true;
      connection.close(new Error("Antigravity exited"));
      await this.managed.terminate();
    });
    this.settled = reaped.then(() => undefined, () => undefined);
    this.ready = connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "uatu", title: "UatuCode", version: "1" },
    }).then(answer => { this.answer = answer; return answer; }, error => { throw withStderr(error, this.capture.snapshot()); });
    void this.ready.catch(() => undefined);
  }

  /** Spawn `agy acp` and send `initialize`; the caller owns the process at once. */
  static spawn(options: AcpProcessOptions): AcpProcess {
    return new AcpProcess(options);
  }

  /** agy's `initialize` answer; only after `ready` has resolved. */
  get initialized(): InitializeResponse {
    if (!this.answer) throw new Error("Antigravity has not answered initialize");
    return this.answer;
  }

  get agent(): ClientConnection["agent"] {
    return this.connection.agent;
  }

  get alive(): boolean {
    return !this.exitedFlag && !this.closing;
  }

  /** What the process printed on stderr, bounded, for failure diagnostics. */
  stderr(): string {
    return this.capture.snapshot();
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.connection.close();
      try { this.stdin.end(); } catch { /* already closed */ }
      await settlesWithin(this.exited, this.stdinCloseGraceMs, milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
      // Whether or not agy left on its own: reap whatever is left in its
      // group, escalating only for what is still running.
      await this.managed.terminate();
    })();
    return this.closing;
  }
}

/** The JSON-RPC error code of a failure, when it is one. */
export function rpcErrorCode(error: unknown): number | undefined {
  if (error instanceof RequestError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

function withStderr(error: unknown, stderr: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(stderr ? `${message}: ${stderr.split("\n").slice(-3).join(" ")}` : message);
}
