// Watched-root resolution and filesystem scanning: turning CLI path arguments
// into WatchEntry records, walking them into the document index, and the
// deny-policy for names that must never be indexed or served (VCS internals,
// build output, secrets).

import { promises as fs } from "node:fs";
import path from "node:path";

import { classifyFile } from "../document/classify";
import { loadIgnoreMatcher, type IgnoreMatcher } from "../ignore/engine";
import { safeGit } from "../document/git-base-ref";
import type { DocumentMeta, RootGroup } from "../shared/types";
import { shouldDenyPath } from "../ignore/exposure";
export { shouldDenyPath } from "../ignore/exposure";

export const DEFAULT_RESPECT_GITIGNORE = true;

export type WatchEntry =
  | { kind: "dir"; absolutePath: string }
  | { kind: "file"; absolutePath: string; parentDir: string };

export type NonGitWatchEntry = {
  entry: WatchEntry;
};

export async function findNonGitWatchEntries(entries: WatchEntry[]): Promise<NonGitWatchEntry[]> {
  const checked = await Promise.all(entries.map(async entry => {
    const probePath = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
    const result = await safeGit(probePath, ["rev-parse", "--show-toplevel"]);
    return result.ok && result.stdout.trim()
      ? null
      : { entry };
  }));

  return checked.filter((entry): entry is NonGitWatchEntry => Boolean(entry));
}

export async function resolveWatchRoots(inputPaths: string[], cwd: string): Promise<WatchEntry[]> {
  const resolved = new Map<string, WatchEntry>();

  for (const inputPath of inputPaths) {
    const absolutePath = path.resolve(cwd, inputPath);
    let stat;

    try {
      stat = await fs.stat(absolutePath);
    } catch {
      throw new Error(`root does not exist: ${inputPath}`);
    }

    if (stat.isDirectory()) {
      resolved.set(absolutePath, { kind: "dir", absolutePath });
      continue;
    }

    if (stat.isFile()) {
      if (shouldDenyPath(path.basename(absolutePath))) {
        throw new Error(`path is not viewable: ${inputPath}`);
      }

      const kind = await classifyFile(absolutePath, path.basename(absolutePath));
      if (kind === "binary") {
        throw new Error(`path is a binary file: ${inputPath}`);
      }
      resolved.set(absolutePath, {
        kind: "file",
        absolutePath,
        parentDir: path.dirname(absolutePath),
      });
      continue;
    }

    throw new Error(`path must be a directory or a non-binary file: ${inputPath}`);
  }

  return Array.from(resolved.values()).sort((left, right) =>
    left.absolutePath.localeCompare(right.absolutePath),
  );
}

export type ScanOptions = {
  respectGitignore?: boolean;
  matcherCache?: Map<string, IgnoreMatcher>;
};

export async function scanRoots(
  entries: WatchEntry[],
  options: ScanOptions = {},
): Promise<RootGroup[]> {
  const { respectGitignore = DEFAULT_RESPECT_GITIGNORE, matcherCache } = options;
  const roots: RootGroup[] = [];

  for (const entry of entries) {
    if (entry.kind === "dir") {
      let matcher = matcherCache?.get(entry.absolutePath);
      if (!matcher) {
        matcher = await loadIgnoreMatcher({
          rootPath: entry.absolutePath,
          respectGitignore,
        });
        matcherCache?.set(entry.absolutePath, matcher);
      }

      const walked = await walkAllFiles(entry.absolutePath, entry.absolutePath, matcher);
      roots.push({
        id: entry.absolutePath,
        label: path.basename(entry.absolutePath) || entry.absolutePath,
        path: entry.absolutePath,
        docs: walked.docs.sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        ),
        hiddenCount: walked.hiddenCount,
      });
      continue;
    }

    const stat = await fs.stat(entry.absolutePath).catch(() => null);
    if (!stat) {
      roots.push({
        id: entry.absolutePath,
        label: path.basename(entry.absolutePath),
        path: entry.parentDir,
        docs: [],
        hiddenCount: 0,
      });
      continue;
    }

    const relativePath = path.basename(entry.absolutePath);
    if (shouldDenyPath(relativePath)) {
      roots.push({
        id: entry.absolutePath,
        label: relativePath,
        path: entry.parentDir,
        docs: [],
        hiddenCount: 1,
      });
      continue;
    }

    const kind = await classifyFile(entry.absolutePath, relativePath);
    roots.push({
      id: entry.absolutePath,
      label: relativePath,
      path: entry.parentDir,
      docs: [
        {
          id: entry.absolutePath,
          name: relativePath,
          relativePath,
          mtimeMs: stat.mtimeMs,
          rootId: entry.absolutePath,
          kind,
        },
      ],
      hiddenCount: 0,
    });
  }

  return roots;
}

export function getAssetRoots(entries: WatchEntry[]): string[] {
  return entries.map(entry => (entry.kind === "dir" ? entry.absolutePath : entry.parentDir));
}

type WalkResult = { docs: DocumentMeta[]; hiddenCount: number };

async function walkAllFiles(
  rootPath: string,
  currentPath: string,
  matcher: IgnoreMatcher,
): Promise<WalkResult> {
  const dirEntries = await fs.readdir(currentPath, { withFileTypes: true });
  const docs: DocumentMeta[] = [];
  let hiddenCount = 0;

  for (const entry of dirEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (shouldDenyPath(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    const relativeFromRoot = path
      .relative(rootPath, absolutePath)
      .split(path.sep)
      .join("/");

    if (matcher.shouldIgnore(relativeFromRoot, entry.isDirectory())) {
      // Count files we filter out via the user-controlled matcher. Directories
      // count as one (we don't recurse to count their contents — that would
      // defeat the point of the matcher's perf benefit).
      hiddenCount += 1;
      continue;
    }

    if (entry.isDirectory()) {
      const sub = await walkAllFiles(rootPath, absolutePath, matcher);
      docs.push(...sub.docs);
      hiddenCount += sub.hiddenCount;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stat = await fs.stat(absolutePath);
    const kind = await classifyFile(absolutePath, entry.name);
    docs.push({
      id: absolutePath,
      name: entry.name,
      relativePath: relativeFromRoot,
      mtimeMs: stat.mtimeMs,
      rootId: rootPath,
      kind,
    });
  }

  return { docs, hiddenCount };
}
