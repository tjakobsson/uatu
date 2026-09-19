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
  return { WORKTREE_BRANCH_NAME_MAX_LENGTH, validWorktreeBranch, initialWorktreeBase, localTrackingBranch };
}
const branchRules = createWorktreeBranchRules();

export const WORKTREE_BRANCH_NAME_MAX_LENGTH = branchRules.WORKTREE_BRANCH_NAME_MAX_LENGTH;
export const validWorktreeBranch = branchRules.validWorktreeBranch;
export const initialWorktreeBase = branchRules.initialWorktreeBase;
export const localTrackingBranch = branchRules.localTrackingBranch;

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
