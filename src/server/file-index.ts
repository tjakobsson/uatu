import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { classifyFile, classifyFileName } from "../document/classify";
import type { DiscoveryState, DocumentReference, DocumentRoot, RevisionedDocument, RevisionedFolder, RevisionedRoot } from "../shared/document-updates";
import { isFollowableFile } from "../shared/types";
import type { IgnoreMatcher } from "../ignore/engine";
import type { WatchEntry } from "./roots";
import { NewestDocument } from "./newest-document";
import { createWatchPolicy, rootRelative } from "./watch-policy";
import { createRefreshScheduler, type RefreshSchedulerClock } from "./refresh-scheduler";
import { fileFingerprint, sameFileFingerprint, type FileFingerprint } from "./file-fingerprint";
import { IgnoredFolders } from "./ignored-folders";
import { classifyGitIgnored, type IgnoredInventory } from "./git-ignore";

// Updates inside Git-ignored folders (builds, installs) are coalesced by path
// and published on their own slower cadence in larger patches, so a rebuild
// arrives as a few patches and never delays an ordinary edit.
export const IGNORED_LANE_DEBOUNCE_MS = 1000;
export const IGNORED_LANE_MAX_WAIT_MS = 5000;
export const IGNORED_LANE_PATCH_LIMIT = 1024;
// Files written inside ignored levels nobody has listed are indexed so a fresh
// render reaches Recent; at most this many per root, newest first.
export const IGNORED_WINDOW_LIMIT = 2000;

type Job = { id: string; stats?: Stats; order: number; live: boolean; attempts: number };
export type FileIndexBatch = {
  followCandidates?: { id: string; order: number }[];
  upserts: RevisionedDocument[];
  removals: { rootId: string; id: string }[];
  folderUpserts?: RevisionedFolder[];
  folderRemovals?: DocumentReference[];
  // A batch from the ignored-folder lane: already classified, never followed.
  lane?: boolean;
  changedId: string | null;
  changedOrder: number;
  discovery: DiscoveryState;
};
export type FileIndexOptions = {
  revision: () => number;
  publish: (batch: FileIndexBatch) => void;
  classify?: typeof classifyFile;
  stat?: (id: string) => Promise<Stats>;
  concurrency?: number;
  clock?: RefreshSchedulerClock;
  onWork?: (kind: "stat" | "classify" | "batch") => void;
  onInvalidate?: (id: string, descendants: boolean) => void;
  // Git's ignored folders and files for this root; null outside a work tree.
  ignored?: IgnoredInventory | null;
  windowLimit?: number;
  // Runtime classification of a new directory (tests substitute it).
  classifyDirectory?: (relative: string) => Promise<boolean>;
};

export class FileIndex {
  readonly policy: ReturnType<typeof createWatchPolicy>;
  readonly documents = new Map<string, RevisionedDocument>();
  readonly newest = new NewestDocument();
  private directories = new Map<string, Set<string>>();
  private jobs = new Map<string, Job>();
  // Jobs for paths inside ignored folders wait here, and may hold at most
  // half the slots, so a build or install never starves an ordinary edit.
  private laneJobs = new Map<string, Job>();
  private activeLane = 0;
  private requested = new Set<string>();
  private current = new Map<string, number>();
  private pending = new Map<string, { doc: RevisionedDocument | null; live: boolean; order: number }>();
  private active = 0;
  private ready = false;
  private initialComplete = false;
  private initialPublished = false;
  private stopped = false;
  private error: string | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduler: ReturnType<typeof createRefreshScheduler>;
  private waiters: (() => void)[] = [];
  private publicationWaiters: (() => void)[] = [];
  private pathWaiters = new Map<string, (() => void)[]>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private fingerprints = new Map<string, { revision: number; value: FileFingerprint }>();
  readonly ignoredFolders: IgnoredFolders;
  readonly folders = new Map<string, RevisionedFolder>();
  private readonly knownIgnoredFiles: Set<string>;
  private git: boolean;
  private lanePending = new Map<string, { doc: RevisionedDocument | null; order: number }>();
  private folderPending = new Map<string, RevisionedFolder | null>();
  private laneScheduler: ReturnType<typeof createRefreshScheduler>;
  private laneDrainTimer: ReturnType<typeof setTimeout> | null = null;
  // Windowed documents in write order (oldest first), and the pinned ones.
  // Windowed documents by observed write order (ascending), and the latest
  // order appended; a late-classified older write is placed by its order.
  private windowed = new Map<string, number>();
  private windowTail = 0;
  // Counts folder removals, so a classification started before one can
  // tell that its directory may be gone.
  private folderRemovals = 0;
  private pinned = new Set<string>();

