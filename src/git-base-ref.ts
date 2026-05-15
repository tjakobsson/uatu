import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ReviewBase } from "./shared";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2500;
const GIT_MAX_BUFFER = 256 * 1024;

export type GitResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string; message: string };

type GitMetricsSink = { inc(name: string): void };
let gitMetricsSink: GitMetricsSink | null = null;

export function setGitMetricsSink(sink: GitMetricsSink | null): void {
  gitMetricsSink = sink;
}

export async function safeGit(
  cwd: string,
  args: string[],
  options: { maxBuffer?: number; timeoutMs?: number } = {},
): Promise<GitResult> {
  gitMetricsSink?.inc("git.execs_total");
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    if (err.killed === true || err.signal === "SIGTERM") {
      gitMetricsSink?.inc("git.timeouts_total");
    }
    return {
      ok: false,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
      message: err.message,
    };
  }
}

export async function resolveReviewBase(
  repoRoot: string,
  configuredBase: string | undefined,
): Promise<ReviewBase> {
  if (configuredBase && await refExists(repoRoot, configuredBase)) {
    return mergeBase(repoRoot, configuredBase, "configured");
  }

  const originHead = await safeGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const remoteDefault = originHead.ok ? originHead.stdout.trim() : "";
  if (remoteDefault && await refExists(repoRoot, remoteDefault)) {
    return mergeBase(repoRoot, remoteDefault, "remote-default");
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (await refExists(repoRoot, candidate)) {
      return mergeBase(repoRoot, candidate, "fallback");
    }
  }

  return { mode: "dirty-worktree-only", ref: "HEAD", mergeBase: null };
}

export async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  const result = await safeGit(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref]);
  return result.ok;
}

async function mergeBase(
  repoRoot: string,
  ref: string,
  mode: ReviewBase["mode"],
): Promise<ReviewBase> {
  const result = await safeGit(repoRoot, ["merge-base", "--", ref, "HEAD"]);
  return {
    mode,
    ref,
    mergeBase: result.ok ? result.stdout.trim() || null : null,
  };
}
