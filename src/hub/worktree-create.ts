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
// Four modes (design §3, and D12 of add-github-pr-review):
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
//   pull-request     local branch `pr/<n>` at the pull request's head, fetched
//                    from `refs/pull/<n>/head` on a configured remote (the
//                    service does the fetch; design D12). A new branch gets
//                    that ref as its upstream (`branch.pr/<n>.remote` and
//                    `.merge`), so `git pull` follows the pull request. An
//                    existing `pr/<n>` with exactly that upstream is checked
//                    out as it is, never reset or fast-forwarded; any other
//                    existing `pr/<n>` is a conflict.
//
// The source checkout's working tree is irrelevant to all of it: a dirty
// source neither blocks creation nor travels into the new checkout.

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  localTrackingBranch,
  pullRequestHeadRef,
  pullRequestWorktreeBranch,
  validWorktreeBranch,
  worktreeDestinationCandidates,
} from "../shared/worktree-branches";
import {
  WorktreeOperationError,
  type WorktreeCreateMode,
  type WorktreePullRequestCreateRequest,
  type WorktreeRefCreateRequest,
} from "../shared/worktree-contract";
import {
  assertGitArgumentSafe,
  checkoutForBranch,
  type GitRunner,
  type WorktreeRecord,
} from "./worktree-git";

// What creation needs from a request: everything but who sent it.
export type WorktreeCreationRequest =
  | Pick<WorktreeRefCreateRequest, "mode" | "branch" | "base">
  | Pick<WorktreePullRequestCreateRequest, "mode" | "branch" | "pullRequest">;

// A pull request checkout's own facts, carried from planning to the branch
// creation that precedes `git worktree add`.
export type WorktreePullRequestPlan = {
  readonly number: number;
  readonly remote: string;
  // `refs/pull/<n>/head`: the upstream's merge ref and the creation origin.
  readonly headRef: string;
  // The commit the explicit fetch found there.
  readonly headOid: string;
  // False when an existing `pr/<n>` with exactly this upstream is reused.
  readonly createBranch: boolean;
};

export type WorktreeCreationPlan = {
  readonly mode: WorktreeCreateMode;
  // The exact local branch, slashes included. Also the child's display name.
  readonly branch: string;
  // For a pull request, the local branch the checkout is added on (it exists
  // by then: reused, or created at the fetched head just before).
  readonly base: { readonly kind: "local" | "remote"; readonly ref: string };
  // The immutable creation snapshot recorded before the mutation. Absent for
  // an existing branch with no recorded history: its origin is unknown.
  readonly sourceRef?: string;
  // The upstream this creation establishes or keeps: the remote ref for
  // remote-tracking, `refs/pull/<n>/head` for a pull request.
  readonly upstream?: string;
  readonly pullRequest?: WorktreePullRequestPlan;
  readonly destination: string;
  // True when the preferred destination was taken and the deterministic
  // branch-derived sibling was used instead.
  readonly disambiguated: boolean;
};

// What the service learned about a pull request before planning: the
// fetched head, and the existing `pr/<n>` branch's upstream configuration
// (absent when there is no such branch, empty fields when it has none).
export type WorktreePullRequestFacts = {
  readonly headOid: string;
  readonly existingUpstream?: { readonly remote?: string; readonly merge?: string };
};

