// What a document's diff depends on in the repository data: HEAD, the
// resolved compare base, and the document's own entry in the changed-files
// context (path, status, rename source). A repository update that leaves this
// key unchanged cannot change the diff, so the Diff view keeps what it shows.
// Edits to the document itself are tracked separately through its file
// revision.
import type { CompareTarget, RepositorySnapshot } from "../shared/types";

function withSlash(directory: string): string {
  return directory.endsWith("/") ? directory : `${directory}/`;
}

export function diffInputKey(documentId: string, repositories: readonly RepositorySnapshot[], compareTarget: CompareTarget): string {
  // The innermost repository containing the document owns its diff.
  let owner: RepositorySnapshot | undefined;
  for (const repository of repositories) {
    if (!documentId.startsWith(withSlash(repository.rootPath))) continue;
    if (!owner || repository.rootPath.length > owner.rootPath.length) owner = repository;
  }
  if (!owner) return JSON.stringify([compareTarget, null]);
  const relative = documentId.slice(withSlash(owner.rootPath).length);
  const entry = owner.changedFiles.find(file => file.path === relative || file.oldPath === relative);
  return JSON.stringify([
    compareTarget,
    owner.status,
    owner.metadata.commitShort,
    owner.base.mergeBase ?? owner.base.ref,
    owner.base.compareTarget,
    // Line counts are left out: they move only when the content does, and a
    // content change already re-fetches through the document revision.
    entry ? [entry.path, entry.status, entry.oldPath] : null,
  ]);
}
