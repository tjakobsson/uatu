// Bounded, non-force worktree creation (task 4.1).
//
// Two halves, deliberately separated so the rules can be tested without a
// repository and the mutation can be tested against a real one:
//
//   planWorktreeCreation()  every refusal that is knowable BEFORE Git runs —
//     branch grammar, ref availability, branch occupancy, name collision,
//     destination occupancy. It returns the exact branch, base and
//     destination the mutation will use; nothing downstream re-derives them.
//   buildWorktreeAddArguments()/runWorktreeAdd()  the one `git worktree add`
//     invocation. It never passes --force, -f, --detach or a reset: a branch
//     checked out elsewhere is refused and its existing checkout is offered.
//
// Three modes (design §3):
//   new-branch       a new local branch from an EXPLICITLY selected base,
//                    local or remote-qualified. `--no-track` keeps the new
//                    branch's upstream unset even from a remote base, so
//                    "new branch" never silently becomes a tracking branch
//                    through branch.autoSetupMerge.
//   existing-local   an existing local branch, never reset.
//   remote-tracking  a new local branch whose name is the remote ref minus
//                    its remote prefix, with `--track` establishing exactly
//                    the selected upstream. An existing local name of that
//                    spelling is a conflict, never a reset.
//
// The source checkout's working tree is irrelevant to all of it: a dirty
// source neither blocks creation nor travels into the new checkout.

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  localTrackingBranch,
  validWorktreeBranch,
  worktreeDestinationCandidates,
} from "../shared/worktree-branches";
import {
  WorktreeOperationError,
  type WorktreeCreateMode,
  type WorktreeCreateRequest,
} from "../shared/worktree-contract";
import {
  assertGitArgumentSafe,
  checkoutForBranch,
  type GitRunner,
  type WorktreeRecord,
} from "./worktree-git";

export type WorktreeCreationPlan = {
  readonly mode: WorktreeCreateMode;
  // The exact local branch, slashes included. Also the child's display name.
  readonly branch: string;
  readonly base: { readonly kind: "local" | "remote"; readonly ref: string };
  // The immutable creation snapshot recorded before the mutation. Absent for
  // an existing branch with no recorded history: its origin is unknown.
  readonly sourceRef?: string;
  // The upstream this creation establishes, set only for remote-tracking.
  readonly upstream?: string;
  readonly destination: string;
  // True when the preferred destination was taken and the deterministic
  // branch-derived sibling was used instead.
  readonly disambiguated: boolean;
};

export type WorktreeCreationInput = {
  readonly request: Pick<WorktreeCreateRequest, "mode" | "branch" | "base">;
  // The repository's main checkout folder: destinations are its siblings.
  readonly mainPath: string;
  readonly refs: { readonly local: readonly string[]; readonly remote: readonly string[] };
  readonly records: readonly WorktreeRecord[];
  // Whether a filesystem entry exists at a candidate destination. Injected
  // so the rules are testable without a filesystem.
  readonly occupied: (candidate: string) => Promise<boolean>;
  // The recorded creation source of an EXISTING local branch, if Uatu
  // created that branch earlier. Only used by existing-local mode.
  readonly branchOrigin?: string;
};

function refuse(
  code: Parameters<typeof WorktreeOperationError.of>[0],
  message: string,
  extra?: Parameters<typeof WorktreeOperationError.of>[2],
): never {
  throw WorktreeOperationError.of(code, message, extra);
}

// The target branch each mode names. Derivation is explicit and total: no
// mode guesses a name from the repository's current checkout.
export function targetBranchFor(request: Pick<WorktreeCreateRequest, "mode" | "branch" | "base">): string {
  if (request.mode === "new-branch") {
    return request.branch ?? refuse("invalid-input", "A new branch needs a name.");
  }
  const derived = request.mode === "remote-tracking" ? localTrackingBranch(request.base.ref) : request.base.ref;
  if (request.branch !== undefined && request.branch !== derived) {
    refuse("invalid-input", "The requested branch does not match the selected ref.");
  }
  return derived;
}

export async function planWorktreeCreation(input: WorktreeCreationInput): Promise<WorktreeCreationPlan> {
  const { request, refs, records } = input;
  const branch = targetBranchFor(request);
  // Grammar first, before any value can reach a Git argument list: an
  // option-like name ("-f"), a revision expression, a traversal or a
  // control character never becomes an argument at all.
  if (!validWorktreeBranch(branch)) refuse("invalid-input", "Use a valid branch name, not an option, path traversal or revision expression.");
  assertGitArgumentSafe(branch, "branch");
  assertGitArgumentSafe(request.base.ref, "starting branch");

  const available = request.base.kind === "local" ? refs.local : refs.remote;
  if (!available.includes(request.base.ref)) {
    refuse("ref-unavailable", "The selected branch is no longer available. Choose another branch; no ref was substituted.", { retry: "refresh" });
  }
  if (request.mode !== "existing-local" && refs.local.includes(branch)) {
    refuse("branch-exists", "That branch name already exists. Choose another name or use Existing branch; no branch was reset.");
  }
  // Occupancy is per repository identity: the same branch name in another
  // repository is not a conflict.
  const occupant = checkoutForBranch(records, branch);
  if (occupant) {
    refuse("branch-in-use", "That branch is already checked out. Open its existing checkout instead; it cannot be forced into another tree.", {
      retry: "open-existing",
      conflictCheckoutId: occupant.path,
    });
  }

  const [preferred, fallback] = worktreeDestinationCandidates(input.mainPath, branch);
  let destination = preferred;
  let disambiguated = false;
  if (await input.occupied(preferred)) {
    destination = fallback;
    disambiguated = true;
    if (await input.occupied(fallback)) {
      refuse("destination-occupied", "The destination folder already exists. Existing content was preserved; resolve the collision outside Uatu.");
    }
  }
  assertGitArgumentSafe(destination, "destination");
  return {
    mode: request.mode,
    branch,
    base: request.base,
    // The snapshot is the ref the user explicitly selected, remote-qualified
    // spelling included — never the parent's current checkout. Checking out
    // an existing branch creates no branch, so it snapshots nothing: its
    // origin is whatever history was recorded when it WAS created, if any.
    ...(request.mode === "existing-local"
      ? (input.branchOrigin === undefined ? {} : { sourceRef: input.branchOrigin })
      : { sourceRef: request.base.ref }),
    ...(request.mode === "remote-tracking" ? { upstream: request.base.ref } : {}),
    destination,
    disambiguated,
  };
}

