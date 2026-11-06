import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerDismissalsStore, type WorkerDismissalEvidence } from "./worker-dismissals";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const scope = { user: "alice", workspaceId: "project", conversationId: "opencode:parent" };
const mutations = Array.from({ length: 285 }, (_, i) => ({ executionId: `execution:${i}`, expectedRevision: 0, operation: "dismiss" as const }));
const evidence: WorkerDismissalEvidence[] = Array.from({ length: 290 }, (_, i) => ({ executionId: `execution:${i}`, signature: "fixture", active: false, dismissible: i < 285 }));
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "uatu-dismissal-batch-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "marks.json"), store = new WorkerDismissalsStore(file); await store.load();
  return { store, file };
}

test("285 dismissals alongside five unresolved workers use one read, atomic rename and invalidation and survive reload", async () => {
  const { store, file } = await fixture();
  let reads = 0, notices = 0; store.subscribe(() => notices++);
  const rename = spyOn(fs, "rename"); cleanups.push(() => rename.mockRestore());
  const state = await store.reconcile(scope, async () => { reads++; return evidence; }, mutations);
  expect(reads).toBe(1); expect(rename).toHaveBeenCalledTimes(1); expect(notices).toBe(1);
  expect(state.entries.filter(entry => entry.dismissed)).toHaveLength(285);
  expect(state.entries.filter(entry => !entry.dismissed)).toHaveLength(5);
  const reloaded = new WorkerDismissalsStore(file); await reloaded.load();
  expect(await reloaded.reconcile(scope, async () => evidence)).toEqual(state);
  expect((await reloaded.reconcile({ ...scope, user: "bob" }, async () => evidence)).entries.every(entry => !entry.dismissed)).toBe(true);
});

for (const reason of ["stale", "active", "foreign"] as const) test(`${reason} target refuses the entire group, not a partial dismissal`, async () => {
  const { store } = await fixture();
  const source = evidence.map(item => ({ ...item }));
  if (reason === "active") Object.assign(source[284]!, { active: true, dismissible: false });
  if (reason === "foreign") source.splice(284, 1);
  const targets = mutations.map(item => ({ ...item }));
  if (reason === "stale") targets[284]!.expectedRevision = 1;
  await expect(store.reconcile(scope, async () => source, targets)).rejects.toThrow();
  expect((await store.reconcile(scope, async () => source)).entries.every(entry => !entry.dismissed)).toBe(true);
});

test("failed batch save retains the prior store and no partial success", async () => {
  const { store, file } = await fixture();
  await store.reconcile(scope, async () => evidence);
  const before = await fs.readFile(file, "utf8");
  const rename = spyOn(fs, "rename").mockRejectedValue(new Error("synthetic failure"));
  try { await expect(store.reconcile(scope, async () => evidence, mutations)).rejects.toThrow("failed to save"); }
  finally { rename.mockRestore(); }
  expect(await fs.readFile(file, "utf8")).toBe(before);
  expect((await store.reconcile(scope, async () => evidence)).entries.every(entry => !entry.dismissed)).toBe(true);
});

test("repeated first-save capacity failures retain no unpublished fence ownership", async () => {
  const { file } = await fixture();
  const store = new WorkerDismissalsStore(file, { maxEntries: 1, maxBytes: 1 }); await store.load();
  for (let i = 0; i < 10; i++) {
    const executionId = `execution:unpublished:${i}`;
    await expect(store.reconcile(scope, async () => [{ executionId, signature: "fixture", active: false, dismissible: true }],
      [{ executionId, expectedRevision: 0, operation: "dismiss" }])).rejects.toMatchObject({ code: "capacity" });
  }
  // Inspect ownership bounds without introducing a product test-only seam.
  expect((Reflect.get(store, "records") as Map<unknown, unknown>).size).toBe(0);
  expect((Reflect.get(store, "authorities") as Map<unknown, unknown>).size).toBe(0);
  expect(Reflect.get(store, "pendingAdmissions")).toBe(0);
  expect((Reflect.get(store, "fences") as Map<unknown, unknown>).size).toBe(0);
});

test("positive activity after batch admission refuses all selected dismissals and retires prior marks", async () => {
  const { store } = await fixture();
  await store.reconcile(scope, async () => evidence, mutations);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const pending = store.reconcile(scope, async () => { entered.resolve(); await release.promise; return evidence; }, mutations);
  await entered.promise;
  store.observe(scope.workspaceId, scope.conversationId, [{ ...evidence[284]!, active: true, dismissible: false, signature: "working" }]);
  release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "conflict" });
  const state = await store.reconcile(scope, async () => []);
  expect(state.entries.find(entry => entry.executionId === "execution:284")?.dismissed).toBe(false);
  expect(state.entries.filter(entry => entry.dismissed)).toHaveLength(284);
});

