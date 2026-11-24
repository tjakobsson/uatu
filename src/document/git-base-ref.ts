import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";

import type { CompareBase, CompareTarget, PullRequestBaseState } from "../shared/types";
import { pullRequestBaseFor } from "./pull-request-base";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2500;
const GIT_MAX_BUFFER = 256 * 1024;
const cancellation = new AsyncLocalStorage<AbortSignal>();

export function withGitCancellation<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return cancellation.run(signal, operation);
}
export function throwIfGitCancelled(): void { cancellation.getStore()?.throwIfAborted(); }

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
  options: { maxBuffer?: number; timeoutMs?: number; input?: string } = {},
): Promise<GitResult> {
  const signal = cancellation.getStore();
  signal?.throwIfAborted();
  gitMetricsSink?.inc("git.execs_total");
  try {
    const operation = execFileAsync("git", args, {
      cwd,
      // uatu only observes repositories. Without this, `git status` rewrites
      // .git/index to cache refreshed stat data, and the repository probe
      // reads that write as a new change and refreshes again.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      windowsHide: true,
      signal,
    });
    if (options.input !== undefined) {
      operation.child.stdin?.on("error", () => {});
      operation.child.stdin?.end(options.input);
    }
    const { stdout, stderr } = await operation;
    return { ok: true, stdout, stderr };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
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

// The base `base` comparisons measure from. With the checked-out branch's
// pull request known (pull-request-base.ts, set by the GitHub service), in
// order (add-github-pr-review D7):
// 1. GitHub's base commit is local: the merge base of it and HEAD, `exact`
//    (what GitHub's Files changed shows);
// 2. else the local `<remote>/<baseRefName>`: its merge base, `stale` (it may
//    be behind GitHub's);
// 3. else the default resolution below, flagged `missing`.
// Without a pull request: `origin/HEAD` → `origin/main` → `origin/master` →
// `main` → `master`, then staged + unstaged changes against HEAD.
export async function resolveCompareBase(repoRoot: string): Promise<CompareBase> {
  const pullRequest = await pullRequestBase(repoRoot);
  if (pullRequest && pullRequest.state !== "missing") {
    return mergeBase(repoRoot, pullRequest.mergeFrom, "pull-request", pullRequest.anchor, { number: pullRequest.number, ref: pullRequest.anchor, state: pullRequest.state });
  }
  const resolved = await resolveDefaultCompareBase(repoRoot);
  return pullRequest ? { ...resolved, pullRequest: { number: pullRequest.number, ref: pullRequest.anchor, state: "missing" } } : resolved;
}

async function pullRequestBase(repoRoot: string): Promise<{ number: number; anchor: string; state: PullRequestBaseState; mergeFrom: string } | null> {
  const override = pullRequestBaseFor(repoRoot);
  if (!override) return null;
  const branch = await safeGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch.ok || branch.stdout.trim() !== override.branch) return null;
  const anchor = `${override.remote}/${override.baseRefName}`;
  const base = { number: override.number, anchor };
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(override.baseRefOid)
    && (await safeGit(repoRoot, ["cat-file", "-e", `${override.baseRefOid}^{commit}`])).ok) {
    return { ...base, state: "exact", mergeFrom: override.baseRefOid };
  }
  const tracking = `refs/remotes/${anchor}`;
  if (await refExists(repoRoot, tracking)) return { ...base, state: "stale", mergeFrom: tracking };
  return { ...base, state: "missing", mergeFrom: "" };
}

async function resolveDefaultCompareBase(repoRoot: string): Promise<CompareBase> {
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

// `label` names the base where it isn't the ref itself (a pull request's
// base commit is labelled `<remote>/<baseRefName>`).
async function mergeBase(
  repoRoot: string,
  ref: string,
  mode: CompareBase["mode"],
  label = ref,
  pullRequest?: CompareBase["pullRequest"],
): Promise<CompareBase> {
  const result = await safeGit(repoRoot, ["merge-base", "--", ref, "HEAD"]);
  const mergeBaseSha = result.ok ? result.stdout.trim() || null : null;
  return applyCompareTarget(
    { mode, ref: label, mergeBase: mergeBaseSha, compareTarget: "base", comparedAgainstRef: label, targetsCollapsed: mergeBaseSha === null, ...(pullRequest ? { pullRequest } : {}) },
    "base",
  );
}

// Single source of truth mapping a resolved base + a compare target onto the
// fields the changed-files context and the diff both consume. `last-commit`
// always measures staged + unstaged changes against HEAD; `base` keeps the
// resolved-base behavior (falling back to HEAD when no base merge-base
// exists). Returns a fresh CompareBase with `compareTarget` /
// `comparedAgainstRef` / `targetsCollapsed` set for the requested target.
export function applyCompareTarget(base: CompareBase, target: CompareTarget): CompareBase {
  const targetsCollapsed = base.mergeBase === null;
  // When collapsed, both targets are really "vs HEAD" regardless of request.
  const effectiveTarget: CompareTarget = targetsCollapsed ? "last-commit" : target;
  const comparedAgainstRef =
    effectiveTarget === "last-commit" ? "HEAD" : base.ref ?? "HEAD";
  return { ...base, compareTarget: target, comparedAgainstRef, targetsCollapsed };
}

// The literal git ref to diff a single file against for this target.
// `base` uses the merge-base SHA (so the diff spans committed + worktree
// changes); `last-commit` and the no-base fallback use HEAD.
export function compareRefForTarget(base: CompareBase, target: CompareTarget): string {
  if (target === "last-commit") {
    return "HEAD";
  }
  return base.mergeBase ?? "HEAD";
}
