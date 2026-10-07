import type { Stats } from "node:fs";
import path from "node:path";
import type { IgnoreMatcher } from "../ignore/engine";
import { shouldDenyPath, type WatchEntry } from "./roots";

export function rootRelative(entry: WatchEntry, file: string): string | null {
  if (entry.kind === "file") return file === entry.absolutePath ? path.basename(file) : null;
  const relative = path.relative(entry.absolutePath, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

export function isPolicyFile(entry: WatchEntry, file: string): boolean {
  return entry.kind === "dir" && path.dirname(file) === entry.absolutePath
    && [".gitignore", ".uatu.json"].includes(path.basename(file));
}

export function createWatchPolicy(entry: WatchEntry, matcher: IgnoreMatcher) {
  // Chokidar consults ignored repeatedly, both with and without stats.
  const hidden = new Set<string>();
  const accepts = (file: string, stats?: Pick<Stats, "isDirectory" | "isSymbolicLink">): boolean => {
    const relative = rootRelative(entry, file);
    if (relative === null) return false;
    if (relative === "") return true;
    if (stats?.isSymbolicLink() || shouldDenyPath(relative)) return false;
    if (entry.kind === "dir" && matcher.shouldIgnore(relative, stats?.isDirectory())) {
      hidden.add(relative);
      return false;
    }
    hidden.delete(relative);
    return true;
  };
  return {
    accepts,
    hidden,
    ignored(file: string, stats?: Pick<Stats, "isDirectory" | "isSymbolicLink">) {
      // Ancestors must be traversable so single-file roots can be reattached
      // after an atomic replacement. Policy files remain observable even
      // when a user rule hides their entries from the tree.
      if (isPolicyFile(entry, file)) return false;
      const relativeToFile = path.relative(file, entry.absolutePath);
      if (relativeToFile === "" || (relativeToFile !== ".." && !relativeToFile.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToFile))) return false;
      return !accepts(file, stats);
    },
  };
}
