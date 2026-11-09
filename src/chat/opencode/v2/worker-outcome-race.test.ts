import { expect, test } from "bun:test";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";
import { ChatAdapter } from "../../adapter";

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

test("an overlapping older child response cannot revoke the later consumed history source", async () => {
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
    const current = await provider.listMessages(parent, { limit: 100, signal: abort.signal });
    expect(current.items).toContainEqual(expect.objectContaining({ type: "background_task", status: "failed" }));
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
