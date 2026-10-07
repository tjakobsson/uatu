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
  index.observe("add", "/docs/image.png", stat());
  await index.idle();
  expect(batches.at(-1)?.upserts.map(doc => doc.name)).toEqual(["a.md", "b.md", "image.png"]);
  expect(batches.at(-1)?.changedId).toBe("/docs/b.md");
  index.observe("change", "/docs/a.md", stat());
  index.observe("unlink", "/docs/b.md");
  await index.idle();
  expect(batches.at(-1)?.changedId).toBe("/docs/a.md");
  expect(batches.at(-1)?.removals).toEqual([{ rootId: "/docs", id: "/docs/b.md" }]);
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
