// Event-driven observation of a repository's Git metadata, modeled on VS
// Code's Git extension: non-recursive watches on the few directories whose
// entries change when a commit, stage, branch switch, fetch or ref packing
// happens. Directories, not files: Git replaces refs and the index by
// renaming a lock file over them, which a file watch would not survive.
import { watch as nodeWatch, type FSWatcher } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { safeGit } from "../document/git-base-ref";
import type { WatchEntry } from "./roots";

export type GitObserver = {
  // Resolves the watched directories and opens their handles. Rejects when a
  // directory exists but cannot be watched; the caller falls back to polling.
  start(): Promise<void>;
  // Directories currently watched, for tests and diagnostics.
  directories(): string[];
  // Repository top levels watched recursively for narrow roots.
  trees(): string[];
  // How many times the watched paths were resolved, for tests.
  resolutions(): number;
  close(): void;
};

type Options = {
  entries: WatchEntry[];
  // A Git-only change may have happened. `name` is the changed entry's name
  // within its watched directory, when the platform reports one.
  onChange: (name: string | null) => void;
  // Native observation stopped working after start().
  onFailure: (error: unknown) => void;
  watch?: typeof nodeWatch;
};

// Names that never describe repository state: lock and temp files around an
// atomic update (the rename to the final name is reported separately), Git's
// object store and housekeeping, watchman's fsmonitor cookies, and FETCH_HEAD,
// which every fetch rewrites even when no ref moved (a fetch that moves a ref
// also renames that ref or packed-refs).
export function isGitNoise(name: string): boolean {
  return name.endsWith(".lock") || name.endsWith(".new") || name.includes(".watchman-cookie-")
    || name === "objects" || name === "FETCH_HEAD" || name === "gc.pid" || name === "gc.log";
}

async function gitPath(cwd: string, args: string[]): Promise<string | null> {
  const result = await safeGit(cwd, args);
  const value = result.ok ? result.stdout.trim() : "";
  return value ? path.resolve(cwd, value) : null;
}

async function symbolicTarget(cwd: string, ref: string): Promise<string | null> {
  const result = await safeGit(cwd, ["symbolic-ref", "-q", ref]);
  return result.ok ? result.stdout.trim() || null : null;
}

// Lock and temp files around an atomic update. They never create a missing
// directory, so they never warrant re-resolving paths either.
function isLockOrTemp(name: string): boolean {
  return name.endsWith(".lock") || name.endsWith(".new") || name.includes(".watchman-cookie-");
}

type Candidates = { directories: string[]; nonGitRoot: string | null };

