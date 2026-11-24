// The checked-out branch's pull request base, per repository root
// (add-github-pr-review D7). The GitHub service (src/github/gh-service.ts)
// sets it from its last summary; base resolution (git-base-ref.ts) reads it
// synchronously, so the repository sweep and the document Diff view measure
// `base` from the pull request's base without asking GitHub. Kept here, in
// the document domain, so nothing on the file-observation path imports
// src/github (tests/github-guard.test.ts).
//
// A change of association or base notifies the listeners (the session
// re-collects Git data: changed files depend on the base). The override
// names the branch it was detected on and applies only while that branch is
// checked out, so switching away falls back to the default resolution at
// once, before GitHub is asked again.

export type PullRequestBaseOverride = {
  number: number;
  // The base repository's local remote (D3), e.g. `origin`.
  remote: string;
  baseRefName: string;
  baseRefOid: string;
  // The local branch the pull request was detected for.
  branch: string;
};

const overrides = new Map<string, PullRequestBaseOverride>();
const listeners = new Set<(repoRoot: string) => void>();
// Bumped when a fetch made the base's commits local: the same override can
// resolve differently now (stale → exact).
const fetches = new Map<string, number>();

function identity(override: PullRequestBaseOverride | null | undefined): string {
  return override ? JSON.stringify([override.number, override.remote, override.baseRefName, override.baseRefOid, override.branch]) : "";
}

// The key base caches add to their own (diff.ts): a new base invalidates.
export function pullRequestBaseKey(repoRoot: string): string {
  return `${identity(overrides.get(repoRoot))}#${fetches.get(repoRoot) ?? 0}`;
}

export function pullRequestBaseFor(repoRoot: string): PullRequestBaseOverride | null {
  return overrides.get(repoRoot) ?? null;
}

export function setPullRequestBase(repoRoot: string, override: PullRequestBaseOverride | null): void {
  const before = identity(overrides.get(repoRoot));
  if (override) overrides.set(repoRoot, override);
  else overrides.delete(repoRoot);
  if (identity(override) === before) return;
  for (const listener of listeners) listener(repoRoot);
}

// The explicit fetch brought refs in: resolve and collect again.
export function pullRequestRefsFetched(repoRoot: string): void {
  fetches.set(repoRoot, (fetches.get(repoRoot) ?? 0) + 1);
  for (const listener of listeners) listener(repoRoot);
}

export function onPullRequestBaseChange(listener: (repoRoot: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Forgets every override without notifying (a test or e2e reset).
export function clearPullRequestBases(): void {
  overrides.clear();
  fetches.clear();
}
