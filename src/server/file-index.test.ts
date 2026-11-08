import { afterEach, expect, test } from "bun:test";
import { Stats } from "node:fs";
import { FileIndex, type FileIndexBatch, type FileIndexOptions } from "./file-index";
import { NewestDocument } from "./newest-document";
import type { DocumentMeta } from "../shared/types";
import type { RevisionedDocument } from "../shared/document-updates";

const indexes: FileIndex[] = [];
afterEach(() => { for (const index of indexes.splice(0)) index.stop(); });
function stat(mtime = 1): Stats {
  return Object.assign(Object.create(Stats.prototype) as Stats, { mode: 0o100644, mtimeMs: mtime });
}
function fixture(options: Partial<FileIndexOptions> = {}) {
  let sequence = 0;
  const batches: FileIndexBatch[] = [];
  const index = new FileIndex({ kind: "dir", absolutePath: "/docs" }, {
    shouldIgnore: () => false, toChokidarIgnored: () => () => false,
  }, { revision: () => ++sequence, publish: batch => batches.push(batch), ...options });
  indexes.push(index);
  return { index, batches };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("initial events reuse supplied metadata and do not impersonate edits", async () => {
  let stats = 0;
  let reads = 0;
  const { index, batches } = fixture({ stat: async () => { stats++; return stat(); }, classify: async () => { reads++; return "text"; } });
  index.observe("add", "/docs/a.md", stat(1));
  index.observe("add", "/docs/b.md", stat(2));
  index.markReady();
  await index.idle();
  expect(stats).toBe(0);
  expect(reads).toBe(0);
  expect(index.newest.id).toBe("/docs/b.md");
  expect(batches.at(-1)?.changedId).toBeNull();
  expect(index.discovery).toEqual({ status: "ready", discovered: 2 });
});

test("snapshots contain exactly the committed batches, not unpublished discovery", async () => {
  const published = new Map<string, RevisionedDocument>();
  let index!: FileIndex;
  ({ index } = fixture({ publish: batch => {
    for (const doc of batch.upserts) published.set(doc.id, doc);
    for (const doc of batch.removals) published.delete(doc.id);
    expect(index.snapshot().docs).toEqual([...published.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)));
  } }));
  for (let i = 0; i < 600; i++) index.observe("add", `/docs/${i}.md`, stat());
  expect(index.snapshot().docs).toEqual([]);
  index.markReady();
  await index.idle();
  expect(published.size).toBe(600);
});

test("multi-file batches retain all invalidations and the last eligible edit", async () => {
  const { index, batches } = fixture();
  index.markReady();
  index.observe("add", "/docs/a.md", stat());
  index.observe("add", "/docs/b.md", stat());
  index.observe("add", "/docs/bundle.zip", stat());
  await index.idle();
  expect(batches.at(-1)?.upserts.map(doc => doc.name)).toEqual(["a.md", "b.md", "bundle.zip"]);
  expect(batches.at(-1)?.changedId).toBe("/docs/b.md");
  index.observe("change", "/docs/a.md", stat());
  index.observe("unlink", "/docs/b.md");
  await index.idle();
  expect(batches.at(-1)?.changedId).toBe("/docs/a.md");
  expect(batches.at(-1)?.removals).toEqual([{ rootId: "/docs", id: "/docs/b.md" }]);
});

test("a previewable image edit is nominated for Follow; another binary edit is not", async () => {
  const { index, batches } = fixture();
  index.markReady();
  index.observe("add", "/docs/a.md", stat());
  await index.idle();
  index.observe("change", "/docs/a.md", stat());
  index.observe("change", "/docs/hero.svg", stat());
  await index.idle();
  expect(batches.at(-1)?.changedId).toBe("/docs/hero.svg");
  index.observe("change", "/docs/a.md", stat());
  index.observe("change", "/docs/bundle.zip", stat());
  await index.idle();
  expect(batches.at(-1)?.changedId).toBe("/docs/a.md");
  index.observe("change", "/docs/bundle.zip", stat());
  await index.idle();
  expect(batches.at(-1)?.changedId).toBeNull();
});

test("unknown classification is bounded and stale results cannot resurrect a subtree", async () => {
  const pending: ReturnType<typeof deferred<"text">>[] = [];
  const { index } = fixture({ concurrency: 2, classify: () => {
    const next = deferred<"text">(); pending.push(next); return next.promise;
  } });
  for (let i = 0; i < 10; i++) index.observe("add", `/docs/dir/${i}.unknown`, stat());
  expect(pending).toHaveLength(2);
  index.observe("unlinkDir", "/docs/dir");
  for (const job of pending) job.resolve("text");
  index.markReady();
  await index.idle();
  expect(pending).toHaveLength(2);
  expect(index.snapshot().docs).toEqual([]);
  expect(index.discovery.status).toBe("ready");
});

