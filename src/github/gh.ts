// The `gh api` transport (design D2): the session child's only way to reach
// GitHub. `gh` resolves the token (the Hub's projection, GH_ENTERPRISE_TOKEN,
// or the user's own login outside a Hub), the API endpoint for Enterprise
// hosts, proxies and certificates; uatu never sees the token.
//
// Rules:
// - `gh api` only, never `gh pr …` porcelain, whose JSON fields change
//   between versions.
// - argv arrays (Bun.spawn, no shell); every request names its host with
//   `--hostname`.
// - GraphQL variables and every write body go as JSON on stdin with
//   `--input -`, never `-f`/`-F` (which read a local file for a value that
//   starts with `@`).
// - `--include` on every call, so the status line and the rate-limit headers
//   classify the answer (src/github/classify.ts).
// - `gh api` exits 1 for HTTP ≥ 400 *and* for any GraphQL `errors` (also a
//   partial answer on HTTP 200) with the body still on stdout, and it neither
//   retries nor throttles. So stdout is parsed whatever the exit code; only
//   an empty stdout is a transport failure.
// - Bounded: a timeout per request (15 s reads, 30 s writes), a cap on
//   stdout, at most GH_PROCESS_CONCURRENCY processes at once, and dispose()
//   kills what is still running when the session stops.
// - stderr is read only to tell "not signed in" from "network down", and is
//   never forwarded to a client.

import { GitHubFailure, type GitHubResponse } from "./classify";
import { providerCliVersionSupported } from "../hub/provider-runtime";

export type GitHubRequest =
  | {
      kind: "graphql";
      host: string;
      // The query's operation name: the fake transport and the logs key on it.
      operation: string;
      query: string;
      variables: Record<string, unknown>;
      write?: boolean;
    }
  | {
      kind: "rest";
      host: string;
      operation: string;
      // A path below the API root, such as `repos/o/r/pulls/1/files?page=2`.
      path: string;
    };

export interface GitHubTransport {
  // Resolves with GitHub's answer, whatever its status; rejects with a
  // GitHubFailure only when there is no answer (gh missing or too old, no
  // login, timeout, network).
  request(request: GitHubRequest): Promise<GitHubResponse>;
  // Whether `gh` is signed in to an Enterprise host (design D3). Never reads
  // or prints the token.
  authenticated?(host: string): Promise<boolean>;
  dispose?(): void;
}

// REST version header (GraphQL ignores it). `gh` sends 2022-11-28 by default;
// github.com and ghe.com get the current version, GitHub Enterprise Server
// keeps gh's default because older servers refuse versions they don't know.
export const REST_API_VERSION = "2026-03-10";
export const READ_TIMEOUT_MS = 15_000;
export const WRITE_TIMEOUT_MS = 30_000;
// A page of 100 changed files with their patches stays well under this.
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const GH_PROCESS_CONCURRENCY = 4;
const VERSION_TIMEOUT_MS = 5_000;

export function isCloudHost(host: string): boolean {
  return host === "github.com" || host === "ghe.com" || host.endsWith(".ghe.com");
}

export function ghArgs(request: GitHubRequest): string[] {
  if (request.kind === "graphql") {
    return ["api", "graphql", "--hostname", request.host, "--method", "POST", "--include", "--input", "-"];
  }
  if (request.path.startsWith("-") || request.path.startsWith("/")) throw new Error("invalid REST path");
  return [
    "api", request.path, "--hostname", request.host, "--method", "GET", "--include",
    "-H", "Accept: application/vnd.github+json",
    ...(isCloudHost(request.host) ? ["-H", `X-GitHub-Api-Version: ${REST_API_VERSION}`] : []),
  ];
}

export function ghStdin(request: GitHubRequest): string | null {
  return request.kind === "graphql" ? JSON.stringify({ query: request.query, variables: request.variables }) : null;
}

