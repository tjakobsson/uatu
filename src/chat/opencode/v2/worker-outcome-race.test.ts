import { expect, test } from "bun:test";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";
import { ChatAdapter } from "../../adapter";
import { AsyncLocalStorage } from "node:async_hooks";
import { workerCanStop, workerExecutionClockRuns } from "../../worker-state";

for (const read of ["history", "automatic-recovery"] as const)
for (const proof of ["same-execution", "parent-report", "changed-identity"] as const)
test(`${read} resumes active work after withdrawing an inferred outcome (${proof})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, resumed = false, armed = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, finished!: () => void;
  const published = new Promise<void>(resolve => { finished = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 50, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route === "/api/session/active") return Response.json({ data: resumed && child ? { [child]: { status: "running" } } : {} });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], changed = resumed && proof === "changed-identity";
      first.time = { created: changed ? 30 : 10 }; first.content[0].time = changed ? { created: 30, ran: 31, completed: 32 } : { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first, ...(proof === "parent-report" ? [{ id: "parent-result", type: "synthetic", time: { created: 25 }, text: "Explicit parent report", metadata: { source: "subagent", childID: child, state: "completed" } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: resumed ? [] : [
      { id: "reverted-child-input", type: "user", text: "Committed reverted suffix", time: { created: 15 } },
      { id: "reverted-child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" },
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = (id, options) => nativeRecovery(id, options?.onSource ? { ...options, onSource: source => options.onSource!({ ...source, workerSource: {
    isCurrent: source.workerSource.isCurrent,
    retain: signal => {
      if (armed) { if (signal.aborted) finished(); else signal.addEventListener("abort", () => finished(), { once: true }); }
      return source.workerSource.retain(signal);
    },
  } }) } : options);
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), abort = new AbortController();
  try {
    parent = (await provider.createSession("Resumed history-only outcome")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const warm = (await adapter.history(parent)).items.find(item => item.type === "background_task" && item.taskId === worker.taskId);
    expect(warm).toMatchObject({ type: "background_task", status: "completed", activity: { kind: "ended" } });
    // Model the persisted result of a committed child revert: its input/idle
    // suffix is gone, no staged boundary remains, and native inventory resumes
    // the same execution. No provider activity or adapter row is fabricated.
    resumed = true;
    const fresh = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    expect(fresh[0]).toMatchObject({ status: proof === "parent-report" ? "completed" : "running", activity: { kind: proof === "parent-report" ? "ended" : "working" } });
    expect(fresh[0]?.activity?.executionId === (warm?.type === "background_task" ? warm.activity?.executionId : undefined)).toBe(proof !== "changed-identity");
    if (proof === "same-execution") expect(fresh[0]?.control?.available).toBe(false);
    armed = true;
    let items: import("../../types").ConversationItem[];
    if (read === "history") items = (await adapter.history(parent)).items;
    else {
      frame("session.message.content.updated", { sessionID: parent, messageID: "ordinary-parent-output", content: [{ type: "text", text: "Resume progress" }] });
      await published;
      items = (await adapter.subscribe(parent, { signal: abort.signal })).snapshot.items;
    }
    const current = items.find((item): item is import("../../types").BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    expect(current?.status).toBe(proof === "same-execution" ? "running" : "completed");
    expect(workerExecutionClockRuns(current!)).toBe(proof === "same-execution");
    if (proof === "same-execution") { expect(current?.activity?.kind).toBe("working"); expect(adapter.activity().working).toBe(true); }
    if (proof === "parent-report") expect(current).toMatchObject({ resultId: "parent-result", summary: "Explicit parent report" });
  } finally { armed = false; abort.abort(); await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const boundary of ["ownership", "initial-parent"] as const)
for (const change of ["competing", "unchanged", "ordinary-output", "unrelated-parent", ...(boundary === "initial-parent" ? ["included-launch" as const] : [])] as const)
test(`parent counterproof survives the ${boundary === "ownership" ? "first ownership" : "initial parent history"} await (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false, lookups = 0, first: any, competitor: any;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const ownershipPending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      competitor = structuredClone(first); competitor.id = "ownership-race-message"; competitor.time = { created: 15 };
      competitor.content[0].id = "ownership-race-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      const data = [first, ...(changed || change === "included-launch" ? [competitor] : [])];
      if (boundary === "initial-parent" && ++lookups === 1) { entered(); await held; }
      return Response.json({ data, cursor: {} });
    }
    if (boundary === "ownership" && route === `/api/session/${child}` && ++lookups === 1) { entered(); await held; }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), firstAbort = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Pre-ownership parent counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId; fake.settleWorker(child, "completed", "No parent report");
    const unrelated = (await provider.createSession("Independent parent")).id;
    const unrelatedWorker = fake.launchRequestWorker(unrelated);
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.ownership-counterproof-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal, onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    void recovery.catch(() => undefined); await ownershipPending;
    changed = change === "competing";
    const content = change === "ordinary-output" ? [{ type: "text", text: "Parent output" }]
      : change === "unchanged" ? first.content : structuredClone(competitor.content);
    if (change === "unrelated-parent") content[0].state.metadata.sessionID = unrelatedWorker.childId;
    frame("session.message.content.updated", { sessionID: change === "unrelated-parent" ? unrelated : parent,
      messageID: change === "unchanged" ? first.id : competitor.id, content });
    frame("diagnostic.ownership-counterproof-applied", {});
    // Stream enrichment has a finite deadline; it cannot authorize the held
    // required lookup. Counterproof must be recorded before that enrichment.
    await observed; release();
    const result = await recovery.then(tasks => ({ tasks }), error => ({ error }));
    if (changed) { expect(result).toMatchObject({ error: expect.any(Error) }); expect(guards.some(guard => !guard.isCurrent())).toBe(true); }
    else if (change === "included-launch") {
      const tasks = "tasks" in result ? result.tasks : undefined;
      expect(tasks).toHaveLength(2);
      expect(tasks?.find(task => task.taskId === worker.taskId)?.status).toBe("running");
      expect(guards.every(guard => guard.isCurrent())).toBe(true);
    }
    else { expect(result).toMatchObject({ tasks: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] }); expect(guards.every(guard => guard.isCurrent())).toBe(true); }
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh).toHaveLength(changed || change === "included-launch" ? 2 : 1);
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(changed || change === "included-launch" ? "running" : "completed");
    if (changed || change === "included-launch") expect(fresh.every(task => task.status === "running")).toBe(true);
  } finally { release(); firstAbort.abort(); abort.abort(); await firstPump; await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const mode of ["prebaseline", "same-report", "large-same-report", "many-reports", "report-budget-at", "report-budget-over", "late-ownerless", "report-change-without-part-clocks"] as const)
