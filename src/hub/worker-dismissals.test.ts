import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerDismissalsStore, type WorkerDismissalEvidence } from "./worker-dismissals";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const scope = { user: "alice", workspaceId: "ws", conversationId: "opencode:parent" };
const evidence = (id = "execution-1", active = false): WorkerDismissalEvidence[] => [{ executionId: id, signature: active ? "working" : "unavailable", dismissible: !active, active }];
async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-worker-dismissals-")); roots.push(root);
  const file = path.join(root, "marks.json"); const store = new WorkerDismissalsStore(file, options); await store.load();
  return { root, file, store };
}
function gate() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}
async function warnedWithin(warning: Promise<void>): Promise<boolean> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([warning.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1200); })]); }
  finally { clearTimeout(timer); }
}

test.each(["retained record", "first record"] as const)("a %s merged after the warning deadline receives private guidance while retirement hangs", async admission => {
  const { store, file } = await fixture();
  const a = { ...scope, workspaceId: "A" }; const b = { ...scope, workspaceId: "B", user: "bob" };
  await store.reconcile(a, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  if (admission === "retained record") await store.reconcile(b, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const entered = gate(); const blocked = gate(); const saveEntered = gate(); const saveBlocked = gate();
  const warnedA = gate(); const warnedB = gate();
  const notices: Array<{ user: string; workspaceId: string; notice: string }> = [];
  const detach = store.subscribe((observed, notice) => {
    notices.push({ user: observed.user, workspaceId: observed.workspaceId, notice });
    if (notice === "unavailable") (observed.workspaceId === "A" ? warnedA : warnedB).release();
  });
  const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (admission === "first record" && ++writes === 1) { entered.release(); await blocked.waiting; }
    else { saveEntered.release(); await saveBlocked.waiting; }
    await original(source, target);
  });
  const holding = admission === "first record"
    ? store.reconcile(b, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" }).then(() => "accepted", error => error.code)
    : store.reconcile({ ...scope, workspaceId: "C" }, async () => { entered.release(); await blocked.waiting; return []; });
  try {
    await entered.waiting;
    store.observe("A", scope.conversationId, evidence("execution-1", true));
    if (admission === "first record") store.observe("B", scope.conversationId, evidence("execution-1", true));
    await warnedA.waiting;
    if (admission === "retained record") store.observe("B", scope.conversationId, evidence("execution-1", true));
    blocked.release();
    if (admission === "first record") expect(await holding).toBe("conflict"); else await holding;
    await saveEntered.waiting;
    expect(await warnedWithin(warnedB.waiting)).toBe(true);
    await expect(store.reconcile(b, async () => evidence())).rejects.toMatchObject({ code: "unavailable" });
    expect(notices.filter(item => item.notice === "unavailable")).toEqual([
      { user: "alice", workspaceId: "A", notice: "unavailable" },
      { user: "bob", workspaceId: "B", notice: "unavailable" },
    ]);
    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    expect(persisted.records.find((record: { workspaceId: string }) => record.workspaceId === "B").dismissed).toBe(admission === "retained record");
    saveBlocked.release();
    // Failed private reads can enqueue one retry; drain it before restarting.
    await store.reconcile({ ...scope, workspaceId: "drain" }, async () => []);
    const restarted = new WorkerDismissalsStore(file); await restarted.load();
    expect((await restarted.reconcile(b, async () => evidence())).entries[0]?.dismissed).toBe(false);
  } finally { blocked.release(); saveBlocked.release(); await holding; await store.reconcile({ ...scope, workspaceId: "drain" }, async () => []); detach(); rename.mockRestore(); }
});

test.each(["separate scopes", "same scope"] as const)("late pending activity after a hung save's warning stays unhealthy until its own commit in %s", async grouping => {
  const { store } = await fixture();
  const a = { ...scope, workspaceId: "A" };
  const b = grouping === "same scope" ? a : { ...scope, workspaceId: "B", user: "bob" };
  await store.reconcile(a, async () => evidence("a"), { executionId: "a", expectedRevision: 0, operation: "dismiss" });
  await store.reconcile(b, async () => evidence("b"), { executionId: "b", expectedRevision: 0, operation: "dismiss" });
  const enteredA = gate(); const blockedA = gate(); const enteredB = gate(); const blockedB = gate();
  const warned = gate(); const ready = gate(); const notices: Array<{ user: string; workspaceId: string; notice: string }> = [];
  const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (++writes === 1) { enteredA.release(); await blockedA.waiting; }
    else { enteredB.release(); await blockedB.waiting; }
    await original(source, target);
  });
  const detach = store.subscribe((observed, notice) => {
    notices.push({ user: observed.user, workspaceId: observed.workspaceId, notice });
    if (notice === "unavailable") warned.release();
    if (notice === "ready" && observed.user === b.user && observed.workspaceId === b.workspaceId) ready.release();
  });
  try {
    store.observe("A", scope.conversationId, evidence("a", true));
    await enteredA.waiting; await warned.waiting;
    expect(() => store.observe(b.workspaceId, scope.conversationId, evidence("b", true))).not.toThrow();
    // Crossing the public private-read seam must fail, not join the hung queue.
    const privateSettled = gate(); let privateResult = "pending";
    void store.reconcile(b, async () => evidence("b")).then(() => { privateResult = "accepted"; privateSettled.release(); }, error => { privateResult = error.code; privateSettled.release(); });
    expect(await warnedWithin(privateSettled.waiting)).toBe(true);
    expect(privateResult).toBe("unavailable");
    expect(notices.filter(item => item.notice === "unavailable").every(item => item.user === "alice" && item.workspaceId === "A" || item.user === b.user && item.workspaceId === b.workspaceId)).toBe(true);
    blockedA.release(); await enteredB.waiting;
    expect(notices.filter(item => item.notice === "ready" && item.user === b.user && item.workspaceId === b.workspaceId)).toEqual([]);
    blockedB.release(); await ready.waiting;
    expect(writes).toBe(2);
  } finally { blockedA.release(); blockedB.release(); await store.reconcile({ ...scope, workspaceId: "drain" }, async () => []); detach(); rename.mockRestore(); }
});