// `gh api --include` prints `HTTP/2.0 200 OK`, then `Name: value` header
// lines, a blank line, then the body.
export function parseIncludeOutput(output: string): GitHubResponse | null {
  const separator = /\r?\n\r?\n/.exec(output);
  const head = separator ? output.slice(0, separator.index) : output;
  const body = separator ? output.slice(separator.index + separator[0].length).trim() : "";
  const [statusLine = "", ...headerLines] = head.split(/\r?\n/);
  const status = /^HTTP\/[\d.]+ (\d{3})\b/.exec(statusLine);
  if (!status) return null;
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  let json: unknown = null;
  if (body) {
    try {
      json = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return { status: Number(status[1]), headers, json };
}

// stderr only says *why* there was no answer; it never leaves this process.
function failureFromStderr(exitCode: number, stderr: string): GitHubFailure {
  if (exitCode === 4 || /gh auth login|not logged in|authentication required|GH_TOKEN/i.test(stderr)) {
    return new GitHubFailure("no-credential", "The GitHub CLI isn't signed in for this host.");
  }
  if (/timeout|timed out/i.test(stderr)) return new GitHubFailure("timeout", "GitHub didn't answer in time.");
  return new GitHubFailure("unavailable", "Couldn't reach GitHub.");
}

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

type SpawnResult = { exitCode: number; stdout: string; stderr: string };

export type GhTransportOptions = {
  // The session's environment; `gh` is looked up on its PATH.
  env?: Record<string, string | undefined>;
  // Test seam: an explicit executable instead of the PATH lookup.
  ghPath?: string;
  timeouts?: { readMs?: number; writeMs?: number };
  maxOutputBytes?: number;
  now?: () => number;
};

export class GhTransport implements GitHubTransport {
  private readonly env: Record<string, string>;
  private readonly gate = new Semaphore(GH_PROCESS_CONCURRENCY);
  private readonly running = new Set<ReturnType<typeof Bun.spawn>>();
  private versionCheck: Promise<void> | null = null;
  private readonly authenticatedHosts = new Map<string, Promise<boolean>>();
  private disposed = false;

  constructor(private readonly options: GhTransportOptions = {}) {
    const source = options.env ?? process.env;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) if (value !== undefined) env[key] = value;
    // No prompts, colors, pager, update checks or debug output.
    delete env.GH_DEBUG;
    delete env.DEBUG;
    this.env = { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", CLICOLOR: "0", GH_PAGER: "cat", GH_SPINNER_DISABLED: "1" };
  }

  // The executable, or null when `gh` isn't on the session's path.
  executable(): string | null {
    if (this.options.ghPath) return this.options.ghPath;
    return Bun.which("gh", { PATH: this.env.PATH ?? "" });
  }

  async request(request: GitHubRequest): Promise<GitHubResponse> {
    await this.ensureVersion();
    const write = request.kind === "graphql" && request.write === true;
    const timeoutMs = write ? this.options.timeouts?.writeMs ?? WRITE_TIMEOUT_MS : this.options.timeouts?.readMs ?? READ_TIMEOUT_MS;
    const result = await this.gate.run(() => this.spawn(ghArgs(request), ghStdin(request), timeoutMs));
    const response = result.stdout.trim() ? parseIncludeOutput(result.stdout) : null;
    if (response) return response;
    if (result.stdout.trim()) throw new GitHubFailure("unavailable", "GitHub's answer couldn't be read.", { operation: request.operation });
    const failure = failureFromStderr(result.exitCode, result.stderr);
    throw new GitHubFailure(failure.kind, failure.message, { operation: request.operation });
  }

  async authenticated(host: string): Promise<boolean> {
    let answer = this.authenticatedHosts.get(host);
    if (!answer) {
      answer = (async () => {
        try {
          await this.ensureVersion();
          const result = await this.gate.run(() => this.spawn(["auth", "status", "--hostname", host], null, READ_TIMEOUT_MS));
          return result.exitCode === 0;
        } catch {
          return false;
        }
      })();
      this.authenticatedHosts.set(host, answer);
    }
    return answer;
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.running) child.kill();
    this.running.clear();
  }

  // Once per transport: `gh --version` against the floor shared with the
  // Hub's provider runtime (src/hub/provider-runtime.ts).
  private ensureVersion(): Promise<void> {
    this.versionCheck ??= (async () => {
      const result = await this.spawn(["--version"], null, VERSION_TIMEOUT_MS);
      const firstLine = result.stdout.split("\n")[0]?.trim() ?? "";
      if (result.exitCode !== 0 || !providerCliVersionSupported("github", firstLine)) {
        const version = /\d+\.\d+(?:\.\d+)?/.exec(firstLine)?.[0];
        throw new GitHubFailure("gh-too-old", version ? `This workspace has gh ${version}.` : "This workspace's gh didn't report its version.");
      }
    })();
    // A missing gh is looked for again next time (it may be installed).
    this.versionCheck.catch(error => {
      if (error instanceof GitHubFailure && error.kind === "gh-missing") this.versionCheck = null;
    });
    return this.versionCheck;
  }

  private async spawn(args: string[], stdin: string | null, timeoutMs: number): Promise<SpawnResult> {
    if (this.disposed) throw new GitHubFailure("unavailable", "The workspace is stopping.");
    const executable = this.executable();
    if (!executable) throw new GitHubFailure("gh-missing", "The GitHub CLI (gh) isn't on this workspace's path.");
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([executable, ...args], {
        env: this.env,
        stdin: stdin === null ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      throw new GitHubFailure("gh-missing", "The GitHub CLI (gh) couldn't be started.");
    }
    this.running.add(child);
    let timedOut = false;
    let oversize = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      if (stdin !== null) {
        const sink = child.stdin as import("bun").FileSink;
        try {
          sink.write(stdin);
          await sink.end();
        } catch {
          // It exited before reading its input; its answer says why.
        }
      }
      const limit = this.options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
      // Read while it runs (a full pipe would stall it), but don't wait on
      // the pipes after a kill: something it started may still hold them.
      const reading = Promise.all([
        readBounded(child.stdout as ReadableStream<Uint8Array>, limit, () => {
          oversize = true;
          child.kill();
        }),
        readBounded(child.stderr as ReadableStream<Uint8Array>, 64 * 1024, () => undefined),
      ]);
      reading.catch(() => undefined);
      const exitCode = await child.exited;
      if (timedOut) throw new GitHubFailure("timeout", "GitHub didn't answer in time.");
      const [stdout, stderr] = await reading;
      if (oversize) throw new GitHubFailure("unavailable", "GitHub's answer was larger than uatu reads.");
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
      this.running.delete(child);
    }
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, onOverflow: () => void): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      onOverflow();
      await reader.cancel().catch(() => undefined);
      return "";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