test("a newer save wins even if older classification finishes last", async () => {
  const old = deferred<"binary">();
  let reads = 0;
  const { index } = fixture({ classify: async () => ++reads === 1 ? old.promise : "text" });
  index.observe("add", "/docs/file.unknown", stat(1));
  index.observe("change", "/docs/file.unknown", stat(2));
  await Promise.resolve();
  old.resolve("binary");
  await index.idle();
  expect(index.documents.get("/docs/file.unknown")?.kind).toBe("text");
  expect(index.documents.get("/docs/file.unknown")?.mtimeMs).toBe(2);
});

test("stop discards queued work and late publication", async () => {
  const read = deferred<"text">();
  const { index, batches } = fixture({ classify: () => read.promise });
  index.observe("add", "/docs/file.unknown", stat());
  index.stop();
  read.resolve("text");
  await index.idle();
  expect(batches).toEqual([]);
  expect(index.documents.size).toBe(0);
});

test("a requested known file bypasses blocked background classification", async () => {
  const read = deferred<"text">();
  const { index } = fixture({ concurrency: 1, classify: () => read.promise });
  index.observe("add", "/docs/slow.unknown", stat());
  index.observe("add", "/docs/README.md", stat(), true);
  await index.settled("/docs/README.md");
  expect(index.documents.has("/docs/README.md")).toBe(true);
  expect(index.documents.has("/docs/slow.unknown")).toBe(false);
  read.resolve("text");
  await index.idle();
});

test("continuous normalized events publish by the maximum wait and idle time performs no work", async () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const advance = (target: number) => {
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].run();
    }
    now = target;
  };
  const times: number[] = [];
  const { index } = fixture({
    clock: { now: () => now,
      setTimer: (run, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, run }); return id as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: timer => { timers.delete(timer as unknown as number); },
    },
    publish: () => times.push(now),
  });
  for (let time = 0; time < 5000; time += 100) {
    advance(time);
    index.observe("change", "/docs/a.md", stat(time));
    await Promise.resolve();
  }
  advance(6000);
  expect(times).toEqual([2000, 4000, 5050]);
  advance(60000);
  expect(times).toHaveLength(3);
});

test.each([1000, 10000])("one edit in a %i-file inventory does not revisit unrelated files", async count => {
  let stats = 0;
  let reads = 0;
  let classifications = 0;
  const { index, batches } = fixture({ stat: async () => { stats++; return stat(); }, classify: async () => { reads++; return "text"; },
    onWork: kind => { if (kind === "classify") classifications++; },
  });
  for (let i = 0; i < count; i++) index.observe("add", `/docs/${i}.md`, stat());
  index.markReady();
  await index.idle();
  batches.length = 0;
  classifications = 0;
  index.observe("change", "/docs/0.md", stat(2));
  await index.idle();
  expect(stats).toBe(0);
  expect(reads).toBe(0);
  expect(classifications).toBe(1);
  expect(batches).toHaveLength(1);
  expect(batches[0]?.upserts).toHaveLength(1);
  expect(index.documents.size).toBe(count);
});

test("newest eligible document stays correct after replacement, reclassification, and removal", () => {
  const heap = new NewestDocument();
  const docs = new Map<string, DocumentMeta>();
  for (let i = 0; i < 300; i++) {
    const id = `/docs/${i % 31}.md`;
    const doc: DocumentMeta = { id, rootId: "/docs", name: id, relativePath: id, mtimeMs: i % 17, kind: i % 5 === 0 ? "binary" : "text" };
    docs.set(id, doc); heap.update(doc);
    if (i % 3 === 0) { docs.delete(id); heap.remove(id); }
    const expected = [...docs.values()].filter(d => d.kind !== "binary").sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath))[0]?.id ?? null;
    expect(heap.id).toBe(expected);
  }
});

// Ignored folders (task: lists on demand, live-write window, batched lane).
function ignoredFixture(options: Partial<FileIndexOptions> = {}) {
  return fixture({ ignored: { folders: ["node_modules", "build"], files: [] }, classify: async () => "binary", ...options });
}
const insideIgnored = (batches: FileIndexBatch[]) => batches.filter(batch => batch.lane);
function documentIds(index: FileIndex, prefix: string) {
  return [...index.documents.keys()].filter(id => id.startsWith(prefix));
}

