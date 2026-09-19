// The Git-dependency guard on the Hub's generic folder rename.
//
// The folder manager renames directories and rewrites registry paths. Git
// worktrees make some of those moves destructive in a way no filesystem
// check can see: a linked checkout's `.git` file and the main repository's
// `worktrees/<name>/gitdir` record each other by ABSOLUTE path, so moving
// either end breaks the pair — including for checkouts Uatu never
// registered and cannot see in its registry.
//
// So the guard asks Git, not the registry. Three verdicts:
//   safe          nothing that moves is part of a worktree structure.
//   blocked       a move would invalidate a linked checkout, a main
//                 checkout, a common Git directory, or an ancestor of one.
//   inconclusive  safety could not be established. The caller refuses; that
//                 is the whole point of naming this case separately.
//
// Deliberate non-goals (design §6): no `git worktree repair`, no moving Git
// structures on the user's behalf, and no host-wide scanning. The subtree
// walk below is bounded and exists only to find checkouts that would travel
// with the folder.
//
// Submodules: a submodule's `.git` file points at
// `<superproject>/.git/modules/<name>` RELATIVELY, so moving a whole
// superproject does not break it, and the guard allows that move. But a
// submodule can own linked worktrees of its own, whose gitdir pointers are
// absolute — so every submodule Git directory under `<common>/modules` is
// inspected with the same rule, and a superproject whose submodule owns a
// linked tree outside the move is blocked.

import { promises as nodeFs, type Dirent } from "node:fs";
import path from "node:path";

import { isPathAtOrBelow, normalizeAbsolutePath } from "./path-reservations";
import { listWorktrees, repositoryContext, type WorktreeGitOptions } from "./worktree-git";

export type RenameGuardVerdict =
  | { readonly kind: "safe" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "inconclusive"; readonly reason: string };

// What the folder manager holds: one call, one verdict, no Git knowledge.
export type WorktreeDependencyProbe = (source: string) => Promise<RenameGuardVerdict>;

export type RenameGuardOptions = WorktreeGitOptions & {
  fs?: Pick<typeof nodeFs, "lstat" | "readdir" | "access">;
  // Bounds on the "what would travel with this folder" walk.
  maxDepth?: number;
  maxEntries?: number;
};

const BLOCKED_REASON =
  "This folder is part of a Git worktree structure. Moving it would break links between checkouts and their repository, including checkouts that are not registered in Uatu. Nothing was moved.";
const INCONCLUSIVE_REASON =
  "Uatu could not establish whether moving this folder would break Git worktree links, so the rename was refused. Nothing was moved. Check the repository with git worktree list, then retry.";

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await nodeFs.realpath(candidate);
  } catch {
    return candidate;
  }
}

async function exists(fs: NonNullable<RenameGuardOptions["fs"]>, candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

// A directory that IS a Git directory (bare repository or a separate
// `--separate-git-dir` target). It carries no `.git` marker of its own, yet
// can own linked worktrees anywhere on the host.
async function looksLikeGitDirectory(fs: NonNullable<RenameGuardOptions["fs"]>, directory: string): Promise<boolean> {
  const [head, objects, refs] = await Promise.all([
    exists(fs, path.join(directory, "HEAD")),
    exists(fs, path.join(directory, "objects")),
    exists(fs, path.join(directory, "refs")),
  ]);
  return head && objects && refs;
}

// Every place under `source` (and the nearest ancestor above it) that could
// belong to a repository. Bounded: a deep or enormous tree stops the walk
// and yields an inconclusive verdict rather than an unbounded scan.
async function findGitLocations(
  source: string,
  options: Required<Pick<RenameGuardOptions, "maxDepth" | "maxEntries">> & { fs: NonNullable<RenameGuardOptions["fs"]> },
): Promise<{ locations: string[]; truncated: boolean }> {
  const { fs } = options;
  const locations: string[] = [];
  // Above: the closest ancestor holding a `.git` entry. Git itself walks up
  // the same way, so this finds the checkout `source` lives in.
  let ancestor = path.dirname(source);
  for (;;) {
    if (await exists(fs, path.join(ancestor, ".git"))) {
      locations.push(ancestor);
      break;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  let visited = 0;
  let truncated = false;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (await exists(fs, path.join(directory, ".git")) || await looksLikeGitDirectory(fs, directory)) {
      locations.push(directory);
      // The walk stops at a checkout: `worktree list` answers for all of its
      // contents. Its submodules are picked up from `<common>/modules`
      // instead, which is cheap and bounded — descending into a checkout's
      // working tree is not.
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true }) as Dirent[];
    } catch {
      truncated = true;
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      // A leaf at the depth limit is fully examined. A child directory is
      // not: it may hide a checkout, so do not report a partial scan as safe.
      if (depth >= options.maxDepth) {
        truncated = true;
        return;
      }
      visited += 1;
      if (visited > options.maxEntries) {
        truncated = true;
        return;
      }
      await walk(path.join(directory, entry.name), depth + 1);
    }
  };
  await walk(source, 0);
  return { locations: [...new Set(locations)], truncated };
}