test(`native parent-result counterproof is scoped and compact (${mode})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0, repaired = false, foreignLookups = 0;
  let entered!: () => void, release!: () => void, secondEntered!: () => void, releaseSecond!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const secondPending = new Promise<void>(resolve => { secondEntered = resolve; }), secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  const hasInitialReport = mode !== "prebaseline" && mode !== "late-ownerless";
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/session/z") foreignLookups++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++reads, delayed = mode === "late-ownerless" && index === 2;
      first.time = { created: 20 }; first.content[0].time = { created: 20, ran: 20, completed: 30 };
      if (mode === "report-change-without-part-clocks") first.content[0].time = {};
      const report = { id: "native-report", type: "synthetic", time: { created: 45 }, text: mode === "large-same-report" ? "Report".repeat(20_000) : "Parent result",
        metadata: { source: "subagent", childID: child, state: hasInitialReport && !(mode === "report-change-without-part-clocks" && index > 1) ? "completed" : "error" } };
      const data = [first, ...(hasInitialReport || index > 1 && !delayed ? [report] : [])];
      if (mode === "many-reports") for (let item = 1; item < 300; item++) data.push({ ...report, id: `result-${item}` });
      if (!repaired && index > 1 && (mode === "report-budget-at" || mode === "report-budget-over")) data.push({ id: "noise", type: "assistant", time: { created: 50 },
        content: Array.from({ length: mode === "report-budget-at" ? 254 : 255 }, (_, item) => ({ type: "tool", id: `n${item}`, name: "subagent", state: { metadata: { sessionID: "z" } } })) });
      if (index === 1) { entered(); await held; }
      if (delayed) { secondEntered(); await secondHeld; }
      return Response.json({ data, cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let older: ReturnType<typeof provider.listMessages> | undefined, delayed: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Compact parent-result observation")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelated = (await provider.createSession("Independent reuse invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void older.catch(() => undefined); await pending;
    await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    if (mode === "late-ownerless") {
      delayed = provider.getReversibleHistoryState!(parent); void delayed.catch(() => undefined); await secondPending;
      await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    }
    await provider.getReversibleHistoryState!(parent); releaseSecond(); await delayed; release();
    const stale = await older, contradicted = mode === "prebaseline" || mode === "late-ownerless" || mode === "report-budget-over" || mode === "report-change-without-part-clocks";
    expect(stale.workerSource?.isCurrent()).toBe(!contradicted);
    expect(foreignLookups).toBe(0);
    await provider.getReversibleHistoryState!(parent); expect(reads).toBe(mode === "late-ownerless" ? 3 : 2);
    repaired = true;
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(task => task.taskId === worker.taskId)).toMatchObject({ status: hasInitialReport && mode !== "report-change-without-part-clocks" ? "completed" : "failed", resultId: "native-report" });
    expect(foreignLookups).toBe(0);
  } finally { release(); releaseSecond(); abort.abort(); await older?.catch(() => undefined); await delayed?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const arrival of ["after-owned", "while-owned-pending"] as const)
test(`older ownerless parent results cannot revoke later consumed results (${arrival})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void, newerEntered!: () => void, releaseNewer!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const newerPending = new Promise<void>(resolve => { newerEntered = resolve; }), newerHeld = new Promise<void>(resolve => { releaseNewer = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++reads;
      first.time = { created: 20 }; first.content[0].time = { created: 20, ran: 20, completed: 30 };
      if (index === 1) { entered(); await held; }
      else if (arrival === "while-owned-pending") { newerEntered(); await newerHeld; }
      return Response.json({ data: [first, { id: "parent-result", type: "synthetic", time: { created: 45 }, text: "Authoritative result",
        metadata: { source: "subagent", childID: child, state: index === 1 ? "completed" : "error" } }], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let older: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, read: ReturnType<typeof provider.listMessages> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Native report ordering")).id; const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelated = (await provider.createSession("Independent reuse invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal);
    older = provider.getReversibleHistoryState!(parent); void older.catch(() => undefined); await pending;
    await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    read = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void read.catch(() => undefined);
    if (arrival === "while-owned-pending") { await newerPending; release(); await older; releaseNewer(); }
    const page = await read; expect(page.workerSource?.isCurrent()).toBe(true);
    expect(page.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "failed", resultId: "parent-result" }));
    release(); await older;
    expect(page.workerSource?.isCurrent()).toBe(true);
    await provider.getReversibleHistoryState!(parent); expect(reads).toBe(2);
    expect(page.workerSource?.isCurrent()).toBe(true);
  } finally { release(); releaseNewer(); abort.abort(); await older?.catch(() => undefined); await read?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["failed-report", "report-before-idle", "same-report", "other-child", "earlier-report", "append-text", "hidden-report"] as const)
test(`automatic recovery guards native parent results through interaction admission (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, otherChild: string | undefined, changed = false;
  let folded!: () => void, interactionsEntered!: () => void, release!: () => void;
  const consumed = new Promise<void>(resolve => { folded = resolve; }), interactions = new Promise<void>(resolve => { interactionsEntered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") { interactionsEntered(); await held; }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 20 };
      first.content[0].time = { created: 20, ran: 20, completed: 30 };
      const report = { id: "native-parent-result", type: "synthetic", time: { created: change === "earlier-report" ? 5 : change === "report-before-idle" ? 35 : 45 },
        text: "Native parent result", metadata: { source: "subagent", childID: change === "other-child" ? otherChild : child, state: change === "same-report" ? "completed" : "error" } };
      return Response.json({ data: [first,
        ...(change === "hidden-report" ? [{ id: "report-hidden", type: "user", text: "Hidden suffix", time: { created: 43 } }] : []),
        ...(change === "same-report" || changed && change !== "append-text" ? [report] : []),
        ...(changed && change === "append-text" ? [{ id: "ordinary-output", type: "assistant", time: { created: 50 }, content: [{ type: "text", text: "Parent output" }] }] : []),
      ], cursor: {} });
    }
    if (route === `/api/session/${parent}` && change === "hidden-report") {
      const body = await response.json(); body.data.revert = { messageID: "report-hidden" }; return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    if (route === `/api/session/${otherChild}/message`) return Response.json({ data: [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), abort = new AbortController();
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  provider.reconcileBackgroundTasks = async (id, options) => {
    const tasks = await nativeRecovery(id, { ...options, onSource: source => { options?.onSource?.(source); guards.push(source.workerSource.retain(abort.signal)); } });
    folded(); return tasks;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump: Promise<void> | undefined, events: Promise<import("../../types").BackgroundTaskItem> | undefined;
  try {
    parent = (await provider.createSession("Native parent report handoff")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (change === "other-child") otherChild = fake.launchRequestWorker(parent).childId;
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    events = (async () => { for await (const event of subscription.events) if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
      throw new Error("Scheduler ended before worker publication"); })(); void events.catch(() => undefined);
    pump = adapter.startEventPump(); await Promise.all([consumed, interactions]);
    expect(guards.length).toBeGreaterThan(0);
    changed = true;
    // This native read, not SSE, discovers the parent report before the older
    // scheduler recovery can commit its report-free inferred completion.
    const current = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    const failed = change === "failed-report" || change === "report-before-idle";
    const expected = failed ? "failed" : change === "hidden-report" ? "running" : "completed";
    expect(current.find(task => task.taskId === worker.taskId)?.status).toBe(expected);
    if (!failed && change !== "hidden-report") expect(guards.every(guard => guard.isCurrent())).toBe(true);
    release(); const published = await events;
    expect(published.status).toBe(expected);
    if (failed) expect(guards.some(guard => !guard.isCurrent())).toBe(true);
    if (failed || change === "same-report") expect(published).toMatchObject({ resultId: "native-parent-result", summary: "Native parent result" });
    else expect(published.resultId).toBeUndefined();
  } finally { release(); abort.abort(); await adapter.dispose(); await pump; await events?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const change of ["stale-cleared", "stale-staged", "unchanged", "newer-change"] as const)
test(`ownerless session lookup cannot claim a collecting visibility read (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, lookups = 0, staged = change === "stale-staged";
  let historyEntered!: () => void, releaseHistory!: () => void, lookupEntered!: () => void, releaseLookup!: () => void;
  const historyPending = new Promise<void>(resolve => { historyEntered = resolve; }), historyHeld = new Promise<void>(resolve => { releaseHistory = resolve; });
  const lookupPending = new Promise<void>(resolve => { lookupEntered = resolve; }), lookupHeld = new Promise<void>(resolve => { releaseLookup = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 }; return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      historyEntered(); await historyHeld;
      return Response.json({ data: [{ id: "child-hidden", type: "user", text: "Visibility suffix", time: { created: 35 } },
        { id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    }
    if (route === `/api/session/${child}`) {
      const body = await response.json(); if (staged) body.data.revert = { messageID: "child-hidden" };
      if (++lookups === 2) { lookupEntered(); await lookupHeld; }
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let read: ReturnType<typeof provider.listMessages> | undefined, ownerless: ReturnType<typeof provider.getSession> | undefined;
  try {
    parent = (await provider.createSession("Explicit visibility read owner")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    read = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void read.catch(() => undefined); await historyPending;
    ownerless = provider.getSession(child); void ownerless.catch(() => undefined); await lookupPending;
    staged = change === "stale-cleared"; releaseHistory();
    const page = await read;
    expect(page.workerSource?.isCurrent()).toBe(true);
    expect(page.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: staged ? "running" : "completed" }));
    releaseLookup(); await ownerless;
    expect(page.workerSource?.isCurrent()).toBe(true);
    if (change === "newer-change") {
      staged = true; await provider.getSession(child);
      expect(page.workerSource?.isCurrent()).toBe(false);
    }
    const current = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(current.workerSource?.isCurrent()).toBe(true);
    expect(current.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: staged ? "running" : "completed" }));
  } finally { releaseHistory(); releaseLookup(); abort.abort(); await read?.catch(() => undefined); await ownerless?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["competing", "unchanged", "append", "other-child", "late-ownerless", "native-count-at-limit", "native-count-over-limit", "native-bytes-below-limit", "native-bytes-over-limit", "native-replacements"] as const)
test(`ownerless parent inventory covers its first pending response (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, otherChild: string | undefined, reads = 0, recovered = false, unknownLookups = 0;
  const bounded = change.startsWith("native-"), saturated = change === "native-count-over-limit" || change === "native-bytes-over-limit";
  let entered!: () => void, release!: () => void, secondEntered!: () => void, releaseSecond!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const secondPending = new Promise<void>(resolve => { secondEntered = resolve; }), secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/session/z") unknownLookups++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++reads;
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "new-parent-launch"; competitor.time = { created: 15 };
      competitor.content[0].id = "new-parent-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (change === "other-child") competitor.content[0].state.metadata.sessionID = otherChild;
      const delayed = change === "late-ownerless" && index === 2;
      const data = [first, ...(index > 1 && !delayed && !bounded && change !== "unchanged" && change !== "append" ? [competitor] : []),
        ...(index > 1 && change === "append" ? [{ id: "ordinary-output", type: "assistant", time: { created: 30 }, content: [{ type: "text", text: "Continued output" }] }] : [])];
      if (bounded && index > 1 && !recovered) data.push({ id: "m", type: "assistant", time: { created: 30 }, content: Array.from({ length: change === "native-count-at-limit" ? 255 : change === "native-count-over-limit" ? 256 : 1 }, (_, item) => ({
        type: "tool", name: "subagent", id: change === "native-bytes-over-limit" ? "x".repeat(32_768) : change === "native-bytes-below-limit" ? "x".repeat(30_000) : change === "native-replacements" ? `n${index}` : `n${item}`,
        state: { metadata: { sessionID: "z" } },
      })) });
      if (index === 1) { entered(); await held; }
      if (delayed) { secondEntered(); await secondHeld; }
      return Response.json({ data, cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    if (route === `/api/session/${otherChild}/message`) return Response.json({ data: [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let older: ReturnType<typeof provider.listMessages> | undefined, delayed: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Pending parent / ownerless inventory")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (change === "other-child") otherChild = fake.launchRequestWorker(parent).childId;
    const unrelated = (await provider.createSession("Independent invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void older.catch(() => undefined); await pending;
    await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    if (change === "late-ownerless") {
      delayed = provider.getReversibleHistoryState!(parent); void delayed.catch(() => undefined); await secondPending;
      await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    }
    await provider.getReversibleHistoryState!(parent);
    if (change === "native-replacements") for (let index = 1; index < 260; index++) {
      await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
      await provider.getReversibleHistoryState!(parent);
    }
    const nativeReads = change === "native-replacements" ? 261 : change === "late-ownerless" ? 3 : 2;
    expect(reads).toBe(nativeReads);
    releaseSecond(); await delayed; release();
    const stale = await older, contradicted = change === "competing" || change === "late-ownerless" || saturated;
    expect(stale.workerSource?.isCurrent()).toBe(!contradicted);
    if (!contradicted) expect(stale.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    await provider.getReversibleHistoryState!(parent);
    expect(reads).toBe(nativeReads);
    expect(unknownLookups).toBe(0); // Provisional native facts never grant child IO.
    recovered = true;
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh).toHaveLength(!bounded && (contradicted || change === "other-child") ? 2 : 1);
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(contradicted && !bounded ? "running" : "completed");
    if (contradicted && !bounded) expect(fresh.every(task => task.status === "running")).toBe(true);
    expect(unknownLookups).toBe(0);
  } finally { release(); releaseSecond(); abort.abort(); await older?.catch(() => undefined); await delayed?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const arrival of ["after-owned", "while-owned-pending", "shared-transport"] as const)
test(`an older ownerless parent response cannot poison newer owned inventory (${arrival})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void, newerEntered!: () => void, releaseNewer!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const newerPending = new Promise<void>(resolve => { newerEntered = resolve; }), newerHeld = new Promise<void>(resolve => { releaseNewer = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++reads;
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "later-parent"; competitor.time = { created: 15 };
      competitor.content[0].id = "later-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (index === 1) { entered(); await held; }
      else if (arrival === "while-owned-pending") { newerEntered(); await newerHeld; }
      return Response.json({ data: index === 1 ? [first] : [first, competitor], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport }), abort = new AbortController();
  let older: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, current: ReturnType<typeof provider.listMessages> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Native parent order")).id; child = fake.launchRequestWorker(parent).childId;
    const unrelated = (await provider.createSession("Independent invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal);
    older = provider.getReversibleHistoryState!(parent); void older.catch(() => undefined); await pending;
    if (arrival !== "shared-transport") await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    current = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void current.catch(() => undefined);
    if (arrival === "while-owned-pending") { await newerPending; release(); await older; releaseNewer(); }
    if (arrival === "shared-transport") release();
    const page = await current;
    expect(page.workerSource?.isCurrent()).toBe(true);
    expect(page.items.filter(item => item.type === "background_task")).toHaveLength(arrival === "shared-transport" ? 1 : 2);
    expect(page.items.filter(item => item.type === "background_task").every(task => task.status === (arrival === "shared-transport" ? "completed" : "running"))).toBe(true);
    release(); await older;
    expect(page.workerSource?.isCurrent()).toBe(true);
    await provider.getReversibleHistoryState!(parent); expect(reads).toBe(arrival === "shared-transport" ? 1 : 2);
    expect(page.workerSource?.isCurrent()).toBe(true);
  } finally { release(); releaseNewer(); abort.abort(); await older?.catch(() => undefined); await current?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["committed-revert", "unchanged", "append", "late-ownerless"] as const)
test(`ownerless reversible history covers the first pending child response (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0, changed = false;
  let entered!: () => void, release!: () => void, wire!: ReadableStreamDefaultController<Uint8Array>, secondEntered!: () => void, releaseSecond!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const secondPending = new Promise<void>(resolve => { secondEntered = resolve; }), secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  const reverted = change === "committed-revert" || change === "late-ownerless";
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      const index = ++reads, first = index === 1, delayed = change === "late-ownerless" && index === 2;
      const data = changed && reverted && !delayed ? [] : [
        { id: "child-input", type: "user", text: "Reverted suffix", time: { created: 15 } },
        { id: "child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" },
        ...(changed && change === "append" ? [{ id: "later-output", type: "assistant", time: { created: 25 }, content: [{ type: "text", text: "Continued output" }] }] : []),
      ];
      if (first) { entered(); await held; }
      if (delayed) { secondEntered(); await secondHeld; }
      return Response.json({ data, cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let older: ReturnType<typeof provider.listMessages> | undefined, pump: Promise<void> | undefined,
    delayed: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined;
  try {
    parent = (await provider.createSession("Pending child / ownerless native read")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelated = (await provider.createSession("Independent reuse invalidation")).id;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
    await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void older.catch(() => undefined);
    await pending;
    // A committed revert's persisted suffix removal is discovered by a native
    // reader, not SSE. An independent fresh recovery invalidates shared reuse.
    changed = true;
    await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    if (change === "late-ownerless") {
      delayed = provider.getReversibleHistoryState!(child); void delayed.catch(() => undefined); await secondPending;
      await provider.reconcileBackgroundTasks!(unrelated, { fresh: true, signal: abort.signal });
    }
    const state = await provider.getReversibleHistoryState!(child);
    expect(state.canUndo).toBe(!reverted);
    expect(reads).toBe(change === "late-ownerless" ? 3 : 2);
    // The older ownerless request returns last and must neither replace the
    // newer cached transcript nor overwrite its pending counterproof slot.
    releaseSecond(); await delayed;
    release();
    const stale = await older;
    expect(stale.workerSource?.isCurrent()).toBe(!reverted);
    if (!reverted) expect(stale.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    // Reuse must still contain the newer transcript, not the late old response.
    expect((await provider.getReversibleHistoryState!(child)).canUndo).toBe(!reverted);
    expect(reads).toBe(change === "late-ownerless" ? 3 : 2);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.status).toBe(reverted ? "running" : "completed");
  } finally { release(); releaseSecond(); abort.abort(); await older?.catch(() => undefined); await delayed?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const arrival of ["after-owned", "while-owned-pending"] as const)
test(`a stale ownerless reversible response cannot revoke later owned child evidence or its reuse (${arrival})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void, newerEntered!: () => void, releaseNewer!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const newerPending = new Promise<void>(resolve => { newerEntered = resolve; }), newerHeld = new Promise<void>(resolve => { releaseNewer = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {}, location: { directory } })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      const first = ++reads === 1;
      if (first) { entered(); await held; }
      else if (arrival === "while-owned-pending") { newerEntered(); await newerHeld; }
      return Response.json({ data: [{ id: "child-idle", type: "idle", time: { created: 20 }, outcome: first ? "succeeded" : "failed" }], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), guards: import("../../provider").WorkerSourceGuard[] = [];
  let older: ReturnType<NonNullable<typeof provider.getReversibleHistoryState>> | undefined, pump: Promise<void> | undefined,
    recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Ownerless overlap ordering")).id; child = fake.launchRequestWorker(parent).childId;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
    await provider.waitForEventStream!(abort.signal);
    older = provider.getReversibleHistoryState!(child); void older.catch(() => undefined); await pending;
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal,
      onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    void recovery.catch(() => undefined);
    if (arrival === "while-owned-pending") { await newerPending; release(); await older; releaseNewer(); }
    const current = await recovery;
    expect(current[0]?.status).toBe("failed"); expect(guards.length).toBeGreaterThan(0);
    release(); await older;
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const reused = await provider.reconcileBackgroundTasks!(parent, { signal: abort.signal });
    expect(reused[0]?.status).toBe("failed"); expect(reads).toBe(2);
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
  } finally { release(); releaseNewer(); abort.abort(); await older?.catch(() => undefined); await recovery?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const outcome of ["terminal", "activity"] as const)
for (const pressure of ["count-at-limit", "count-over-limit", "bytes-below-limit", "bytes-over-limit", "count-replays", "byte-replays"] as const)
test(`prebaseline buffer ${pressure} preserves bounded ${outcome} authority`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, independent: string | undefined, independentChild: string | undefined, heldOnce = false, interrupts = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/interrupt")) interrupts++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: Object.fromEntries([child, independentChild].filter(Boolean).map(id => [id, { status: "running" }])) });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message` || route === `/api/session/${independent}/message`) {
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      if (route === `/api/session/${parent}/message` && !heldOnce) { heldOnce = true; entered(); await held; }
      return Response.json({ data: [first], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: outcome === "terminal"
      ? [{ id: "child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }] : [], cursor: {} });
    if (route === `/api/session/${independentChild}/message`) return Response.json({ data: [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), guards: import("../../provider").WorkerSourceGuard[] = [], independentGuards: import("../../provider").WorkerSourceGuard[] = [];
  let pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Bounded counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    independent = (await provider.createSession("Independent owned worker")).id;
    const other = fake.launchRequestWorker(independent); independentChild = other.childId;
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.buffer-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    const before = await provider.reconcileBackgroundTasks!(independent, { fresh: true, signal: abort.signal,
      onSource: source => independentGuards.push(source.workerSource.retain(abort.signal)) });
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ taskId: other.taskId, status: "running", activity: { kind: "working" }, control: { available: true } });
    expect(workerCanStop(before[0]!)).toBe(true);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal,
      onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    void recovery.catch(() => undefined); await pending;
    // Minimal unrelated tool facts fit 256 entries below the byte cap. Long
    // native message identities cross the byte cap with just one fact; tool
    // input would be hashed and would not exercise retained evidence size.
    const count = pressure === "count-at-limit" ? 256 : pressure === "count-over-limit" ? 257
      : pressure.endsWith("replays") ? 300 : 1;
    const messageID = pressure === "bytes-over-limit" ? "x".repeat(32_768)
      : pressure === "bytes-below-limit" || pressure === "byte-replays" ? "x".repeat(32_000) : "n";
    for (let index = 0; index < count; index++) frame("session.message.content.updated", {
      sessionID: parent, messageID, content: [{ type: "tool", id: pressure.startsWith("count-") && !pressure.endsWith("replays") ? `n${index}` : "n", name: "tool" }],
    });
    frame("diagnostic.buffer-applied", {}); await observed; release();
    const result = await recovery.then(tasks => ({ tasks }), error => ({ error }));
    const saturated = pressure === "count-over-limit" || pressure === "bytes-over-limit";
    expect(guards.length).toBeGreaterThan(0);
    if (saturated) {
      const error = "error" in result ? result.error : undefined;
      expect(error).toBeInstanceOf(Error);
      if (outcome === "terminal") expect(guards.some(guard => !guard.isCurrent())).toBe(true);
      else {
        // Inventory/ownership evidence can remain current, but its later
        // history-only activity publication must fail the retained counterproof.
        expect(error?.message).toBe("Background launch inventory changed during recovery");
      }
    } else {
      const tasks = "tasks" in result ? result.tasks : undefined;
      expect(tasks).toHaveLength(1);
      expect(tasks?.[0]).toMatchObject({ taskId: worker.taskId, status: outcome === "terminal" ? "completed" : "running",
        activity: { kind: outcome === "terminal" ? "ended" : "working" } });
      expect(guards.every(guard => guard.isCurrent())).toBe(true);
    }
    await expect(provider.stopTask!(parent, `v2:${parent}:n0`)).rejects.toMatchObject({ name: "BackgroundTaskUnavailableError" });
    expect(interrupts).toBe(0);
    expect(independentGuards.length).toBeGreaterThan(0);
    expect(independentGuards.every(guard => guard.isCurrent())).toBe(true);
    expect((await provider.getSession(independentChild))?.id).toBe(independentChild);
    const after = await provider.reconcileBackgroundTasks!(independent, { fresh: true, signal: abort.signal });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ taskId: other.taskId, status: "running", activity: { kind: "working", executionId: before[0]?.activity?.executionId }, control: { available: true } });
    expect(workerCanStop(after[0]!)).toBe(true);
  } finally { release(); abort.abort(); await recovery?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const replay of [false, true])
test(`older parent response cannot overwrite a newer read's launch baseline (replay: ${replay})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, parentReads = 0, childReads = 0, competitor: any;
  let wire!: ReadableStreamDefaultController<Uint8Array>, oldEntered!: () => void, childEntered!: () => void,
    releaseOld!: () => void, releaseChild!: () => void, applied!: () => void;
  const oldPending = new Promise<void>(resolve => { oldEntered = resolve; });
  const childPending = new Promise<void>(resolve => { childEntered = resolve; });
  const oldHeld = new Promise<void>(resolve => { releaseOld = resolve; });
  const childHeld = new Promise<void>(resolve => { releaseChild = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0], index = ++parentReads;
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      competitor = structuredClone(first); competitor.id = "newer-launch"; competitor.time = { created: 15 };
      competitor.content[0].id = "newer-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (index === 1) { oldEntered(); await oldHeld; }
      return Response.json({ data: index === 1 ? [first] : [first, competitor], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      if (++childReads === 1) { childEntered(); await childHeld; }
      return Response.json({ data: [{ id: "child-idle", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let pump: Promise<void> | undefined, old: ReturnType<typeof provider.listMessages> | undefined,
    fresh: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  const guards: import("../../provider").WorkerSourceGuard[] = [];
  try {
    parent = (await provider.createSession("Read-owned parent baselines")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId; fake.settleWorker(child, "completed", "No parent report");
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.baseline-replay") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    old = provider.listMessages(parent, { limit: 100, signal: abort.signal }); void old.catch(() => undefined);
    await oldPending;
    fresh = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal, onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    void fresh.catch(() => undefined); await childPending;
    releaseOld(); await old.catch(() => undefined);
    if (replay) {
      frame("session.message.content.updated", { sessionID: parent, messageID: competitor.id, content: competitor.content });
      frame("diagnostic.baseline-replay", {}); await observed;
    }
    releaseChild();
    const result = await fresh;
    expect(result).toHaveLength(2);
    expect(result.find(task => task.taskId === worker.taskId)?.status).toBe("running");
    expect(result.every(task => task.status === "running")).toBe(true);
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const next = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(next).toHaveLength(2);
    expect(next.find(task => task.taskId === worker.taskId)?.status).toBe("running");
  } finally { releaseOld(); releaseChild(); abort.abort(); await old?.catch(() => undefined); await fresh?.catch(() => undefined); await pump; await provider.dispose!(); await fake.stop(); }
}, 10_000);

test("an overlapping stale child read and transport reuse preserve newer owned working activity", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${child}/message`) {
      const first = ++reads === 1;
      if (first) { entered(); await held; }
      return Response.json({ data: first ? [{ id: "stale-boundary", type: "idle", time: { created: Date.now() + 1_000 } }] : [], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const firstAbort = new AbortController(), abort = new AbortController(), guards: import("../../provider").WorkerSourceGuard[] = [];
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, stale: ReturnType<typeof provider.listMessages> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Newer working source ordering")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
    await provider.waitForEventStream!(abort.signal);
    stale = provider.listMessages(child, { limit: 100, signal: abort.signal });
    await reading;
    const current = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal,
      onSource: source => guards.push(source.workerSource.retain(abort.signal)) });
    expect(current).toContainEqual(expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) }));
    release(); await stale;
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const reused = await provider.reconcileBackgroundTasks!(parent, { signal: abort.signal });
    expect(reused).toContainEqual(expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) }));
    expect(reads).toBe(2);
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
  } finally { release(); firstAbort.abort(); abort.abort(); await firstPump; await pump; await stale?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const read of ["provider", "automatic-recovery"] as const)
for (const change of ["completed", "bare-boundary", "append"] as const)
test(`${read} retains activity-only child observation through the final parent lookup (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false, captured = false, heldOnce = false;
  let entered!: () => void, release!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${child}/message`) return Response.json({ data: !changed ? [] : change === "append"
      ? [{ id: "later-assistant", type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Still working" }] }]
      : [{ id: "child-boundary", type: "idle", time: { created: Date.now() + 1_000 }, ...(change === "completed" ? { outcome: "succeeded" } : {}) }], cursor: {} });
    if (route === `/api/session/${parent}` && captured && !heldOnce) { heldOnce = true; entered(); await held; }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = (id, options) => nativeRecovery(id, { ...options, onSource: source => {
    options?.onSource?.(source); captured = true;
  } });
  const adapter = read === "automatic-recovery" ? new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }) : undefined;
  const firstAbort = new AbortController(), abort = new AbortController();
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, pending: Promise<unknown> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Prepublication child observation continuity")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (adapter) pump = adapter.startEventPump();
    else {
      pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
      await provider.waitForEventStream!(abort.signal);
      pending = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    }
    void pending?.catch(() => undefined); await atPublication;
    if (adapter) {
      // Subscribe after startup so this case observes the scheduler itself,
      // without startup's selected-projection history() reconciliation.
      const subscription = await adapter.subscribe(parent, { signal: abort.signal });
      pending = (async () => { for await (const event of subscription.events) {
        if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
      } throw new Error("No automatic worker publication"); })();
      void pending.catch(() => undefined);
    }
    changed = true;
    if (change !== "append") fake.workerObservation(child, false);
    const current = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    expect(current.find(task => task.taskId === worker.taskId)?.activity?.kind).toBe(change === "completed" ? "ended" : change === "bare-boundary" ? "unavailable" : "working");
    release();
    const result = await pending!.then(value => ({ value }), error => ({ error }));
    if (adapter) {
      expect(result).toMatchObject({ value: expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: change === "completed" ? "ended" : change === "bare-boundary" ? "unavailable" : "working" }) }) });
    } else if (change === "append") expect(result).toMatchObject({ value: [expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) })] });
    else expect(result).toMatchObject({ error: expect.any(Error) });
  } finally { release(); firstAbort.abort(); abort.abort(); if (adapter) await adapter.dispose(); else await provider.dispose!(); await firstPump; await pump; await pending?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const read of ["provider-guard", "history", "workerEvidence"] as const)
