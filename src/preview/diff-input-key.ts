// What a document's diff depends on in the repository data: HEAD, the
// resolved compare base, and the document's own entry in the changed-files
// context (path, status, rename source). A repository update that leaves this
// key unchanged cannot change the diff, so the Diff view keeps what it shows.
// Edits to the document itself are tracked separately through its file
// revision.
import type { ChangedFileSummary, CompareTarget, RepositorySnapshot } from "../shared/types";

function withSlash(directory: string): string {
  return directory.endsWith("/") ? directory : `${directory}/`;
}

function within(directory: string, file: string): boolean {
  return file === directory || file.startsWith(withSlash(directory));
}

// The repository's changed-files paths are relative to its top level, which
// Git reports as a real path (/private/tmp/...), while document ids keep the
// watched root's spelling (/tmp/...). Ownership therefore goes through the
// watched roots, whose ids share the documents' spelling; the top level is
// only used for the root's offset when it is spelled the same way.
function changeEntry(owner: RepositorySnapshot, documentId: string, rootId: string): ChangedFileSummary | undefined {
  const fromRoot = documentId.slice(withSlash(rootId).length);
  if (within(owner.rootPath, rootId)) {
    const relative = documentId.slice(withSlash(owner.rootPath).length);
    return owner.changedFiles.find(file => file.path === relative || file.oldPath === relative);
  }
  // Spelled differently: the repository-relative path ends with the
  // root-relative one. The longest such entry is the most specific.
  const matches = (candidate: string | null) => candidate !== null && (candidate === fromRoot || candidate.endsWith(`/${fromRoot}`));
  return owner.changedFiles
    .filter(file => matches(file.path) || matches(file.oldPath))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function diffInputKey(documentId: string, repositories: readonly RepositorySnapshot[], compareTarget: CompareTarget): string {
  // The innermost watched root containing the document picks its repository.
  let owner: RepositorySnapshot | undefined;
  let ownerRoot = "";
  for (const repository of repositories) {
    for (const rootId of repository.watchedRootIds) {
      if (rootId !== documentId && !documentId.startsWith(withSlash(rootId))) continue;
      if (rootId.length > ownerRoot.length) { owner = repository; ownerRoot = rootId; }
    }
  }
  if (!owner) return JSON.stringify([compareTarget, null]);
  const entry = changeEntry(owner, documentId, ownerRoot);
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
