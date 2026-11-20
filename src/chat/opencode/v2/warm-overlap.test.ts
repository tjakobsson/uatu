import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { ChatAdapter } from "../../adapter";
import type { BackgroundTaskItem, ConversationItem } from "../../types";
import { workerDismissalEvidence } from "../../worker-dismissal-evidence";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

for (const kind of ["record", "inbox"] as const)
for (const mode of ["overlap", "unchanged", "disjoint", "before-load"] as const)
for (const phase of kind === "record" && mode === "overlap" ? ["pending", "installed"] as const : ["pending"] as const)
// Pure qualification controls moved to the native-history interface. Keep the
// adapter's canonical outcome/evidence assertions and both failure seams.
for (const seam of mode === "overlap" ? ["provider", "adapter"] as const : ["adapter"] as const)
test(`pre-registration ${kind} response fences ${phase} raw history (${mode}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const oldEntered = gate(), oldRelease = gate(), rawEntered = gate(), rawRelease = gate();
  const oldContext = new AsyncLocalStorage<boolean>();
  let parent: string | undefined, child: string | undefined, other: string | undefined, changed = false, rawReads = 0;
  const nativeOrder: string[] = [];
  const report = () => ({ id: "overlapping-native-failure", type: "synthetic", time: { created: 45 }, payload: {
    text: "Actual delivered failure", metadata: { source: "subagent", childID: child, state: "error" },
  } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    // No automatic discovery may create worker consumers while raw cache IO warms.
    if (route === "/api/session" && request.method === "GET") return Response.json({ data: [], cursor: {} });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    if (route.endsWith("/inbox")) {
      const old = kind === "inbox" && oldContext.getStore();
      const data = old && mode !== "unchanged" ? [report()] : [];
      if (old) { nativeOrder.push("old request entered"); oldEntered.release(); await oldRelease.promise; nativeOrder.push("old response delivered"); }
      else nativeOrder.push("empty inbox observed");
      return Response.json({ data });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message` || route === `/api/session/${child}/message`) {
      const parentHistory = route === `/api/session/${parent}/message`;
      let data: unknown[];
      if (parentHistory) {
        const body = await response.json(), launch = body.data[0];
        launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
        const result = report();
        data = [launch, ...(kind === "inbox" && changed ? [{ ...result.payload, id: result.id, type: result.type, time: result.time }] : [])];
      } else data = [{ id: "child-input", type: "user", time: { created: 15 }, text: "Work" },
        ...(!(kind === "record" && changed) ? [{ id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : [])];
      if (parentHistory === (kind === "inbox")) {
        if (++rawReads === 1) { nativeOrder.push("raw snapshot held"); rawEntered.release(); await rawRelease.promise; nativeOrder.push("raw snapshot returned"); }
      }
      return Response.json({ data, cursor: {} });
    }
    if (kind === "record" && oldContext.getStore() && route === `/api/session/${mode === "disjoint" ? other : child}`) {
      const body = await response.json();
      if (mode !== "unchanged") body.data.revert = { messageID: "old-idle" };
      nativeOrder.push("old request entered"); oldEntered.release(); await oldRelease.promise; nativeOrder.push("old response delivered");
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), owner = new AbortController();
  let old: Promise<unknown> | undefined, warm: Promise<unknown> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Ownerless pending raw history overlap")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    other = (await provider.createSession("Disjoint session")).id;
    pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream!(owner.signal);
    const subject = mode === "disjoint" ? other : kind === "record" ? child : parent;
    old = oldContext.run(true, () => kind === "record" ? provider.getSession(subject!) : provider.listPendingInbox!(subject!));
    void old.catch(() => undefined); await oldEntered.promise;
    const warmSubject = kind === "record" ? child : parent;
    if (mode !== "before-load") { warm = provider.getReversibleHistoryState!(warmSubject); void warm.catch(() => undefined); await rawEntered.promise; }
    if (phase === "installed") { rawRelease.release(); await warm; }
    oldRelease.release(); await old;
    changed = mode === "overlap" || mode === "before-load";
    if (kind === "record") await provider.getSession(subject!);
    else await provider.listPendingInbox!(subject!);
    nativeOrder.push("transition observations finished");
    if (mode === "before-load") { warm = provider.getReversibleHistoryState!(warmSubject); void warm.catch(() => undefined); await rawEntered.promise; }
    expect(nativeOrder.indexOf("old request entered")).toBeLessThan(nativeOrder.indexOf("raw snapshot held"));
    if (mode !== "before-load") expect(nativeOrder.indexOf("raw snapshot held")).toBeLessThan(nativeOrder.indexOf("old response delivered"));
    rawRelease.release(); await warm;
    expect(rawReads).toBe(1); // Cache invalidation must not retry/cancel the existing raw waiter.
    nativeOrder.push("first worker consumer starts");
    expect(nativeOrder.indexOf("transition observations finished")).toBeLessThan(nativeOrder.indexOf("first worker consumer starts"));
    const page = seam === "provider" ? { items: await provider.reconcileBackgroundTasks!(parent) } : await adapter.history(parent);
    const items: ConversationItem[] = page.items;
    const row = items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    if (changed && kind === "record") {
      expect(row).toMatchObject({ status: "running" });
      expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
    } else if (changed) expect(row).toMatchObject({ status: "failed", resultId: "overlapping-native-failure", summary: "Actual delivered failure" });
    else expect(row).toMatchObject({ status: "completed" });
    expect(rawReads).toBe(mode === "overlap" ? 2 : 1); // Only a later independent read loads current truth.
    if (seam === "adapter") {
      const evidence = await adapter.workerEvidence(parent);
      expect(evidence.entries.find(entry => entry.executionId === row?.activity?.executionId)?.dismissible).toBe(kind === "record" && changed ? false : true);
    }
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    if (changed && kind === "record") expect(fresh).toMatchObject({ status: "running", activity: { kind: "working" } });
    else if (changed) expect(fresh).toMatchObject({ status: "failed", resultId: "overlapping-native-failure" });
    else expect(fresh).toMatchObject({ status: "completed" });
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    oldRelease.release(); rawRelease.release(); owner.abort(); await old?.catch(() => undefined); await warm?.catch(() => undefined);
    await adapter.dispose(); await pump?.catch(() => undefined); await fake.stop();
  }
}, 10_000);

