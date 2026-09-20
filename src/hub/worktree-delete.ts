// Guarded worktree removal: the read-only safety inspection and the single
// non-force Git mutation (tasks 5.3–5.4). Orchestration — ownership, fences,
// stopping, journaling, Hub cleanup — lives in worktree-service.ts; this
// module answers "may these files be removed right now" and runs
// `git worktree remove` without ever forcing it.
//
// What blocks, and why each is a blocker rather than a warning:
//   * tracked changes, untracked files — Git itself refuses these, but the
//     user deserves the reason before the dialog commits, not after.
//   * IGNORED files — `git worktree remove` deletes them silently. Build
//     output is cheap; a local `.env`, a database or a signing key is not,
//     and Uatu cannot tell them apart. Nothing is copied, so nothing is
//     recoverable: removal refuses while any exist.
//   * `git worktree lock` — an explicit "do not remove" from someone.
//   * a Git operation in progress or paused — somebody outside Uatu is
//     working in that tree right now; Uatu cannot stop them and says so.
//   * a linked worktree nested inside — removing the parent directory would
//     remove another checkout's files with it.
//   * an unreadable status — fails closed.
//
// The branch is never touched: there is no branch argument anywhere here.

import { promises as fs } from "node:fs";
import path from "node:path";

import { WorktreeOperationError } from "../shared/worktree-contract";
import { assertGitArgumentSafe, type GitRunner, type WorktreeRecord } from "./worktree-git";

export type RemovalDataSummary = { tracked: number; untracked: number; ignored: number };

// `git status --porcelain=v1 -z`: `XY <path>` entries, NUL-separated; a
// rename/copy entry is followed by its source path as a separate field.
export function summarizePorcelainStatus(output: string): RemovalDataSummary {
  const summary: RemovalDataSummary = { tracked: 0, untracked: 0, ignored: 0 };
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 3) continue;
    const code = field.slice(0, 2);
    if (code === "??") summary.untracked += 1;
    else if (code === "!!") summary.ignored += 1;
    else {
      summary.tracked += 1;
      if (code.includes("R") || code.includes("C")) index += 1;
    }
  }
  return summary;
}

function blocker(code: Parameters<typeof WorktreeOperationError.of>[0], message: string, retry: "retry-delete" | "none" | "refresh" = "retry-delete"): WorktreeOperationError {
  return WorktreeOperationError.of(code, message, { retry, phase: "preflight" });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    // An unreadable lock location is not proof of absence.
    return true;
  }
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export type RemovalSafetyInput = {
  run: GitRunner;
  checkoutPath: string;
  // The repository's current `git worktree list`, read under the fence.
  records: readonly WorktreeRecord[];
};

