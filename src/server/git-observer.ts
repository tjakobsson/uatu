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

// The repository a watch entry belongs to, by real path. The entry is narrow
// when it covers less than its repository: a subdirectory, or a single file.
// Edits elsewhere in that repository change its Git data but never reach the
// content watcher.
async function repositoryOf(entry: WatchEntry): Promise<{ topLevel: string; root: string; narrow: boolean } | null> {
  const cwd = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
  const result = await safeGit(cwd, ["rev-parse", "--show-toplevel"]);
  const reported = result.ok ? result.stdout.trim() : "";
  if (!reported) return null;
  const topLevel = await realpath(reported).catch(() => null);
  const root = await realpath(entry.absolutePath).catch(() => null);
  if (!topLevel || !root) return null;
  return { topLevel, root, narrow: entry.kind === "file" || root !== topLevel };
}

export async function narrowRepository(entry: WatchEntry): Promise<{ topLevel: string; root: string } | null> {
  const repository = await repositoryOf(entry);
  return repository?.narrow ? { topLevel: repository.topLevel, root: repository.root } : null;
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
  // Repository top levels whose roots cover the whole repository and that
  // currently need no working-tree watch.
  let wholeRepositories = new Set<string>();
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
    if (base === "index") {
      for (const [topLevel, tree] of trees) void refreshTracked(topLevel, tree);
      checkQuietRepositories();
    }
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

  // Working-tree events the content watcher cannot see: anything outside a
  // narrow root, and tracked files the .gitignore matches anywhere (the
  // content watcher honours the .gitignore, Git still reports them). Errs
  // towards triggering: a missed ignore costs one silent collection, while a
  // dropped tracked path would leave the Change Overview stale.
  function receiveTree(topLevel: string, name: string | null) {
    if (closed || failed) return;
    const tree = trees.get(topLevel);
    if (!tree) return;
    if (name === null) { options.onChange(null); return; }
    const relative = name.split(path.sep).join("/");
    if (relative.split("/").includes(".git")) return;
    const absolute = path.join(topLevel, name);
    if (relative === ".gitignore") void refreshTracked(topLevel, tree);
    if (tree.trackedIgnored.has(relative)) { options.onChange(path.basename(name)); return; }
    if (tree.roots.some(root => contains(root, absolute))) return;
    if (relative !== ".gitignore" && tree.ignored.ignores(relative)) return;
    options.onChange(path.basename(name));
  }

  // A repository gets a working-tree watch when a watched root is narrower
  // than it, or when it tracks files its .gitignore matches. A whole-repository
  // root without such files needs none; it is rechecked when its index changes.
  async function openTrees(repositories: Map<string, { roots: string[]; narrow: boolean }>) {
    const wanted = new Map<string, { roots: string[]; ignored: Ignore; trackedIgnored: Set<string> }>();
    const quiet = new Set<string>();
    for (const [topLevel, repository] of repositories) {
      const existing = trees.get(topLevel);
      const trackedIgnored = existing?.trackedIgnored ?? await loadTrackedIgnored(topLevel);
      if (closed || failed) return;
      if (!repository.narrow && trackedIgnored.size === 0) { quiet.add(topLevel); continue; }
      wanted.set(topLevel, { roots: repository.roots, ignored: existing?.ignored ?? await loadGitignore(topLevel), trackedIgnored });
    }
    if (closed || failed) return;
    wholeRepositories = quiet;
    for (const [topLevel, tree] of trees) {
      if (!wanted.has(topLevel)) { tree.handle.close(); trees.delete(topLevel); }
    }
    for (const [topLevel, want] of wanted) {
      const existing = trees.get(topLevel);
      if (existing) { existing.roots = want.roots; continue; }
      const handle = watchDirectory(topLevel, { recursive: true }, (_event, filename) => receiveTree(topLevel, filename == null ? null : filename.toString()));
      handle.on("error", fail);
      trees.set(topLevel, { handle, roots: want.roots, ignored: want.ignored, trackedIgnored: want.trackedIgnored, refreshing: null, refreshAgain: false });
    }
  }

  // A whole-repository root with no tracked-but-ignored files has no tree
  // watch. Staging can create one (git add -f), so its index changes are
  // checked with one ls-files call; a hit re-resolves to open the watch.
  const checkingQuiet = new Set<string>();
  function checkQuietRepositories() {
    for (const topLevel of wholeRepositories) {
      if (checkingQuiet.has(topLevel)) continue;
      checkingQuiet.add(topLevel);
      void loadTrackedIgnored(topLevel).then(found => {
        if (found.size && !closed && !failed) void resync();
      }).finally(() => checkingQuiet.delete(topLevel));
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
    const repositories = new Map<string, { roots: string[]; narrow: boolean }>();
    const nonGit = new Set<string>();
    const pendingGit = new Set<string>();
    for (const entry of options.entries) {
      const candidates = await candidateDirectories(entry);
      for (const directory of candidates.directories) directories.add(directory);
      if (candidates.nonGitRoot) {
        const real = await realpath(candidates.nonGitRoot).catch(() => null);
        if (real) {
          directories.add(real);
          nonGit.add(real);
          // `git init` creates .git before it writes HEAD, so the first
          // resolution can still find no repository. Watching the half-made
          // .git lets its HEAD or config write resolve again.
          const pending = path.join(real, ".git");
          if (await stat(pending).then(info => info.isDirectory(), () => false)) { directories.add(pending); pendingGit.add(pending); }
        }
      }
      const repository = await repositoryOf(entry);
      if (repository) {
        const known = repositories.get(repository.topLevel);
        repositories.set(repository.topLevel, { roots: [...(known?.roots ?? []), repository.root], narrow: (known?.narrow ?? false) || repository.narrow });
      }
      if (closed || failed) return 0;
    }
    nonGitRoots = nonGit;
    const watchedBefore = new Set(handles.keys());
    const opened = await open([...directories]);
    if (closed || failed) return 0;
    // git init may have finished between finding no repository and the
    // half-made .git's watch going live, leaving no event to come. Resolve
    // once more now that later writes are observed.
    if ([...pendingGit].some(directory => handles.has(directory) && !watchedBefore.has(directory))) resolveAgain = true;
    await openTrees(repositories);
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
      resolveAgain = false;
      await resolveAll();
      if (resolveAgain && !closed && !failed) await resync();
    },
    directories: () => [...handles.keys()].sort(),
    trees: () => [...trees.keys()].sort(),
    resolutions: () => resolutionCount,
    close,
  };
}