// A positive inbox read can finish before any warm entry exists. Delivery during
// (or after) the first parent load must not leave its pre-delivery transcript
// reusable once that known report disappears.
for (const delivery of ["never", "during-load", "unseen-until-consumer"] as const)
for (const seam of ["provider", "adapter"] as const)
test(`known pre-registration inbox report fences warm history across delivery (${delivery}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const rawEntered = gate(), rawRelease = gate();
  let parent: string | undefined, child: string | undefined, delivered = false, rawReads = 0;
  const report = () => ({ id: "native-failure", type: "synthetic", time: { created: 45 }, payload: {
    text: "Known native failure", metadata: { source: "subagent", childID: child, state: "error" },
  } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/session" && request.method === "GET") return Response.json({ data: [], cursor: {} });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    if (route.endsWith("/inbox")) return Response.json({ data: delivered ? [] : [report()] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0], result = report();
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      // The transcript is captured when the request arrives, before any hold.
      const data = [launch, ...(delivered ? [{ ...result.payload, id: result.id, type: result.type, time: result.time }] : [])];
      if (++rawReads === 1) { rawEntered.release(); await rawRelease.promise; }
      return Response.json({ data, cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-input", type: "user", time: { created: 15 }, text: "Work" },
      { id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), owner = new AbortController();
  let warm: Promise<unknown> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Known inbox across warm registration")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream!(owner.signal);
    // 1. The positive read completes before any reuse entry is registered.
    await provider.listPendingInbox!(parent);
    // 2. The first warm load captures the pre-delivery transcript and is held.
    warm = provider.getReversibleHistoryState!(parent); void warm.catch(() => undefined); await rawEntered.promise;
    // 3. Delivery empties the inbox; only during-load observes it before install.
    delivered = delivery !== "never";
    if (delivery === "during-load") await provider.listPendingInbox!(parent);
    rawRelease.release(); await warm;
    expect(rawReads).toBe(1);
    const page = seam === "provider" ? { items: await provider.reconcileBackgroundTasks!(parent) } : await adapter.history(parent);
    const items: ConversationItem[] = page.items;
    const row = items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    let published = row;
    if (delivery !== "unseen-until-consumer") expect(row).toMatchObject({ status: "failed", resultId: "native-failure", summary: "Known native failure" });
    else {
      // The consumer itself first observes disappearance; it may not publish
      // the stale inferred completion, and a later quiet read reloads.
      expect(row?.status).not.toBe("completed");
      const quiet = seam === "provider" ? { items: await provider.reconcileBackgroundTasks!(parent) } : await adapter.history(parent);
      const later = (quiet.items as ConversationItem[]).find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
      expect(later).toMatchObject({ status: "failed", resultId: "native-failure", summary: "Known native failure" });
      published = later;
    }
    // Disappearance retires the stale transcript; one later independent read
    // loads the delivered report. (A still-pending report keeps its existing
    // per-consumer counterproof, so the control's read count is not pinned.)
    if (delivery !== "never") expect(rawReads).toBe(2);
    if (seam === "adapter") {
      // Dismissal evidence follows the Failed row, not a stale Completed one.
      const expected = workerDismissalEvidence(published)!, evidence = await adapter.workerEvidence(parent);
      expect(evidence.entries.find(entry => entry.executionId === expected.executionId)?.signature).toBe(expected.signature);
    }
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    expect(fresh).toMatchObject({ status: "failed", resultId: "native-failure" });
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    rawRelease.release(); owner.abort(); await warm?.catch(() => undefined);
    await adapter.dispose(); await pump?.catch(() => undefined); await fake.stop();
  }
}, 10_000);

// Pre-request invalidation cannot retire a child history warmed while the
// stage request is in flight. If the stage is then committed before any staged
// record or event is observed, and the cleared record matches the pre-stage
// one, that warm entry must not supply the idle the commit removed.
for (const seam of ["provider", "adapter"] as const)
test(`successful revert staging retires child history warmed during the request (${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const stageEntered = gate(), stageRelease = gate();
  let parent: string | undefined, child: string | undefined, committed = false, childReads = 0;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/session" && request.method === "GET") return Response.json({ data: [], cursor: {} });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === `/api/session/${child}/revert/stage`) { stageEntered.release(); await stageRelease.promise; }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      childReads++;
      return Response.json({ data: committed ? [] : [{ id: "child-input", type: "user", time: { created: 15 }, text: "Work" },
        { id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    }
    if (route === `/api/session/${child}` && committed) {
      // The committed record clears its boundary: identical to the pre-stage record.
      const body = await response.json(); delete body.data.revert; return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), owner = new AbortController();
  let undo: Promise<unknown> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Revert stage warm overlap")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream!(owner.signal);
    undo = provider.undo!(child); void undo.catch(() => undefined); await stageEntered.promise;
    const before = childReads;
    // Warm the child's native history while the stage request is in flight.
    expect(await provider.getReversibleHistoryState!(child)).toMatchObject({ staged: false });
    expect(childReads).toBe(before + 1);
    stageRelease.release(); await undo;
    committed = true; // Committed before any staged record or event was observed.
    const page = seam === "provider" ? { items: await provider.reconcileBackgroundTasks!(parent) } : await adapter.history(parent);
    const items: ConversationItem[] = page.items;
    const row = items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    expect(row).toMatchObject({ status: "running" });
    expect(row?.resultId).toBeUndefined();
    expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    expect(fresh).toMatchObject({ status: "running", activity: { kind: "working" } });
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    stageRelease.release(); owner.abort(); await undo?.catch(() => undefined);
    await adapter.dispose(); await pump?.catch(() => undefined); await fake.stop();
  }
}, 10_000);

// A streamed same-child failure can arrive before any history source or warm
// entry exists. Delivery without a frame or inbox read must not leave the
// report-free warm transcript reusable for a publishable inferred completion.
for (const seam of ["provider", "page", "adapter"] as const)
test(`streamed pre-registration inbox report fences warm history across unseen delivery (${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, delivered = false, rawReads = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `${type}:${created}`, type, data, created, location: { directory } })}\n\n`));
  const payload = () => ({ text: "Streamed native failure", metadata: { source: "subagent", childID: child, state: "error" } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route === "/api/session" && request.method === "GET") return Response.json({ data: [], cursor: {} });
    if (route === "/api/session/active") return Response.json({ data: {} });
    if (route === `/api/session/${parent}/inbox`) return Response.json({ data: delivered ? [] : [{ id: "streamed-failure", type: "synthetic", time: { created: 45 }, payload: payload() }] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      rawReads++;
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch, ...(delivered ? [{ ...payload(), id: "streamed-failure", type: "synthetic", time: { created: 45 } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-input", type: "user", time: { created: 15 }, text: "Work" },
      { id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeEvents = provider.events.bind(provider);
  let streamed!: () => void;
  const enqueued = new Promise<void>(resolve => { streamed = resolve; });
  provider.events = signal => (async function* () {
    for await (const event of nativeEvents(signal)) {
      if (event.eventType === "session.inbox.enqueued" && event.conversationId === parent) streamed();
      yield event;
    }
  })();
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), owner = new AbortController();
  let pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Streamed inbox before warm registration")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream!(owner.signal);
    // 1. The failure is only streamed: no inbox read, no source, no warm entry.
    frame("session.inbox.enqueued", { sessionID: parent, inboxID: "streamed-failure", item: { type: "synthetic", payload: payload() } }, 45);
    await enqueued;
    // 2. Parent history warms while the report is still pending.
    await provider.getReversibleHistoryState!(parent);
    expect(rawReads).toBe(1);
    // 3. Native delivery happens with neither a frame nor an inbox read yet.
    delivered = true;
    let row: BackgroundTaskItem | undefined;
    if (seam === "provider") row = (await provider.reconcileBackgroundTasks!(parent)).find(item => item.taskId === worker.taskId);
    else if (seam === "page") {
      const page = await provider.listMessages(parent, { limit: 100 });
      row = page.items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
      expect(page.workerSource?.isCurrent()).toBe(true);
    } else {
      const page = await adapter.history(parent);
      row = (page.items as ConversationItem[]).find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    }
    // The already-observed failure denies a report-free, dismissible Completed.
    expect(row?.status).not.toBe("completed");
    expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
    if (seam === "adapter") {
      // The stale entry is retired: a later quiet read loads the delivered
      // report, and dismissal evidence follows that Failed row.
      const later = (await adapter.history(parent)).items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
      expect(later).toMatchObject({ status: "failed", resultId: "streamed-failure" });
      const expected = workerDismissalEvidence(later)!, evidence = await adapter.workerEvidence(parent);
      expect(evidence.entries.find(item => item.executionId === expected.executionId)?.signature).toBe(expected.signature);
    }
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    expect(fresh).toMatchObject({ status: "failed", resultId: "streamed-failure" });
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    owner.abort(); await adapter.dispose(); await pump?.catch(() => undefined); await fake.stop();
  }
}, 10_000);

// A streamed revert stage can be consumed before the first child warm-load
// registration. A clear record observed while the pre-commit transcript is held,
// before any commit frame, must not become that entry's visibility baseline.
for (const seam of ["provider", "page", "adapter"] as const)
test(`streamed pre-registration revert stage fences warm child history across a crossing clear (${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const rawEntered = gate(), rawRelease = gate();
  let parent: string | undefined, child: string | undefined, committed = false, rawReads = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const frame = (type: string, data: unknown, created: number) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `${type}:${created}`, type, data, created, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}, 1); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route === "/api/session" && request.method === "GET") return Response.json({ data: [], cursor: {} });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      // The transcript is captured on arrival: the first read predates the commit.
      const data = [{ id: "child-input", type: "user", time: { created: 15 }, text: "Work" },
        ...(!committed ? [{ id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : [])];
      if (++rawReads === 1) { rawEntered.release(); await rawRelease.promise; }
      return Response.json({ data, cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeEvents = provider.events.bind(provider);
  let streamed!: () => void;
  const staged = new Promise<void>(resolve => { streamed = resolve; });
  provider.events = signal => (async function* () {
    for await (const event of nativeEvents(signal)) {
      if (event.eventType === "session.revert.staged") streamed();
      yield event;
    }
  })();
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), owner = new AbortController();
  let warm: Promise<unknown> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Streamed stage before warm registration")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream!(owner.signal);
    // 1. Only the stream reports the stage: no record read, no warm entry yet.
    frame("session.revert.staged", { sessionID: child, revert: { messageID: "old-idle" } }, 50);
    await staged;
    // 2. The first child warm load captures the pre-commit transcript and is held.
    warm = provider.getReversibleHistoryState!(child); void warm.catch(() => undefined); await rawEntered.promise;
    // 3. The commit lands natively; a clear record is observed before its frame.
    committed = true;
    await provider.getSession(child);
    rawRelease.release(); await warm;
    let row: BackgroundTaskItem | undefined;
    if (seam === "provider") row = (await provider.reconcileBackgroundTasks!(parent)).find(item => item.taskId === worker.taskId);
    else if (seam === "page") {
      const page = await provider.listMessages(parent, { limit: 100 });
      row = page.items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    } else {
      const page = await adapter.history(parent);
      row = (page.items as ConversationItem[]).find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    }
    // The removed idle cannot supply a Completed outcome. A bare page has no
    // inventory, so it reports Status unavailable under the existing policy;
    // inventory-backed reads see the still-Working child, which is not dismissible.
    expect(row).toMatchObject({ status: "running" });
    if (seam !== "page") {
      expect(row?.activity?.kind).toBe("working");
      expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
    }
    expect(rawReads).toBe(2); // Only a later independent read loads current truth.
    if (seam === "adapter") {
      const expected = workerDismissalEvidence(row)!, evidence = await adapter.workerEvidence(parent);
      expect(evidence.entries.find(item => item.executionId === expected.executionId)?.dismissible).not.toBe(true);
    }
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    expect(fresh).toMatchObject({ status: "running", activity: { kind: "working" } });
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    rawRelease.release(); owner.abort(); await warm?.catch(() => undefined);
    await adapter.dispose(); await pump?.catch(() => undefined); await fake.stop();
  }
}, 10_000);
