// Repository-level git data sweep — changed files vs the resolved compare
// base, commit log, repository metadata, and the gitignored-files list that
// feeds tree annotations. This is the data layer behind the Change Overview
// pane, the Changed filter, the diff view's base, and the git-log pane.

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ChangedFileSummary,
  CommitLogEntry,
  CompareBase,
  CompareTarget,
  RepositoryMetadata,
  RepositorySnapshot,
  RootGroup,
} from "../shared/types";
import { DEFAULT_COMPARE_TARGET } from "../shared/types";
import type { WatchEntry } from "../server/roots";
import { applyCompareTarget, resolveCompareBase, safeGit } from "./git-base-ref";
import { loadIgnoreConfig } from "../ignore/config";

export { safeGit, setGitMetricsSink } from "./git-base-ref";

const GIT_MAX_BUFFER = 256 * 1024;
const MAX_COMMITS = 100;

type RepositoryGroup = {
  id: string;
  rootPath: string;
  label: string;
  watchedRootIds: string[];
  // Directory watch roots whose `.uatu.json` the ignore engine reads. File
  // entries contribute nothing: single-file roots skip ignore config.
  configRoots: string[];
  status: "git" | "non-git" | "unavailable";
  message: string | null;
};

export async function collectRepositorySnapshots(
  entries: WatchEntry[],
  roots: RootGroup[],
  compareTarget: CompareTarget = DEFAULT_COMPARE_TARGET,
): Promise<RepositorySnapshot[]> {
  const groups = await detectRepositoryGroups(entries, roots);
  const rootsById = new Map(roots.map(root => [root.id, root]));
  const snapshots = await Promise.all(
    groups.map(group => {
      const groupRoots = group.watchedRootIds
        .map(id => rootsById.get(id))
        .filter((root): root is RootGroup => Boolean(root));
      return snapshotGroup(group, groupRoots, compareTarget);
    }),
  );
  return snapshots.sort((left, right) => left.rootPath.localeCompare(right.rootPath));
}

async function detectRepositoryGroups(
  entries: WatchEntry[],
  roots: RootGroup[],
): Promise<RepositoryGroup[]> {
  const rootByPath = new Map(roots.map(root => [root.id, root]));
  const gitGroups = new Map<string, RepositoryGroup>();
  const groups: RepositoryGroup[] = [];

  for (const entry of entries) {
    const probePath = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
    const rootId = entry.absolutePath;
    const detected = await safeGit(probePath, ["rev-parse", "--show-toplevel"]);

    if (!detected.ok) {
      const label = rootByPath.get(rootId)?.label ?? path.basename(probePath) ?? probePath;
      groups.push({
        id: `non-git:${probePath}`,
        rootPath: probePath,
        label,
        watchedRootIds: [rootId],
        configRoots: entry.kind === "dir" ? [entry.absolutePath] : [],
        status: "non-git",
        message: "No git repository is available for this watched root.",
      });
      continue;
    }

    const repoRoot = detected.stdout.trim();
    const existing = gitGroups.get(repoRoot);
    if (existing) {
      existing.watchedRootIds.push(rootId);
      if (entry.kind === "dir") {
        existing.configRoots.push(entry.absolutePath);
      }
      continue;
    }

    const label = path.basename(repoRoot) || repoRoot;
    const group: RepositoryGroup = {
      id: repoRoot,
      rootPath: repoRoot,
      label,
      watchedRootIds: [rootId],
      configRoots: entry.kind === "dir" ? [entry.absolutePath] : [],
      status: "git",
      message: null,
    };
    gitGroups.set(repoRoot, group);
    groups.push(group);
  }

  return groups;
}

async function snapshotGroup(
  group: RepositoryGroup,
  roots: readonly RootGroup[],
  compareTarget: CompareTarget,
): Promise<RepositorySnapshot> {
  const configWarnings = await collectConfigWarnings(group.rootPath, group.configRoots);
  if (group.status !== "git") {
    return unavailableSnapshot(group, "non-git", group.message, unavailableMetadata(group, "non-git", group.message), configWarnings);
  }

  const metadata = await collectMetadata(group);
  if (metadata.status !== "git") {
    return unavailableSnapshot(group, "unavailable", metadata.message, metadata, configWarnings);
  }

  const resolvedBase = await resolveCompareBase(group.rootPath);
  // Augment the resolved base with the requested compare target so the
  // snapshot carries the precise anchor and so collectChangedFiles knows
  // whether to include the committed merge-base..HEAD range.
  const base = applyCompareTarget(resolvedBase, compareTarget);
  const knownTreePaths = await collectKnownTreePaths(group.rootPath, roots);
  const [changedFiles, commitLog, gitIgnoredFiles] = await Promise.all([
    collectChangedFiles(group.rootPath, base),
    collectCommitLog(group.rootPath),
    collectGitIgnoredFiles(group.rootPath, knownTreePaths),
  ]);

  return {
    id: group.id,
    rootPath: group.rootPath,
    label: group.label,
    watchedRootIds: group.watchedRootIds,
    metadata,
    status: "available",
    base,
    changedFiles,
    gitIgnoredFiles,
    configWarnings,
    message: null,
    commitLog,
  };
}

