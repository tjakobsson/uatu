import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ChangedFileSummary,
  CommitLogEntry,
  RepositoryMetadata,
  RepositoryReviewSnapshot,
  ReviewAreaConfig,
  ReviewBase,
  ReviewConfiguredArea,
  ReviewLoadResult,
  ReviewScoreDriver,
  ReviewSettings,
  ReviewThresholds,
  RootGroup,
} from "./shared";
import type { WatchEntry } from "./server";
import { resolveReviewBase, safeGit, setGitMetricsSink } from "./git-base-ref";

export { safeGit, setGitMetricsSink } from "./git-base-ref";

const GIT_MAX_BUFFER = 256 * 1024;
const DEFAULT_THRESHOLDS: ReviewThresholds = { medium: 35, high: 70 };
const MAX_COMMITS = 100;

type RepositoryGroup = {
  id: string;
  rootPath: string;
  label: string;
  watchedRootIds: string[];
  status: "git" | "non-git" | "unavailable";
  message: string | null;
};

export async function collectRepositorySnapshots(
  entries: WatchEntry[],
  roots: RootGroup[],
): Promise<RepositoryReviewSnapshot[]> {
  const groups = await detectRepositoryGroups(entries, roots);
  const rootsById = new Map(roots.map(root => [root.id, root]));
  const snapshots = await Promise.all(
    groups.map(group => {
      const groupRoots = group.watchedRootIds
        .map(id => rootsById.get(id))
        .filter((root): root is RootGroup => Boolean(root));
      return snapshotGroup(group, groupRoots);
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
        status: "non-git",
        message: "No git repository is available for this watched root.",
      });
      continue;
    }

    const repoRoot = detected.stdout.trim();
    const existing = gitGroups.get(repoRoot);
    if (existing) {
      existing.watchedRootIds.push(rootId);
      continue;
    }

    const label = path.basename(repoRoot) || repoRoot;
    const group: RepositoryGroup = {
      id: repoRoot,
      rootPath: repoRoot,
      label,
      watchedRootIds: [rootId],
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
): Promise<RepositoryReviewSnapshot> {
  if (group.status !== "git") {
    const metadata = unavailableMetadata(group, "non-git", group.message);
    return {
      id: group.id,
      rootPath: group.rootPath,
      label: group.label,
      watchedRootIds: group.watchedRootIds,
      metadata,
      reviewLoad: unavailableReviewLoad("non-git", group.message),
      commitLog: [],
    };
  }

  const settingsResult = await loadReviewSettings(group.rootPath);
  const metadata = await collectMetadata(group);
  if (metadata.status !== "git") {
    return {
      id: group.id,
      rootPath: group.rootPath,
      label: group.label,
      watchedRootIds: group.watchedRootIds,
      metadata,
      reviewLoad: unavailableReviewLoad("unavailable", metadata.message),
      commitLog: [],
    };
  }

  const base = await resolveReviewBase(group.rootPath, settingsResult.settings.baseRef);
  const knownTreePaths = await collectKnownTreePaths(group.rootPath, roots);
  const [changedFiles, commitLog, gitIgnoredFiles] = await Promise.all([
    collectChangedFiles(group.rootPath, base),
    collectCommitLog(group.rootPath),
    collectGitIgnoredFiles(group.rootPath, knownTreePaths),
  ]);
  const reviewLoad = scoreReviewLoad(
    changedFiles,
    base,
    settingsResult.settings,
    settingsResult.warnings,
  );
  reviewLoad.gitIgnoredFiles = gitIgnoredFiles;

  return {
    id: group.id,
    rootPath: group.rootPath,
    label: group.label,
    watchedRootIds: group.watchedRootIds,
    metadata,
    reviewLoad,
    commitLog,
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

async function collectChangedFiles(repoRoot: string, base: ReviewBase): Promise<ChangedFileSummary[]> {
  const specs: string[][] = [];
  if (base.mergeBase) {
    specs.push([`${base.mergeBase}..HEAD`]);
  }
  specs.push(["--cached"]);
  specs.push([]);

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

export async function loadReviewSettings(
  repoRoot: string,
): Promise<{ settings: ReviewSettings; warnings: string[] }> {
  const settings: ReviewSettings = {
    thresholds: DEFAULT_THRESHOLDS,
    riskAreas: [],
    supportAreas: [],
    ignoreAreas: [],
  };
  const warnings: string[] = [];
  const filePath = path.join(repoRoot, ".uatu.json");
  const source = await fs.readFile(filePath, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`Could not read .uatu.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  });

  if (!source) {
    return { settings, warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    warnings.push(`Invalid .uatu.json: ${error instanceof Error ? error.message : String(error)}`);
    return { settings, warnings };
  }

  const review = isRecord(parsed) ? parsed.review : undefined;
  if (!isRecord(review)) {
    return { settings, warnings };
  }

  if (typeof review.baseRef === "string" && review.baseRef.trim()) {
    settings.baseRef = review.baseRef.trim();
  } else if (review.baseRef !== undefined) {
    warnings.push("Ignored review.baseRef because it must be a non-empty string.");
  }

  if (isRecord(review.thresholds)) {
    const medium = asFiniteNumber(review.thresholds.medium);
    const high = asFiniteNumber(review.thresholds.high);
    if (medium !== null && high !== null && medium > 0 && high > medium) {
      settings.thresholds = { medium, high };
    } else {
      warnings.push("Ignored review.thresholds because medium/high must be positive numbers and high must exceed medium.");
    }
  }

  settings.riskAreas = parseAreas(review.riskAreas, "riskAreas", warnings);
  settings.supportAreas = parseAreas(review.supportAreas, "supportAreas", warnings);
  settings.ignoreAreas = parseAreas(review.ignoreAreas, "ignoreAreas", warnings);

  return { settings, warnings };
}

function parseAreas(value: unknown, fieldName: string, warnings: string[]): ReviewAreaConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`Ignored review.${fieldName} because it must be an array.`);
    return [];
  }

  const areas: ReviewAreaConfig[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.label !== "string" || !Array.isArray(entry.paths)) {
      warnings.push(`Ignored review.${fieldName}[${index}] because it needs label and paths.`);
      return;
    }
    const paths = entry.paths
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
      .map(pattern => pattern.endsWith("/") ? `${pattern}**` : pattern);
    if (paths.length === 0) {
      warnings.push(`Ignored review.${fieldName}[${index}] because it has no valid paths.`);
      return;
    }

    areas.push({
      label: entry.label,
      paths,
      score: asFiniteNumber(entry.score) ?? undefined,
      perFile: asFiniteNumber(entry.perFile) ?? undefined,
      max: asFiniteNumber(entry.max) ?? undefined,
      maxDiscount: asFiniteNumber(entry.maxDiscount) ?? undefined,
    });
  });
  return areas;
}

function scoreReviewLoad(
  files: ChangedFileSummary[],
  base: ReviewBase,
  settings: ReviewSettings,
  settingsWarnings: string[],
): ReviewLoadResult {
  const ignoredMatches = matchAreas(files, settings.ignoreAreas);
  const ignoredPaths = new Set(ignoredMatches.flatMap(match => match.files));
  const scoredFiles = files.filter(file => !ignoredPaths.has(file.path));
  const ignoredFiles = files.filter(file => ignoredPaths.has(file.path));
  const riskMatches = matchAreas(scoredFiles, settings.riskAreas);
  const supportMatches = matchAreas(scoredFiles, settings.supportAreas);
  const configuredAreas: ReviewConfiguredArea[] = [
    ...buildConfiguredAreas(settings.riskAreas, riskMatches, "risk"),
    ...buildConfiguredAreas(settings.supportAreas, supportMatches, "support"),
    ...buildConfiguredAreas(settings.ignoreAreas, ignoredMatches, "ignore"),
  ];
  const drivers: ReviewScoreDriver[] = [];

  for (const match of ignoredMatches) {
    drivers.push({
      kind: "ignore",
      label: match.area.label,
      score: 0,
      detail: `${match.files.length} file${match.files.length === 1 ? "" : "s"} excluded from scoring`,
      files: match.files,
    });
  }

  const fileCount = scoredFiles.length;
  const touchedLines = scoredFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const hunkCount = scoredFiles.reduce((sum, file) => sum + file.hunks, 0);
  const directoryCount = new Set(scoredFiles.map(file => firstDirectory(file.path))).size;
  const renameCount = scoredFiles.filter(file => file.oldPath).length;
  const dependencyCount = scoredFiles.filter(file => isDependencyOrConfigFile(file.path)).length;

  addMechanicalDriver(drivers, "Changed files", Math.min(30, fileCount * 4), `${fileCount} changed file${fileCount === 1 ? "" : "s"}`, scoredFiles.map(file => file.path));
  addMechanicalDriver(drivers, "Touched lines", Math.min(35, Math.ceil(touchedLines / 20)), `${touchedLines} added or removed line${touchedLines === 1 ? "" : "s"}`, []);
  addMechanicalDriver(drivers, "Diff hunks", Math.min(20, hunkCount * 2), `${hunkCount} diff hunk${hunkCount === 1 ? "" : "s"}`, []);
  addMechanicalDriver(drivers, "Directory spread", Math.min(12, Math.max(0, directoryCount - 1) * 3), `${directoryCount} top-level area${directoryCount === 1 ? "" : "s"}`, []);
  addMechanicalDriver(drivers, "Renames", Math.min(10, renameCount * 5), `${renameCount} rename or move${renameCount === 1 ? "" : "s"}`, []);
  addMechanicalDriver(drivers, "Dependency/config files", Math.min(14, dependencyCount * 7), `${dependencyCount} dependency or config file${dependencyCount === 1 ? "" : "s"}`, []);

  addAreaDrivers(drivers, riskMatches, "risk");
  addAreaDrivers(drivers, supportMatches, "support");

  for (const warning of settingsWarnings) {
    drivers.push({ kind: "warning", label: "Configuration warning", score: 0, detail: warning, files: [] });
  }

  const score = Math.max(0, Math.round(drivers.reduce((sum, driver) => sum + driver.score, 0)));
  const level = score >= settings.thresholds.high ? "high" : score >= settings.thresholds.medium ? "medium" : "low";

  return {
    status: "available",
    score,
    level,
    thresholds: settings.thresholds,
    base,
    changedFiles: scoredFiles,
    ignoredFiles,
    // Populated by snapshotGroup after the score is computed; gitignored
    // files have no role in scoring, so the scorer leaves it empty here.
    gitIgnoredFiles: [],
    drivers,
    configuredAreas,
    settingsWarnings,
    message: null,
  };
}

function addMechanicalDriver(
  drivers: ReviewScoreDriver[],
  label: string,
  score: number,
  detail: string,
  files: string[],
) {
  if (score <= 0 && files.length === 0) {
    return;
  }
  drivers.push({ kind: "mechanical", label, score, detail, files });
}

function addAreaDrivers(
  drivers: ReviewScoreDriver[],
  matches: { area: ReviewAreaConfig; files: string[] }[],
  kind: "risk" | "support",
) {
  for (const match of matches) {
    const score = scoreAreaMatch(match.area, match.files.length, kind);
    drivers.push({
      kind,
      label: match.area.label,
      score,
      detail: `${match.files.length} matched file${match.files.length === 1 ? "" : "s"}`,
      files: match.files,
    });
  }
}

function buildConfiguredAreas(
  areas: ReviewAreaConfig[],
  matches: { area: ReviewAreaConfig; files: string[] }[],
  kind: ReviewConfiguredArea["kind"],
): ReviewConfiguredArea[] {
  return areas.map(area => {
    const match = matches.find(candidate => candidate.area === area);
    const matchedFiles = match?.files ?? [];
    return {
      kind,
      label: area.label,
      paths: area.paths,
      matchedFiles,
      score: matchedFiles.length > 0 ? scoreAreaMatch(area, matchedFiles.length, kind) : 0,
    };
  });
}

function scoreAreaMatch(
  area: ReviewAreaConfig,
  fileCount: number,
  kind: ReviewConfiguredArea["kind"],
): number {
  if (kind === "ignore") {
    return 0;
  }

  const baseScore = area.score ?? 0;
  const perFile = area.perFile ?? 0;
  let score = baseScore + perFile * fileCount;
  if (kind === "risk" && area.max !== undefined) {
    score = Math.min(score, Math.abs(area.max));
  }
  if (kind === "support") {
    const maxDiscount = Math.abs(area.maxDiscount ?? area.max ?? Math.abs(score));
    score = -Math.min(Math.abs(score), maxDiscount);
  }
  return score;
}

function matchAreas(files: ChangedFileSummary[], areas: ReviewAreaConfig[]) {
  return areas
    .map(area => ({
      area,
      files: files
        .filter(file => area.paths.some(pattern => matchPath(pattern, file.path)))
        .map(file => file.path),
    }))
    .filter(match => match.files.length > 0);
}

export function matchPath(pattern: string, filePath: string): boolean {
  const normalizedPattern = pattern.split(path.sep).join("/");
  const normalizedPath = filePath.split(path.sep).join("/");
  const regex = new RegExp(`^${globToRegex(normalizedPattern)}$`);
  return regex.test(normalizedPath);
}

function globToRegex(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        output += "(?:.*/)?";
        index += 2;
      } else {
        output += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      output += "[^/]*";
      continue;
    }
    if (char === "?") {
      output += "[^/]";
      continue;
    }
    output += escapeRegex(char);
  }
  return output;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function firstDirectory(filePath: string): string {
  return filePath.includes("/") ? filePath.split("/")[0]! : ".";
}

function isDependencyOrConfigFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return [
    "package.json",
    "bun.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "cargo.toml",
    "cargo.lock",
    "go.mod",
    "go.sum",
    "requirements.txt",
    "pyproject.toml",
    "dockerfile",
  ].includes(name) || /\.(config|rc)\.(js|ts|cjs|mjs|json|yaml|yml)$/.test(name);
}

function unavailableReviewLoad(
  status: "non-git" | "unavailable",
  message: string | null,
): ReviewLoadResult {
  return {
    status,
    score: 0,
    level: "low",
    thresholds: DEFAULT_THRESHOLDS,
    base: { mode: status === "non-git" ? "unavailable" : "dirty-worktree-only", ref: null, mergeBase: null },
    changedFiles: [],
    ignoredFiles: [],
    gitIgnoredFiles: [],
    drivers: [],
    configuredAreas: [],
    settingsWarnings: [],
    message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