for (const mutation of ["replay", "changed-facts"] as const)
test(`${read} progresses through repeated requested-child snapshots (${mutation})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, consumed = false, streaming = false, changed = false, updates = 0;
  let requested: any, wire!: ReadableStreamDefaultController<Uint8Array>;
  const explicitRead = new AsyncLocalStorage<boolean>();
  const barriers = new Map<string, () => void>();
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 35, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      requested = structuredClone(first); requested.id = "requested-message"; requested.time = { created: changed ? 15 : 30 };
      const tool = requested.content[0]; tool.id = "requested-call"; tool.time = { created: changed ? 15 : 30, ran: changed ? 16 : 31 };
      tool.state.status = "pending"; tool.state.input.sessionID = child; tool.state.metadata = {};
      return Response.json({ data: [first, requested], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      consumed = true;
      return Response.json({ data: [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    }
    if (route === `/api/session/${parent}` && consumed && streaming && explicitRead.getStore()) {
      const diagnostic = `diagnostic.requested-replay-${++updates}`;
      const observed = new Promise<void>(resolve => { barriers.set(diagnostic, resolve); request.signal.addEventListener("abort", () => resolve(), { once: true }); });
      const content = structuredClone(requested.content);
      if (mutation === "changed-facts") { changed = true; content[0].time = { created: 15, ran: 16 }; }
      // Every attempt overlaps snapshots, so a retry cannot buy quiet output.
      for (let index = 0; index < 3; index++) frame("session.message.content.updated", { sessionID: parent, messageID: requested.id, content });
      frame(diagnostic, {}); await observed;
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeEvents = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) { barriers.get(event.eventType)?.(); yield event; } };
  const adapter = read === "provider-guard" ? undefined : new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 1_000 });
  const abort = new AbortController();
  let pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Requested-child replay progress")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId; fake.settleWorker(child, "completed", "No parent report");
    if (adapter) await adapter.history(parent);
    else { pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })(); await provider.waitForEventStream!(abort.signal); }
    streaming = true;
    if (adapter) {
      const result = await explicitRead.run(true, () => adapter[read === "history" ? "history" : "workerEvidence"](parent!));
      if ("items" in result) expect(result.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: mutation === "replay" ? "completed" : "running" }));
      else {
        expect(result).toMatchObject({ conversationId: parent, complete: true });
        // Compact evidence also includes the pending tool's own dismissal row.
        expect(result.entries).toHaveLength(2);
        expect(result.entries).toContainEqual(expect.objectContaining({ executionId: "worker-dismissal:tool:requested-call", active: false }));
        expect(result.entries.filter(entry => entry.executionId.startsWith("v1:"))).toHaveLength(1);
      }
    } else {
      const guards: import("../../provider").WorkerSourceGuard[] = [];
      const result = await explicitRead.run(true, () => provider.reconcileBackgroundTasks!(parent!, { fresh: true, signal: abort.signal, onSource: source => guards.push(source.workerSource.retain(abort.signal)) }))
        .then(tasks => ({ tasks }), error => ({ error }));
      if (mutation === "replay") {
        expect(result).toMatchObject({ tasks: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] });
        expect(guards.every(guard => guard.isCurrent())).toBe(true);
      } else { expect(result).toMatchObject({ error: expect.any(Error) }); expect(guards.some(guard => !guard.isCurrent())).toBe(true); }
    }
    expect(updates).toBeGreaterThan(0);
  } finally { streaming = false; abort.abort(); await pump; if (adapter) await adapter.dispose(); else await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const path of ["native-read", "stream"] as const)
for (const change of ["competing", "ordinary-output", "other-child"] as const)
test(`returned history-only activity observes ${path} parent launch counterproof (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, other: string | undefined, changed = false, competitor: any;
  let wire!: ReadableStreamDefaultController<Uint8Array>, folded!: (tasks: import("../../types").BackgroundTaskItem[]) => void, release!: () => void, applied!: () => void;
  const returned = new Promise<import("../../types").BackgroundTaskItem[]>(resolve => { folded = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {}); request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") await held;
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      competitor = structuredClone(first); competitor.id = "tied-parent-message"; competitor.content[0].id = "tied-parent-call";
      if (change === "other-child") competitor.content[0].state.metadata.sessionID = other;
      return Response.json({ data: [first, ...(changed && change !== "ordinary-output" ? [competitor] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), nativeEvents = provider.events.bind(provider);
  provider.reconcileBackgroundTasks = async (id, options) => { const tasks = await nativeRecovery(id, options); folded(tasks); return tasks; };
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) {
    if (event.eventType === "diagnostic.parent-counterproof-applied") applied(); yield event;
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const abort = new AbortController(), firstAbort = new AbortController();
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, publication: Promise<import("../../types").BackgroundTaskItem> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Returned activity launch inventory")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (change === "other-child") other = fake.launchRequestWorker(parent).childId;
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    publication = (async () => { for await (const event of subscription.events) {
      if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
    } throw new Error("No activity recovery publication"); })();
    void publication.catch(() => undefined); pump = adapter.startEventPump();
    expect(await returned).toContainEqual(expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) }));
    changed = true;
    if (path === "native-read") {
      const fresh = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
      expect(fresh.find(task => task.taskId === worker.taskId)?.activity?.kind).toBe(change === "competing" ? "session-active" : "working");
    } else {
      frame("session.message.content.updated", { sessionID: parent,
        messageID: change === "ordinary-output" ? "ordinary-parent-output" : competitor.id,
        content: change === "ordinary-output" ? [{ type: "text", text: "Parent output progresses" }] : competitor.content });
      frame("diagnostic.parent-counterproof-applied", {}); await observed;
    }
    release();
    const published = await publication;
    expect(published.activity?.kind).toBe(change === "competing" ? "session-active" : "working");
    expect(published.status).toBe("running"); expect(published.control?.available).not.toBe(true);
  } finally { release(); firstAbort.abort(); abort.abort(); await adapter.dispose(); await firstPump; await pump; await publication?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const read of ["listMessages", "reconcileBackgroundTasks"] as const)
for (const staged of [false, true])
for (const newerParentRead of [false, true])
test(`${read} retains boundary counterproof while its first outcome visibility lookup is pending (${staged}, newer parent: ${newerParentRead})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false, childLookups = 0;
  let entered!: () => void, release!: () => void;
  const pendingLookup = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 }; return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-reverted", type: "user", text: "Reverted suffix", time: { created: 35 } },
      { id: "child-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    if (route === `/api/session/${child}`) {
      const body = await response.json();
      if (changed && staged) body.data.revert = { messageID: "child-reverted" };
      // Verification is the first lookup; hold the first outcome-visibility
      // response after capturing its old null boundary, not the newer response.
      if (++childLookups === 2) { entered(); await held; }
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let older: Promise<unknown> | undefined;
  try {
    parent = (await provider.createSession("First child visibility lookup counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId; fake.settleWorker(child, "completed", "No parent report");
    older = read === "listMessages" ? provider.listMessages(parent, { limit: 100, signal: abort.signal })
      : provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    void older.catch(() => undefined); await pendingLookup;
    changed = true;
    expect(await provider.getSession(child)).not.toBeNull();
    const current = newerParentRead ? await provider.listMessages(parent, { limit: 100, signal: abort.signal }) : undefined;
    if (current) {
      expect(current.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: staged ? "running" : "completed" }));
      expect(current.workerSource?.isCurrent()).toBe(true);
    }
    release();
    const result = await older.then(value => ({ value }), error => ({ error }));
    if (read === "listMessages" && "value" in result) expect((result.value as Awaited<ReturnType<typeof provider.listMessages>>).workerSource?.isCurrent()).toBe(!staged);
    else if (staged) expect(result).toMatchObject({ error: expect.any(Error) });
    else expect(result).toMatchObject({ value: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] });
    const fresh = current ?? await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(fresh.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: staged ? "running" : "completed" }));
    expect(fresh.workerSource?.isCurrent()).toBe(true);
  } finally { release(); abort.abort(); await older?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["terminal", "append", "unrelated-terminal"] as const)
test(`automatic recovery fences ${change} after returning generation-2 history-only activity`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, ended = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, folded!: (tasks: import("../../types").BackgroundTaskItem[]) => void, release!: () => void, applied!: () => void;
  const returned = new Promise<import("../../types").BackgroundTaskItem[]>(resolve => { folded = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: Date.now(), location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") await held;
    const response = await fetch(request);
    if (route === `/api/session/${child}/message`) return Response.json({ data: ended
      ? [{ id: "terminal-boundary", type: "idle", time: { created: Date.now() + 1_000 } }] : [], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), nativeEvents = provider.events.bind(provider);
  provider.reconcileBackgroundTasks = async (id, options) => { const tasks = await nativeRecovery(id, options); folded(tasks); return tasks; };
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) {
    if (event.eventType === "diagnostic.post-return-applied") applied(); yield event;
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const abort = new AbortController(), firstAbort = new AbortController();
  let firstPump: Promise<void> | undefined, pump: Promise<void> | undefined, publication: Promise<import("../../types").BackgroundTaskItem> | undefined;
  try {
    firstPump = (async () => { for await (const _event of provider.events(firstAbort.signal)) {} })();
    await provider.waitForEventStream!(firstAbort.signal); firstAbort.abort(); await firstPump;
    parent = (await provider.createSession("Post-return activity authority")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    publication = (async () => { for await (const event of subscription.events) {
      if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
    } throw new Error("No automatic recovery publication"); })();
    void publication.catch(() => undefined);
    pump = adapter.startEventPump();
    expect(await returned).toContainEqual(expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) }));
    if (change === "terminal") { ended = true; fake.workerObservation(child, false); }
    if (change === "append") frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: "Still working" }] });
    else frame("session.execution.succeeded", { sessionID: change === "terminal" ? child : "unrelated-child" });
    frame("diagnostic.post-return-applied", {}); await observed; release();
    const published = await publication;
    expect(published.activity?.kind).toBe(change === "terminal" ? "unavailable" : "working");
    expect(published.status).toBe("running"); expect(published.control?.available).not.toBe(true);
  } finally { release(); firstAbort.abort(); abort.abort(); await adapter.dispose(); await firstPump; await pump; await publication?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const parentReport of [false, true])
test(`automatic recovery replaces an admitted history-only outcome but preserves parent reports (${parentReport})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, admitted!: () => void, updated!: () => void;
  const initial = new Promise<void>(resolve => { admitted = resolve; });
  const later = new Promise<void>(resolve => { updated = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "competing-message"; competitor.time = { created: 15 };
      competitor.content[0].id = "competing-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      return Response.json({ data: [first,
        ...(parentReport ? [{ id: "parent-result", type: "synthetic", time: { created: 13 }, text: "Explicit parent report", metadata: { source: "subagent", childID: child, state: "completed" } }] : []),
        ...(changed ? [competitor] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), abort = new AbortController();
  let pump: Promise<void> | undefined, events: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Already-admitted scheduler outcome")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No inferred parent report");
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    events = (async () => { for await (const event of subscription.events) {
      if (event.type !== "item.upsert" || event.item.type !== "background_task") continue;
      if (event.item.taskId === worker.taskId && event.item.status === "completed") admitted();
      if (event.item.toolUseId === "competing-call") updated();
    } })();
    pump = adapter.startEventPump(); await initial;
    changed = true;
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(parentReport ? "completed" : "running");
    // A public ordinary-output event requests automatic recovery, not history().
    frame("session.message.content.updated", { sessionID: parent, messageID: "ordinary-output", content: [{ type: "text", text: "Keep progressing" }] });
    await later;
    const current = (await adapter.subscribe(parent, { signal: abort.signal })).snapshot.items.find(item => item.type === "background_task" && item.taskId === worker.taskId);
    expect(current).toMatchObject({ type: "background_task", status: parentReport ? "completed" : "running", stateUncertain: !parentReport });
    if (parentReport) expect(current).toMatchObject({ resultId: "parent-result", summary: "Explicit parent report" });
    else expect(current).toMatchObject({ activity: { kind: "unavailable" }, control: { available: false } });
  } finally { abort.abort(); await adapter.dispose(); await pump; await events; await fake.stop(); }
}, 10_000);

for (const change of ["remove", "alter", "append"] as const)
test(`a direct child history ${change} observes consumed parent outcome counterproof before SSE`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 }; return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      ...(changed && change === "remove" ? [] : [{ id: "child-outcome", type: "idle", time: { created: 40 }, outcome: changed && change === "alter" ? "failed" : "succeeded" }]),
      ...(changed && change === "append" ? [{ id: "later-assistant", type: "assistant", time: { created: 50 }, content: [{ type: "text", text: "Continued output" }] }] : []),
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  try {
    parent = (await provider.createSession("Direct child outcome counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    const earlier = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(earlier.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    expect(earlier.workerSource?.isCurrent()).toBe(true);
    changed = true;
    await provider.listMessages(child, { limit: 100, signal: abort.signal });
    expect(earlier.workerSource?.isCurrent()).toBe(change === "append");
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh[0]?.status).toBe(change === "remove" ? "running" : change === "alter" ? "failed" : "completed");
  } finally { abort.abort(); await provider.dispose!(); await fake.stop(); }
});