function unavailableSnapshot(
  group: RepositoryGroup,
  status: "non-git" | "unavailable",
  message: string | null,
  metadata: RepositoryMetadata,
  configWarnings: string[],
): RepositorySnapshot {
  return {
    id: group.id,
    rootPath: group.rootPath,
    label: group.label,
    watchedRootIds: group.watchedRootIds,
    metadata,
    status,
    base: {
      mode: status === "non-git" ? "unavailable" : "dirty-worktree-only",
      ref: null,
      mergeBase: null,
      compareTarget: DEFAULT_COMPARE_TARGET,
      comparedAgainstRef: "HEAD",
      targetsCollapsed: true,
    },
    changedFiles: [],
    gitIgnoredFiles: [],
    configWarnings,
    message,
    commitLog: [],
  };
}

function unavailableMetadata(
  group: RepositoryGroup,
  status: "non-git" | "unavailable",
  message: string | null,
): RepositoryMetadata {
  return {
    id: group.id,
    rootPath: group.rootPath,
    label: group.label,
    watchedRootIds: group.watchedRootIds,
    status,
    branch: null,
    detached: false,
    commitShort: null,
    dirty: false,
    message,
  };
}

async function collectMetadata(group: RepositoryGroup): Promise<RepositoryMetadata> {
  const [branchResult, commitResult, dirtyResult] = await Promise.all([
    safeGit(group.rootPath, ["branch", "--show-current"]),
    safeGit(group.rootPath, ["rev-parse", "--short=12", "HEAD"]),
    safeGit(group.rootPath, ["status", "--porcelain=v1"]),
  ]);

  if (!commitResult.ok) {
    return unavailableMetadata(group, "unavailable", "Git metadata could not be read.");
  }

  const branch = branchResult.ok ? branchResult.stdout.trim() : "";
  return {
    id: group.id,
    rootPath: group.rootPath,
    label: group.label,
    watchedRootIds: group.watchedRootIds,
    status: "git",
    branch: branch || null,
    detached: !branch,
    commitShort: commitResult.stdout.trim() || null,
    dirty: dirtyResult.ok && dirtyResult.stdout.trim().length > 0,
    message: null,
  };
}

// `.uatu.json` warnings surfaced in the Change Overview pane. The ignore
// loader is the single source — read, parse, and shape warnings alike — and
// it is read per *directory watch root*, since that is the file that
// actually controls filtering (the engine never reads the repository top
// level when a root sits below it). A warning from a root below the top is
// prefixed with the root's repo-relative path so multiple roots stay
// distinguishable; a root at the top keeps the bare message.
export async function collectConfigWarnings(repoRoot: string, configRoots: string[] = [repoRoot]): Promise<string[]> {
  // Realpath both sides before relativizing — `rev-parse --show-toplevel`
  // resolves symlinks (`/var` → `/private/var` on macOS) while watch entries
  // keep the caller's spelling, and a mismatch would inject `../` prefixes.
  const resolvedRepoRoot = await fs.realpath(repoRoot).catch(() => repoRoot);
  const resolvedConfigRoots = new Set(
    await Promise.all(configRoots.map(configRoot => fs.realpath(configRoot).catch(() => configRoot))),
  );
  const warnings: string[] = [];
  for (const configRoot of resolvedConfigRoots) {
    const { warnings: rootWarnings } = await loadIgnoreConfig(configRoot);
    const rel = path.relative(resolvedRepoRoot, configRoot).split(path.sep).join("/");
    for (const warning of rootWarnings) {
      const qualified = rel ? `${rel}: ${warning}` : warning;
      if (!warnings.includes(qualified)) {
        warnings.push(qualified);
      }
    }
  }
  return warnings;
}