export type WorktreeCreationInput = {
  readonly request: WorktreeCreationRequest;
  // The repository's main checkout folder: destinations are its siblings.
  readonly mainPath: string;
  readonly refs: { readonly local: readonly string[]; readonly remote: readonly string[] };
  readonly records: readonly WorktreeRecord[];
  // Whether a filesystem entry exists at a candidate destination. Injected
  // so the rules are testable without a filesystem.
  readonly occupied: (candidate: string) => Promise<boolean>;
  // The recorded creation source of an EXISTING local branch, if Uatu
  // created that branch earlier. Used by existing-local mode and by a reused
  // pull request branch.
  readonly branchOrigin?: string;
  // Required for pull-request mode, ignored otherwise.
  readonly pullRequest?: WorktreePullRequestFacts;
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
export function targetBranchFor(request: WorktreeCreationRequest): string {
  if (request.mode === "new-branch") {
    return request.branch ?? refuse("invalid-input", "A new branch needs a name.");
  }
  const derived = request.mode === "pull-request"
    ? pullRequestWorktreeBranch(request.pullRequest.number)
    : request.mode === "remote-tracking" ? localTrackingBranch(request.base.ref) : request.base.ref;
  if (request.branch !== undefined && request.branch !== derived) {
    refuse("invalid-input", "The requested branch does not match the selected ref.");
  }
  return derived;
}

// The plan's pull-request half: reuse an existing `pr/<n>` only when its
// upstream is exactly this pull request on this remote. Anything else with
// that name is somebody's branch, and it is never reset.
function planPullRequest(
  request: Pick<WorktreePullRequestCreateRequest, "pullRequest">,
  branch: string,
  exists: boolean,
  facts: WorktreePullRequestFacts | undefined,
): WorktreePullRequestPlan {
  if (!facts) refuse("internal", "The pull request's head was not fetched.");
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(facts.headOid)) refuse("internal", "The pull request's head is not a commit id.");
  const { number, remote } = request.pullRequest;
  const headRef = pullRequestHeadRef(number);
  if (exists) {
    const upstream = facts.existingUpstream;
    if (upstream?.remote !== remote || upstream.merge !== headRef) {
      refuse("branch-exists", `A branch named ${branch} already exists and does not track pull request #${number} on ${remote}. Nothing was reset; rename or delete that branch, then try again.`);
    }
  }
  return { number, remote, headRef, headOid: facts.headOid, createBranch: !exists };
}

