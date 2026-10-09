// One native recursive subscription per directory, with a bounded inventory
// walk. Chokidar remains the polling/unsupported-platform fallback. In Bun,
// Chokidar 5's native per-file subscriptions make large startup crawls stall.
import { EventEmitter } from "node:events";
import { watch, type FSWatcher, type Stats } from "node:fs";
import { lstat, stat, readdir } from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import type { WatchEntry } from "./roots";
import type { createWatchPolicy } from "./watch-policy";

export type FileObserver = EventEmitter & { close(): Promise<void> };
type Options = {
  ignored: ReturnType<typeof createWatchPolicy>["ignored"];
  usePolling?: boolean;
  renew?: boolean;
  // Controlled native notifications with real filesystem reads in tests.
  watch?: typeof watch;
  onWork?: (kind: "watch" | "stat" | "directory") => void;
};
type NativeSubscription = { watcher: FSWatcher; listeners: Set<(event: string, file: string | null) => void> };
const subscriptions = new Map<string, NativeSubscription>();

function contained(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function subscribe(root: string, listener: (event: string, file: string | null) => void, onWork?: Options["onWork"], renew = false, watchFiles = watch): () => void {
  // Nested roots share coverage. Recovery requests a fresh handle before the
  // old observer releases its subscription, even if that old handle is stale.
  const parent = renew ? undefined : [...subscriptions.keys()].find(candidate => contained(candidate, root));
  const key = parent ?? root;
  let subscription = renew ? undefined : subscriptions.get(key);
  if (!subscription) {
    const listeners = new Set<(event: string, file: string | null) => void>();
    const watcher = watchFiles(root, { recursive: true }, (event, filename) => {
      const file = filename == null ? null : path.resolve(root, filename.toString());
      for (const receive of listeners) receive(event, file);
    });
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      if (subscriptions.get(key)?.watcher === watcher) subscriptions.delete(key);
      watcher.close();
      for (const receive of listeners) receive("error", null);
    };
    watcher.on("error", fail);
    watcher.on("close", () => { if (listeners.size) fail(); });
    subscription = { watcher, listeners };
    subscriptions.set(key, subscription);
    onWork?.("watch");
  }
  subscription.listeners.add(listener);
  const owned = subscription;
  return () => {
    owned.listeners.delete(listener);
    if (owned.listeners.size === 0) {
      if (subscriptions.get(key) === owned) subscriptions.delete(key);
      owned.watcher.close();
    }
  };
}

// Polling mode: the session's --poll choice, overridden either way by
// Chokidar's own CHOKIDAR_USEPOLLING. The Git metadata observer follows it too.
export function pollingRequested(usePolling: boolean | undefined): boolean {
  const poll = process.env.CHOKIDAR_USEPOLLING?.toLowerCase();
  return poll === undefined ? usePolling === true : poll !== "false" && poll !== "0" && poll !== "";
}

