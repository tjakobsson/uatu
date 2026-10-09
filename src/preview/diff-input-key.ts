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
// watched roots, whose ids share the documents' spelling. The root's offset
// inside the repository comes from the top level when both are spelled alike,
// otherwise from where the top level's name appears in the root's path.
function segmentsOf(value: string): string[] {
  return value.split("/").filter(Boolean);
}

function rootOffset(owner: RepositorySnapshot, rootId: string): string | null {
  if (within(owner.rootPath, rootId)) return rootId.slice(withSlash(owner.rootPath).length).replace(/\/$/, "");
  const name = segmentsOf(owner.rootPath).at(-1);
  const segments = segmentsOf(rootId);
  for (let below = 0; below < segments.length; below++) {
    if (segments[segments.length - 1 - below] === name) return segments.slice(segments.length - below).join("/");
  }
  return null;
}

function changeEntry(owner: RepositorySnapshot, documentId: string, rootId: string): ChangedFileSummary | undefined {
  const fromRoot = documentId.slice(withSlash(rootId).length);
  const offset = rootOffset(owner, rootId);
  if (offset !== null) {
    const relative = offset ? `${offset}/${fromRoot}` : fromRoot;
    return owner.changedFiles.find(file => file.path === relative || file.oldPath === relative);
  }
  // The top level's name never appears (a renamed symlink): an entry must be
  // the root-relative path under a prefix that is itself a trailing part of
  // the root's path. The longest such prefix is the most specific.
  const segments = segmentsOf(rootId);
  const fits = (candidate: string | null) => {
    if (candidate === null) return false;
    if (candidate === fromRoot) return true;
    if (!candidate.endsWith(`/${fromRoot}`)) return false;
    const prefix = segmentsOf(candidate.slice(0, -fromRoot.length));
    return prefix.every((segment, index) => segments[segments.length - prefix.length + index] === segment);
  };
  return owner.changedFiles
    .filter(file => fits(file.path) || fits(file.oldPath))
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