export async function planWorktreeCreation(input: WorktreeCreationInput): Promise<WorktreeCreationPlan> {
  const { request, refs, records } = input;
  const branch = targetBranchFor(request);
  // Grammar first, before any value can reach a Git argument list: an
  // option-like name ("-f"), a revision expression, a traversal or a
  // control character never becomes an argument at all.
  if (!validWorktreeBranch(branch)) refuse("invalid-input", "Use a valid branch name, not an option, path traversal or revision expression.");
  assertGitArgumentSafe(branch, "branch");

  let base: WorktreeCreationPlan["base"];
  let pullRequest: WorktreePullRequestPlan | undefined;
  if (request.mode === "pull-request") {
    assertGitArgumentSafe(request.pullRequest.remote, "remote");
    pullRequest = planPullRequest(request, branch, refs.local.includes(branch), input.pullRequest);
    base = { kind: "local", ref: branch };
  } else {
    assertGitArgumentSafe(request.base.ref, "starting branch");
    const available = request.base.kind === "local" ? refs.local : refs.remote;
    if (!available.includes(request.base.ref)) {
      refuse("ref-unavailable", "The selected branch is no longer available. Choose another branch; no ref was substituted.", { retry: "refresh" });
    }
    if (request.mode !== "existing-local" && refs.local.includes(branch)) {
      refuse("branch-exists", "That branch name already exists. Choose another name or use Existing branch; no branch was reset.");
    }
    base = request.base;
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
  // The snapshot is the ref the user explicitly selected, remote-qualified
  // spelling included — never the parent's current checkout. Checking out
  // an existing branch creates no branch, so it snapshots nothing: its
  // origin is whatever history was recorded when it WAS created, if any. A
  // new pull request branch's origin is the pull request's head ref.
  const reused = request.mode === "existing-local" || (pullRequest !== undefined && !pullRequest.createBranch);
  const sourceRef = reused ? input.branchOrigin : pullRequest?.headRef ?? base.ref;
  return {
    mode: request.mode,
    branch,
    base,
    ...(sourceRef === undefined ? {} : { sourceRef }),
    ...(request.mode === "remote-tracking" ? { upstream: base.ref } : {}),
    ...(pullRequest === undefined ? {} : { upstream: pullRequest.headRef, pullRequest }),
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
  if (plan.mode === "existing-local" || plan.mode === "pull-request") {
    // No -b: Git explicitly looks up this name in refs/heads before DWIM
    // revision resolution. Unlike a -b start point, a fully qualified name
    // here detaches HEAD and bypasses branch occupancy protection. A pull
    // request's branch exists by now (runPullRequestBranch below).
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

// --- A pull request's branch -------------------------------------------------

// The commands that make a new `pr/<n>` before `git worktree add` checks it
// out. The upstream is written FIRST: a crash after it leaves only
// configuration for a branch that does not exist yet, and the retry writes
// the same values again. A crash after the branch leaves a `pr/<n>` with
// exactly this upstream, which the retry reuses. `--no-track` keeps Git's
// own tracking setup out of it; nothing here can reset an existing branch,
// because `git branch` without -f refuses an existing name.
export function buildPullRequestBranchCommands(plan: WorktreeCreationPlan): string[][] {
  const pullRequest = plan.pullRequest;
  if (!pullRequest?.createBranch) return [];
  const key = `branch.${plan.branch}`;
  const commands = [
    ["config", `${key}.remote`, pullRequest.remote],
    ["config", `${key}.merge`, pullRequest.headRef],
    ["branch", "--no-track", plan.branch, pullRequest.headOid],
  ];
  // `--no-track` is the one flag; every other value is a name or an id that
  // must not read as an option.
  for (const args of commands) {
    for (const arg of args.slice(1)) if (arg !== "--no-track") assertGitArgumentSafe(arg, "pull request branch");
  }
  return commands;
}

export async function runPullRequestBranch(
  run: GitRunner,
  sourcePath: string,
  plan: WorktreeCreationPlan,
): Promise<WorktreeAddOutcome> {
  for (const args of buildPullRequestBranchCommands(plan)) {
    const result = await run(args, sourcePath);
    if (result.exitCode === 0 && !result.timedOut) continue;
    if (result.timedOut) {
      return { ok: false, error: WorktreeOperationError.of("timeout", "Creating the pull request's branch timed out. Nothing was checked out; try again.", { phase: "creating" }) };
    }
    const stderr = result.stderr || result.stdout;
    if (/already exists/i.test(stderr)) {
      return { ok: false, error: WorktreeOperationError.of("branch-exists", `A branch named ${plan.branch} appeared meanwhile. Nothing was reset; try again to check it out.`, { phase: "creating" }) };
    }
    if (/could not lock|unable to (?:create|lock)/i.test(stderr)) {
      return { ok: false, error: WorktreeOperationError.of("git-lock", `The repository is locked by another Git process. Nothing was checked out; try again. ${stderr}`, { phase: "creating" }) };
    }
    return { ok: false, error: WorktreeOperationError.of("conflict", `Git refused to create ${plan.branch}: ${stderr}`, { phase: "creating" }) };
  }
  return { ok: true };
}

// The upstream configuration of an existing local branch: what decides
// whether a `pr/<n>` may be reused. Exit 1 is "not set".
export async function readBranchUpstream(
  run: GitRunner,
  sourcePath: string,
  branch: string,
): Promise<{ remote?: string; merge?: string }> {
  assertGitArgumentSafe(branch, "branch");
  const read = async (field: "remote" | "merge"): Promise<string | undefined> => {
    const result = await run(["config", "--get", `branch.${branch}.${field}`], sourcePath);
    if (result.exitCode === 0 && !result.timedOut) return result.stdout.trim() || undefined;
    if (result.exitCode === 1 && !result.timedOut) return undefined;
    throw WorktreeOperationError.of("inventory-unavailable", `The configuration of ${branch} could not be read. Nothing was created; try again.`, { retry: "refresh" });
  };
  const [remote, merge] = [await read("remote"), await read("merge")];
  return { ...(remote === undefined ? {} : { remote }), ...(merge === undefined ? {} : { merge }) };
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