  constructor(readonly entry: WatchEntry, readonly matcher: IgnoreMatcher, private options: FileIndexOptions) {
    this.policy = createWatchPolicy(entry, matcher);
    this.scheduler = createRefreshScheduler(() => this.flush(), options.clock);
    this.laneScheduler = createRefreshScheduler(() => this.flushLane(), options.clock,
      { debounceMs: IGNORED_LANE_DEBOUNCE_MS, maxWaitMs: IGNORED_LANE_MAX_WAIT_MS });
    const inventory = entry.kind === "dir" ? options.ignored ?? null : null;
    this.git = inventory !== null;
    this.ignoredFolders = new IgnoredFolders(inventory?.folders ?? []);
    this.knownIgnoredFiles = new Set(inventory?.files ?? []);
    // Seeded entries are part of the first snapshot, before any publication.
    for (const relative of inventory?.folders ?? []) {
      const id = path.join(entry.absolutePath, ...relative.split("/"));
      if (this.policy.accepts(id, DIRECTORY)) this.folders.set(id, this.folderEntry(id, relative, false, 0));
    }
  }

  // The Git inventory, when it arrives after the index (so a file can be
  // opened while Git runs). Its folder entries are published as a patch.
  setIgnoredInventory(inventory: IgnoredInventory | null): void {
    if (this.entry.kind !== "dir" || !inventory) return;
    this.git = true;
    for (const file of inventory.files) this.knownIgnoredFiles.add(file);
    for (const relative of inventory.folders) {
      this.ignoredFolders.addTop(relative);
      const id = path.join(this.entry.absolutePath, ...relative.split("/"));
      if (this.policy.accepts(id, DIRECTORY)) this.queueFolder(id, relative);
    }
  }

  get discovery(): DiscoveryState {
    return {
      status: this.error ? "error" : this.initialComplete && (this.initialPublished || this.unpublished === 0) ? "ready" : "indexing",
      discovered: this.documents.size,
      ...(this.error ? { message: this.error } : {}),
    };
  }
  get hasPendingChanges(): boolean { return this.pending.size > 0; }
  private get unpublished(): number { return this.pending.size + this.lanePending.size + this.folderPending.size; }
  fingerprint(id: string, revision: number): FileFingerprint | null {
    const stored = this.fingerprints.get(id);
    return stored?.revision === revision ? stored.value : null;
  }

  metadata(): DocumentRoot {
    return { id: this.entry.absolutePath, path: this.entry.kind === "dir" ? this.entry.absolutePath : this.entry.parentDir,
      label: path.basename(this.entry.absolutePath) || this.entry.absolutePath, hiddenCount: this.policy.hidden.size };
  }

  snapshot(): RevisionedRoot {
    return {
      ...this.metadata(),
      docs: [...this.documents.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      ...(this.folders.size ? { folders: [...this.folders.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)) } : {}),
    };
  }

  isIgnoredPath(id: string): boolean {
    const relative = rootRelative(this.entry, path.resolve(id));
    return !!relative && this.ignoredFolders.isInside(relative);
  }

  // A directory inside the ignored tree that nobody has listed: the watcher
  // knows it but does not read it.
  isUnlistedDirectory(id: string): boolean {
    id = path.resolve(id);
    const relative = rootRelative(this.entry, id);
    // Chokidar asks without stats; a path known as a file is not a folder,
    // so its removal must not be suppressed.
    if (this.documents.has(id) || this.pending.get(id)?.doc || this.lanePending.get(id)?.doc) return false;
    return !!relative && this.ignoredFolders.isUnlistedDirectory(relative);
  }

