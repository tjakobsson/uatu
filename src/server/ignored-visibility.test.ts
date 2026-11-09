import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWatchSession } from "./watch-session";
import { isDocumentVisible } from "../shared/file-visibility";
import { DocumentStateIndex, unseenSnapshotChange, type DocumentUpdate } from "../shared/document-updates";
import { DEFAULT_WATCH_CONTEXT } from "../shared/watch-context";
import { MetricsRegistry } from "../debug/metrics";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() { const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-visibility-")); dirs.push(dir); return dir; }
async function wait(predicate: () => boolean) {
  const end = Date.now() + 6000;
  while (!predicate()) { if (Date.now() > end) throw new Error("visibility condition timed out"); await Bun.sleep(15); }
}
async function init(cwd: string) { const child = Bun.spawn(["git", "init", "-q"], { cwd, stdout: "ignore", stderr: "ignore" }); expect(await child.exited).toBe(0); }

test("an ignored file is never a Follow candidate in any client, and Git metadata never writes or replays Follow", async () => {
  const cwd = await fixture(); await init(cwd);
  await writeFile(path.join(cwd, ".gitignore"), "ignored.md\n");
  const visible = path.join(cwd, "visible.md"), ignored = path.join(cwd, "ignored.md");
  await writeFile(visible, "visible"); await writeFile(ignored, "ignored");
  const metrics = new MetricsRegistry();
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], true, { metrics });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const frames: DocumentUpdate[][] = [[], []];
  try {
    await session.start();
    await wait(() => session.findDocument(ignored)?.gitIgnoreStatus === "ignored");
    const watcher = session._internalWatcher();
    const contexts = [true, false].map(showIgnored => ({ ...DEFAULT_WATCH_CONTEXT, showIgnored }));
    const work = () => Object.fromEntries(Object.entries(metrics.snapshot().counters).filter(([key]) => key.startsWith("index.")));
    const beforeToggles = work();
    for (let i = 0; i < 20; i++) session.getStatePayload(null, contexts[i % 2]);
    expect(work()).toEqual(beforeToggles);
    contexts.forEach((context, i) => {
      const reader = session.eventsResponse(context).body!.getReader(); readers.push(reader);
      void (async () => { for (;;) { const value = await reader.read(); if (value.done) return; const text = new TextDecoder().decode(value.value); if (text.startsWith("event: state")) frames[i]!.push(JSON.parse(text.split("data: ")[1]!)); } })();
    });
    await wait(() => frames.every(list => list.length > 0));
    // One normalized batch: the ignored edit comes last but is never followed.
    watcher!.emit("all", "change", visible);
    watcher!.emit("all", "change", ignored);
    await wait(() => frames.every(list => list.some(frame => frame.changedId === visible)));
    await Bun.sleep(300);
    expect(frames.flat().some(frame => frame.changedId === ignored)).toBe(false);
    // Shown or hidden, the ignored file stays browsable.
    expect(session.getRoots(contexts[1]).flatMap(root => root.docs).some(doc => doc.id === ignored)).toBe(true);
    expect(isDocumentVisible(session.findDocument(ignored)!, false)).toBe(false);
    const before = session.findDocument(ignored)!;
    await writeFile(path.join(cwd, ".gitignore"), "");
    await wait(() => session.findDocument(ignored)?.gitIgnoreStatus === "not-ignored");
    const after = session.findDocument(ignored)!;
    // Reclassification is metadata: no new revision, no rebuild, no Follow.
    expect(after.revision).toBe(before.revision); expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(session._internalWatcher()).toBe(watcher);
    expect(frames.flat().some(frame => frame.changedId === ignored)).toBe(false);
    for (const context of contexts) {
      const index = new DocumentStateIndex(); index.apply(session.getStatePayload(null, context));
      expect(index.latestChange?.id).toBe(visible);
    }
  } finally { await Promise.all(readers.map(reader => reader.cancel())); await session.stop(); }
});

