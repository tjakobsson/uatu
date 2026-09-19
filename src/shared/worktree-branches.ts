// Presentation/input rules only. Ref inventory and operations belong to callers.

// The branch-naming rules (WORKTREE_BRANCH_NAME_MAX_LENGTH,
// validWorktreeBranch, initialWorktreeBase, localTrackingBranch) are defined
// exactly once, inside src/shell/worktree-dialog.ts's installWorktreeDialog()
// — the same function whose toString() the Hub dashboard inlines verbatim as
// a plain <script> (worktreeDialogScript; see that file's header for why the
// rules live there and not here). Re-exporting them from this call, rather
// than redefining them, keeps one source of truth for both the server (which
// imports this module directly, e.g. src/hub/worktree-api.ts) and every
// client surface. installWorktreeDialog never touches the DOM merely by
// being called, so calling it here with an inert `{}` target is safe with no
// `document`/`window` in scope, exactly as it is on the server.
//
// A branch IS the child's display name (src/hub/worktree-registrar.ts), so it
// must satisfy the registry's own display-name ceiling
// (src/hub/registry.ts WORKSPACE_DISPLAY_NAME_MAX_LENGTH) or registration
// throws after Git has already created the checkout and branch — an
// unrecoverable "Retry registration" loop. worktree-branches.test.ts asserts
// the two ceilings stay in sync.
import { installWorktreeDialog } from "../shell/worktree-dialog";

const branchRules = installWorktreeDialog({} as Record<string, unknown>);

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