async function collectChangedFiles(repoRoot: string, base: CompareBase): Promise<ChangedFileSummary[]> {
  const specs: string[][] = [];
  // When the effective comparison is "vs HEAD" — the `last-commit` target, or
  // any target with no resolvable base (collapsed) — use a single `git diff
  // HEAD` pass. This is exactly what `getDocumentDiff` runs, so the overview
  // and the Diff view always agree: a `--cached` + unstaged union would double
  // a path whose staged and unstaged edits cancel, reporting a change for a
  // file the Diff view shows as unchanged.
  if (base.compareTarget === "last-commit" || base.mergeBase === null) {
    specs.push(["HEAD"]);
  } else {
    // `base` target with a resolved base: committed range + staged + unstaged,
    // spanning merge-base..worktree (the reviewer's full view).
    specs.push([`${base.mergeBase}..HEAD`]);
    specs.push(["--cached"]);
    specs.push([]);
  }

  const combined = new Map<string, ChangedFileSummary>();
  for (const spec of specs) {
    const files = await collectDiffFiles(repoRoot, spec);
    for (const file of files) {
      const existing = combined.get(file.path);
      if (!existing) {
        combined.set(file.path, file);
        continue;
      }
      existing.additions += file.additions;
      existing.deletions += file.deletions;
      existing.hunks += file.hunks;
      if (existing.status === "M" && file.status !== "M") {
        existing.status = file.status;
      }
    }
  }
  for (const file of await collectUntrackedFiles(repoRoot)) {
    if (!combined.has(file.path)) {
      combined.set(file.path, file);
    }
  }

  return Array.from(combined.values()).sort((left, right) => left.path.localeCompare(right.path));
}

// Build the set of repo-root-relative paths that uatu's tree currently
// displays for this repository group. Used to intersect git's ignored-files
// list so we only ship the rows the client will actually annotate. Paths
// are normalized to forward slashes regardless of platform so they match
// the git output without per-OS branching. Both repoRoot and each
// `root.path` are realpath-resolved so symlinks (notably `/tmp` →
// `/private/tmp` on macOS, which `git rev-parse --show-toplevel` returns
// in resolved form) do not produce spurious `..` ladders.
async function collectKnownTreePaths(
  repoRoot: string,
  roots: readonly RootGroup[],
): Promise<Set<string>> {
  const known = new Set<string>();
  const resolvedRepoRoot = await fs.realpath(repoRoot).catch(() => repoRoot);
  for (const root of roots) {
    const resolvedRootPath = await fs.realpath(root.path).catch(() => root.path);
    const rootRelToRepo = path.relative(resolvedRepoRoot, resolvedRootPath).replace(/\\/g, "/");
    for (const doc of root.docs) {
      const repoRelative = rootRelToRepo
        ? `${rootRelToRepo}/${doc.relativePath}`
        : doc.relativePath;
      known.add(repoRelative);
    }
  }
  return known;
}

// Files present on disk that match git's standard ignore rules
// (.gitignore, core.excludesFile, .git/info/exclude). We intersect against
// `knownTreePaths` because the raw set can be enormous in repos with
// node_modules / dist / .cache (tens of thousands of entries), and every
// path beyond what the tree actually shows is wasted bytes over the wire.
async function collectGitIgnoredFiles(repoRoot: string, knownTreePaths: Set<string>): Promise<string[]> {
  if (knownTreePaths.size === 0) {
    return [];
  }
  // The output of `--ignored --exclude-standard` is unbounded — in this repo
  // it ships ~1.6 MB (mostly node_modules contents). The default 256 KB
  // buffer would silently truncate and the exec would error out, leaving
  // every gitignored file unannotated with no log trail. 16 MB is enough for
  // any realistic repo; if it ever overflows, the safe-fail path returns
  // [] and the only consequence is missing annotations (no crash).
  const result = await safeGit(
    repoRoot,
    ["ls-files", "--others", "--ignored", "--exclude-standard"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (!result.ok || !result.stdout.trim()) {
    return [];
  }
  const out: string[] = [];
  for (const line of result.stdout.trim().split("\n")) {
    if (knownTreePaths.has(line)) {
      out.push(line);
    }
  }
  return out;
}

async function collectUntrackedFiles(repoRoot: string): Promise<ChangedFileSummary[]> {
  const result = await safeGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (!result.ok || !result.stdout.trim()) {
    return [];
  }

  const files: ChangedFileSummary[] = [];
  for (const relativePath of result.stdout.trim().split("\n")) {
    const additions = await countFileLines(path.join(repoRoot, relativePath));
    files.push({
      path: relativePath,
      oldPath: null,
      status: "?",
      additions,
      deletions: 0,
      hunks: additions > 0 ? 1 : 0,
    });
  }
  return files;
}

async function countFileLines(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > GIT_MAX_BUFFER) {
    return 0;
  }
  const source = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!source) {
    return 0;
  }
  return source.replace(/\n$/, "").split("\n").length;
}

async function collectDiffFiles(repoRoot: string, rangeArgs: string[]): Promise<ChangedFileSummary[]> {
  const numstat = await safeGit(repoRoot, ["diff", "--numstat", "-M", ...rangeArgs]);
  if (!numstat.ok || !numstat.stdout.trim()) {
    return [];
  }

  const [hunks, statusByPath] = await Promise.all([
    countHunks(repoRoot, rangeArgs),
    collectNameStatus(repoRoot, rangeArgs),
  ]);
  return numstat.stdout
    .trim()
    .split("\n")
    .map(line => parseNumstatLine(line, hunks, statusByPath))
    .filter((file): file is ChangedFileSummary => Boolean(file));
}

