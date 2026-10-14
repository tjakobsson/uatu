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
  const watcher = chokidar.watch(entry.absolutePath, {
    ignored: options.ignored, usePolling: polling, interval: 100,
    ignoreInitial: false, alwaysStat: true, followSymlinks: false, atomic: true, awaitWriteFinish: false,
  });
  return polling ? new PolledBaselineCheck(watcher, options.ignored) : watcher;
}

// Chokidar polls each file and directory with fs.watchFile, which (in Bun, as
// in Node's libuv) takes its baseline stat asynchronously after the watch is
// registered. A change that lands before that stat becomes the baseline and is
// never reported: an edit to a file, or a file created in a directory that
// was just found. The index has no periodic rescan to repair either. So each
// state reported for a file, and each directory reported, is checked once
// more after this delay; a missed edit is reported then, and a missed child
// is handed to Chokidar to watch.
export const POLL_BASELINE_SETTLE_MS = 1000;

const sameState = (a: Stats | undefined, b: Stats): boolean => a !== undefined && a.mtimeMs === b.mtimeMs
  && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino;

type PolledWatcher = EventEmitter & { add(path: string): unknown; close(): Promise<void> };

export class PolledBaselineCheck extends EventEmitter implements FileObserver {
  // The stats each file was last reported with.
  private reported = new Map<string, Stats>();
  // The children reported for each reported directory.
  private children = new Map<string, Set<string>>();
  // Paths awaiting their check, in due order.
  private due = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  // One batch at a time: paths that come due while a batch runs wait for the
  // next one, so the 16-path bound holds however slow the metadata reads are.
  private checking = false;
  private closed = false;

  constructor(
    private watcher: PolledWatcher,
    private ignored: Options["ignored"],
    private settleMs = POLL_BASELINE_SETTLE_MS,
    private fs: { lstat: typeof lstat; readdir: typeof readdir } = { lstat, readdir },
  ) {
    super();
    watcher.on("all", (event: string, file: string, stats?: Stats) => {
      // Chokidar's own reports pass through unchanged, even one that repeats
      // a state: the session reads a policy file's change as an edit it may
      // not have loaded yet.
      if (event === "add" || event === "change") {
        this.children.get(path.dirname(file))?.add(file);
        if (stats) { this.reported.set(file, stats); this.schedule(file); }
      } else if (event === "addDir") {
        this.children.get(path.dirname(file))?.add(file);
        if (!this.children.has(file)) this.children.set(file, new Set());
        this.schedule(file);
      } else if (event === "unlink" || event === "unlinkDir") {
        this.children.get(path.dirname(file))?.delete(file);
        this.children.delete(file);
        this.reported.delete(file);
        this.due.delete(file);
      }
      this.emit("all", event, file, stats);
    });
    watcher.on("raw", (...args: unknown[]) => this.emit("raw", ...args));
    watcher.on("ready", () => this.emit("ready"));
    watcher.on("error", (error: unknown) => this.emit("error", error));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.due.clear();
    this.reported.clear();
    this.children.clear();
    await this.watcher.close();
    this.removeAllListeners();
  }

  private schedule(file: string): void {
    this.due.delete(file);
    this.due.set(file, performance.now() + this.settleMs);
    this.arm();
  }

  private arm(): void {
    if (this.closed || this.timer || this.checking) return;
    const next = this.due.values().next();
    if (next.done) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.checking = true;
      void this.check().finally(() => { this.checking = false; this.arm(); });
    }, Math.max(0, next.value - performance.now()));
    this.timer.unref?.();
  }

  private async check(): Promise<void> {
    const now = performance.now();
    const paths: string[] = [];
    for (const [file, at] of this.due) {
      if (at > now) break;
      paths.push(file);
      this.due.delete(file);
    }
    // Bounded like the native observer's metadata work.
    let next = 0;
    const worker = async () => {
      while (next < paths.length && !this.closed) {
        const file = paths[next++]!;
        await (this.children.has(file) ? this.checkDirectory(file) : this.checkFile(file));
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, paths.length) }, worker));
  }

  // Drops a path and everything under it from the check's own state.
  private forget(target: string): void {
    const prefix = target + path.sep;
    const under = (p: string) => p === target || p.startsWith(prefix);
    this.children.get(path.dirname(target))?.delete(target);
    for (const p of [...this.reported.keys()]) if (under(p)) this.reported.delete(p);
    for (const p of [...this.children.keys()]) if (under(p)) this.children.delete(p);
    for (const p of [...this.due.keys()]) if (under(p)) this.due.delete(p);
  }

  private async checkFile(file: string): Promise<void> {
    const expected = this.reported.get(file);
    if (!expected) return;
    // lstat: following a link would report its target as this file.
    const stats = await this.fs.lstat(file).catch(() => null);
    // Removal stays with Chokidar's own unlink. A newer report while this
    // stat ran means the file's polling is live, and this stat may be older
    // than that report.
    if (this.closed || !stats || this.reported.get(file) !== expected) return;
    if (stats.isSymbolicLink()) {
      // Replaced by a link before the baseline: the watch policy excludes
      // links, so the file is gone from the index's point of view.
      this.reported.delete(file);
      this.children.get(path.dirname(file))?.delete(file);
      this.emit("all", "unlink", file);
      return;
    }
    if (!stats.isFile() || sameState(expected, stats)) return;
    this.reported.set(file, stats);
    this.emit("all", "change", file, stats);
  }

  private async checkDirectory(directory: string): Promise<void> {
    // A directory removed meanwhile, or one that cannot be read, is left to
    // Chokidar. lstat first: readdir would follow a link and list its
    // target's children as this directory's.
    const before = await this.fs.lstat(directory).catch(() => null);
    if (this.closed || !before || !this.children.has(directory)) return;
    if (before.isSymbolicLink()) {
      // Replaced by a link before the baseline: the watch policy excludes
      // links, so the directory and everything under it are gone.
      this.forget(directory);
      this.emit("all", "unlinkDir", directory);
      return;
    }
    if (!before.isDirectory()) return;
    const entries = await this.fs.readdir(directory, { withFileTypes: true }).catch(() => null);
    // Swapped while it was read: what readdir listed may not be this
    // directory's. Chokidar, or the next reported state, settles it.
    const after = await this.fs.lstat(directory).catch(() => null);
    const known = this.children.get(directory);
    if (this.closed || !entries || !known || !after?.isDirectory() || after.ino !== before.ino || after.dev !== before.dev) return;
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (known.has(child) || entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory()) || this.ignored(child, entry)) continue;
      // Chokidar stats, watches and reports the child itself; one it has
      // meanwhile found on its own is not reported twice.
      this.watcher.add(child);
    }
  }
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
