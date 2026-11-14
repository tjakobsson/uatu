import { expect, spyOn, test } from "bun:test";
import { SessionChanges } from "./session-changes";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";
import { workerDismissalEvidence } from "../../worker-dismissal-evidence";
import type { BackgroundTaskItem } from "../../types";
import type { WorkerSourceGuard } from "../../provider";

test("an expired worker source cannot acquire child pins after healthy parent IO completes", async () => {
  // Resource accounting only, not an oracle for recovered outcomes.
  const capture = SessionChanges.prototype.capture, live = new Set<object>();
  const acquired: string[] = [];
  const captures = spyOn(SessionChanges.prototype, "capture").mockImplementation(function (this: SessionChanges, session: string) {
    const counter = capture.call(this, session);
    acquired.push(session); live.add(counter);
    return { unchanged: counter.unchanged, release: () => { live.delete(counter); counter.release(); } };
  });
  const timeout = AbortSignal.timeout, sourceDeadline = new AbortController();
  let sourceDeadlineSelected = false;
  const timeouts = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    if (ms === 25_000 && !sourceDeadlineSelected) { sourceDeadlineSelected = true; return sourceDeadline.signal; }
    return timeout.call(AbortSignal, ms);
  });
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, entered!: () => void, release!: () => void;
  let parentSignal: AbortSignal | undefined;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      for (const message of body.data) for (const tool of message.content ?? []) if (tool.type === "tool") {
        message.time = { created: 10 }; tool.time = { created: 10, ran: 11, completed: 12 };
      }
      body.data.push({ id: "healthy-parent-text", type: "user", time: { created: 1 }, text: "Healthy parent transcript" });
      parentSignal = request.signal; entered(); await held;
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController();
  let reading: ReturnType<typeof provider.listMessages> | undefined;
  try {
    parent = (await provider.createSession("Expired source, healthy parent")).id;
    child = fake.launchRequestWorker(parent).childId;
    reading = provider.listMessages(parent, { limit: 100, signal: owner.signal });
    void reading.catch(() => undefined);
    await pending;
    expect(acquired).toEqual([parent]); expect(live.size).toBe(1);
    sourceDeadline.abort();
    expect(live.size).toBe(0); expect(parentSignal!.aborted).toBe(false); expect(owner.signal.aborted).toBe(false);
    release();
    const page = await reading;
    expect(JSON.stringify(page.items)).toContain("Healthy parent transcript");
    expect(page.workerSource!.isCurrent()).toBe(false);
    const worker = page.items.find((item): item is BackgroundTaskItem => item.type === "background_task")!;
    expect(worker).toMatchObject({ status: "running", outcomeWithheld: true, control: { available: false } });
    expect(workerDismissalEvidence(worker)?.dismissible).toBe(false);
    expect(acquired).toEqual([parent]);
    expect(live.size).toBe(0);
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    release(); owner.abort(); await reading?.catch(() => undefined); await provider.dispose!(); await fake.stop();
    timeouts.mockRestore(); captures.mockRestore();
  }
});