for (const failure of ["abort", "wait", "read", "forget"] as const) test(`batch ${failure} releases every admitted target`, async () => {
  const { file } = await fixture();
  const store = new WorkerDismissalsStore(file, { maxEntries: 285, maxPending: 1 }); await store.load();
  const abort = new AbortController();
  await expect(store.withAdmission(scope, mutations, async reconcile => {
    if (failure === "abort") abort.abort();
    if (failure === "wait") throw new Error("synthetic wait failure");
    if (failure === "forget") await store.forgetWorkspace(scope.workspaceId);
    return reconcile(async () => { if (failure === "read") throw new Error("synthetic read failure"); return evidence.slice(0, 285); });
  }, abort.signal)).rejects.toThrow();
  expect((await store.reconcile(scope, async () => evidence.slice(0, 285), mutations)).entries.every(entry => entry.dismissed)).toBe(true);
});

test("positive activity during the atomic rename retires the affected new mark after persistence", async () => {
  const { store, file } = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (++writes === 1) { entered.resolve(); await release.promise; }
    await original(source, target);
  });
  try {
    const pending = store.reconcile(scope, async () => evidence, mutations);
    await entered.promise;
    store.observe(scope.workspaceId, scope.conversationId, [{ ...evidence[284]!, active: true, dismissible: false, signature: "working" }]);
    release.resolve(); await pending;
    const state = await store.reconcile(scope, async () => []);
    expect(state.entries.find(entry => entry.executionId === "execution:284")).toMatchObject({ dismissed: false, revision: 1 });
    expect(state.entries.filter(entry => entry.dismissed)).toHaveLength(284);
    const reloaded = new WorkerDismissalsStore(file); await reloaded.load();
    expect(await reloaded.reconcile(scope, async () => [])).toEqual(state);
  } finally { release.resolve(); rename.mockRestore(); }
});

for (const activity of ["before", "after"] as const) test(`abandoned first batch retains retirement ownership for activity ${activity} abort during rename`, async () => {
  const { store, file } = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController();
  const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (++writes === 1) { entered.resolve(); await release.promise; }
    await original(source, target);
  });
  try {
    const pending = store.withAdmission(scope, mutations.slice(0, 2), reconcile => reconcile(async () => evidence.slice(0, 2)), abort.signal);
    await entered.promise;
    const observe = () => store.observe(scope.workspaceId, scope.conversationId, [{ ...evidence[1]!, active: true, dismissible: false, signature: "working" }]);
    if (activity === "before") observe();
    abort.abort();
    if (activity === "after") observe();
    release.resolve(); await pending.catch(() => undefined);
    const state = await store.reconcile(scope, async () => []);
    expect(state.entries.find(entry => entry.executionId === "execution:1")).toMatchObject({ dismissed: false, revision: 1 });
    expect(state.entries.find(entry => entry.executionId === "execution:0")?.dismissed).toBe(true);
    const reloaded = new WorkerDismissalsStore(file); await reloaded.load();
    expect(await reloaded.reconcile(scope, async () => [])).toEqual(state);
  } finally { release.resolve(); rename.mockRestore(); }
});

test("abandoned failed batch releases its independent commit owner after I/O drains", async () => {
  const { file } = await fixture();
  const store = new WorkerDismissalsStore(file, { maxEntries: 2, maxPending: 1 }); await store.load();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController();
  const rename = spyOn(fs, "rename").mockImplementation(async () => { entered.resolve(); await release.promise; throw new Error("synthetic failure"); });
  const pending = store.withAdmission(scope, mutations.slice(0, 2), reconcile => reconcile(async () => evidence.slice(0, 2)), abort.signal);
  try {
    await entered.promise; abort.abort();
    store.observe(scope.workspaceId, scope.conversationId, [{ ...evidence[1]!, active: true, dismissible: false, signature: "working" }]);
    release.resolve(); await expect(pending).rejects.toThrow("failed to save");
  } finally { release.resolve(); rename.mockRestore(); }
  expect(await fs.access(file).then(() => true, () => false)).toBe(false);
  const fresh = mutations.slice(0, 2).map(item => ({ ...item, executionId: `${item.executionId}:new` }));
  const state = await store.reconcile(scope, async () => fresh.map(({ executionId }) => ({ executionId, signature: "fixture", active: false, dismissible: true })), fresh);
  expect(state.entries.every(entry => entry.dismissed)).toBe(true);
});