test("unlisted writes are captured within a bounded, newest-first window", async () => {
  const { index } = ignoredFixture();
  index.markReady();
  for (let i = 0; i < 80_000; i++) index.observe("add", `/docs/node_modules/pkg${i % 400}/f${i}.js`, stat(i));
  await index.idle();
  const kept = documentIds(index, "/docs/node_modules/");
  expect(kept).toHaveLength(2000);
  expect(kept.every(id => Number(id.match(/f(\d+)\.js$/)![1]) >= 78_000)).toBe(true);
  expect([...index.documents.values()].every(doc => doc.gitIgnoreStatus === "ignored")).toBe(true);
}, 30_000);

test("the window evicts the oldest unpinned write, refreshes rewritten files, and listing brings evicted files back", async () => {
  const { index } = ignoredFixture({ windowLimit: 3 });
  index.markReady();
  const file = (name: string) => `/docs/build/renders/${name}.wav`;
  for (const name of ["a", "b", "c"]) index.observe("add", file(name), stat());
  await index.idle();
  index.pin(file("a"));
  index.observe("change", file("b"), stat(2)); // b is now the newest write
  index.observe("add", file("d"), stat());
  await index.idle();
  // a is pinned, so c (the oldest unpinned) leaves; b was rewritten.
  expect(documentIds(index, "/docs/build/").sort()).toEqual([file("a"), file("b"), file("d")]);
  index.observe("add", file("e"), stat());
  await index.idle();
  expect(documentIds(index, "/docs/build/").sort()).toEqual([file("a"), file("d"), file("e")]);
  // Listing the level: its files are admitted and leave the window.
  index.markListed("/docs/build");
  index.markListed("/docs/build/renders");
  for (const name of ["b", "c"]) index.observe("add", file(name), stat(3));
  await index.idle();
  for (const name of ["f", "g", "h", "i"]) index.observe("add", file(name), stat(4));
  await index.idle();
  expect(documentIds(index, "/docs/build/").sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(file));
});

test("a burst inside an ignored folder arrives as a few classified patches with no Follow candidates", async () => {
  const { index, batches } = ignoredFixture();
  index.markReady();
  index.markListed("/docs/build");
  await index.idle();
  batches.length = 0;
  for (let i = 0; i < 5000; i++) index.observe("add", `/docs/build/obj${i}.o`, stat());
  await index.idle();
  const lane = insideIgnored(batches);
  // idle() also forces the (empty) ordinary flush; only batches with files count.
  expect(batches.filter(batch => batch.upserts.length || batch.removals.length)).toEqual(lane);
  expect(lane.length).toBeLessThanOrEqual(5);
  expect(lane.reduce((n, batch) => n + batch.upserts.length, 0)).toBe(5000);
  expect(lane.every(batch => batch.upserts.length <= 1024 && batch.upserts.every(doc => doc.gitIgnoreStatus === "ignored"))).toBe(true);
  expect(lane.every(batch => batch.changedId === null && (batch.followCandidates ?? []).length === 0)).toBe(true);
});

test("repeated writes collapse and short-lived output is never published", async () => {
  const { index, batches } = ignoredFixture();
  index.markReady();
  index.markListed("/docs/build");
  await index.idle();
  batches.length = 0;
  for (const mtime of [1, 2, 3]) index.observe("change", "/docs/build/main.o", stat(mtime));
  index.observe("add", "/docs/build/tmp.o", stat());
  index.observe("unlink", "/docs/build/tmp.o");
  await index.idle();
  const upserts = insideIgnored(batches).flatMap(batch => batch.upserts);
  expect(upserts.map(doc => [doc.relativePath, doc.mtimeMs])).toEqual([["build/main.o", 3]]);
  expect(insideIgnored(batches).flatMap(batch => batch.removals)).toEqual([]);
});