// The directories whose entries carry the published repository state for one
// watch entry. Every compare-base candidate (origin/HEAD's target,
// origin/main|master, main|master) lives in refs/remotes/origin or refs/heads.
// Optional directories are included only when they can matter: reftable/
// only for a reftable repository, refs/remotes/origin only with an origin
// remote. Otherwise they would stay "missing" forever and make every event
// re-resolve. A root outside any repository is watched for `.git` appearing.
async function candidateDirectories(entry: WatchEntry): Promise<Candidates> {
  const cwd = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
  const gitDir = await gitPath(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return { directories: [], nonGitRoot: cwd };
  const directories = new Set<string>([gitDir]);
  const add = async (args: string[], parent = false) => {
    const resolved = await gitPath(cwd, args);
    if (resolved) directories.add(parent ? path.dirname(resolved) : resolved);
  };
  await add(["rev-parse", "--git-common-dir"]);
  await add(["rev-parse", "--git-path", "refs/heads"]);
  if ((await safeGit(cwd, ["config", "--get", "remote.origin.url"])).ok) await add(["rev-parse", "--git-path", "refs/remotes/origin"]);
  const reftable = await gitPath(cwd, ["rev-parse", "--git-path", "reftable"]);
  if (reftable && await stat(reftable).then(info => info.isDirectory(), () => false)) directories.add(reftable);
  for (const symref of ["HEAD", "refs/remotes/origin/HEAD"]) {
    const target = await symbolicTarget(cwd, symref);
    if (target) await add(["rev-parse", "--git-path", target], true);
  }
  return { directories: [...directories], nonGitRoot: null };
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// A watch entry is narrow when it covers less than its repository: a
// subdirectory, or a single file. Edits elsewhere in that repository change
// its Git data but never reach the content watcher.
export async function narrowRepository(entry: WatchEntry): Promise<{ topLevel: string; root: string } | null> {
  const cwd = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
  const result = await safeGit(cwd, ["rev-parse", "--show-toplevel"]);
  const reported = result.ok ? result.stdout.trim() : "";
  if (!reported) return null;
  const topLevel = await realpath(reported).catch(() => null);
  const root = await realpath(entry.absolutePath).catch(() => null);
  if (!topLevel || !root) return null;
  return entry.kind === "file" || root !== topLevel ? { topLevel, root } : null;
}

export async function hasNarrowRoot(entries: WatchEntry[]): Promise<boolean> {
  for (const entry of entries) if (await narrowRepository(entry)) return true;
  return false;
}

// `ignored` is the top-level .gitignore; `trackedIgnored` the tracked files
// it nonetheless matches, which Git still reports and so must stay visible.
type TreeWatch = { handle: FSWatcher; roots: string[]; ignored: Ignore; trackedIgnored: Set<string>; refreshing: Promise<void> | null; refreshAgain: boolean };

async function loadGitignore(topLevel: string): Promise<Ignore> {
  const content = await readFile(path.join(topLevel, ".gitignore"), "utf8").catch(() => "");
  return ignore().add(content);
}

async function loadTrackedIgnored(topLevel: string): Promise<Set<string>> {
  const result = await safeGit(topLevel, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"], { maxBuffer: 8 * 1024 * 1024 });
  return new Set(result.ok ? result.stdout.split("\0").filter(Boolean) : []);
}

export function createGitObserver(options: Options): GitObserver {
  const watchDirectory = options.watch ?? nodeWatch;
  const handles = new Map<string, FSWatcher>();
  const trees = new Map<string, TreeWatch>();
  // Watched roots outside any repository, by real path: only `.git`
  // appearing in them matters.
  let nonGitRoots = new Set<string>();
  let missing = false;
  let resolutionCount = 0;
  let closed = false;
  let failed = false;
  let resolving: Promise<void> | null = null;
  let resolveAgain = false;

  function fail(error: unknown) {
    if (closed || failed) return;
    failed = true;
    close();
    options.onFailure(error);
  }

  function receive(directory: string, name: string | null) {
    if (closed || failed) return;
    const base = name === null ? null : path.basename(name);
    if (nonGitRoots.has(directory)) {
      // `git init` (or a clone into place) makes this root a repository.
      if (base === null || base === ".git") { void resync(); options.onChange(base); }
      return;
    }
    // A directory that did not exist yet may exist now. FETCH_HEAD counts:
    // on Linux the first fetch reports only FETCH_HEAD here, while it creates
    // refs/remotes/origin below a directory nobody watches. Lock and temp
    // names never create one.
    const lockOrTemp = base !== null && isLockOrTemp(base);
    if (missing && !lockOrTemp) void resync();
    if (base !== null && isGitNoise(base)) return;
    // A moved HEAD symref (branch switch, a new origin/HEAD) or a config
    // change (a remote added) can change which ref directories matter.
    if (!missing && (base === null || base === "HEAD" || base === "config")) void resync();
    // Staging can track a file the .gitignore matches (git add -f).
    if (base === "index" && trees.size) for (const [topLevel, tree] of trees) void refreshTracked(topLevel, tree);
    options.onChange(base);
  }

  function refreshTracked(topLevel: string, tree: TreeWatch): Promise<void> {
    if (tree.refreshing) { tree.refreshAgain = true; return tree.refreshing; }
    tree.refreshing = (async () => {
      do {
        tree.refreshAgain = false;
        const [ignored, trackedIgnored] = await Promise.all([loadGitignore(topLevel), loadTrackedIgnored(topLevel)]);
        tree.ignored = ignored;
        tree.trackedIgnored = trackedIgnored;
      } while (tree.refreshAgain && !closed && !failed);
    })().catch(() => {}).finally(() => { tree.refreshing = null; });
    return tree.refreshing;
  }

  // Working-tree events from a narrow root's repository. Errs towards
  // triggering: a missed ignore costs one silent collection, while a dropped
  // tracked path would leave the Change Overview stale.
  function receiveTree(topLevel: string, name: string | null) {
    if (closed || failed) return;
    const tree = trees.get(topLevel);
    if (!tree) return;
    if (name === null) { options.onChange(null); return; }
    const relative = name.split(path.sep).join("/");
    if (relative.split("/").includes(".git")) return;
    const absolute = path.join(topLevel, name);
    if (tree.roots.some(root => contains(root, absolute))) return;
    if (relative === ".gitignore") void refreshTracked(topLevel, tree);
    else if (tree.ignored.ignores(relative) && !tree.trackedIgnored.has(relative)) return;
    options.onChange(path.basename(name));
  }

  async function openTrees(wanted: Map<string, string[]>) {
    for (const [topLevel, tree] of trees) {
      if (!wanted.has(topLevel)) { tree.handle.close(); trees.delete(topLevel); }
    }
    for (const [topLevel, roots] of wanted) {
      const existing = trees.get(topLevel);
      if (existing) { existing.roots = roots; continue; }
      const [ignored, trackedIgnored] = await Promise.all([loadGitignore(topLevel), loadTrackedIgnored(topLevel)]);
      if (closed || failed) return;
      const handle = watchDirectory(topLevel, { recursive: true }, (_event, filename) => receiveTree(topLevel, filename == null ? null : filename.toString()));
      handle.on("error", fail);
      trees.set(topLevel, { handle, roots, ignored, trackedIgnored, refreshing: null, refreshAgain: false });
    }
  }

  // Returns how many directories gained a handle.
  async function open(directories: string[]): Promise<number> {
    let anyMissing = false;
    let opened = 0;
    const wanted = new Set<string>();
    for (const candidate of directories) {
      // rev-parse mixes real paths with cwd-relative ones (/tmp vs
      // /private/tmp on macOS); one physical directory gets one handle.
      const directory = await realpath(candidate).catch(() => null);
      const info = directory ? await stat(directory).catch(() => null) : null;
      if (!directory || !info?.isDirectory()) { anyMissing = true; continue; }
      wanted.add(directory);
    }
    if (closed || failed) return 0;
    for (const [directory, handle] of handles) {
      if (!wanted.has(directory)) { handle.close(); handles.delete(directory); }
    }
    for (const directory of wanted) {
      if (handles.has(directory)) continue;
      let handle: FSWatcher;
      try {
        handle = watchDirectory(directory, { recursive: false }, (_event, filename) => receive(directory, filename == null ? null : filename.toString()));
      } catch (error) {
        // Removed between the stat and the watch: retry on the next resync.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { anyMissing = true; continue; }
        throw error;
      }
      handle.on("error", fail);
      handles.set(directory, handle);
      opened++;
    }
    missing = anyMissing;
    return opened;
  }

  async function resolveAll(): Promise<number> {
    resolutionCount++;
    const directories = new Set<string>();
    const narrow = new Map<string, string[]>();
    const nonGit = new Set<string>();
    for (const entry of options.entries) {
      const candidates = await candidateDirectories(entry);
      for (const directory of candidates.directories) directories.add(directory);
      if (candidates.nonGitRoot) {
        const real = await realpath(candidates.nonGitRoot).catch(() => null);
        if (real) { directories.add(real); nonGit.add(real); }
      }
      const repository = await narrowRepository(entry);
      if (repository) narrow.set(repository.topLevel, [...(narrow.get(repository.topLevel) ?? []), repository.root]);
      if (closed || failed) return 0;
    }
    nonGitRoots = nonGit;
    const opened = await open([...directories]);
    if (closed || failed) return 0;
    await openTrees(narrow);
    return opened;
  }

  // Coalesced: one resolution at a time, plus one follow-up if events asked
  // for another while it ran.
  function resync(): Promise<void> {
    if (resolving) { resolveAgain = true; return resolving; }
    resolving = (async () => {
      do {
        resolveAgain = false;
        let opened: number;
        try { opened = await resolveAll(); }
        catch (error) { fail(error); return; }
        // A newly watched directory's current entries were written before
        // its watch existed (the fetch that created refs/remotes/origin).
        if (opened > 0 && !closed && !failed) options.onChange(null);
      } while (resolveAgain && !closed && !failed);
    })().finally(() => { resolving = null; });
    return resolving;
  }

  function close() {
    closed = true;
    for (const handle of handles.values()) handle.close();
    handles.clear();
    for (const tree of trees.values()) tree.handle.close();
    trees.clear();
  }

  return {
    async start() {
      await resolveAll();
    },
    directories: () => [...handles.keys()].sort(),
    trees: () => [...trees.keys()].sort(),
    resolutions: () => resolutionCount,
    close,
  };
}