test.each([false, true])("output folders appear without configuration and runtime exclusions share index and direct policy, polling=%s", async usePolling => {
  const cwd = await fixture();
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { usePolling });
  try {
    await session.start();
    await mkdir(path.join(cwd, "build/renders"), { recursive: true });
    await mkdir(path.join(cwd, "build/objects"));
    const file = path.join(cwd, "build/renders/out.wav"), object = path.join(cwd, "build/objects/main.o");
    await writeFile(file, "audio"); await writeFile(object, "object");
    await wait(() => !!session.findDocument(file) && !!session.findDocument(object));
    await writeFile(path.join(cwd, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["build/objects/"] } }));
    await wait(() => !session.findDocument(object));
    expect(session.findDocument(file)).toBeDefined();
    expect(await session.ensureDocument(object)).toBeUndefined();
    await writeFile(path.join(cwd, ".uatu.json"), JSON.stringify({ ignore: { exclude: [] } }));
    await wait(() => !!session.findDocument(object));
  } finally { await session.stop(); }
}, 15_000);

test.each([false, true])("any explicit respecting directory root defaults to hide independently of root order, reversed=%s", async reversed => {
  const left = await fixture(), right = await fixture();
  await writeFile(path.join(left, ".uatu.json"), JSON.stringify({ ignore: { respectGitignore: true } }));
  await writeFile(path.join(right, ".uatu.json"), JSON.stringify({ ignore: { respectGitignore: false } }));
  const unconfigured = await fixture();
  const paths = [left, right, unconfigured];
  const entries = (reversed ? paths.reverse() : paths).map(absolutePath => ({ kind: "dir" as const, absolutePath }));
  const session = createWatchSession(entries, false);
  try {
    await session.start();
    expect(session.getStatePayload().initialShowIgnored).toBe(false);
    expect(session.getDiscoveryState().status).toBe("ready");
    // The server supplies a fallback, not a command overriding client choice.
    expect(session.getStatePayload(null, { ...DEFAULT_WATCH_CONTEXT, showIgnored: true }).showIgnored).toBe(true);
  } finally { await session.stop(); }
  const explicit = createWatchSession(entries, false, { respectGitignore: false });
  try { await explicit.start(); expect(explicit.getStatePayload().initialShowIgnored).toBe(true); }
  finally { await explicit.stop(); }
});

test.each([undefined, false])("unconfigured and false-only directory roots default to show, explicit=%s", async respectGitignore => {
  const left = await fixture(), right = await fixture();
  if (respectGitignore !== undefined) await writeFile(path.join(left, ".uatu.json"), JSON.stringify({ ignore: { respectGitignore } }));
  const session = createWatchSession([left, right].map(absolutePath => ({ kind: "dir" as const, absolutePath })), false);
  try {
    await session.start();
    expect(session.getStatePayload().initialShowIgnored).toBe(true);
    expect(session.getStatePayload(null, { ...DEFAULT_WATCH_CONTEXT, showIgnored: false }).showIgnored).toBe(false);
  } finally { await session.stop(); }
});

test("runtime recovery recomputes visibility from current roots after edits, additions and removals", async () => {
  const left = await fixture(), right = await fixture();
  const leftConfig = path.join(left, ".uatu.json"), rightConfig = path.join(right, ".uatu.json");
  const configure = (file: string, respectGitignore: boolean) => writeFile(file, JSON.stringify({ ignore: { respectGitignore } }));
  await configure(leftConfig, true);
  await configure(rightConfig, true);
  const session = createWatchSession([left, right].map(absolutePath => ({ kind: "dir" as const, absolutePath })), false);
  const expectDefault = async (show: boolean) => {
    await wait(() => session.getDiscoveryState().status === "ready" && session.getStatePayload().initialShowIgnored === show);
  };
  try {
    await session.start();
    await expectDefault(false);
    await rm(leftConfig);
    await session.recover();
    expect(session.getStatePayload().initialShowIgnored).toBe(false);
    await configure(rightConfig, false);
    await expectDefault(true);
    await configure(leftConfig, true);
    await expectDefault(false);
    await writeFile(leftConfig, JSON.stringify({ ignore: {} }));
    await expectDefault(true);
    await configure(rightConfig, true);
    await expectDefault(false);
    await rm(rightConfig);
    await expectDefault(true);
  } finally { await session.stop(); }
}, 15_000);
