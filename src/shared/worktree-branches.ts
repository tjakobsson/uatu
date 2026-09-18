// Presentation/input rules only. Ref inventory and operations belong to callers.
export function validWorktreeBranch(branch: string): boolean {
  return Boolean(branch) && branch !== "@" && !/^[-/]|[\s\x00-\x1f\x7f~^:?*\\\[]|\.\.|@\{|\/\//.test(branch)
    && !/[/.]$/.test(branch) && branch.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"));
}

export function initialWorktreeBase(local: string[], remote: string[]): string {
  if (local.includes("main")) return "local:main";
  const mains = remote.filter(ref => ref.slice(ref.indexOf("/") + 1) === "main");
  return mains.length === 1 ? `remote:${mains[0]}` : "";
}

// A remote-qualified ref's local tracking name is the ref minus its remote
// prefix ("origin/feature/login" → "feature/login"). No other derivation is
// applied: an existing local name of that spelling is a conflict, never a
// reset (spec: "Remote ref becomes a tracking branch").
export function localTrackingBranch(remoteRef: string): string {
  const separator = remoteRef.indexOf("/");
  return separator < 0 ? remoteRef : remoteRef.slice(separator + 1);
}

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