export async function destinationOccupied(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    // An unreadable destination is not provably free; refusing keeps a
    // creation from writing into something it cannot see.
    refuse("destination-occupied", "The destination could not be inspected. Nothing was created.");
  }
}

// Every flag this module may ever pass. `git worktree add` also accepts
// --force/-f/--detach/--reason; none of them appears here, and
// assertNoForceFlags below is what keeps a later edit honest.
const ALLOWED_FLAGS = new Set(["worktree", "add", "-b", "--track", "--no-track", "--"]);

export function assertNoForceFlags(args: readonly string[]): void {
  for (const arg of args) {
    if (arg.startsWith("-") && !ALLOWED_FLAGS.has(arg)) {
      throw WorktreeOperationError.of("internal", "a worktree creation argument was not allowed");
    }
  }
}

export function buildWorktreeAddArguments(plan: WorktreeCreationPlan): string[] {
  const args = ["worktree", "add"];
  if (plan.mode === "existing-local") {
    // No -b: Git explicitly looks up this name in refs/heads before DWIM
    // revision resolution. Unlike a -b start point, a fully qualified name
    // here detaches HEAD and bypasses branch occupancy protection.
    args.push(plan.destination, plan.branch);
  } else {
    // --track only for the tracking mode, --no-track otherwise: a new branch
    // from a remote base must not acquire an upstream by configuration.
    const baseRef = `refs/${plan.base.kind === "local" ? "heads" : "remotes"}/${plan.base.ref}`;
    args.push(plan.mode === "remote-tracking" ? "--track" : "--no-track", "-b", plan.branch, plan.destination, baseRef);
  }
  assertNoForceFlags(args);
  return args;
}

// Git's own refusals, mapped onto the closed error vocabulary. Anything
// unrecognized stays a sanitized `conflict` rather than being guessed at.
export function classifyWorktreeAddFailure(stderr: string, plan: WorktreeCreationPlan): WorktreeOperationError {
  const text = stderr.toLowerCase();
  if (/is already checked out|already used by worktree/.test(text)) {
    return WorktreeOperationError.of("branch-in-use", "That branch is already checked out. Open its existing checkout instead; it cannot be forced into another tree.", { retry: "open-existing" });
  }
  if (/already exists/.test(text) && /branch/.test(text)) {
    return WorktreeOperationError.of("branch-exists", "That branch name already exists. Choose another name or use Existing branch; no branch was reset.");
  }
  if (/not a valid object name|invalid reference|unknown revision|no such ref/.test(text)) {
    return WorktreeOperationError.of("ref-unavailable", "The selected branch is no longer available. Choose another branch; no ref was substituted.", { retry: "refresh" });
  }
  if (/permission denied|read-only file system/.test(text)) {
    return WorktreeOperationError.of("permission-denied", `The checkout could not be created: ${stderr}`);
  }
  if (/already exists/.test(text)) {
    return WorktreeOperationError.of("destination-occupied", "The destination folder already exists. Existing content was preserved; resolve the collision outside Uatu.");
  }
  return WorktreeOperationError.of("conflict", `Git refused to create the worktree: ${stderr}`, { phase: "creating" });
}

export type WorktreeAddOutcome = { readonly ok: true } | { readonly ok: false; readonly error: WorktreeOperationError };

// Runs the single bounded mutation. The runner owns its timeout and process
// group kill, so a wedged Git leaves no orphan behind.
export async function runWorktreeAdd(
  run: GitRunner,
  sourcePath: string,
  plan: WorktreeCreationPlan,
): Promise<WorktreeAddOutcome> {
  const result = await run(buildWorktreeAddArguments(plan), sourcePath);
  if (result.exitCode === 0 && !result.timedOut) return { ok: true };
  if (result.timedOut) {
    return {
      ok: false,
      error: WorktreeOperationError.of("timeout", "Creating the worktree timed out. Nothing was forced; refresh the inventory to see what exists.", { retry: "refresh", phase: "creating" }),
    };
  }
  return { ok: false, error: classifyWorktreeAddFailure(result.stderr || result.stdout, plan) };
}

// The repository's main checkout folder, derived from the canonical common
// directory (`<main>/.git`). A bare repository or a `--separate-git-dir`
// main checkout has no `.git` sibling to place worktrees beside, so it is
// refused as a creation source rather than half-handled (worktree-git's
// documented unsupported set).
export function mainCheckoutPathFor(commonDirectory: string): string {
  if (path.basename(commonDirectory) !== ".git") {
    refuse("git-unsupported", "This repository layout cannot host Uatu worktree destinations.");
  }
  return path.dirname(commonDirectory);
}