// Submodule Git directories live under `<common>/modules/<name>` (nested
// submodules recursively below that). They carry no `.git` marker, they move
// with the superproject, and a submodule can own linked worktrees of its own
// anywhere on the host — so each is inspected like any other repository.
async function findSubmoduleGitDirectories(
  commonDirectory: string,
  fs: NonNullable<RenameGuardOptions["fs"]>,
  maxDepth: number,
  maxEntries: number,
): Promise<{ locations: string[]; truncated: boolean }> {
  const found: string[] = [];
  let truncated = false;
  let visited = 0;
  const walk = async (directory: string, depth: number, optional = false): Promise<void> => {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true }) as Dirent[];
    } catch (error) {
      // Repositories need not have a modules directory. Other failures (or
      // a discovered directory disappearing) leave inspection incomplete.
      if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") truncated = true;
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (!entry.isDirectory()) continue;
      if (depth > maxDepth || ++visited > maxEntries) {
        truncated = true;
        return;
      }
      const candidate = path.join(directory, entry.name);
      if (await looksLikeGitDirectory(fs, candidate)) {
        found.push(candidate);
        await walk(path.join(candidate, "modules"), depth + 1, true);
      } else {
        await walk(candidate, depth + 1);
      }
    }
  };
  await walk(path.join(commonDirectory, "modules"), 0, true);
  return { locations: found, truncated };
}

// Refuses the moves that would invalidate a worktree dependency, and only
// those: an ordinary folder, an unrelated sibling, a subfolder inside a
// checkout, and a repository with no linked worktrees all stay renameable.
export function createWorktreeRenameGuard(options: RenameGuardOptions = {}): WorktreeDependencyProbe {
  const fs = options.fs ?? nodeFs;
  const maxDepth = options.maxDepth ?? 6;
  const maxEntries = options.maxEntries ?? 4_000;
  return async (rawSource: string): Promise<RenameGuardVerdict> => {
    // Canonical, because Git answers in canonical paths: on macOS a
    // /var/folders source and Git's /private/var/folders answer are the same
    // directory, and a lexical comparison would miss every dependency.
    const source = await canonicalPath(normalizeAbsolutePath(rawSource));
    const { locations, truncated } = await findGitLocations(source, { fs, maxDepth, maxEntries });
    if (truncated) return { kind: "inconclusive", reason: INCONCLUSIVE_REASON };
    // No Git marker above or below: no worktree dependency can exist, and
    // the rename stays available on a host without Git at all.
    if (locations.length === 0) return { kind: "safe" };

    const inspected = new Set<string>();
    const queue = [...locations];
    for (let index = 0; index < queue.length; index += 1) {
      const location = queue[index]!;
      const context = await repositoryContext(location, options);
      if (context.kind === "indeterminate") return { kind: "inconclusive", reason: INCONCLUSIVE_REASON };
      if (context.kind === "not-a-repository") continue;
      if (inspected.has(context.identity.repositoryId)) continue;
      inspected.add(context.identity.repositoryId);
      const submodules = await findSubmoduleGitDirectories(context.commonDirectory, fs, maxDepth, maxEntries);
      if (submodules.truncated) return { kind: "inconclusive", reason: INCONCLUSIVE_REASON };
      queue.push(...submodules.locations);

      const inventory = await listWorktrees(location, options);
      if (inventory.kind === "indeterminate") return { kind: "inconclusive", reason: INCONCLUSIVE_REASON };
      // One record means one checkout and no linked trees: nothing records
      // an absolute path to anything, so the move breaks no link.
      if (inventory.records.length <= 1) continue;

      // With linked trees present, ANY end of the structure travelling with
      // the folder breaks a recorded absolute path — the common directory,
      // the main checkout, a linked checkout, or an ancestor of one.
      const dependencies = [context.commonDirectory, ...inventory.records.map(record => record.path)];
      for (const dependency of dependencies) {
        // A path Git lists but the filesystem cannot resolve (a pruned or
        // externally removed tree) falls back to what Git reported.
        const resolved = await canonicalPath(dependency);
        if (isPathAtOrBelow(resolved, source) || isPathAtOrBelow(dependency, source)) {
          return { kind: "blocked", reason: BLOCKED_REASON };
        }
      }
    }
    return { kind: "safe" };
  };
}