test("a newer pending signature on the same execution cannot recover on the older signature's commit", async () => {
  const { store } = await fixture();
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const entered = gate(); const blocked = gate(); const nextEntered = gate(); const nextBlocked = gate(); const warned = gate(); const ready = gate();
  const notices: string[] = []; const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (++writes === 1) { entered.release(); await blocked.waiting; }
    else { nextEntered.release(); await nextBlocked.waiting; }
    await original(source, target);
  });
  const detach = store.subscribe((_, notice) => { notices.push(notice); if (notice === "unavailable") warned.release(); if (notice === "ready") ready.release(); });
  const newer = evidence("execution-1", true).map(item => ({ ...item, signature: "working-g2" }));
  try {
    store.observe("ws", scope.conversationId, evidence("execution-1", true));
    await entered.waiting; await warned.waiting;
    store.observe("ws", scope.conversationId, newer);
    blocked.release(); await nextEntered.waiting;
    expect(notices.filter(notice => notice === "ready")).toEqual([]);
    await expect(store.reconcile(scope, async () => newer)).rejects.toMatchObject({ code: "unavailable" });
    nextBlocked.release(); await ready.waiting;
    expect((await store.reconcile(scope, async () => newer)).entries[0]).toMatchObject({ dismissed: false, revision: 2 });
    expect(writes).toBe(2);
    expect(notices.filter(notice => notice === "unavailable")).toHaveLength(1);
  } finally { blocked.release(); nextBlocked.release(); await store.reconcile({ ...scope, workspaceId: "drain" }, async () => []); detach(); rename.mockRestore(); }
});

test("load invalidates an old hung batch's warnings and completion notifications", async () => {
  const { store } = await fixture();
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const entered = gate(); const blocked = gate(); const warned = gate(); const notices: string[] = [];
  const original = fs.rename.bind(fs);
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => { entered.release(); await blocked.waiting; await original(source, target); });
  const detach = store.subscribe((_, notice) => { notices.push(notice); if (notice === "unavailable") warned.release(); });
  try {
    store.observe("ws", scope.conversationId, evidence("execution-1", true));
    await entered.waiting; await warned.waiting;
    await store.load();
    blocked.release(); await store.reconcile({ ...scope, workspaceId: "drain" }, async () => []);
    expect(notices).toEqual(["unavailable"]);
  } finally { blocked.release(); await store.reconcile({ ...scope, workspaceId: "drain" }, async () => []); detach(); rename.mockRestore(); }
});