// Keyed by the post-change path (the right-hand path for renames). Returns the
// raw git letter (or `R<similarity>` / `C<similarity>` for renames and copies)
// so callers can do the usual first-character switch.
async function collectNameStatus(repoRoot: string, rangeArgs: string[]): Promise<Map<string, string>> {
  const result = await safeGit(repoRoot, ["diff", "--name-status", "-M", ...rangeArgs]);
  const map = new Map<string, string>();
  if (!result.ok || !result.stdout.trim()) {
    return map;
  }
  for (const line of result.stdout.trim().split("\n")) {
    const parts = line.split("\t");
    const status = parts[0];
    if (!status) continue;
    // Renames/copies: `R75\told\tnew` — the new path is the trailing field.
    // Everything else: `M\tpath` (single path field).
    const path = parts[parts.length - 1];
    if (!path) continue;
    map.set(path, status);
  }
  return map;
}

async function countHunks(repoRoot: string, rangeArgs: string[]): Promise<Map<string, number>> {
  const result = await safeGit(repoRoot, ["diff", "--unified=0", "--no-ext-diff", "-M", ...rangeArgs], {
    maxBuffer: 512 * 1024,
  });
  const hunks = new Map<string, number>();
  if (!result.ok) {
    console.warn(`uatu: failed to count diff hunks: ${result.message}`);
    return hunks;
  }

  let currentPath: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("@@") && currentPath) {
      hunks.set(currentPath, (hunks.get(currentPath) ?? 0) + 1);
    }
  }
  return hunks;
}

function parseNumstatLine(
  line: string,
  hunks: Map<string, number>,
  statusByPath: Map<string, string>,
): ChangedFileSummary | null {
  const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
  const rawPath = pathParts.join("\t");
  if (!rawAdditions || !rawDeletions || !rawPath) {
    return null;
  }

  const pathInfo = parseDiffPath(rawPath);
  const additions = rawAdditions === "-" ? 0 : Number.parseInt(rawAdditions, 10);
  const deletions = rawDeletions === "-" ? 0 : Number.parseInt(rawDeletions, 10);
  // Prefer git's own name-status letter (handles A/M/D/R/C/T precisely); fall
  // back to the rename-vs-modify heuristic when name-status is unavailable
  // for this path (rare — only if the two git invocations disagree).
  const status = statusByPath.get(pathInfo.path) ?? (pathInfo.oldPath ? "R" : "M");
  return {
    path: pathInfo.path,
    oldPath: pathInfo.oldPath,
    status,
    additions: Number.isFinite(additions) ? additions : 0,
    deletions: Number.isFinite(deletions) ? deletions : 0,
    hunks: hunks.get(pathInfo.path) ?? 1,
  };
}

export function parseDiffPath(rawPath: string): { path: string; oldPath: string | null } {
  const braceMatch = rawPath.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix = "", oldName = "", newName = "", suffix = ""] = braceMatch;
    if (!oldName && !newName) {
      return { path: rawPath, oldPath: null };
    }
    return {
      path: `${prefix}${newName}${suffix}`,
      oldPath: `${prefix}${oldName}${suffix}`,
    };
  }

  const arrowIndex = rawPath.indexOf(" => ");
  if (arrowIndex !== -1) {
    return {
      path: rawPath.slice(arrowIndex + 4),
      oldPath: rawPath.slice(0, arrowIndex),
    };
  }

  return { path: rawPath, oldPath: null };
}

async function collectCommitLog(repoRoot: string): Promise<CommitLogEntry[]> {
  const result = await safeGit(repoRoot, [
    "log",
    `--max-count=${MAX_COMMITS}`,
    "--pretty=format:%h%x09%an%x09%cr%x09%s%x00%B%x00",
  ], {
    maxBuffer: 1024 * 1024,
  });
  if (!result.ok || !result.stdout.trim()) {
    return [];
  }

  const parts = result.stdout.split("\0");
  const commits: CommitLogEntry[] = [];
  for (let index = 0; index < parts.length - 1; index += 2) {
    const metadata = parts[index]?.replace(/^\n/, "") ?? "";
    if (!metadata) {
      continue;
    }
    const [sha = "", author = "", relativeTime = "", ...subjectParts] = metadata.split("\t");
    const subject = subjectParts.join("\t") || "(no subject)";
    const message = parts[index + 1]?.trim() || subject;
    commits.push({
      sha,
      author: author || null,
      relativeTime: relativeTime || null,
      subject,
      message,
    });
  }
  return commits;
}