export function observeFiles(entry: WatchEntry, options: Options): FileObserver {
  const polling = pollingRequested(options.usePolling);
  if (!polling) {
    try { return new DirectoryObserver(entry, options); }
    catch (error) {
      if (!["ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "ERR_INVALID_ARG_VALUE", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return chokidar.watch(entry.absolutePath, {
    ignored: options.ignored, usePolling: polling, interval: 100,
    ignoreInitial: false, alwaysStat: true, followSymlinks: false, atomic: true, awaitWriteFinish: false,
  });
}

class DirectoryObserver extends EventEmitter implements FileObserver {
  private known = new Map<string, Stats>();
  private children = new Map<string, Set<string>>();
  private pending = new Map<string, boolean>();
  private activePaths = new Set<string>();
  private deleted = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private ready = false;
  private failed = false;
  private scheduled = false;
  private release: () => void;

  constructor(private entry: WatchEntry, private options: Options) {
    super();
    const root = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
    this.release = subscribe(root, (event, file) => {
      if (this.stopped) return;
      if (file === null) { this.emit("error", new Error("Filesystem observation needs recovery")); return; }
      if (entry.kind === "file") {
        // Save-by-rename can report only the temporary sibling's name. The
        // single allowed destination is enough to reconcile that ambiguity.
        if (file !== entry.absolutePath && !(event === "rename" && path.dirname(file) === entry.parentDir)) return;
        this.emit("raw", event, file);
        this.enqueue(entry.absolutePath, false);
        return;
      }
      if (!contained(entry.absolutePath, file)) return;
      this.emit("raw", event, file);
      if (event === "rename") {
        // Native backends need not name both sides of a rename. Even an
        // ignored temporary source can have replaced an allowed sibling.
        // The keyed queue coalesces bursts; force one shallow parent check.
        const parent = path.dirname(file);
        if (contained(entry.absolutePath, parent) && !options.ignored(parent)) this.enqueue(parent, true);
      }
      if (!options.ignored(file)) this.enqueue(file, event === "rename");
    }, options.onWork, options.renew, options.watch);
    // Listeners are attached by the caller before either discovery or errors
    // can be delivered. Watching starts before the walk, closing its race.
    queueMicrotask(() => this.enqueue(entry.absolutePath, true));
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.release();
    this.pending.clear();
    for (const timer of this.deleted.values()) clearTimeout(timer);
    this.deleted.clear();
    this.known.clear();
    this.children.clear();
    this.removeAllListeners();
  }

  private enqueue(file: string, discover: boolean): void {
    if (this.stopped) return;
    this.pending.set(file, (this.pending.get(file) ?? false) || discover);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  private pump(): void {
    if (this.stopped) return;
    for (const [file, discover] of this.pending) {
      if (this.activePaths.size >= 16) break;
      if (this.activePaths.has(file)) continue;
      this.pending.delete(file);
      this.activePaths.add(file);
      void this.inspect(file, discover).catch(error => {
        if (!this.stopped) { this.failed = true; this.emit("error", error); }
      }).finally(() => {
        this.activePaths.delete(file);
        this.pump();
      });
    }
    if (!this.ready && !this.failed && !this.pending.size && !this.activePaths.size) {
      this.ready = true;
      this.emit("ready");
    }
    if (!this.pending.size && !this.activePaths.size) this.emit("idle");
  }

  private async inspect(file: string, discover: boolean): Promise<void> {
    this.options.onWork?.("stat");
    let stats: Stats;
    try { stats = await (file === this.entry.absolutePath && this.entry.kind === "dir" ? stat(file) : lstat(file)); }
    catch (error) {
      if (file === this.entry.absolutePath && this.entry.kind === "dir" && !this.ready) throw error;
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) { this.scheduleRemoval(file); return; }
      throw error;
    }
    if (this.stopped) return;
    if (stats.isSymbolicLink() || this.options.ignored(file, stats)) { this.remove(file); return; }
    const deletion = this.deleted.get(file);
    if (deletion) clearTimeout(deletion);
    this.deleted.delete(file);
    const previous = this.known.get(file);
    const directory = stats.isDirectory();
    if (!directory && !stats.isFile()) return;
    if (previous && previous.isDirectory() !== directory) this.remove(file);
    this.known.set(file, stats);
    if (file !== this.entry.absolutePath) {
      const parent = path.dirname(file);
      let children = this.children.get(parent);
      if (!children) this.children.set(parent, children = new Set());
      children.add(file);
    }
    if (directory) {
      if (!previous) this.emit("all", "addDir", file, stats);
      if (!discover && previous?.isDirectory() && previous.mtimeMs === stats.mtimeMs && previous.ino === stats.ino) return;
      this.options.onWork?.("directory");
      const entries = await readdir(file, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      if (this.stopped) return;
      const present = new Set<string>();
      for (const entry of entries) {
        const child = path.join(file, entry.name);
        present.add(child);
        // Dirent supplies the kind needed by ignore policy before descending.
        if (entry.isSymbolicLink() || this.options.ignored(child, entry)) { this.remove(child); continue; }
        if (!this.known.has(child)) this.enqueue(child, true);
        // Recheck existing entries after an ambiguous rename, including a
        // replaced target whose name never left the directory. Known child
        // directories use the metadata fast path rather than another crawl.
        else if (discover || previous?.isDirectory() && previous.ino !== stats.ino) this.enqueue(child, false);
      }
      for (const child of this.children.get(file) ?? []) if (!present.has(child)) this.scheduleRemoval(child);
    } else {
      // Ignore read-induced atime notifications and duplicate native events.
      // ctime and identity still distinguish equal-mtime replacements/edits.
      const changed = !previous || previous.mtimeMs !== stats.mtimeMs || previous.ctimeMs !== stats.ctimeMs
        || previous.size !== stats.size || previous.ino !== stats.ino;
      if (changed) this.emit("all", previous?.isFile() ? "change" : "add", file, stats);
    }
  }

  private scheduleRemoval(file: string): void {
    if (this.stopped || !this.known.has(file) || this.deleted.has(file)) return;
    // Save-by-rename retains the old entry briefly. A replacement cancels
    // this timer and emits change, rather than an unavailable-preview flash.
    this.deleted.set(file, setTimeout(() => { this.deleted.delete(file); this.remove(file); }, 100));
  }

  private remove(file: string): void {
    if (this.stopped) return;
    const previous = this.known.get(file);
    if (!previous) return;
    for (const child of [...(this.children.get(file) ?? [])]) this.remove(child);
    this.children.delete(file);
    this.children.get(path.dirname(file))?.delete(file);
    this.known.delete(file);
    const timer = this.deleted.get(file);
    if (timer) clearTimeout(timer);
    this.deleted.delete(file);
    this.emit("all", previous.isDirectory() ? "unlinkDir" : "unlink", file);
  }
}
