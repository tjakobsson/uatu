// A document's Diff view, for a file the workspace's current pull request
// changes, offers "Review this file in #n": the pull request's Files changed,
// scrolled to that file, is where line comments are made. The document Diff
// compares against the workspace's compare base, not the pull request's
// base, so it offers no commenting of its own.

// (diff.ts builds the link; this module is the rule.)

import type { DocumentMeta, RepositorySnapshot, RootGroup } from "../shared/types";

// The document's path relative to its repository's root, as a pull request
// names files; null when the document is outside the repository.
export function repositoryRelativePath(repositoryRoot: string, watchedRoot: string, relativePath: string): string | null {
  const trim = (path: string) => path.replace(/\/+$/, "");
  const absolute = `${trim(watchedRoot)}/${relativePath.replace(/^\/+/, "")}`;
  const prefix = `${trim(repositoryRoot)}/`;
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : null;
}

// The repository, pull request and file path for a document the current
// pull request changes; null otherwise.
export function pullRequestFileFor(
  doc: Pick<DocumentMeta, "rootId" | "relativePath">,
  roots: readonly Pick<RootGroup, "id" | "path">[],
  repositories: readonly Pick<RepositorySnapshot, "id" | "rootPath" | "watchedRootIds">[],
  current: { repositoryId: string | null; number: number | null; files: readonly { path: string }[] | null },
): { repositoryId: string; number: number; path: string } | null {
  if (!current.repositoryId || current.number === null || !current.files) return null;
  const repository = repositories.find(candidate => candidate.id === current.repositoryId);
  const root = roots.find(candidate => candidate.id === doc.rootId);
  if (!repository || !root || !repository.watchedRootIds.includes(root.id)) return null;
  const path = repositoryRelativePath(repository.rootPath, root.path, doc.relativePath);
  if (!path || !current.files.some(file => file.path === path)) return null;
  return { repositoryId: repository.id, number: current.number, path };
}
