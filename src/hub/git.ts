// Git plumbing for the hub's workspace-creation flows: the non-git-folder
// preflight (mirroring the desktop launcher's rules), `git init` on
// confirmation, and `git clone` into a chosen destination directory. All
// run as the daemon's OS user with its ambient git config/credentials —
// the hub stores no credentials of its own.

import { spawnSync } from "node:child_process";

export type GitProbeResult =
  | { kind: "repository"; toplevel: string }
  | { kind: "not-a-repository" }
  // The probe failed without proving the repository is missing (git not
  // installed, safe.directory rejection, …) — per the desktop preflight
  // spec, the caller skips the init offer and lets the serve CLI's own
  // preflight report.
  | { kind: "indeterminate"; detail: string };

const GIT_PROBE_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT = 64 * 1024;

type GitRunOptions = { timeoutMs?: number; outputLimit?: number };

async function collectGitOutput(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
  stop: () => void,
): Promise<{ text: string; exceeded: boolean }> {
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    for (;;) {
      if (signal.aborted) break;
      const next = await reader.read();
      if (next.done) break;
      const remaining = limit - size;
      if (remaining > 0) {
        chunks.push(next.value.slice(0, remaining));
        size += Math.min(remaining, next.value.length);
      }
      if (next.value.length > remaining) {
        exceeded = true;
        stop();
        break;
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))), exceeded };
}

async function runGit(
  args: string[],
  cwd?: string,
  executable = "git",
  options: GitRunOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; outputExceeded: boolean }> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([executable, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, outputExceeded: false };
  }
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    if (process.platform === "win32" && child.pid > 0) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 1_000,
        windowsHide: true,
      });
    }
    if (process.platform !== "win32" && child.pid > 0) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // Fall through to the direct child.
      }
    }
    try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS);
  try {
    const stdoutPromise = collectGitOutput(child.stdout as ReadableStream<Uint8Array>, options.outputLimit ?? GIT_OUTPUT_LIMIT, controller.signal, stop);
    const stderrPromise = collectGitOutput(child.stderr as ReadableStream<Uint8Array>, options.outputLimit ?? GIT_OUTPUT_LIMIT, controller.signal, stop);
    const exitCode = await child.exited;
    const drains = Promise.all([stdoutPromise, stderrPromise]);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainTimeout = new Promise<[Awaited<typeof stdoutPromise>, Awaited<typeof stderrPromise>]>(resolve => {
      drainTimer = setTimeout(() => {
        stop();
        void drains.then(resolve);
      }, 100);
    });
    const [stdout, stderr] = await Promise.race([drains, drainTimeout]).finally(() => clearTimeout(drainTimer));
    return { exitCode, stdout: stdout.text, stderr: stderr.text, timedOut, outputExceeded: stdout.exceeded || stderr.exceeded };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function probeGitRepository(folder: string, executable = "git", options: GitRunOptions = {}): Promise<GitProbeResult> {
  const result = await runGit(["rev-parse", "--show-toplevel"], folder, executable, options);
  if (result.outputExceeded) return { kind: "indeterminate", detail: "git repository probe exceeded the output limit" };
  if (result.timedOut) return { kind: "indeterminate", detail: "git repository probe timed out" };
  if (result.exitCode === 0) {
    return { kind: "repository", toplevel: result.stdout.trim() };
  }
  if (/not a git repository/i.test(result.stderr)) {
    return { kind: "not-a-repository" };
  }
  return { kind: "indeterminate", detail: result.stderr.trim() };
}

export async function gitInit(folder: string, executable = "git"): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await runGit(["init"], folder, executable);
  if (result.exitCode === 0) {
    return { ok: true };
  }
  return { ok: false, error: result.stderr.trim() || `git init exited ${result.exitCode}` };
}

// Derives the checkout folder name from a clone URL:
// "git@github.com:me/uatu.git" → "uatu", "https://x/y/repo" → "repo".
export function cloneTargetName(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  const name = last.endsWith(".git") ? last.slice(0, -4) : last;
  if (name === "" || name === "." || name === "..") {
    return null;
  }
  return name;
}

// A checkout folder name must be one visible path segment, held to the same
// bar as the folder manager's name validator (folderName there): the whole
// control category (Cc — the C0 range, DEL, and the C1 range U+0080–U+009F)
// and Unicode format characters (Cf — the zero-width family, the bidi
// embedding and override controls, the BOM) are rejected. The
// caller trims before this check, and trimming leaves those in place, so a
// name made only of them would otherwise pass as nonempty and clone into a
// directory that renders blank, while an embedded bidi control could make
// the checkout display a name other than the path it occupies.
export function validCloneFolderName(value: string): boolean {
  return value !== ""
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}
