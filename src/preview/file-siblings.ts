import type { DocumentMeta, RootGroup, Scope } from "../shared/types";
import { compareFileNames } from "../shared/file-order";

export type FileDestination = Pick<DocumentMeta, "id" | "rootId" | "relativePath">;
export type FileSiblings = { kind: "ready"; files: DocumentMeta[]; index: number } | { kind: "missing-target" | "ambiguous" };

export function fileSiblings(roots: readonly RootGroup[], scope: Scope, target: FileDestination): FileSiblings {
  if (roots.flatMap(root => root.docs).filter(doc => doc.id === target.id).length > 1) return { kind: "ambiguous" };
  const matchingRoots = roots.filter(root => root.id === target.rootId);
  if (matchingRoots.length > 1) return { kind: "ambiguous" };
  const root = matchingRoots[0];
  if (!root || (scope.kind === "file" && scope.documentId !== target.id)) return { kind: "missing-target" };
  const parent = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
  const files = root.docs.filter(doc => doc.rootId === root.id
    && parent(doc.relativePath) === parent(target.relativePath)
    && (scope.kind === "folder" || doc.id === scope.documentId));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const file of files) {
    if (ids.has(file.id) || paths.has(file.relativePath)) return { kind: "ambiguous" };
    ids.add(file.id);
    paths.add(file.relativePath);
  }
  files.sort((a, b) => compareFileNames(a.relativePath.slice(parent(a.relativePath).length), b.relativePath.slice(parent(b.relativePath).length)));
  const index = files.findIndex(doc => doc.id === target.id && doc.relativePath === target.relativePath);
  return index < 0 ? { kind: "missing-target" } : { kind: "ready", files, index };
}
