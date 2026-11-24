import { client, ndJsonStream, RequestError, type ClientConnection, type InitializeResponse, type RequestPermissionRequest, type RequestPermissionResponse } from "@agentclientprotocol/sdk";

import { BoundedTextCapture, ManagedProcess, settlesWithin } from "../managed-process";

/** agy's answer to a session call made without a usable login. */
export const AUTH_REQUIRED_CODE = -32000;

const STDERR_LIMIT_BYTES = 16 * 1024;
// Closing stdin ends agy within about 200 ms (design D2); after this, the
// shared helper escalates with SIGTERM, a grace and SIGKILL to the group.
const STDIN_CLOSE_GRACE_MS = 1_000;
const TERM_GRACE_MS = 2_000;

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
 * never asks UatuCode to read files or run commands for it. `close()` ends
 * stdin first and then escalates through the shared process helpers.
 */
export class AcpProcess {
  private closing: Promise<void> | null = null;
  private exitedFlag = false;

  private constructor(
    private readonly managed: ManagedProcess,
    private readonly connection: ClientConnection,
    private readonly stdin: ReturnType<AcpSpawn>["stdin"],
    private readonly capture: BoundedTextCapture,
    readonly exited: Promise<number | null>,
    private readonly stdinCloseGraceMs: number,
    readonly initialized: InitializeResponse,
  ) {
    void exited.then(() => { this.exitedFlag = true; }, () => { this.exitedFlag = true; });
  }

  static async start(options: AcpProcessOptions): Promise<AcpProcess> {
    const spawned = (options.spawn ?? defaultSpawn)([options.executable, "acp"], { cwd: options.cwd, env: options.env ?? process.env });
    const capture = new BoundedTextCapture(STDERR_LIMIT_BYTES);
    capture.consume(spawned.stderr);
    const managed = new ManagedProcess(spawned, { capture, termGraceMs: options.termGraceMs ?? TERM_GRACE_MS, escalation: "group" });
    const stdin = spawned.stdin;
    const output = new WritableStream<Uint8Array>({
      write: async chunk => { stdin.write(chunk); await stdin.flush?.(); },
      close: () => { try { stdin.end(); } catch { /* already closed */ } },
    });
    const app = client({ name: "uatu" })
      .onNotification("session/update", (value: unknown) => value, ({ params }) => options.handlers.update(params))
      .onRequest("session/request_permission", ({ params, signal }) => options.handlers.permission(params, signal));
    const connection = app.connect(ndJsonStream(output, spawned.stdout));
    const exited = spawned.exited.then(code => code, () => null);
    // A process that ends closes its connection, rejecting whatever waits.
    void exited.then(() => connection.close(new Error("Antigravity exited")));
    try {
      const initialized = await connection.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "uatu", title: "UatuCode", version: "1" },
      });
      return new AcpProcess(managed, connection, stdin, capture, exited, options.stdinCloseGraceMs ?? STDIN_CLOSE_GRACE_MS, initialized);
    } catch (error) {
      connection.close();
      try { stdin.end(); } catch { /* already closed */ }
      await managed.terminate();
      throw withStderr(error, capture.snapshot());
    }
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