  // A directory created after discovery: Git decides whether it is ignored
  // as a whole before the watcher reads it.
  async classifyNewDirectory(id: string): Promise<boolean> {
    const relative = rootRelative(this.entry, path.resolve(id));
    if (!relative || !this.git || this.stopped) return false;
    if (this.ignoredFolders.isInside(relative)) return this.ignoredFolders.isUnlistedDirectory(relative);
    const generation = this.folderRemovals;
    const ignored = this.options.classifyDirectory
      ? await this.options.classifyDirectory(relative)
      : (await classifyGitIgnored(this.entry.absolutePath, [`${relative}/`]))[0] === "ignored";
    if (!ignored || this.stopped) return false;
    // A removal while Git answered may have taken the directory away.
    if (generation !== this.folderRemovals && !(await lstat(id).catch(() => null))?.isDirectory()) return false;
    this.ignoredFolders.addTop(relative);
    this.queueFolder(path.resolve(id), relative);
    return true;
  }

  // A folder Git now ignores that was already read (polling cannot ask Git
  // before walking): it becomes an ignored folder in place. Every level that
  // holds known files stays listed and current; nothing is re-indexed.
  adoptIgnoredFolder(relative: string): void {
    if (this.entry.kind !== "dir" || this.ignoredFolders.isInside(relative)) return;
    this.ignoredFolders.addTop(relative);
    const levels = new Set<string>();
    for (const doc of this.documents.values()) {
      if (!doc.relativePath.startsWith(`${relative}/`)) continue;
      // Every level from the file's folder up to (and including) the adopted one.
      for (let level = path.posix.dirname(doc.relativePath); ; level = path.posix.dirname(level)) {
        levels.add(level);
        if (level === relative || !level.startsWith(`${relative}/`)) break;
      }
    }
    const id = path.join(this.entry.absolutePath, ...relative.split("/"));
    if (!levels.size) { if (this.policy.accepts(id, DIRECTORY)) this.queueFolder(id, relative); return; }
    for (const level of [...levels].sort((a, b) => a.length - b.length)) {
      this.markListed(path.join(this.entry.absolutePath, ...level.split("/")));
    }
  }

  // Lists one level of an ignored folder: its subfolders become folder
  // entries, its files are admitted by the caller, and live writes directly
  // inside it leave the window.
  markListed(id: string): void {
    const relative = rootRelative(this.entry, path.resolve(id));
    if (!relative || !this.ignoredFolders.isInside(relative)) return;
    this.ignoredFolders.markListed(relative);
    for (const windowedId of [...this.windowed.keys()]) {
      if (path.dirname(windowedId) === path.resolve(id)) this.windowed.delete(windowedId);
    }
    this.queueFolder(path.resolve(id), relative, true);
  }

  admitFolder(id: string): void {
    const relative = rootRelative(this.entry, path.resolve(id));
    if (relative && this.ignoredFolders.isPublishedFolder(relative)) this.queueFolder(path.resolve(id), relative);
  }

  // A folder that no longer exists: its entry, its descendants' entries and
  // documents, and its listed levels go.
  forgetFolder(id: string): void {
    id = path.resolve(id);
    const relative = rootRelative(this.entry, id);
    // "" is the watched root itself: everything under it goes.
    if (relative === null) return;
    this.folderRemovals++;
    const order = this.options.revision();
    for (const child of [...(this.directories.get(id) ?? [])]) this.remove(child, order);
    for (const folderId of new Set([...this.folders.keys(), ...this.folderPending.keys()])) {
      if (folderId !== id && !folderId.startsWith(`${id}${path.sep}`)) continue;
      if (this.folders.has(folderId)) this.folderPending.set(folderId, null);
      else this.folderPending.delete(folderId);
    }
    this.ignoredFolders.forget(relative);
    this.laneScheduler.schedule();
  }

  // A file a client has opened stays indexed even if the window overflows.
  pin(id: string): void { this.pinned.add(path.resolve(id)); }
  // Files a client opened, carried into a replacement index on recovery.
  get pinnedIds(): readonly string[] { return [...this.pinned]; }