test("the lane waits at least 1 s and at most 5 s while ordinary edits keep their 2 s bound", async () => {
  let now = 0, nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const advance = async (target: number) => {
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].run();
      await Promise.resolve();
    }
    now = target;
  };
  const published: { at: number; lane: boolean; ids: string[] }[] = [];
  const { index } = ignoredFixture({
    clock: { now: () => now,
      setTimer: (run, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, run }); return id as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: timer => { timers.delete(timer as unknown as number); },
    },
    publish: batch => published.push({ at: now, lane: batch.lane === true, ids: batch.upserts.map(doc => doc.relativePath) }),
  });
  index.markReady();
  index.markListed("/docs/build");
  index.flushLane();
  published.length = 0;
  // A build writes every 100 ms for 8 s; a document is saved at 1 s.
  for (let time = 0; time < 8000; time += 100) {
    await advance(time);
    index.observe("change", `/docs/build/obj${time}.o`, stat(time));
    if (time === 1000) index.observe("change", "/docs/notes.md", stat(time));
    await Bun.sleep(0);
  }
  await advance(20_000);
  const lane = published.filter(batch => batch.lane);
  const ordinary = published.filter(batch => !batch.lane && batch.ids.length);
  expect(ordinary.map(batch => batch.ids)).toEqual([["notes.md"]]);
  expect(ordinary[0]!.at - 1000).toBeLessThanOrEqual(2000);
  expect(lane[0]!.at).toBeGreaterThanOrEqual(1000);
  expect(lane[0]!.at).toBeLessThanOrEqual(5000);
  for (let i = 1; i < lane.length; i++) expect(lane[i]!.at - lane[i - 1]!.at).toBeLessThanOrEqual(5000);
  expect(lane.flatMap(batch => batch.ids)).toHaveLength(80);
});

test("a requested ignored file is published before settlement even behind 1,500 pending entries", async () => {
  const { index } = ignoredFixture();
  index.markReady();
  index.markListed("/docs/build");
  for (let i = 0; i < 1500; i++) index.observe("add", `/docs/build/obj${i}.o`, stat());
  // Let the jobs finish without letting the lane publish.
  await Bun.sleep(50);
  await index.request("/docs/build/obj1499.o", stat());
  expect(index.documents.has("/docs/build/obj1499.o")).toBe(true);
});

test("a folder recreated before its removal is published stays an entry", async () => {
  const { index, batches } = ignoredFixture({ classifyDirectory: async () => true });
  index.markReady();
  await index.idle();
  index.observe("unlinkDir", "/docs/build");
  expect(await index.classifyNewDirectory("/docs/build")).toBe(true);
  index.observe("addDir", "/docs/build");
  index.flushLane();
  expect(index.folders.has("/docs/build")).toBe(true);
  expect(batches.flatMap(batch => batch.folderRemovals ?? []).filter(removal => removal.id === "/docs/build")).toEqual([]);
});

test("ignored files waiting on content classification never take every slot from an ordinary edit", async () => {
  const blocked = Promise.withResolvers<"binary">();
  let started = 0;
  const { index, batches } = ignoredFixture({ classify: async id => {
    if (id.endsWith(".sniff")) { started++; return blocked.promise; }
    return "text";
  } });
  index.markReady();
  index.markListed("/docs/build");
  // An unfamiliar extension forces a content sniff.
  for (let i = 0; i < 20; i++) index.observe("add", `/docs/build/obj${i}.sniff`, stat());
  await Bun.sleep(20);
  // Half the default eight slots at most.
  expect(started).toBe(4);
  index.observe("change", "/docs/notes.unknown", stat(5));
  const deadline = Date.now() + 2000;
  while (!batches.some(batch => batch.upserts.some(doc => doc.relativePath === "notes.unknown")) && Date.now() < deadline) await Bun.sleep(20);
  expect(batches.some(batch => batch.upserts.some(doc => doc.relativePath === "notes.unknown"))).toBe(true);
  blocked.resolve("binary");
  await index.idle();
  expect(documentIds(index, "/docs/build/")).toHaveLength(20);
});

test("deleting a large ignored folder publishes its removal only after every file's removal", async () => {
  const { index, batches } = ignoredFixture();
  index.markReady();
  index.markListed("/docs/build");
  for (let i = 0; i < 1500; i++) index.observe("add", `/docs/build/obj${i}.o`, stat());
  await index.idle();
  batches.length = 0;
  index.observe("unlinkDir", "/docs/build");
  await index.idle();
  const lane = batches.filter(batch => batch.lane);
  const folderBatch = lane.findIndex(batch => (batch.folderRemovals ?? []).some(removal => removal.id === "/docs/build"));
  const lastFileBatch = lane.findLastIndex(batch => batch.removals.length > 0);
  expect(lane.flatMap(batch => batch.removals)).toHaveLength(1500);
  expect(folderBatch).toBeGreaterThanOrEqual(lastFileBatch);
  expect(lane.every(batch => batch.upserts.length + batch.removals.length + (batch.folderRemovals ?? []).length <= 1024)).toBe(true);
});