for (const change of ["revert", "append", "parent-report", "reconnect", "interaction-error"] as const)
test(`automatic recovery retains consumed outcomes through pending interactions (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false;
  let folded!: () => void, interactionsEntered!: () => void, release!: () => void;
  const consumed = new Promise<void>(resolve => { folded = resolve; });
  const interactions = new Promise<void>(resolve => { interactionsEntered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const leases: AbortSignal[] = [], released: Promise<void>[] = [];
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") {
      interactionsEntered(); await held;
      if (change === "interaction-error" && changed) return new Response(null, { status: 503 });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      if (change === "parent-report") body.data.push({ id: "parent-result", type: "synthetic", time: { created: 45 },
        text: "Explicit parent report", metadata: { source: "subagent", childID: child, state: "completed" } });
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-reverted", type: "user", text: "Reversible suffix", time: { created: 35 } },
      { id: "child-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      ...(changed && change === "append" ? [{ id: "later-assistant", type: "assistant", time: { created: 50 }, content: [{ type: "text", text: "Continued child output" }] }] : []),
    ], cursor: {} });
    if (changed && change !== "append" && route === `/api/session/${child}`) {
      const body = await response.json(); body.data.revert = { messageID: "child-reverted" }; return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = async (id, options) => {
    const tasks = await nativeRecovery(id, options?.onSource ? { ...options, onSource: source => options.onSource!({ ...source, workerSource: {
      isCurrent: source.workerSource.isCurrent,
      retain: signal => {
        leases.push(signal);
        released.push(signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })));
        return source.workerSource.retain(signal);
      },
    } }) } : options);
    folded(); return tasks;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const abort = new AbortController();
  let pump: Promise<void> | undefined, events: Promise<import("../../types").BackgroundTaskItem> | undefined;
  try {
    parent = (await provider.createSession("Automatic outcome handoff")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No inferred parent report");
    const subscription = await adapter.subscribe(parent, { signal: abort.signal });
    events = (async () => { for await (const event of subscription.events) {
      if (event.type === "item.upsert" && event.item.type === "background_task" && event.item.taskId === worker.taskId) return event.item;
    } throw new Error("Recovery subscription ended before publication"); })();
    void events.catch(() => undefined);
    pump = adapter.startEventPump();
    await Promise.all([consumed, interactions]);
    changed = true;
    const current = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    const status = change === "append" || change === "parent-report" ? "completed" : "running";
    expect(current.find(task => task.taskId === worker.taskId)?.status).toBe(status);
    if (change === "reconnect") {
      await adapter.stopEventPump();
      await Promise.all(released);
      expect(leases.every(signal => signal.aborted)).toBe(true);
    }
    release();
    if (change === "reconnect") pump = adapter.startEventPump();
    const published = await events;
    expect(published.status).toBe(status);
    if (change === "parent-report") expect(published).toMatchObject({ resultId: "parent-result", summary: "Explicit parent report" });
    if (leases.length) {
      await Promise.all(released);
      expect(leases.every(signal => signal.aborted)).toBe(true);
    }
  } finally { release(); abort.abort(); await adapter.dispose(); await pump; await events?.catch(() => undefined); await fake.stop(); }
}, 10_000);

test("an overlapping older parent history cannot revoke the later consumed launch inventory", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const firstRead = ++reads === 1, body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "competing-parent"; competitor.time = { created: 15 };
      competitor.content[0].id = "competing-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (firstRead) { entered(); await held; }
      return Response.json({ data: [first, ...(firstRead ? [] : [competitor])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let pump: Promise<void> | undefined, older: ReturnType<typeof provider.listMessages> | undefined;
  try {
    parent = (await provider.createSession("Overlapping parent observations")).id;
    child = fake.launchRequestWorker(parent).childId; fake.settleWorker(child, "completed", "No parent report");
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.parent-output-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal });
    await reading;
    frame("session.message.content.updated", { sessionID: parent, messageID: "ordinary-output", content: [{ type: "text", text: "Parent streaming" }] });
    frame("diagnostic.parent-output-applied", {}); await observed;
    const current = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(current.items.filter(item => item.type === "background_task")).toHaveLength(2);
    expect(current.items.filter(item => item.type === "background_task").every(item => item.status === "running")).toBe(true);
    expect(current.workerSource?.isCurrent()).toBe(true);
    release();
    const stale = await older;
    expect(stale.workerSource?.isCurrent()).toBe(false);
    expect(current.workerSource?.isCurrent()).toBe(true);
  } finally { release(); abort.abort(); await pump; await older?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
});

for (const read of ["retained-source", "adapter-history"] as const)
for (const change of ["competing-launch", "parent-output", "child-output", "different-child"] as const)
test(`${read} observes later parent history ${change} before SSE without requiring quiet output`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, otherChild: string | undefined, changed = false, armed = false, heldOnce = false;
  let entered!: () => void, release!: () => void;
  const atHandoff = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first); competitor.id = "observed-parent-launch"; competitor.time = { created: 15 };
      competitor.content[0].id = "observed-parent-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      if (change === "different-child") competitor.content[0].state.metadata.sessionID = otherChild;
      return Response.json({ data: [first,
        ...(changed && (change === "competing-launch" || change === "different-child") ? [competitor] : []),
        ...(changed && change === "parent-output" ? [{ id: "later-parent-output", type: "assistant", time: { created: 30 }, content: [{ type: "text", text: "Parent output" }] }] : []),
      ], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" },
      ...(changed && change === "child-output" ? [{ id: "later-child-output", type: "assistant", time: { created: 30 }, content: [{ type: "text", text: "Child output" }] }] : []),
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider), abort = new AbortController();
  const sources: import("../../provider").WorkerSourceGuard[] = [];
  provider.reconcileBackgroundTasks = async (id, options) => {
    const tasks = await nativeRecovery(id, { ...options, onSource: source => {
      options?.onSource?.(source);
      if (armed) sources.push(source.workerSource.retain(abort.signal));
    } });
    if (armed && !heldOnce) { heldOnce = true; entered(); await held; }
    return tasks;
  };
  const adapter = read === "adapter-history" ? new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }) : undefined;
  let pending: Promise<unknown> | undefined;
  try {
    parent = (await provider.createSession("Observed parent inventory counterproof")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    if (change === "different-child") { otherChild = fake.launchRequestWorker(parent).childId; fake.settleWorker(otherChild, "completed", "No unrelated report"); }
    if (adapter) expect((await adapter.history(parent)).items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    armed = true;
    pending = adapter ? adapter.history(parent) : provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    void pending.catch(() => undefined);
    await atHandoff;
    expect(sources.every(source => source.isCurrent())).toBe(true);
    changed = true;
    const fresh = await nativeRecovery(parent, { fresh: true, signal: abort.signal });
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(change === "competing-launch" ? "running" : "completed");
    release();
    if (adapter) {
      const snapshot = await pending as Awaited<ReturnType<ChatAdapter["history"]>>;
      expect(snapshot.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: change === "competing-launch" ? "running" : "completed" }));
    } else await pending;
    expect(sources.every(source => source.isCurrent())).toBe(change !== "competing-launch");
  } finally { release(); abort.abort(); await pending?.catch(() => undefined); if (adapter) await adapter.dispose(); else await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const read of ["listMessages", "reconcileBackgroundTasks", "adapter-history"] as const)
for (const change of read === "adapter-history" ? ["competing-launch", "ordinary-output"] as const : ["competing-launch", "ordinary-output", "replay"] as const)
for (const cachedTerminal of read === "adapter-history" && change === "competing-launch" ? [false, true] : [false])
for (const parentReport of cachedTerminal ? [false, true] : [false])
test(`${read} fences ${change} in the consumed parent launch inventory (cached terminal: ${cachedTerminal}, parent report: ${parentReport})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, armed = false, heldOnce = false, changed = false;
  let first: any, competitor: any;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 30, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); first = body.data[0]; first.time = { created: 10 };
      first.content[0].time = { created: 10, ran: 11, completed: 12 };
      competitor = structuredClone(first); competitor.id = "competing-parent-message"; competitor.time = { created: 15 };
      competitor.content[0].id = "competing-call"; competitor.content[0].time = { created: 15, ran: 16, completed: 25 };
      return Response.json({ data: [first,
        ...(parentReport ? [{ id: "parent-result", type: "synthetic", time: { created: 13 }, text: "Explicit parent report", metadata: { source: "subagent", childID: child, state: "completed" } }] : []),
        ...(changed ? [competitor] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      if (armed && !heldOnce) { heldOnce = true; entered(); await held; }
      return Response.json({ data: armed || cachedTerminal ? [{ id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" }] : [], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeEvents = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of nativeEvents(signal)) {
    if (event.eventType === "diagnostic.parent-change-applied") applied();
    yield event;
  } };
  const abort = new AbortController();
  const adapter = read === "adapter-history" ? new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }) : undefined;
  let pump: Promise<void> | undefined, recovery: Promise<any> | undefined;
  try {
    parent = (await provider.createSession("Parent competition publication race")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    if (adapter) {
      const warm = await adapter.history(parent);
      expect(warm.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: cachedTerminal ? "completed" : "running" }));
    }
    else {
      pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
      await provider.waitForEventStream!(abort.signal);
    }
    // A native ordinary update expires only transport reuse, not outcome proof.
    frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: "Output" }] });
    frame("diagnostic.parent-change-applied", {}); await observed;
    armed = true;
    recovery = read === "listMessages" ? provider.listMessages(parent, { limit: 100, signal: abort.signal })
      : adapter ? adapter.history(parent) : provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    void recovery.catch(() => undefined);
    await atPublication;
    changed = change === "competing-launch";
    const processed = new Promise<void>(resolve => { applied = resolve; });
    frame("session.message.content.updated", { sessionID: parent,
      messageID: change === "ordinary-output" ? "ordinary-assistant" : changed ? competitor.id : first.id,
      content: change === "ordinary-output" ? [{ type: "text", text: "Parent output continues" }] : changed ? competitor.content : first.content });
    frame("diagnostic.parent-change-applied", {}); await processed; release();
    const result = await recovery.then(value => ({ value }), error => ({ error }));
    if ("value" in result) {
      const tasks = Array.isArray(result.value) ? result.value : result.value.items.filter((item: any) => item.type === "background_task");
      if (changed && read === "listMessages") expect(result.value.workerSource.isCurrent()).toBe(false);
      else expect(tasks.find((task: any) => task.taskId === worker.taskId)?.status).toBe(changed && !parentReport ? "running" : "completed");
      if (parentReport) expect(tasks.find((task: any) => task.taskId === worker.taskId)).toMatchObject({ resultId: "parent-result", summary: "Explicit parent report" });
    } else { expect(change).toBe("competing-launch"); expect(result.error).toBeInstanceOf(Error); }
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh).toHaveLength(changed ? 2 : 1);
    expect(fresh.find(task => task.taskId === worker.taskId)?.status).toBe(changed && !parentReport ? "running" : "completed");
  } finally { release(); abort.abort(); await pump; await recovery?.catch(() => undefined); if (adapter) await adapter.dispose(); else await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const change of ["finished", "append"] as const)