  observe(event: string, id: string, stats?: Stats, priority = false): void {
    if (this.stopped) return;
    id = path.resolve(id);
    if (rootRelative(this.entry, id) === null) return;
    if (event === "addDir") {
      const relative = rootRelative(this.entry, id);
      if (relative && this.ignoredFolders.isPublishedFolder(relative) && this.policy.accepts(id, DIRECTORY)) this.queueFolder(id, relative);
      return;
    }
    // The same state discovered twice (a listed level is admitted directly
    // and then read by the watcher) is not a new revision. A change report is
    // an edit; ctime still separates an equal-mtime save.
    if (event === "add" && stats && !this.current.has(id)) {
      const known = this.fingerprints.get(id);
      const doc = this.documents.get(id) ?? this.pending.get(id)?.doc ?? this.lanePending.get(id)?.doc;
      if (known && doc?.revision === known.revision && sameFileFingerprint(known.value, fileFingerprint(stats))) return;
    }
    if (["add", "change", "unlink", "unlinkDir"].includes(event)) {
      this.fingerprints.delete(id);
      this.options.onInvalidate?.(id, event === "unlinkDir");
    }
    if (event === "unlinkDir") {
      // The membership map includes in-flight files, so a late classifier
      // cannot resurrect a descendant removed with its parent directory.
      this.forgetFolder(id);
      return;
    }
    const order = this.options.revision();
    if (event === "unlink" || !this.policy.accepts(id, stats)) {
      this.remove(id, order);
      return;
    }
    if (event !== "add" && event !== "change") return;
    this.cancelRetry(id);
    this.current.set(id, order);
    const job: Job = { id, stats, order, live: !priority && (event === "change" || this.ready), attempts: 0 };
    this.track(id, true);
    if (priority && stats && classifyFileName(path.basename(id)) !== null) {
      this.run(job);
      return;
    }
    this.queueJob(job);
    if (priority) this.requested.add(id);
    this.pump();
  }

  markReady(): void {
    this.ready = true;
    this.schedule();
    this.settle();
  }

  fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.schedule();
  }

  async idle(): Promise<void> {
    if (this.active || this.queuedJobs || this.retryTimers.size) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.flush();
    this.flushLane();
    if (this.unpublished) await new Promise<void>(resolve => this.publicationWaiters.push(resolve));
  }
  async settled(id: string): Promise<void> {
    if (this.current.has(id)) await new Promise<void>(resolve => {
      const waiting = this.pathWaiters.get(id) ?? [];
      waiting.push(resolve); this.pathWaiters.set(id, waiting);
    });
    if (this.lanePending.has(id)) this.flushLane(id); else this.flush(id);
    // A file replacing a folder of the same path waits for that folder's
    // removal; the caller is waiting for the file itself.
    while (!this.stopped && this.pending.get(id)?.doc) {
      await new Promise(resolve => setTimeout(resolve, 0));
      this.flushLane();
      this.flush(id);
    }
  }

  async request(id: string, stats: Stats): Promise<void> {
    const queued = this.jobs.get(id) ?? this.laneJobs.get(id);
    if (queued && classifyFileName(path.basename(id)) !== null) {
      this.jobs.delete(id); this.laneJobs.delete(id); this.requested.delete(id);
      this.run({ ...queued, stats: queued.stats ?? stats });
    } else if (queued) {
      // A waiting client goes first, into a free slot if there is one.
      this.requested.add(id);
      this.pump();
    }
    else if (!this.current.has(id) && !this.pending.get(id)?.doc) this.observe("add", id, stats, true);
    await this.settled(id);
  }

  flush(preferredId?: string): void {
    this.scheduler.cancel();
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    if (this.stopped) return;
    const upserts: RevisionedDocument[] = [];
    const removals: { rootId: string; id: string }[] = [];
    let changedId: string | null = null;
    let changedOrder = 0;
    const followCandidates: { id: string; order: number }[] = [];
    const pending = this.pending;
    const entries = function* () {
      const preferred = preferredId ? pending.get(preferredId) : undefined;
      if (preferred && preferredId) yield [preferredId, preferred] as const;
      yield* pending;
    };
    let blocked = false;
    for (const [id, value] of entries()) {
      // A file replacing a folder of the same path waits until that folder's
      // removal is published; clients cannot hold both at once.
      if (value.doc && this.folderPending.has(id) && this.folderPending.get(id) === null) { blocked = true; continue; }
      this.pending.delete(id);
      if (value.doc) {
        this.documents.set(id, value.doc);
        this.newest.update(value.doc);
        upserts.push(value.doc);
        // Only a file Follow can show is nominated: documents and previewable
        // images. Other binaries are still published but never move a
        // following client's selection.
        if (value.live && isFollowableFile(value.doc)) {
          followCandidates.push({ id, order: value.order });
          if (value.order > changedOrder) { changedId = id; changedOrder = value.order; }
        }
      } else {
        this.documents.delete(id);
        this.newest.remove(id);
        removals.push({ rootId: this.entry.absolutePath, id });
      }
      if (upserts.length + removals.length >= 256) break;
    }
    if (!this.unpublished && this.initialComplete) this.initialPublished = true;
    this.options.onWork?.("batch");
    this.options.publish({ upserts, removals, changedId, changedOrder, followCandidates: followCandidates.sort((a, b) => b.order - a.order), discovery: this.discovery });
    if (blocked) { this.flushLane(); this.schedule(); }
    else if (this.pending.size) this.drainTimer = setTimeout(() => this.flush(), 0);
    else this.resolvePublication();
  }

  // The ignored-folder lane: whole patches of up to IGNORED_LANE_PATCH_LIMIT
  // entries, back to back until the lane is empty.
  // A preferred entry (a file a client is waiting for) leads the first patch.
  flushLane(preferredId?: string): void {
    this.laneScheduler.cancel();
    if (this.laneDrainTimer) clearTimeout(this.laneDrainTimer);
    this.laneDrainTimer = null;
    if (this.stopped || !this.lanePending.size && !this.folderPending.size) { this.resolvePublication(); return; }
    const upserts: RevisionedDocument[] = [];
    const removals: DocumentReference[] = [];
    const folderUpserts: RevisionedFolder[] = [];
    const folderRemovals: DocumentReference[] = [];
    const full = () => upserts.length + removals.length + folderUpserts.length + folderRemovals.length >= IGNORED_LANE_PATCH_LIMIT;
    const lanePending = this.lanePending;
    const laneEntries = function* () {
      const preferred = preferredId ? lanePending.get(preferredId) : undefined;
      if (preferred && preferredId) yield [preferredId, preferred] as const;
      yield* lanePending;
    };
    let blocked = false;
    for (const [id, value] of laneEntries()) {
      if (full()) break;
      if (!this.lanePending.has(id)) continue;
      // A file replacing a folder of the same path follows that folder's
      // removal, published below; it goes in the next patch.
      if (value.doc && this.folderPending.has(id) && this.folderPending.get(id) === null) { blocked = true; continue; }
      this.lanePending.delete(id);
      if (value.doc) { this.documents.set(id, value.doc); upserts.push(value.doc); }
      else if (this.documents.delete(id)) { this.newest.remove(id); removals.push({ rootId: this.entry.absolutePath, id }); }
    }
    for (const [id, folder] of this.folderPending) {
      if (full()) break;
      // A folder leaves only after every pending entry beneath it has been
      // published, so no patch removes a row while its files remain.
      if (!folder && [...this.lanePending.keys()].some(child => child.startsWith(`${id}${path.sep}`))) continue;
      this.folderPending.delete(id);
      if (folder) { this.folders.set(id, folder); folderUpserts.push(folder); }
      else if (this.folders.delete(id)) folderRemovals.push({ rootId: this.entry.absolutePath, id });
    }
    if (!this.unpublished && this.initialComplete) this.initialPublished = true;
    this.options.onWork?.("batch");
    this.options.publish({ upserts, removals, folderUpserts, folderRemovals, changedId: null, changedOrder: 0, followCandidates: [], discovery: this.discovery, lane: true });
    if (this.lanePending.size || this.folderPending.size || blocked) this.laneDrainTimer = setTimeout(() => this.flushLane(), 0);
    else this.resolvePublication();
  }

  private resolvePublication(): void {
    if (!this.unpublished) for (const resolve of this.publicationWaiters.splice(0)) resolve();
  }

  private folderEntry(id: string, relative: string, listed: boolean, revision: number): RevisionedFolder {
    return { id, rootId: this.entry.absolutePath, relativePath: `${relative}/`, listed, revision };
  }

  private queueFolder(id: string, relative: string, listed = this.ignoredFolders.isListed(relative)): void {
    // A queued removal (null) is replaced when the folder reappears.
    const current = this.folderPending.has(id) ? this.folderPending.get(id) : this.folders.get(id);
    if (current && current.listed === listed) return;
    this.folderPending.set(id, this.folderEntry(id, relative, listed, this.options.revision()));
    this.laneScheduler.schedule();
  }

  // Returns false when the write itself is the oldest and leaves the window.
  private touchWindow(id: string, order: number): boolean {
    this.windowed.delete(id);
    if (order >= this.windowTail) { this.windowed.set(id, order); this.windowTail = order; }
    else this.windowed = new Map([...this.windowed, [id, order] as const].sort((a, b) => a[1] - b[1]));
    const limit = this.options.windowLimit ?? IGNORED_WINDOW_LIMIT;
    if (this.windowed.size <= limit) return true;
    for (const candidate of [...this.windowed.keys()]) {
      if (this.windowed.size <= limit) break;
      if (this.pinned.has(candidate)) continue;
      if (candidate === id) { this.windowed.delete(id); return false; }
      this.remove(candidate, this.options.revision());
    }
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.scheduler.cancel();
    this.laneScheduler.cancel();
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.laneDrainTimer) clearTimeout(this.laneDrainTimer);
    this.lanePending.clear();
    this.folderPending.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.jobs.clear();
    this.laneJobs.clear();
    this.requested.clear();
    this.pending.clear();
    this.current.clear();
    this.fingerprints.clear();
    for (const resolve of this.waiters.splice(0)) resolve();
    for (const resolve of this.publicationWaiters.splice(0)) resolve();
    for (const waiting of this.pathWaiters.values()) for (const resolve of waiting) resolve();
    this.pathWaiters.clear();
  }

  private track(id: string, add: boolean): void {
    const rootPath = this.entry.kind === "dir" ? this.entry.absolutePath : this.entry.parentDir;
    for (let parent = path.dirname(id); ; parent = path.dirname(parent)) {
      if (add) {
        let members = this.directories.get(parent);
        if (!members) this.directories.set(parent, members = new Set());
        members.add(id);
      } else {
        const members = this.directories.get(parent);
        members?.delete(id);
        if (members?.size === 0) this.directories.delete(parent);
      }
      if (parent === rootPath || path.dirname(parent) === parent) break;
    }
  }

  private remove(id: string, order: number): void {
    this.fingerprints.delete(id);
    this.options.onInvalidate?.(id, false);
    this.current.delete(id);
    this.cancelRetry(id);
    this.jobs.delete(id);
    this.laneJobs.delete(id);
    this.requested.delete(id);
    this.track(id, false);
    const relative = rootRelative(this.entry, id);
    if (relative && this.ignoredFolders.isInside(relative)) {
      this.windowed.delete(id);
      // An upsert queued before its folder became ignored is in the other
      // lane; it must not be published after the file is gone.
      this.pending.delete(id);
      // Never published: nothing to retract.
      if (this.documents.has(id)) { this.lanePending.set(id, { doc: null, order }); this.laneScheduler.schedule(); }
      else this.lanePending.delete(id);
    } else if (this.documents.has(id) || this.pending.get(id)?.doc) {
      this.lanePending.delete(id);
      this.pending.set(id, { doc: null, order, live: false });
      this.schedule();
    }
    this.settle();
  }

  private get queuedJobs(): number { return this.jobs.size + this.laneJobs.size; }

  private queueJob(job: Job): void {
    const relative = rootRelative(this.entry, job.id);
    // A replacement job may land in the other queue (its folder became
    // ignored meanwhile); the older one must not run instead.
    this.jobs.delete(job.id);
    this.laneJobs.delete(job.id);
    (relative && this.ignoredFolders.isInside(relative) ? this.laneJobs : this.jobs).set(job.id, job);
  }

  private pump(): void {
    const limit = this.options.concurrency ?? 8;
    const laneLimit = Math.max(1, Math.floor(limit / 2));
    while (!this.stopped && this.active < limit && this.queuedJobs) {
      // A file a client waits for comes first, then ordinary paths; ignored
      // paths only take their share of the slots.
      let id: string | undefined = this.requested.values().next().value;
      if (id === undefined) {
        if (this.jobs.size) id = this.jobs.keys().next().value!;
        else if (this.activeLane < laneLimit) id = this.laneJobs.keys().next().value!;
        else break;
      }
      const lane = !this.jobs.has(id) && this.laneJobs.has(id);
      const job = this.jobs.get(id) ?? this.laneJobs.get(id);
      this.requested.delete(id);
      this.jobs.delete(id);
      this.laneJobs.delete(id);
      if (!job || this.current.get(id) !== job.order) continue;
      this.run(job, lane);
    }
  }

  private run(job: Job, lane = false): void {
    this.active++;
    if (lane) this.activeLane++;
    void this.process(job).finally(() => {
      this.active--;
      if (lane) this.activeLane--;
      if (this.current.get(job.id) === job.order && !this.retryTimers.has(job.id)) this.current.delete(job.id);
      this.pump();
      this.settle();
    });
  }

  private async process(job: Job): Promise<void> {
    try {
      if (!job.stats) this.options.onWork?.("stat");
      const stats = job.stats ?? await (this.options.stat ?? lstat)(job.id) as Stats;
      const valid = () => !this.stopped && this.current.get(job.id) === job.order;
      if (!valid()) return;
      if (!stats.isFile() || !this.policy.accepts(job.id, stats)) { this.remove(job.id, job.order); return; }
      const name = path.basename(job.id);
      this.options.onWork?.("classify");
      const kind = classifyFileName(name) ?? await (this.options.classify ?? classifyFile)(job.id, name);
      if (!valid()) return;
      const relative = rootRelative(this.entry, job.id)!;
      const inside = this.ignoredFolders.isInside(relative);
      const doc: RevisionedDocument = {
        id: job.id, rootId: this.entry.absolutePath, name, relativePath: relative,
        mtimeMs: stats.mtimeMs, kind, revision: job.order,
        gitIgnoreStatus: inside ? "ignored" : this.documents.get(job.id)?.gitIgnoreStatus ?? (this.knownIgnoredFiles.has(relative) ? "ignored" : "unknown"),
        ...(this.matcher.isVisibilityException?.(relative) ? { ignoreVisibilityException: true } : {}),
      };
      this.fingerprints.set(job.id, { revision: job.order, value: fileFingerprint(stats) });
      if (inside) {
        // An older write that finished classifying late can be the one that
        // leaves the window; it is then not published.
        if (this.ignoredFolders.isWindowed(relative) && !this.touchWindow(job.id, job.order)) return;
        this.pending.delete(job.id);
        this.lanePending.set(job.id, { doc, order: job.order });
        this.laneScheduler.schedule();
      } else {
        this.lanePending.delete(job.id);
        this.pending.set(job.id, { doc, live: job.live, order: job.order });
        this.schedule();
      }
    } catch (error) {
      if (this.stopped || this.current.get(job.id) !== job.order) return;
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) this.remove(job.id, job.order);
      else if (job.attempts < 2) {
        // Retain the job's generation while its retry is outstanding.
        const retry = { ...job, stats: undefined, attempts: job.attempts + 1 };
        const timer = setTimeout(() => {
          this.retryTimers.delete(job.id);
          if (!this.stopped && this.current.get(job.id) === job.order) {
            this.queueJob(retry);
            this.pump();
          }
          this.settle();
        }, 100 * retry.attempts);
        this.retryTimers.set(job.id, timer);
      } else this.fail(error);
    }
  }

  private schedule(): void {
    this.scheduler.schedule();
  }

  private settle(): void {
    for (const [id, waiting] of this.pathWaiters) {
      if (this.current.has(id)) continue;
      this.pathWaiters.delete(id);
      for (const resolve of waiting) resolve();
    }
    if (this.active || this.queuedJobs || this.retryTimers.size) return;
    if (this.ready && !this.initialComplete) {
      this.initialComplete = true;
      if (!this.stopped) this.schedule();
    }
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private cancelRetry(id: string): void {
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
  }
}

const DIRECTORY = { isDirectory: () => true, isSymbolicLink: () => false };
