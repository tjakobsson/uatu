import { expect, test } from "bun:test";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";
import { ChatAdapter } from "../../adapter";

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
