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
  // A working-tree path the content watcher excludes (built-in folders such
  // as dist/, .uatu.json excludes, a .gitignore it honours). Git may still
  // track it, so it is considered here against Git's own ignore rules.
  noteWorkingTreeChange(file: string): void;
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
  const isDirectory = (candidate: string) => stat(candidate).then(info => info.isDirectory(), () => false);
  const reftable = await gitPath(cwd, ["rev-parse", "--git-path", "reftable"]);
  if (reftable && await isDirectory(reftable)) directories.add(reftable);
  // info/exclude changes what Git reports as untracked and ignored.
  const exclude = await gitPath(cwd, ["rev-parse", "--git-path", "info/exclude"]);
  if (exclude && await isDirectory(path.dirname(exclude))) directories.add(path.dirname(exclude));
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

// Per repository: the top-level .gitignore, the tracked files it nonetheless
// matches (Git still reports those), and for a narrow root the recursive
// working-tree watch covering the rest of the repository.
type RepositoryState = {
  roots: string[];
  handle: FSWatcher | null;
  ignored: Ignore;
  trackedIgnored: Set<string>;
  refreshing: Promise<void> | null;
  refreshAgain: boolean;
};

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
  const repositories = new Map<string, RepositoryState>();
  // Watched roots as spelled by the session, with their real paths, so a
  // content-watcher path can be placed in its repository.
  let aliases: Array<{ spelled: string; real: string; topLevel: string }> = [];
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
    // Staging can track a file the .gitignore matches (git add -f), and
    // info/exclude changes what counts as ignored.
    if (base === "index" || base === "exclude") for (const [topLevel, state] of repositories) void refreshTracked(topLevel, state);
    options.onChange(base);
  }

  function refreshTracked(topLevel: string, state: RepositoryState): Promise<void> {
    if (state.refreshing) { state.refreshAgain = true; return state.refreshing; }
    state.refreshing = (async () => {
      do {
        state.refreshAgain = false;
        const [ignored, trackedIgnored] = await Promise.all([loadGitignore(topLevel), loadTrackedIgnored(topLevel)]);
        state.ignored = ignored;
        state.trackedIgnored = trackedIgnored;
      } while (state.refreshAgain && !closed && !failed);
    })().catch(() => {}).finally(() => { state.refreshing = null; });
    return state.refreshing;
  }

  // Whether a working-tree change can matter to Git. Errs towards
  // triggering: a missed ignore costs one silent collection, while a dropped
  // tracked path would leave the Change Overview stale.
  function consider(topLevel: string, state: RepositoryState, relative: string) {
    const segments = relative.split("/");
    if (segments.includes(".git")) return;
    const base = segments[segments.length - 1] ?? relative;
    // Any .gitignore, nested ones included, can change what is tracked but
    // ignored.
    if (base === ".gitignore") void refreshTracked(topLevel, state);
    else if (state.ignored.ignores(relative) && !state.trackedIgnored.has(relative)) return;
    options.onChange(base);
  }

  // Events from a narrow root's working-tree watch. Inside a watched root the
  // content watcher reports them (excluded ones through
  // noteWorkingTreeChange), so only the rest of the repository counts here.
  function receiveTree(topLevel: string, name: string | null) {
    if (closed || failed) return;
    const state = repositories.get(topLevel);
    if (!state) return;
    if (name === null) { options.onChange(null); return; }
    if (state.roots.some(root => contains(root, path.join(topLevel, name)))) return;
    consider(topLevel, state, name.split(path.sep).join("/"));
  }

  function noteWorkingTreeChange(file: string) {
    if (closed || failed) return;
    let owner: (typeof aliases)[number] | undefined;
    for (const alias of aliases) {
      if (contains(alias.spelled, file) && (!owner || alias.spelled.length > owner.spelled.length)) owner = alias;
    }
    const state = owner && repositories.get(owner.topLevel);
    if (!owner || !state) return;
    const real = path.join(owner.real, path.relative(owner.spelled, file));
    const relative = path.relative(owner.topLevel, real).split(path.sep).join("/");
    if (relative.startsWith("..")) return;
    consider(owner.topLevel, state, relative);
  }

  async function syncRepositories(wanted: Map<string, { roots: string[]; narrow: boolean }>) {
    for (const [topLevel, state] of repositories) {
      if (!wanted.has(topLevel)) { state.handle?.close(); repositories.delete(topLevel); }
    }
    for (const [topLevel, want] of wanted) {
      let state = repositories.get(topLevel);
      if (!state) {
        const [ignored, trackedIgnored] = await Promise.all([loadGitignore(topLevel), loadTrackedIgnored(topLevel)]);
        if (closed || failed) return;
        state = { roots: want.roots, handle: null, ignored, trackedIgnored, refreshing: null, refreshAgain: false };
        repositories.set(topLevel, state);
      }
      state.roots = want.roots;
      if (want.narrow && !state.handle) {
        state.handle = watchDirectory(topLevel, { recursive: true }, (_event, filename) => receiveTree(topLevel, filename == null ? null : filename.toString()));
        state.handle.on("error", fail);
      } else if (!want.narrow && state.handle) {
        state.handle.close();
        state.handle = null;
      }
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
    const wanted = new Map<string, { roots: string[]; narrow: boolean }>();
    const spelled: typeof aliases = [];
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
        const known = wanted.get(repository.topLevel);
        wanted.set(repository.topLevel, { roots: [...(known?.roots ?? []), repository.root], narrow: (known?.narrow ?? false) || repository.narrow });
        spelled.push({ spelled: entry.absolutePath, real: repository.root, topLevel: repository.topLevel });
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
    await syncRepositories(wanted);
    aliases = spelled;
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
    for (const state of repositories.values()) state.handle?.close();
    repositories.clear();
  }

  return {
    async start() {
      resolveAgain = false;
      await resolveAll();
      if (resolveAgain && !closed && !failed) await resync();
    },
    directories: () => [...handles.keys()].sort(),
    trees: () => [...repositories].filter(([, state]) => state.handle).map(([topLevel]) => topLevel).sort(),
    noteWorkingTreeChange,
    resolutions: () => resolutionCount,
    close,
  };
}