test(`reconnected history-only activity observes ${change} after outcome-free child history consumption`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, captured = false, finished = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: Date.now(), location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${child}/message`) return Response.json({ data: finished
      ? [{ id: "child-boundary", type: "idle", time: { created: Date.now() + 1_000 } }] : [], cursor: {} });
    if (route === `/api/session/${parent}` && captured) { entered(); await held; }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), initialAbort = new AbortController();
  let pump: Promise<void> | undefined, initialPump: Promise<void> | undefined;
  let recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    initialPump = (async () => { for await (const _event of provider.events(initialAbort.signal)) {} })();
    await provider.waitForEventStream!(initialAbort.signal);
    initialAbort.abort(); await initialPump;
    parent = (await provider.createSession("Reconnect history-only activity race")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.activity-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal, onSource: () => { captured = true; } });
    void recovery.catch(() => undefined);
    await atPublication;
    if (change === "finished") {
      finished = true; fake.settleWorker(child, "completed", "No parent report");
      frame("session.execution.succeeded", { sessionID: child });
    } else frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: "Working output" }] });
    frame("diagnostic.activity-applied", {});
    await observed; release();
    const raced = await recovery.then(tasks => ({ tasks }), error => ({ error }));
    if (change === "append") expect(raced).toMatchObject({ tasks: [expect.objectContaining({ taskId: worker.taskId, activity: expect.objectContaining({ kind: "working", generation: 2 }) })] });
    else if ("tasks" in raced) expect(raced.tasks.every(task => task.activity?.kind !== "working")).toBe(true);
    else expect(raced.error).toBeInstanceOf(Error);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal: abort.signal });
    expect(fresh[0]?.activity?.kind).toBe(change === "finished" ? "unavailable" : "working");
    expect(fresh[0]?.control?.available).not.toBe(true);
  } finally { release(); initialAbort.abort(); abort.abort(); await initialPump; await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const directChild of [false, true])
test(`an overlapping older child response cannot revoke the later consumed history source (direct child: ${directChild})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reads = 0;
  let entered!: () => void, release!: () => void;
  let wire!: ReadableStreamDefaultController<Uint8Array>, applied!: () => void;
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 50, location: { directory } })}\n\n`));
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      const first = ++reads === 1;
      if (first) { entered(); await held; }
      return Response.json({ data: [{ id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: first ? "succeeded" : "failed" }], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController();
  let older: ReturnType<typeof provider.listMessages> | undefined;
  let pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Overlapping child snapshots")).id;
    child = fake.launchRequestWorker(parent).childId; fake.settleWorker(child, "completed", "No parent report");
    pump = (async () => { for await (const event of provider.events(abort.signal)) if (event.eventType === "diagnostic.append-applied") applied(); })();
    await provider.waitForEventStream!(abort.signal);
    older = provider.listMessages(parent, { limit: 100, signal: abort.signal });
    await reading;
    frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: "Continued output" }] });
    frame("diagnostic.append-applied", {});
    await observed;
    const current = await provider.listMessages(directChild ? child : parent, { limit: 100, signal: abort.signal });
    if (!directChild) expect(current.items).toContainEqual(expect.objectContaining({ type: "background_task", status: "failed" }));
    expect(current.workerSource?.isCurrent()).toBe(true);
    release();
    const stale = await older;
    expect(stale.workerSource?.isCurrent()).toBe(false);
    expect(current.workerSource?.isCurrent()).toBe(true);
  } finally { release(); abort.abort(); await pump; await older?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
});

for (const change of ["remove", "alter", "append"] as const)
test(`a later nonoverlapping child history ${change} fences only changed consumed outcome evidence`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      body.data.push({ id: "parent-hidden", type: "user", text: "Staged suffix", time: { created: 60 } });
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      ...(changed && change === "remove" ? [] : [{ id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: changed && change === "alter" ? "failed" : "succeeded" }]),
      ...(changed && change === "append" ? [{ id: "later-assistant", type: "assistant", time: { created: 50 }, content: [{ type: "text", text: "Continued output" }] }] : []),
    ], cursor: {} });
    if (route === `/api/session/${parent}`) {
      const body = await response.json(); body.data.revert = { messageID: "parent-hidden" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  try {
    parent = (await provider.createSession("Observed committed child history")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    // Both child session lookups have a null revert boundary. No SSE is sent.
    const raced = await provider.reconcileBackgroundTasks!(parent, { fresh: true, onSource: () => { changed = true; } })
      .then(tasks => ({ tasks }), error => ({ error }));
    if (change === "append") expect(raced).toMatchObject({ tasks: [expect.objectContaining({ taskId: worker.taskId, status: "completed" })] });
    else if ("tasks" in raced) expect(raced.tasks).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: change === "alter" ? "failed" : "running" }));
    else expect(raced.error).toBeInstanceOf(Error);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ taskId: worker.taskId, status: change === "remove" ? "running" : change === "alter" ? "failed" : "completed" });
    expect(fresh[0]?.control?.available).not.toBe(true);
  } finally { await provider.dispose!(); await fake.stop(); }
});

for (const read of ["history", "workerEvidence"] as const)
test(`covered ${read} finishes while a consumed child keeps appending output`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, consumed = false, streaming = false, outputUpdates = 0;
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const barriers = new Map<string, () => void>();
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 50, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      consumed = true;
      return Response.json({ data: [{ id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    }
    if (route === `/api/session/${parent}` && consumed && streaming) {
      // Every attempt overlaps output. A retry cannot buy a quiet child.
      const sequence = ++outputUpdates, diagnostic = `diagnostic.output-applied-${sequence}`;
      const observed = new Promise<void>(resolve => {
        barriers.set(diagnostic, resolve);
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      frame("session.message.content.updated", { sessionID: child, messageID: "later-assistant", content: [{ type: "text", text: `Output ${sequence}` }] });
      frame(diagnostic, {});
      await observed;
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    barriers.get(event.eventType)?.();
    yield event;
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 1_000 });
  try {
    parent = (await provider.createSession("Covered streaming child")).id;
    child = fake.launchRequestWorker(parent).childId;
    fake.settleWorker(child, "completed", "No parent report");
    await adapter.history(parent);
    streaming = true;
    const result = await adapter[read](parent);
    expect(outputUpdates).toBeGreaterThan(0);
    if ("items" in result) expect(result.items).toContainEqual(expect.objectContaining({ type: "background_task", status: "completed" }));
    else { expect(result.complete).toBe(true); expect(result.entries).toHaveLength(1); }
  } finally { await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const mutation of ["append", "alter-outcome", "remove", "revert"] as const)
test(`consumed child outcomes allow ${mutation} progress only when their proof is unchanged`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, consumed = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const publication = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 50, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(); body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      consumed = true;
      return Response.json({ data: [{ id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    }
    if (route === `/api/session/${parent}` && consumed) { entered(); await publication; }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  let pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Streaming resumed child")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    pump = (async () => { for await (const event of provider.events(signal)) if (event.eventType === "diagnostic.mutation-applied") applied(); })();
    await provider.waitForEventStream!(signal);
    const sources: import("../../provider").WorkerSourceGuard[] = [];
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal, onSource: source => sources.push(source.workerSource.retain(signal)) });
    void recovery.catch(() => undefined);
    await atPublication;
    if (mutation === "append") {
      // A later assistant message and successive streaming snapshots leave the
      // older typed idle outcome and its execution interval untouched.
      for (const text of ["New", "New output", "New output continues"]) frame("session.message.content.updated", {
        sessionID: child, messageID: "later-assistant", content: [{ type: "text", text }],
      });
    } else if (mutation === "alter-outcome") frame("session.message.content.updated", {
      sessionID: child, messageID: "idle-outcome", content: [{ type: "text", text: "Replacement" }],
    });
    else if (mutation === "remove") frame("session.revert.committed", { sessionID: child, to: "idle-outcome" });
    else frame("session.revert.staged", { sessionID: child, revert: { messageID: "idle-outcome" } });
    frame("diagnostic.mutation-applied", {});
    await observed; release();
    if (mutation === "append") {
      expect(await recovery).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
      expect(sources.every(source => source.isCurrent())).toBe(true);
    } else await expect(recovery).rejects.toThrow();
  } finally { release(); abort.abort(); await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

test("an observed child staged revert between inventory and parent visibility cannot retain an earlier outcome", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, staged = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      body.data.push({ id: "parent-hidden", type: "user", text: "Hidden suffix", time: { created: 60 } });
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-hidden", type: "user", text: "Reverted input", time: { created: 35 } },
      { id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    if (route === `/api/session/${parent}` || route === `/api/session/${child}`) {
      const body = await response.json();
      if (route === `/api/session/${parent}`) body.data.revert = { messageID: "parent-hidden" };
      else if (staged) body.data.revert = { messageID: "child-hidden" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  try {
    parent = (await provider.createSession("Observed child visibility race")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    const raced = await provider.reconcileBackgroundTasks!(parent, { fresh: true, onSource: () => { staged = true; } })
      .then(tasks => ({ tasks }), error => ({ error }));
    // No SSE event is sent: the fresh native lookup itself observes the change.
    if ("tasks" in raced) {
      expect(raced.tasks).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: true }));
      expect(raced.tasks[0]?.control?.available).not.toBe(true);
    } else expect(raced.error).toBeInstanceOf(Error);
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(fresh).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: true }));
    expect(fresh[0]?.control?.available).not.toBe(true);
  } finally { await provider.dispose!(); await fake.stop(); }
});

for (const scope of ["dependent", "unrelated"] as const)
test(`an outcome first consumed by a staged parent visibility reread fences ${scope} mutation through publication`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, captured = false, outcome = false, consumed = false, reverted = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, completed!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const publication = new Promise<void>(resolve => { release = resolve; });
  const executionApplied = new Promise<void>(resolve => { completed = resolve; });
  const revertApplied = new Promise<void>(resolve => { applied = resolve; });
  const frame = (type: string, data: unknown, created = 50) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      body.data[0].time = { created: 20 };
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      body.data.push({ id: "parent-hidden", type: "user", text: "Hidden suffix", time: { created: 60 } });
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      if (outcome) consumed = true;
      return Response.json({ data: outcome && !reverted ? [
        { id: "child-reverted", type: "user", text: "Reversible input", time: { created: 35 } },
        { id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      ] : [], cursor: {} });
    }
    if (route === `/api/session/${parent}`) {
      if (captured) await executionApplied;
      if (consumed) { entered(); await publication; }
      const body = await response.json(); body.data.revert = { messageID: "parent-hidden" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  let pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Late visibility outcome")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const unrelatedParent = (await provider.createSession("Unrelated visibility source")).id;
    const unrelatedChild = fake.launchRequestWorker(unrelatedParent).childId;
    pump = (async () => { for await (const event of provider.events(signal)) {
      if (event.eventType === "diagnostic.execution-applied") completed();
      if (event.eventType === "diagnostic.revert-applied") applied();
    } })();
    await provider.waitForEventStream!(signal);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal, onSource: () => {
      if (captured) return;
      captured = true; outcome = true;
      frame("session.execution.succeeded", { sessionID: child }, 40);
      frame("diagnostic.execution-applied", {});
    } });
    void recovery.catch(() => undefined);
    await atPublication;
    reverted = scope === "dependent";
    frame("session.revert.committed", { sessionID: scope === "dependent" ? child : unrelatedChild, to: "child-reverted" });
    frame("diagnostic.revert-applied", {});
    await revertApplied; release();
    if (scope === "dependent") {
      const result = await recovery.then(tasks => ({ tasks }), error => ({ error }));
      expect(result).toMatchObject({ error: expect.any(Error) });
    }
    else expect(await recovery).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ taskId: worker.taskId, status: scope === "dependent" ? "running" : "completed" });
    expect(fresh[0]?.control?.available).not.toBe(true);
  } finally { release(); abort.abort(); await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

test("fresh parent outcomes follow child staged, cleared and committed visibility", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined;
  let visibility: "staged" | "cleared" | "committed" = "staged";
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-kept", type: "user", time: { created: 10 }, text: "Kept prefix" },
      ...(visibility === "committed" ? [] : [
        { id: "child-reverted", type: "user", time: { created: 35 }, text: "Staged suffix" },
        { id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      ]),
    ], cursor: {} });
    if (route === `/api/session/${child}`) {
      const body = await response.json();
      if (visibility === "staged") body.data.revert = { messageID: "child-reverted" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  try {
    parent = (await provider.createSession("Child visibility outcome recovery")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "No parent report");
    const read = async (status: "running" | "completed") => {
      const tasks = await provider.reconcileBackgroundTasks!(parent!, { fresh: true });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ taskId: worker.taskId, status, stateUncertain: status === "running" });
      expect(tasks[0]?.control?.available).not.toBe(true);
      expect(tasks[0]?.resultId).toBeUndefined();
      expect(tasks[0]?.summary).toBeUndefined();
    };
    await read("running");
    visibility = "cleared";
    await read("completed");
    visibility = "staged";
    await read("running");
    visibility = "committed";
    await read("running");
  } finally { await provider.dispose!(); await fake.stop(); }
});

for (const scope of ["dependent", "unrelated"] as const)
for (const lifecycle of ["committed", "staged", "cleared"] as const)
test(`a ${scope} child revert ${lifecycle} after history consumption fences only dependent parent publication`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, consumed = false, reverted = false, held = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const atPublication = new Promise<void>(resolve => { entered = resolve; });
  const publication = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      body.data[0].content[0].time = { created: 20, ran: 20, completed: 30 };
      return Response.json(body);
    }
    if (route === `/api/session/${child}/message`) {
      consumed = true;
      return Response.json({ data: reverted && lifecycle === "committed" ? [] : [
        { id: "child-reverted", type: "user", time: { created: 35 }, text: "Reversible child input" },
        { id: "idle-outcome", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      ], cursor: {} });
    }
    if (route === `/api/session/${child}`) {
      const body = await response.json();
      if (reverted && lifecycle === "staged" || scope === "dependent" && !reverted && lifecycle === "cleared") {
        body.data.revert = { messageID: "child-reverted" };
      }
      return Response.json(body);
    }
    // This lookup is reached only after the child transcript has been folded.
    // Holding the child response itself would not exercise publication leases.
    if (route === `/api/session/${parent}` && consumed && !held) {
      held = true; entered(); await publication;
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  let pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    parent = (await provider.createSession("Consumed outcome publication fence")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    fake.settleWorker(child, "completed", "Do not invent a parent report");
    const unrelatedParent = (await provider.createSession("Independent recovery source")).id;
    const unrelatedChild = fake.launchRequestWorker(unrelatedParent).childId;
    pump = (async () => { for await (const event of provider.events(signal)) if (event.eventType === "diagnostic.revert-applied") applied(); })();
    await provider.waitForEventStream!(signal);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal });
    void recovery.catch(() => undefined);
    await atPublication;
    reverted = scope === "dependent";
    const changedChild = scope === "dependent" ? child : unrelatedChild;
    for (const event of [
      { id: "event-child-reverted", type: `session.revert.${lifecycle}`, created: 50, durable: { aggregateID: changedChild, seq: 1, version: 1 }, data: {
        sessionID: changedChild, ...(lifecycle === "committed" ? { to: "child-reverted" } : lifecycle === "staged" ? { revert: { messageID: "child-reverted" } } : {}),
      } },
      { type: "diagnostic.revert-applied", data: {} },
    ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory } })}\n\n`));
    await observed; release();
    if (scope === "dependent") await expect(recovery).rejects.toThrow();
    else expect(await recovery).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed", stateUncertain: false }));
    const fresh = await provider.reconcileBackgroundTasks!(parent, { fresh: true, signal });
    expect(fresh).toHaveLength(1);
    const unresolved = scope === "dependent" && lifecycle !== "cleared";
    expect(fresh[0]).toMatchObject({ taskId: worker.taskId, status: unresolved ? "running" : "completed", stateUncertain: unresolved });
    expect(fresh[0]?.control?.available).not.toBe(true);
    expect(fresh[0]?.resultId).toBeUndefined();
    expect(fresh[0]?.summary).toBeUndefined();
  } finally { release(); abort.abort(); await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);
