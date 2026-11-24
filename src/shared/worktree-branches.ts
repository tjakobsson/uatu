// Presentation/input rules only. Ref inventory and operations belong to callers.

// A branch IS the child's display name (src/hub/worktree-registrar.ts), so it
// must satisfy the registry's own display-name ceiling
// (src/hub/registry.ts WORKSPACE_DISPLAY_NAME_MAX_LENGTH) or registration
// throws after Git has already created the checkout and branch — an
// unrecoverable "Retry registration" loop. worktree-branches.test.ts asserts
// the two ceilings stay in sync.
// Self-contained scope: serialized clients receive dependencies by stable
// property keys, never by concatenating independently minified identifiers.
export function createWorktreeBranchRules() {
  const WORKTREE_BRANCH_NAME_MAX_LENGTH = 64;
  function validWorktreeBranch(branch: string): boolean {
    return Boolean(branch) && branch !== "@" && [...branch].length <= WORKTREE_BRANCH_NAME_MAX_LENGTH
      && !/^[-/]|[\s\x00-\x1f\x7f~^:?*\\\[]|\.\.|@\{|\/\//.test(branch)
      && !/[/.]$/.test(branch) && branch.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"));
  }
  function initialWorktreeBase(local: readonly string[], remote: readonly string[]): string {
    if (local.includes("main")) return "local:main";
    const mains = remote.filter(ref => ref.slice(ref.indexOf("/") + 1) === "main");
    return mains.length === 1 ? `remote:${mains[0]}` : "";
  }
  function localTrackingBranch(remoteRef: string): string {
    const separator = remoteRef.indexOf("/");
    return separator < 0 ? remoteRef : remoteRef.slice(separator + 1);
  }
  // A pull request checkout (the `pull-request` create mode). GitHub numbers
  // pull requests from 1; the ceiling keeps the number a plain integer that
  // never needs exponent notation in a ref.
  const WORKTREE_PULL_REQUEST_NUMBER_MAX = 2_147_483_647;
  function validPullRequestNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= WORKTREE_PULL_REQUEST_NUMBER_MAX;
  }
  // A configured remote's name, as the request names it. Deliberately
  // narrower than Git's own grammar (no slash, no leading dot or dash), so a
  // name can never read as an option, a URL, a path or a refspec.
  function validWorktreeRemoteName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.includes("..") && !name.endsWith(".lock");
  }
  // The local branch of a pull request checked out by number: `pr/<n>`. It
  // cannot collide with a fork's `main` or `patch-1`.
  function pullRequestWorktreeBranch(number: number): string {
    return `pr/${number}`;
  }
  // The head ref GitHub publishes for every pull request, forks included.
  function pullRequestHeadRef(number: number): string {
    return `refs/pull/${number}/head`;
  }
  return {
    WORKTREE_BRANCH_NAME_MAX_LENGTH, validWorktreeBranch, initialWorktreeBase, localTrackingBranch,
    WORKTREE_PULL_REQUEST_NUMBER_MAX, validPullRequestNumber, validWorktreeRemoteName, pullRequestWorktreeBranch, pullRequestHeadRef,
  };
}
const branchRules = createWorktreeBranchRules();

export const WORKTREE_BRANCH_NAME_MAX_LENGTH = branchRules.WORKTREE_BRANCH_NAME_MAX_LENGTH;
export const validWorktreeBranch = branchRules.validWorktreeBranch;
export const initialWorktreeBase = branchRules.initialWorktreeBase;
export const localTrackingBranch = branchRules.localTrackingBranch;
export const WORKTREE_PULL_REQUEST_NUMBER_MAX = branchRules.WORKTREE_PULL_REQUEST_NUMBER_MAX;
export const validPullRequestNumber = branchRules.validPullRequestNumber;
export const validWorktreeRemoteName = branchRules.validWorktreeRemoteName;
export const pullRequestWorktreeBranch = branchRules.pullRequestWorktreeBranch;
export const pullRequestHeadRef = branchRules.pullRequestHeadRef;

// The destination folder name. Only the FOLDER is sanitized — the branch and
// the child's display name keep their exact spelling, slashes included.
// Kept deliberately narrow (ASCII, lowercase) so the path is typable in a
// terminal on every filesystem; two branches can therefore sanitize to the
// same folder, which worktreeDestinationCandidates disambiguates.
export function worktreeFolderName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase().slice(0, 100).replace(/^-+/, "") || "branch";
}

// FNV-1a over the exact branch: a deterministic, collision-disambiguating
// suffix that is stable across restarts and hosts, so a retried creation
// targets the same destination rather than accumulating siblings.
function branchSuffix(branch: string): string {
  let hash = 2166136261;
  for (const character of branch) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// The predetermined sibling destination `<main-folder>.worktrees/<folder>`
// and its one deterministic fallback. There is no destination form and no
// third guess: when both are occupied the caller refuses rather than
// overwriting or inventing another path (design §3).
export function worktreeDestinationCandidates(mainPath: string, branch: string): [string, string] {
  const separator = mainPath.includes("\\") && !mainPath.includes("/") ? "\\" : "/";
  const parent = `${mainPath.replace(/[/\\]+$/, "")}.worktrees`;
  const folder = worktreeFolderName(branch);
  return [`${parent}${separator}${folder}`, `${parent}${separator}${folder}-${branchSuffix(branch)}`];
}