// Returns the ONE blocker that stops removal, or undefined when the files
// may be removed now. Read-only.
export async function inspectRemovalSafety(input: RemovalSafetyInput): Promise<WorktreeOperationError | undefined> {
  const { run, checkoutPath, records } = input;
  const record = records.find(candidate => candidate.path === checkoutPath);
  if (!record) {
    return blocker("identity-uncertain", "Git no longer lists this worktree. Refresh the inventory; nothing was removed.", "refresh");
  }
  if (record.locked) {
    return blocker("git-lock", "This worktree is locked in Git. Unlock it outside Uatu if it is safe, then retry. Nothing was removed.");
  }
  const nested = records.find(candidate => inside(checkoutPath, candidate.path));
  if (nested) {
    return blocker("nested-dependency", "Another worktree is inside this folder. Remove or move it first; nothing was removed.");
  }

  // Resolve through Git: linked checkouts have their own operation state,
  // while some paths can be relocated by repository configuration.
  const markers = ["index.lock", "rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "BISECT_START"];
  const markerPaths = await run(["rev-parse", "--path-format=absolute", ...markers.flatMap(marker => ["--git-path", marker])], checkoutPath);
  const resolvedPaths = markerPaths.stdout.trimEnd().split("\n");
  if (markerPaths.exitCode !== 0 || markerPaths.timedOut || markerPaths.outputExceeded || resolvedPaths.length !== markers.length || resolvedPaths.some(resolved => !path.isAbsolute(resolved))) {
    return blocker("identity-uncertain", "The worktree could not be inspected, so it was not removed.");
  }
  for (const resolved of resolvedPaths) {
    if (await exists(resolved)) {
      return blocker("external-activity", "A Git operation appears to be running or paused in this worktree outside Uatu. Finish or abort it, then retry. Nothing was removed.");
    }
  }

  const status = await run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames"], checkoutPath);
  if (status.exitCode !== 0 || status.timedOut || status.outputExceeded) {
    return blocker("identity-uncertain", "The worktree's files could not be inspected, so it was not removed.");
  }
  const summary = summarizePorcelainStatus(status.stdout);
  if (summary.tracked > 0) {
    return blocker("local-data", `It has uncommitted changes (${plural(summary.tracked, "file", "files")}). Commit, stash or discard them, then retry. Nothing was removed.`);
  }
  if (summary.untracked > 0) {
    return blocker("local-data", `It has untracked files (${plural(summary.untracked, "file", "files")}). Commit, move or delete them, then retry. Nothing was removed.`);
  }
  if (summary.ignored > 0) {
    return blocker("local-data", `It has ignored files (${plural(summary.ignored, "file", "files")}), such as build output or local settings, that would be lost. Move or delete them, then retry. Nothing was removed.`);
  }
  return undefined;
}

// `git worktree remove` flags this module may ever pass. Never --force.
const REMOVE_ARGUMENTS = ["worktree", "remove", "--"] as const;

export function buildWorktreeRemoveArguments(checkoutPath: string): string[] {
  if (!path.isAbsolute(checkoutPath)) throw WorktreeOperationError.of("invalid-input", "the checkout path must be absolute");
  assertGitArgumentSafe(checkoutPath, "checkout path");
  const args = [...REMOVE_ARGUMENTS, checkoutPath];
  if (args.some(arg => arg === "-f" || arg === "--force")) throw WorktreeOperationError.of("internal", "a forced removal was requested");
  return args;
}

export function classifyWorktreeRemoveFailure(stderr: string): WorktreeOperationError {
  const text = stderr.toLowerCase();
  if (/modified or untracked files|contains modified|untracked/.test(text)) {
    return WorktreeOperationError.of("local-data", "Git found local changes and did not remove the worktree. Nothing was removed.", { retry: "retry-delete", phase: "removing" });
  }
  if (/locked/.test(text)) {
    return WorktreeOperationError.of("git-lock", "The worktree is locked in Git. Nothing was removed.", { retry: "retry-delete", phase: "removing" });
  }
  if (/submodule/.test(text)) {
    return WorktreeOperationError.of("nested-dependency", "The worktree contains submodules Git will not remove without force. Nothing was removed.", { retry: "none", phase: "removing" });
  }
  if (/main working tree/.test(text)) {
    return WorktreeOperationError.of("ownership-required", "The main checkout cannot be deleted.", { retry: "none", phase: "removing" });
  }
  return WorktreeOperationError.of("conflict", `Git did not remove the worktree: ${stderr}`, { retry: "retry-delete", phase: "removing" });
}

export type WorktreeRemoveOutcome = { readonly ok: true } | { readonly ok: false; readonly error: WorktreeOperationError };

export async function runWorktreeRemove(run: GitRunner, mainPath: string, checkoutPath: string): Promise<WorktreeRemoveOutcome> {
  const result = await run(buildWorktreeRemoveArguments(checkoutPath), mainPath);
  if (result.exitCode === 0 && !result.timedOut) return { ok: true };
  if (result.timedOut) {
    return { ok: false, error: WorktreeOperationError.of("timeout", "Removing the worktree timed out. Refresh the inventory before retrying.", { retry: "refresh", phase: "removing" }) };
  }
  return { ok: false, error: classifyWorktreeRemoveFailure(result.stderr || result.stdout) };
}
