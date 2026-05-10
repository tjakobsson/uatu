import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

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

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2500;
const GIT_MAX_BUFFER = 256 * 1024;
const DEFAULT_THRESHOLDS: ReviewThresholds = { medium: 35, high: 70 };
const MAX_COMMITS = 100;

// Module-level metrics hook: cli.ts wires its registry in at startup so
// safeGit can increment counters without every caller threading the
// registry through. Optional and safe to leave unset (e.g. in tests).
type GitMetricsSink = { inc(name: string): void };
let gitMetricsSink: GitMetricsSink | null = null;
export function setGitMetricsSink(sink: GitMetricsSink | null): void {
  gitMetricsSink = sink;
}

type GitResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string; message: string };

type RepositoryGroup = {
  id: string;
  rootPath: string;
  label: string;
  watchedRootIds: string[];
  status: "git" | "non-git" | "unavailable";
  message: string | null;
};

export async function safeGit(
  cwd: string,
  args: string[],
  options: { maxBuffer?: number; timeoutMs?: number } = {},
): Promise<GitResult> {
  gitMetricsSink?.inc("git.execs_total");
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    if (err.killed === true || err.signal === "SIGTERM") {
      gitMetricsSink?.inc("git.timeouts_total");
    }
    return {
      ok: false,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
      message: err.message,
    };
  }
}

export async function collectRepositorySnapshots(
  entries: WatchEntry[],
  roots: RootGroup[],
): Promise<RepositoryReviewSnapshot[]> {
  const groups = await detectRepositoryGroups(entries, roots);
  const snapshots = await Promise.all(groups.map(group => snapshotGroup(group)));
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

async function snapshotGroup(group: RepositoryGroup): Promise<RepositoryReviewSnapshot> {
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
  const changedFiles = await collectChangedFiles(group.rootPath, base);
  const commitLog = await collectCommitLog(group.rootPath);
  const reviewLoad = scoreReviewLoad(
    changedFiles,
    base,
    settingsResult.settings,
    settingsResult.warnings,
  );

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

async function resolveReviewBase(repoRoot: string, configuredBase: string | undefined): Promise<ReviewBase> {
  if (configuredBase && await refExists(repoRoot, configuredBase)) {
    return mergeBase(repoRoot, configuredBase, "configured");
  }

  const originHead = await safeGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const remoteDefault = originHead.ok ? originHead.stdout.trim() : "";
  if (remoteDefault && await refExists(repoRoot, remoteDefault)) {
    return mergeBase(repoRoot, remoteDefault, "remote-default");
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (await refExists(repoRoot, candidate)) {
      return mergeBase(repoRoot, candidate, "fallback");
    }
  }

  return { mode: "dirty-worktree-only", ref: "HEAD", mergeBase: null };
}

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  const result = await safeGit(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref]);
  return result.ok;
}

async function mergeBase(
  repoRoot: string,
  ref: string,
  mode: ReviewBase["mode"],
): Promise<ReviewBase> {
  const result = await safeGit(repoRoot, ["merge-base", "--", ref, "HEAD"]);
  return {
    mode,
    ref,
    mergeBase: result.ok ? result.stdout.trim() || null : null,
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
      status: "A",
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

  const hunks = await countHunks(repoRoot, rangeArgs);
  return numstat.stdout
    .trim()
    .split("\n")
    .map(line => parseNumstatLine(line, hunks))
    .filter((file): file is ChangedFileSummary => Boolean(file));
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

function parseNumstatLine(line: string, hunks: Map<string, number>): ChangedFileSummary | null {
  const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
  const rawPath = pathParts.join("\t");
  if (!rawAdditions || !rawDeletions || !rawPath) {
    return null;
  }

  const pathInfo = parseDiffPath(rawPath);
  const additions = rawAdditions === "-" ? 0 : Number.parseInt(rawAdditions, 10);
  const deletions = rawDeletions === "-" ? 0 : Number.parseInt(rawDeletions, 10);
  return {
    path: pathInfo.path,
    oldPath: pathInfo.oldPath,
    status: pathInfo.oldPath ? "R" : "M",
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
