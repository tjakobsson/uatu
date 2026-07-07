import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ReviewBase, ReviewCompareTarget } from "../shared/types";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2500;
const GIT_MAX_BUFFER = 256 * 1024;

export type GitResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string; message: string };

type GitMetricsSink = { inc(name: string, delta?: number): void };
let gitMetricsSink: GitMetricsSink | null = null;

export function setGitMetricsSink(sink: GitMetricsSink | null): void {
  gitMetricsSink = sink;
}

// Shared metrics entry point for git-adjacent modules (document/diff phase
// timings live next to the exec counters recorded here). Cumulative-ms
// counters pair with a *_total count so consumers can derive averages.
export function recordGitMetric(name: string, delta = 1): void {
  gitMetricsSink?.inc(name, delta);
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

  // No resolvable base: both compare targets describe the same diff (staged +
  // unstaged vs HEAD), so the choice is collapsed.
  return applyCompareTarget(
    { mode: "dirty-worktree-only", ref: "HEAD", mergeBase: null, compareTarget: "base", comparedAgainstRef: "HEAD", targetsCollapsed: true },
    "base",
  );
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
  const mergeBaseSha = result.ok ? result.stdout.trim() || null : null;
  return applyCompareTarget(
    { mode, ref, mergeBase: mergeBaseSha, compareTarget: "base", comparedAgainstRef: ref, targetsCollapsed: mergeBaseSha === null },
    "base",
  );
}

// Single source of truth mapping a resolved base + a compare target onto the
// fields the meter and the diff both consume. `last-commit` always measures
// staged + unstaged changes against HEAD; `base` keeps the resolved-base
// behavior (falling back to HEAD when no base merge-base exists). Returns a
// fresh ReviewBase with `compareTarget` / `comparedAgainstRef` /
// `targetsCollapsed` set for the requested target.
export function applyCompareTarget(base: ReviewBase, target: ReviewCompareTarget): ReviewBase {
  const targetsCollapsed = base.mergeBase === null;
  // When collapsed, both targets are really "vs HEAD" regardless of request.
  const effectiveTarget: ReviewCompareTarget = targetsCollapsed ? "last-commit" : target;
  const comparedAgainstRef =
    effectiveTarget === "last-commit" ? "HEAD" : base.ref ?? "HEAD";
  return { ...base, compareTarget: target, comparedAgainstRef, targetsCollapsed };
}

// The literal git ref to diff a single file against for this target.
// `base` uses the merge-base SHA (so the diff spans committed + worktree
// changes); `last-commit` and the no-base fallback use HEAD.
export function compareRefForTarget(base: ReviewBase, target: ReviewCompareTarget): string {
  if (target === "last-commit") {
    return "HEAD";
  }
  return base.mergeBase ?? "HEAD";
}