test("forget invalidates pending observation warnings without a ghost recovery notice", async () => {
  const { store } = await fixture();
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const entered = gate(); const blocked = gate(); const warned = gate(); const notices: string[] = [];
  const detach = store.subscribe((_, notice) => { notices.push(notice); if (notice === "unavailable") warned.release(); });
  const holding = store.reconcile({ ...scope, workspaceId: "other" }, async () => { entered.release(); await blocked.waiting; return []; });
  try {
    await entered.waiting;
    const forgotten = store.forgetWorkspace("ws");
    store.observe("ws", scope.conversationId, evidence("execution-1", true));
    await warned.waiting;
    blocked.release(); await holding; await forgotten;
    notices.length = 0;
    await store.reconcile({ ...scope, workspaceId: "drain" }, async () => []);
    expect(notices).toEqual([]);
  } finally { blocked.release(); await holding; await store.reconcile({ ...scope, workspaceId: "drain" }, async () => []); detach(); }
});
test.each(["empty store", "another account"] as const)("first conditional dismissal captures activity during its read with %s", async prior => {
  const { store, file } = await fixture();
  if (prior === "another account") await store.reconcile({ ...scope, user: "bob" }, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const entered = gate(); const blocked = gate();
  const first = store.reconcile(scope, async () => { entered.release(); await blocked.waiting; return evidence(); }, { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  await entered.waiting;
  store.observe("ws", "opencode:parent", evidence("execution-1", true));
  blocked.release();
  await expect(first).rejects.toMatchObject({ code: "conflict" });
  // Even an immediately queued stale retry cannot beat deferred retirement.
  await expect(store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" })).rejects.toMatchObject({ code: "conflict" });
  await store.reconcile(scope, async () => evidence());
  const restarted = new WorkerDismissalsStore(file); await restarted.load();
  expect((await restarted.reconcile(scope, async () => evidence())).entries[0]).toMatchObject({ dismissed: false, revision: 2 });
  if (prior === "another account") expect((await restarted.reconcile({ ...scope, user: "bob" }, async () => evidence())).entries[0]?.dismissed).toBe(false);
});

test("first conditional dismissal captures activity while its initial record save is pending", async () => {
  const { store, file } = await fixture();
  const entered = gate(); const blocked = gate(); const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (++writes === 1) { entered.release(); await blocked.waiting; }
    await original(source, target);
  });
  try {
    const first = store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
    await entered.waiting;
    expect(() => store.observe("ws", "opencode:parent", evidence("execution-1", true))).not.toThrow();
    blocked.release(); await expect(first).rejects.toMatchObject({ code: "conflict" });
    await store.reconcile(scope, async () => evidence());
    const restarted = new WorkerDismissalsStore(file); await restarted.load();
    expect((await restarted.reconcile(scope, async () => evidence())).entries[0]).toMatchObject({ dismissed: false, revision: 2 });
    expect(writes).toBe(3); // Initial admission, retirement, later unavailability.
  } finally { blocked.release(); rename.mockRestore(); }
});

test.each(["execution", "workspace", "conversation"] as const)("first admission does not capture an unrelated %s observation", async mismatch => {
  const { store } = await fixture({ maxEntries: 1 });
  const entered = gate(); const blocked = gate();
  const first = store.reconcile(scope, async () => { entered.release(); await blocked.waiting; return evidence(); }, { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  await entered.waiting;
  for (let index = 0; index < 20_000; index++) store.observe(mismatch === "workspace" ? "other" : "ws", mismatch === "conversation" ? "opencode:child" : "opencode:parent", evidence(mismatch === "execution" ? `unknown-${index}` : "execution-1", true));
  blocked.release();
  expect((await first).entries[0]).toMatchObject({ dismissed: true, revision: 0 });
});

test.each(["invalid evidence", "missing execution", "failed read", "failed save", "capacity"] as const)("a first admission with %s drops transient authority without poisoning its next explicit attempt", async failure => {
  const { store } = await fixture({ maxEntries: 1 });
  const rename = failure === "failed save" ? spyOn(fs, "rename").mockRejectedValueOnce(new Error("synthetic save failure")) : undefined;
  try {
    const first = store.reconcile(scope, async () => {
      store.observe("ws", "opencode:parent", evidence("execution-1", true));
      if (failure === "failed read") throw new Error("synthetic read failure");
      if (failure === "missing execution") return [];
      if (failure === "invalid evidence") return [{ ...evidence()[0]!, signature: "" }];
      if (failure === "capacity") return [...evidence(), ...evidence("other")];
      return evidence();
    }, { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
    await expect(first).rejects.toBeInstanceOf(Error);
  } finally { rename?.mockRestore(); }
  expect((await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" })).entries[0]).toMatchObject({ dismissed: true, revision: 0 });
});

test("pending conditional target capacity is bounded and releases failed and invalid admissions", async () => {
  const { store } = await fixture({ maxEntries: 1 });
  const entered = gate(); const blocked = gate();
  const first = store.reconcile(scope, async () => { entered.release(); await blocked.waiting; return []; }, { executionId: "missing", expectedRevision: 0, operation: "dismiss" });
  await entered.waiting;
  await expect(store.reconcile(scope, async () => evidence(), { executionId: "invalid", expectedRevision: -1, operation: "dismiss" })).rejects.toMatchObject({ code: "invalid-input" });
  let reads = 0;
  for (let index = 0; index < 100; index++) await expect(store.reconcile(scope, async () => { reads++; return evidence(); }, { executionId: `other-${index}`, expectedRevision: 0, operation: "dismiss" })).rejects.toMatchObject({ code: "capacity" });
  expect(reads).toBe(0);
  blocked.release(); await expect(first).rejects.toMatchObject({ code: "not-found" });
  expect((await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" })).entries[0]?.dismissed).toBe(true);
});

test.each(["load", "forget"] as const)("%s clears queued first-admission authority before a new workspace lifecycle", async reset => {
  const { store } = await fixture({ maxEntries: 1 });
  const other = { ...scope, workspaceId: "other" };
  const entered = gate(); const blocked = gate();
  const blocking = store.reconcile(other, async () => { entered.release(); await blocked.waiting; return []; });
  await entered.waiting;
  const forgotten = reset === "forget" ? store.forgetWorkspace("ws") : undefined;
  let reads = 0;
  const old = store.reconcile(scope, async () => { reads++; return evidence(); }, { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  store.observe("ws", "opencode:parent", evidence("execution-1", true));
  if (reset === "load") await store.load();
  blocked.release(); await blocking; await forgotten;
  await expect(old).rejects.toMatchObject({ code: "unavailable" });
  expect(reads).toBe(0);
  expect((await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" })).entries[0]).toMatchObject({ dismissed: true, revision: 0 });
});
test("positive observation during an older evidence read durably retires every account's mark", async () => {
  const { store, file } = await fixture();
  const old = async () => evidence();
  const later = async () => evidence().map(item => ({ ...item, signature: "unavailable-g2" }));
  for (const user of ["alice", "bob"]) await store.reconcile({ ...scope, user }, old, { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const entered = gate(); const blocked = gate();
  const reading = store.reconcile(scope, async () => { entered.release(); await blocked.waiting; return later(); });
  await entered.waiting;
  store.observe("ws", "opencode:parent", evidence("execution-1", true));
  blocked.release(); await reading;
  // A queued public read drains the observation without inspecting internals.
  await store.reconcile(scope, later);
  const restarted = new WorkerDismissalsStore(file); await restarted.load();
  for (const user of ["alice", "bob"]) {
    const current = await restarted.reconcile({ ...scope, user }, later);
    expect(current.entries[0]).toMatchObject({ dismissed: false, revision: 3 });
    await expect(restarted.reconcile({ ...scope, user }, later, { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" })).rejects.toMatchObject({ code: "conflict" });
  }
});
test("positive activity received during a stale dismissal read rejects that write before retirement drains", async () => {
  const { store, file } = await fixture();
  await store.reconcile(scope, async () => evidence());
  const entered = gate(); const blocked = gate();
  const stale = store.reconcile(scope, async () => { entered.release(); await blocked.waiting; return evidence(); }, { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  await entered.waiting;
  store.observe("ws", "opencode:parent", evidence("execution-1", true));
  blocked.release();
  await expect(stale).rejects.toMatchObject({ code: "conflict" });
  await store.reconcile(scope, async () => evidence());
  const restarted = new WorkerDismissalsStore(file); await restarted.load();
  expect((await restarted.reconcile(scope, async () => evidence())).entries[0]).toMatchObject({ dismissed: false, revision: 2 });
});

test("a fresh explicit dismissal remains supported after durable activity retirement", async () => {
  const { store, file } = await fixture();
  await store.reconcile(scope, async () => evidence());
  const entered = gate(); const blocked = gate();
  const reading = store.reconcile(scope, async () => { entered.release(); await blocked.waiting; return evidence(); });
  await entered.waiting;
  store.observe("ws", "opencode:parent", evidence("execution-1", true));
  blocked.release(); await reading;
  const current = await store.reconcile(scope, async () => evidence());
  const fresh = await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: current.entries[0]!.revision, operation: "dismiss" });
  expect(fresh.entries[0]).toMatchObject({ dismissed: true, revision: 2 });
  const restarted = new WorkerDismissalsStore(file); await restarted.load();
  expect((await restarted.reconcile(scope, async () => evidence())).entries[0]?.dismissed).toBe(true);
});

test.each(["existing record", "first record"] as const)("queued conditional admission before activity cannot hide a %s behind another workspace", async prior => {
  const { store, file } = await fixture();
  const other = { ...scope, workspaceId: "other", conversationId: "opencode:other" };
  await store.reconcile(other, async () => evidence("other"));
  if (prior === "existing record") await store.reconcile(scope, async () => evidence());
  const entered = gate(); const blocked = gate();
  const blocking = store.reconcile(other, async () => { entered.release(); await blocked.waiting; return evidence("other"); });
  await entered.waiting;
  const queued = store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  store.observe("ws", "opencode:parent", evidence("execution-1", true));
  blocked.release(); await blocking;
  await expect(queued).rejects.toMatchObject({ code: "conflict" });
  await store.reconcile(scope, async () => evidence());
  const restarted = new WorkerDismissalsStore(file); await restarted.load();
  expect((await restarted.reconcile(scope, async () => evidence())).entries[0]).toMatchObject({ dismissed: false, revision: 2 });
});

test("a genuinely later admitted dismissal survives an older observation coalesced behind another save", async () => {
  const { store, file } = await fixture();
  const other = { ...scope, workspaceId: "other" };
  await store.reconcile(scope, async () => evidence());
  await store.reconcile(other, async () => evidence("other"), { executionId: "other", expectedRevision: 0, operation: "dismiss" });
  const entered = gate(); const blocked = gate(); const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (++writes === 1) { entered.release(); await blocked.waiting; }
    await original(source, target);
  });
  try {
    store.observe("other", "opencode:parent", evidence("other", true));
    await entered.waiting;
    store.observe("ws", "opencode:parent", evidence("execution-1", true));
    const fresh = store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
    blocked.release();
    expect((await fresh).entries[0]).toMatchObject({ dismissed: true, revision: 0 });
    await store.reconcile(scope, async () => evidence());
    const restarted = new WorkerDismissalsStore(file); await restarted.load();
    expect((await restarted.reconcile(scope, async () => evidence())).entries[0]?.dismissed).toBe(true);
  } finally { blocked.release(); rename.mockRestore(); }
});

test("same-target queued admissions share bounded authority until all older requests finish", async () => {
  const { store } = await fixture({ maxEntries: 1 });
  const entered = gate(); const blocked = gate();
  const first = store.reconcile(scope, async () => { entered.release(); await blocked.waiting; return []; }, { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  await entered.waiting;
  const second = store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  store.observe("ws", "opencode:parent", evidence("execution-1", true));
  blocked.release();
  await expect(first).rejects.toMatchObject({ code: "not-found" });
  await expect(second).rejects.toMatchObject({ code: "conflict" });
  const current = await store.reconcile(scope, async () => evidence());
  expect((await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: current.entries[0]!.revision, operation: "dismiss" })).entries[0]?.dismissed).toBe(true);
});

test("forget ahead of queued activity removes its fences and observations without recreating marks", async () => {
  const { store, file } = await fixture();
  for (const user of ["alice", "bob"]) await store.reconcile({ ...scope, user }, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const entered = gate(); const blocked = gate();
  const reading = store.reconcile(scope, async () => { entered.release(); await blocked.waiting; return evidence(); });
  await entered.waiting;
  const forgotten = store.forgetWorkspace("ws");
  store.observe("ws", "opencode:parent", evidence("execution-1", true));
  blocked.release(); await reading; await forgotten;
  expect((await store.reconcile(scope, async () => [])).entries).toEqual([]);
  const restarted = new WorkerDismissalsStore(file); await restarted.load();
  for (const user of ["alice", "bob"]) expect((await restarted.reconcile({ ...scope, user }, async () => [])).entries).toEqual([]);
});

test("a failed observation retry preserves newer coalesced activity instead of replaying the old signature", async () => {
  const { store } = await fixture();
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const entered = gate(); const blocked = gate(); const warned = gate(); const recovered = gate();
  const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (++writes === 1) { entered.release(); await blocked.waiting; throw new Error("synthetic failure"); }
    await original(source, target);
  });
  const detach = store.subscribe((_, notice) => { if (notice === "unavailable") warned.release(); if (notice === "ready") recovered.release(); });
  const newer = evidence("execution-1", true).map(item => ({ ...item, signature: "working-g2" }));
  try {
    store.observe("ws", "opencode:parent", evidence("execution-1", true));
    await entered.waiting;
    expect(() => store.observe("ws", "opencode:parent", newer)).not.toThrow();
    blocked.release(); await warned.waiting;
    await expect(store.reconcile(scope, async () => newer)).rejects.toMatchObject({ code: "unavailable" });
    await recovered.waiting;
    expect((await store.reconcile(scope, async () => newer)).entries[0]).toMatchObject({ dismissed: false, revision: 1 });
    expect(writes).toBe(2);
  } finally { blocked.release(); detach(); rename.mockRestore(); }
});

test("activity arriving during a dismissal save still retires the committed mark", async () => {
  const { store, file } = await fixture();
  await store.reconcile(scope, async () => evidence());
  const entered = gate(); const blocked = gate();
  const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (++writes === 1) { entered.release(); await blocked.waiting; }
    await original(source, target);
  });
  try {
    const dismissing = store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
    await entered.waiting;
    store.observe("ws", "opencode:parent", evidence("execution-1", true));
    blocked.release(); await dismissing;
    expect((await store.reconcile(scope, async () => evidence())).entries[0]).toMatchObject({ dismissed: false, revision: 2 });
    const restarted = new WorkerDismissalsStore(file); await restarted.load();
    expect((await restarted.reconcile(scope, async () => evidence())).entries[0]?.dismissed).toBe(false);
  } finally { blocked.release(); rename.mockRestore(); }
});

test.each(["failed", "hung"] as const)("%s retirement after an older read warns privately and retains newer activity", async mode => {
  const { store, file } = await fixture();
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const readEntered = gate(); const readBlocked = gate(); const saveEntered = gate(); const saveBlocked = gate();
  const warned = gate(); const recovered = gate();
  const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (++writes === 2) {
      saveEntered.release(); await saveBlocked.waiting;
      if (mode === "failed") throw new Error("synthetic retirement failure");
    }
    await original(source, target);
  });
  const detach = store.subscribe((_, notice) => { if (notice === "unavailable") warned.release(); if (notice === "ready") recovered.release(); });
  const unavailable = async () => evidence().map(item => ({ ...item, signature: "unavailable-g2" }));
  const newer = evidence("execution-1", true).map(item => ({ ...item, signature: "working-g3" }));
  try {
    const reading = store.reconcile(scope, async () => { readEntered.release(); await readBlocked.waiting; return unavailable(); });
    await readEntered.waiting;
    expect(() => store.observe("ws", "opencode:parent", evidence("execution-1", true))).not.toThrow();
    readBlocked.release(); await reading; await saveEntered.waiting;
    expect(() => store.observe("ws", "opencode:parent", newer)).not.toThrow();
    if (mode === "failed") saveBlocked.release();
    await warned.waiting;
    await expect(store.reconcile(scope, unavailable)).rejects.toMatchObject({ code: "unavailable" });
    saveBlocked.release(); await recovered.waiting;
    expect((await store.reconcile(scope, async () => newer)).entries[0]?.dismissed).toBe(false);
    // Drain any coalesced follow-up and verify the durable visibility fence.
    await store.reconcile(scope, unavailable);
    const restarted = new WorkerDismissalsStore(file); await restarted.load();
    expect((await restarted.reconcile(scope, unavailable)).entries[0]?.dismissed).toBe(false);
    await expect(restarted.reconcile(scope, unavailable, { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" })).rejects.toMatchObject({ code: "conflict" });
  } finally { readBlocked.release(); saveBlocked.release(); detach(); rename.mockRestore(); }
});
test("independent per-entry additions merge, repeat idempotently, isolate accounts and survive restart", async () => {
  const { store, file } = await fixture();
  const read = async () => [...evidence("one"), ...evidence("two")];
  await store.reconcile(scope, read);
  await Promise.all(["one", "two"].map(executionId => store.reconcile(scope, read, { executionId, expectedRevision: 0, operation: "dismiss" })));
  const again = await store.reconcile(scope, read, { executionId: "one", expectedRevision: 0, operation: "dismiss" });
  expect(again.entries.every(entry => entry.dismissed)).toBe(true);
  expect((await store.reconcile({ ...scope, user: "bob" }, read)).entries.some(entry => entry.dismissed)).toBe(false);
  const restarted = new WorkerDismissalsStore(file); await restarted.load();
  expect(await restarted.reconcile(scope, read)).toEqual(again);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
});
test("active retirement persists a revision fence through unavailability and restart", async () => {
  const { store, file } = await fixture();
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const active = await store.reconcile(scope, async () => evidence("execution-1", true));
  expect(active.entries[0]).toMatchObject({ dismissed: false, revision: 1 });
  const restarted = new WorkerDismissalsStore(file); await restarted.load();
  await expect(restarted.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" })).rejects.toMatchObject({ code: "conflict" });
  const fresh = await restarted.reconcile(scope, async () => evidence());
  expect(fresh.entries[0]).toMatchObject({ dismissed: false, revision: 2 });
  expect((await restarted.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 2, operation: "dismiss" })).entries[0]?.dismissed).toBe(true);
});
test("capacity and commit failures preserve prior marks without invalidation", async () => {
  const { store, file } = await fixture({ maxEntries: 1 });
  let notifications = 0; store.subscribe(() => { notifications++; });
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const before = await fs.readFile(file, "utf8"); const count = notifications;
  await expect(store.reconcile(scope, async () => evidence("other"))).rejects.toMatchObject({ code: "capacity" });
  const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("synthetic failure"));
  try { await expect(store.reconcile(scope, async () => evidence("execution-1", true))).rejects.toMatchObject({ code: "unavailable" }); } finally { rename.mockRestore(); }
  expect(await fs.readFile(file, "utf8")).toBe(before); expect(notifications).toBe(count);
});
test("unsafe and corrupt files fail closed; forget removes all accounts only in its workspace", async () => {
  const { store, file } = await fixture();
  for (const user of ["alice", "bob"]) await store.reconcile({ ...scope, user }, async () => evidence());
  await store.reconcile({ ...scope, workspaceId: "other" }, async () => evidence());
  await store.forgetWorkspace("ws");
  expect(JSON.parse(await fs.readFile(file, "utf8")).records).toHaveLength(1);
  await fs.chmod(file, 0o644); await store.load();
  await expect(store.reconcile(scope, async () => evidence())).rejects.toMatchObject({ code: "unavailable" });
  await fs.chmod(file, 0o600); await fs.writeFile(file, "broken"); await store.load();
  await expect(store.reconcile(scope, async () => evidence())).rejects.toMatchObject({ code: "unavailable" });
});

test("byte capacity and unsafe links refuse without eviction or following external files", async () => {
  const { store, file, root } = await fixture({ maxBytes: 256 });
  await expect(store.reconcile(scope, async () => evidence("x".repeat(512)))).rejects.toMatchObject({ code: "capacity" });
  expect(await fs.readdir(root)).toEqual([]);
  const external = path.join(root, "external.json"); await fs.writeFile(external, '{"version":1,"records":[]}', { mode: 0o600 });
  await fs.symlink(external, file); await store.load();
  await expect(store.reconcile(scope, async () => evidence())).rejects.toMatchObject({ code: "unavailable" });
  expect(await fs.readFile(external, "utf8")).toBe('{"version":1,"records":[]}');
});

test("authoritative reads serialize before conditional writes; observers see only committed bytes", async () => {
  const { store, file } = await fixture();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const active = store.reconcile(scope, async () => { await waiting; return evidence("execution-1", true); });
  const stale = store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  release(); await active;
  await expect(stale).rejects.toMatchObject({ code: "conflict" });
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  expect(persisted.records[0]).toMatchObject({ revision: 1, dismissed: false });
});

test("invalid file owner makes forget fail closed rather than using previously loaded records", async () => {
  if (typeof process.getuid !== "function") return;
  const { store, file } = await fixture();
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const before = await fs.readFile(file, "utf8");
  const handle = await fs.open(file, "r");
  const stat = await handle.stat();
  const foreignStat = Object.assign(stat, { uid: process.getuid() + 1 });
  const statSpy = spyOn(handle, "stat").mockResolvedValueOnce(foreignStat);
  const openSpy = spyOn(fs, "open").mockResolvedValueOnce(handle);
  try { await store.load(); } finally { openSpy.mockRestore(); statSpy.mockRestore(); }
  await expect(store.forgetWorkspace("ws")).rejects.toMatchObject({ code: "unavailable" });
  await expect(store.reconcile(scope, async () => evidence())).rejects.toMatchObject({ code: "unavailable" });
  expect(await fs.readFile(file, "utf8")).toBe(before);
});

test("trusted observations retire exact existing marks across accounts without creating records", async () => {
  const { store, file } = await fixture();
  for (const user of ["alice", "bob"]) await store.reconcile({ ...scope, user }, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  store.observe("ws", "opencode:parent", [...evidence("execution-1", true), ...evidence("unknown", true)]);
  const state = await store.reconcile(scope, async () => evidence());
  expect(state.entries[0]).toMatchObject({ dismissed: false, revision: 2 });
  expect(JSON.parse(await fs.readFile(file, "utf8")).records).toHaveLength(2);
  const restarted = new WorkerDismissalsStore(file); await restarted.load();
  await expect(restarted.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" })).rejects.toMatchObject({ code: "conflict" });
});

test("observation save failure never throws into chat, invalidates privately and exposes the accepted restart limit", async () => {
  const { store, file } = await fixture();
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("synthetic failure"));
  let notified!: () => void; const notification = new Promise<void>(resolve => { notified = resolve; });
  store.subscribe(() => notified());
  try {
    expect(() => store.observe("ws", "opencode:parent", evidence("execution-1", true))).not.toThrow();
    await notification;
    const restarted = new WorkerDismissalsStore(file); await restarted.load();
    // Approved exception: a failed retirement can leave the old unavailable
    // mark after restart. Positive activity itself is never filtered here.
    expect((await restarted.reconcile(scope, async () => evidence())).entries[0]?.dismissed).toBe(true);
  } finally { rename.mockRestore(); }
  await expect(store.reconcile(scope, async () => evidence())).rejects.toMatchObject({ code: "unavailable" });
});

test("hung observation I/O warns privately while repeated source updates coalesce behind one save", async () => {
  const { store } = await fixture();
  await store.reconcile(scope, async () => evidence(), { executionId: "execution-1", expectedRevision: 0, operation: "dismiss" });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = fs.rename.bind(fs); let writes = 0;
  const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => { writes++; await blocked; await original(source, target); });
  let warning!: () => void; const warned = new Promise<void>(resolve => { warning = resolve; });
  let commit!: () => void; const committed = new Promise<void>(resolve => { commit = resolve; });
  let notices = 0;
  const detach = store.subscribe((observed, notice) => {
    expect(observed.user).toBe("alice");
    if (++notices === 1) { expect(notice).toBe("unavailable"); warning(); }
    else { expect(notice).toBe("ready"); commit(); }
  });
  try {
    for (let index = 0; index < 20_000; index++) store.observe("ws", "opencode:parent", evidence("execution-1", true));
    await warned;
    expect(writes).toBe(1);
    await expect(store.reconcile(scope, async () => evidence())).rejects.toMatchObject({ code: "unavailable" });
    release(); await committed;
    expect(writes).toBe(1);
    const state = await store.reconcile(scope, async () => evidence("execution-1", true));
    expect(state.entries[0]?.dismissed).toBe(false);
    expect(writes).toBe(1);
  } finally { release(); detach(); rename.mockRestore(); }
});