test("already-aborted history reads release their captures without IO or releasing retained live owners", async () => {
  // Unit lifecycle accounting only: this restored spy is not an outcome oracle.
  const capture = SessionChanges.prototype.capture;
  const live = new Set<object>();
  const spy = spyOn(SessionChanges.prototype, "capture").mockImplementation(function (this: SessionChanges, session: string) {
    const counter = capture.call(this, session);
    live.add(counter);
    return { unchanged: counter.unchanged, release: () => { live.delete(counter); counter.release(); } };
  });
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let requests = 0, parent: string | undefined, child: string | undefined, explicit = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    requests++;
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      for (const message of body.data) for (const tool of message.content ?? []) if (tool.type === "tool") {
        message.time = { created: 10 }; tool.time = { created: 10, ran: 11, completed: 12 };
      }
      if (explicit) body.data.push({ id: "actual-report", type: "synthetic", time: { created: 45 },
        text: "Actual result", metadata: { source: "subagent", childID: child, state: "completed" } });
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const initial = new AbortController(), retained = new AbortController();
  try {
    parent = (await provider.createSession("Retained history lifetime")).id;
    child = fake.launchRequestWorker(parent).childId;
    const page = await provider.listMessages(parent, { limit: 100, signal: initial.signal });
    const guard = page.workerSource!.retain(retained.signal);
    const inferred = page.items.find((item): item is BackgroundTaskItem => item.type === "background_task")!;
    expect(inferred).toMatchObject({ status: "completed" });
    expect(inferred.resultId).toBeUndefined();
    expect(page.workerSource!.projectInferredOutcome!(inferred)).toEqual(inferred);
    expect(guard.projectInferredOutcome!(inferred)).toEqual(inferred);
    initial.abort();
    expect(page.workerSource!.isCurrent()).toBe(false);
    expect(guard.isCurrent()).toBe(true);
    expect(page.workerSource!.projectInferredOutcome!(inferred)).toMatchObject({ status: "running", outcomeWithheld: true, control: { available: false } });
    expect(guard.projectInferredOutcome!(inferred)).toEqual(inferred);
    const pinned = live.size;
    expect(pinned).toBe(2); // B still owns the actual parent and child counter pins.
    // A refused extra lease must not free another owner's pins.
    expect(guard.retain(AbortSignal.abort()).isCurrent()).toBe(false);
    expect(live.size).toBe(pinned);
    const before = requests;
    for (let index = 0; index < 32; index++) {
      await expect(provider.listMessages(`cancelled-parent-${index}`, { limit: 100, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
      expect(requests).toBe(before);
      expect(live.size).toBe(pinned);
    }
    explicit = true;
    const reportedPage = await provider.listMessages(parent, { limit: 100, signal: retained.signal });
    const reported = reportedPage.items.find((item): item is BackgroundTaskItem => item.type === "background_task")!;
    expect(reported).toMatchObject({ status: "completed", resultId: "actual-report" });
    expect(page.workerSource!.projectInferredOutcome!(reported)).toEqual(reported);
    retained.abort();
    expect(guard.isCurrent()).toBe(false);
    expect(live.size).toBe(0);
  } finally { initial.abort(); retained.abort(); await provider.dispose!(); await fake.stop(); spy.mockRestore(); }
});

test("released captures allow the bounded observation store to evict their session", () => {
  const changes = new SessionChanges(1);
  changes.observe("parent", "history", ["old"]);
  const owner = changes.capture("parent");
  changes.observe("other", "history", []);
  changes.observe("parent", "history", ["changed"]);
  expect(owner.unchanged()).toBe(false); // Still pinned despite capacity pressure.
  owner.release();
  changes.observe("other", "history", []);
  const next = changes.capture("parent");
  changes.observe("parent", "history", ["new baseline"]);
  expect(next.unchanged()).toBe(true); // Released state was evicted, not retained unboundedly.
  next.release();
});

for (const oldReply of ["unrelated-overflow", "relevant-report"] as const)
for (const arrival of ["after-owned", "while-owned-pending"] as const)
test(`an older inbox ${oldReply} invalidates only inference, not newer Working activity (${arrival})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, working: string | undefined, ended: string | undefined, inboxReads = 0, nativeReads = 0;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let newerEntered!: () => void, releaseNewer!: () => void, inventoryEntered!: () => void;
  const newerPending = new Promise<void>(resolve => { newerEntered = resolve; });
  const newerHeld = new Promise<void>(resolve => { releaseNewer = resolve; });
  const inventory = new Promise<void>(resolve => { inventoryEntered = resolve; });
  const report = (child: string, index = 0) => ({ id: `inbox-result-${index}`, type: "synthetic", time: { created: 45 },
    payload: { text: "Native result", metadata: { source: "subagent", childID: child, state: "completed" } } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    nativeReads++;
    if (route === `/api/session/${parent}/inbox`) {
      const index = ++inboxReads;
      if (index === 1) {
        const data = oldReply === "unrelated-overflow" ? Array.from({ length: 257 }, (_, i) => report(`unrelated-${i}`, i)) : [report(working!)];
        entered(); await held; return Response.json({ data });
      }
      if (index === 2 && arrival === "while-owned-pending") { newerEntered(); await newerHeld; }
      return Response.json({ data: index <= 3 ? [] : [report(working!)] });
    }
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") { inventoryEntered(); return Response.json({ data: working ? { [working]: { status: "running" } } : {} }); }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      for (const message of body.data) for (const tool of message.content ?? []) if (tool.type === "tool") {
        message.time = { created: 10 }; tool.time = { created: 10, ran: 11, completed: 12 };
      }
      return Response.json(body);
    }
    if (route === `/api/session/${working}/message`) return Response.json({ data: [{ id: "working-input", type: "user", time: { created: 10 }, text: "Work" }], cursor: {} });
    if (route === `/api/session/${ended}/message`) return Response.json({ data: [{ id: "ended-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController(), guards: WorkerSourceGuard[] = [];
  let older: Promise<unknown> | undefined, reading: Promise<BackgroundTaskItem[]> | undefined;
  try {
    parent = (await provider.createSession("Inbox activity and outcome order")).id;
    const activeWorker = fake.launchRequestWorker(parent); working = activeWorker.childId;
    const endedWorker = fake.launchRequestWorker(parent); ended = endedWorker.childId;
    older = provider.listPendingInbox!(parent, { signal: owner.signal }); void older.catch(() => undefined); await pending;
    reading = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: owner.signal,
      onSource: source => guards.push(source.workerSource.retain(owner.signal)) });
    void reading.catch(() => undefined);
    if (arrival === "while-owned-pending") { await newerPending; await inventory; release(); await older; releaseNewer(); }
    const rows = await reading;
    const active = rows.find(row => row.taskId === activeWorker.taskId)!;
    const inferred = rows.find(row => row.taskId === endedWorker.taskId)!;
    expect(active).toMatchObject({ status: "running", activity: { kind: "working" } });
    expect(inferred).toMatchObject(arrival === "after-owned" ? { status: "completed" } : { status: "running", outcomeWithheld: true });
    expect(inferred.resultId).toBeUndefined();
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const before = nativeReads;
    release(); await older;
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    expect(guards[0]!.projectInferredOutcome!(active)).toEqual(active);
    const withheld = guards[0]!.projectInferredOutcome!(inferred);
    expect(withheld).toMatchObject({ status: "running", stateUncertain: true, outcomeWithheld: true, control: { available: false } });
    expect(workerDismissalEvidence(withheld)?.dismissible).toBe(false);
    expect(nativeReads).toBe(before); // Projection and stale observation cannot retry any native route.
    await provider.listPendingInbox!(parent, { signal: owner.signal });
    expect(guards.every(guard => guard.isCurrent())).toBe(true); // Old replies cannot replace the newer empty baseline.
    await provider.listPendingInbox!(parent, { signal: owner.signal });
    expect(guards.some(guard => !guard.isCurrent())).toBe(true); // A newer relevant report still fences activity.
  } finally { release(); releaseNewer(); owner.abort(); await older?.catch(() => undefined); await reading?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
});

for (const newerReply of ["relevant-report", "unrelated-overflow"] as const)
test(`a newer inbox ${newerReply} still fences an older pending activity read`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, inboxReads = 0;
  let entered!: () => void, release!: () => void, inventoryEntered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const inventory = new Promise<void>(resolve => { inventoryEntered = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === `/api/session/${parent}/inbox`) {
      if (++inboxReads === 1) { entered(); await held; return Response.json({ data: [] }); }
      const report = (target: string, index: number) => ({ id: `new-report-${index}`, type: "synthetic", time: { created: 45 },
        payload: { text: "New native result", metadata: { source: "subagent", childID: target, state: "completed" } } });
      return Response.json({ data: newerReply === "relevant-report" ? [report(child!, 0)] : Array.from({ length: 257 }, (_, index) => report(`unrelated-${index}`, index)) });
    }
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") { inventoryEntered(); return Response.json({ data: child ? { [child]: { status: "running" } } : {} }); }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "input", type: "user", time: { created: 10 }, text: "Work" }], cursor: {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 10 }; body.data[0].content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController(); let reading: Promise<BackgroundTaskItem[]> | undefined;
  try {
    parent = (await provider.createSession("Newer inbox fences older activity")).id; child = fake.launchRequestWorker(parent).childId;
    reading = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: owner.signal }); void reading.catch(() => undefined);
    await pending; await inventory;
    await provider.listPendingInbox!(parent, { signal: owner.signal });
    release();
    await expect(reading).rejects.toBeInstanceOf(Error);
  } finally { release(); owner.abort(); await reading?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
});

test("an older parent response withholds inference without revoking newer captured Working activity", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, working: string | undefined, ended: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: working ? { [working]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), index = ++reads;
      for (const message of body.data) for (const tool of message.content ?? []) if (tool.type === "tool") {
        message.time = { created: 10 }; tool.time = { created: 10, ran: 11, completed: 12 };
        tool.state.input.prompt = index === 1 ? "Old native admission" : index === 2 ? "Current native admission" : "Newer changed admission";
      }
      if (index === 1) { entered(); await held; }
      return Response.json(body);
    }
    if (route === `/api/session/${working}/message`) return Response.json({ data: [{ id: "working-input", type: "user", time: { created: 10 }, text: "Work" }], cursor: {} });
    if (route === `/api/session/${ended}/message`) return Response.json({ data: [{ id: "ended-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController(), guards: WorkerSourceGuard[] = [];
  let older: Promise<unknown> | undefined;
  try {
    parent = (await provider.createSession("Separate activity and outcome order")).id;
    const activeWorker = fake.launchRequestWorker(parent); working = activeWorker.childId;
    const endedWorker = fake.launchRequestWorker(parent); ended = endedWorker.childId;
    older = provider.getReversibleHistoryState!(parent); void older.catch(() => undefined); await pending;
    const unrelated = (await provider.createSession("Invalidate in-flight reuse")).id;
    await provider.reconcileBackgroundTasks!(unrelated, { fresh: true });
    const rows = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: owner.signal,
      onSource: source => guards.push(source.workerSource.retain(owner.signal)) });
    const active = rows.find(row => row.taskId === activeWorker.taskId)!;
    const inferred = rows.find(row => row.taskId === endedWorker.taskId)!;
    expect(active).toMatchObject({ status: "running", activity: { kind: "working" } });
    expect(inferred).toMatchObject({ status: "completed" });
    expect(inferred.resultId).toBeUndefined();
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const before = reads;
    release(); await older;
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    expect(guards[0]!.projectInferredOutcome!(active)).toEqual(active);
    expect(guards[0]!.projectInferredOutcome!(inferred)).toMatchObject({ status: "running", outcomeWithheld: true, stateUncertain: true });
    expect(reads).toBe(before); // No parent retry on counter mismatch.
    await provider.getReversibleHistoryState!(parent);
    expect(guards.some(guard => !guard.isCurrent())).toBe(true); // A genuinely newer request still fences activity.
  } finally { release(); owner.abort(); await older?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
});

test("a stable cold observation initializes complete facets without a retry", () => {
  const changes = new SessionChanges(), read = changes.capture("parent");
  changes.observe("parent", "record", { id: "parent" });
  changes.observe("parent", "history", []);
  changes.observe("parent", "inbox", []);
  expect(read.unchanged()).toBe(true);
  read.release();
});

test("a different older response advances the counter, and an independent quiet read recovers", () => {
  const changes = new SessionChanges();
  changes.observe("child", "history", ["new"]);
  const read = changes.capture("child");
  changes.observe("child", "history", ["old"]);
  expect(read.unchanged()).toBe(false);
  changes.observe("child", "history", ["new"]);
  expect(read.unchanged()).toBe(false);
  const quiet = changes.capture("child");
  changes.observe("child", "history", ["new"]);
  expect(quiet.unchanged()).toBe(true);
  read.release(); quiet.release();
});

test("pins survive capacity eviction, unrelated sessions do not invalidate them", () => {
  const changes = new SessionChanges(1), read = changes.capture("child");
  changes.observe("child", "record", "owned");
  changes.observe("other", "record", "other");
  expect(read.unchanged()).toBe(true);
  changes.observe("child", "record", "foreign");
  expect(read.unchanged()).toBe(false);
  read.release();
});

test("native deltas bump but exact replay does not", () => {
  const changes = new SessionChanges();
  const read = changes.capture("child");
  changes.observe("child", "message:m1", { text: "hello" }, true);
  expect(read.unchanged()).toBe(false);
  const next = changes.capture("child");
  changes.observe("child", "message:m1", { text: "hello" }, true);
  expect(next.unchanged()).toBe(true);
  read.release(); next.release();
});

for (const entry of ["history", "inventory"] as const)
test(`${entry} retains per-outcome counters through publication without failing the source or retrying`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, revision = 0, explicit = false, childReads = 0;
  let holdAfter = Infinity, entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === `/api/session/${child}` && childReads >= holdAfter) {
      holdAfter = Infinity; entered(); await held;
    }
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch, ...(explicit ? [{ id: "actual-report", type: "synthetic", time: { created: 45 },
        text: "Actual result", metadata: { source: "subagent", childID: child, state: "completed" } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      childReads++;
      return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
        { id: "text", type: "assistant", time: { created: 41 }, content: [{ type: "text", text: `Native text ${revision}` }] }], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController(), guards: WorkerSourceGuard[] = [];
  const read = async () => {
    if (entry === "inventory") return provider.reconcileBackgroundTasks!(parent!, { fresh: true, signal: owner.signal,
      onSource: source => guards.push(source.workerSource.retain(owner.signal)) });
    const page = await provider.listMessages(parent!, { limit: 100, signal: owner.signal });
    guards.push(page.workerSource!.retain(owner.signal));
    return page.items.filter((item): item is BackgroundTaskItem => item.type === "background_task");
  };
  try {
    parent = (await provider.createSession("Counter publication fixture")).id;
    child = fake.launchRequestWorker(parent).childId;
    const rows = await read(), row = rows[0]!;
    expect(row.status).toBe("completed");
    expect(row.resultId).toBeUndefined();
    const held = [...guards];
    const project = (value: BackgroundTaskItem) => held.reduce((item, guard) => guard.projectInferredOutcome?.(item) ?? item, value);
    await provider.listMessages(child, { limit: 100, signal: owner.signal });
    expect(project(row)).toEqual(row); // Identical independent native observation.
    revision++;
    await provider.listMessages(child, { limit: 100, signal: owner.signal });
    const beforeProjection = childReads, withheld = project(row);
    expect(held.every(guard => guard.isCurrent())).toBe(true);
    expect(withheld).toMatchObject({ status: "running", stateUncertain: true, outcomeWithheld: true, activity: { kind: "unavailable" }, control: { available: false } });
    expect(workerDismissalEvidence(withheld)?.dismissible).toBe(false);
    expect(childReads).toBe(beforeProjection); // Projection never retries native IO.
    expect((await read())[0]!.status).toBe("completed"); // Separate quiet read.
    holdAfter = childReads + 1;
    const publishing = read();
    await waiting;
    revision++;
    await provider.listMessages(child, { limit: 100, signal: owner.signal });
    const consumedReads = childReads;
    release();
    expect((await publishing)[0]).toMatchObject({ status: "running", stateUncertain: true, outcomeWithheld: true });
    expect(childReads).toBe(consumedReads); // Native mismatch does not restart the parent read.
    expect((await read())[0]!.status).toBe("completed");
    explicit = true;
    const reported = (await read())[0]!;
    revision++;
    await provider.listMessages(child, { limit: 100, signal: owner.signal });
    expect(project(reported)).toMatchObject({ status: "completed", resultId: "actual-report", summary: "Actual result" });
    expect(workerDismissalEvidence(reported)?.dismissible).toBe(true);
  } finally { release(); owner.abort(); await provider.dispose!(); await fake.stop(); }
});
