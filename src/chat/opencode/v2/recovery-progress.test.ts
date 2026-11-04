import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { ChatAdapter } from "../../adapter";
import { createOpenCodeV2Provider } from "./provider";

const WORKSPACE = "/ws";
const fixture = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/opencode-v2/background-2.0.29.json", import.meta.url), "utf8"));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const session = (id: string, parentID?: string) => ({ id, projectID: "global", title: id,
  location: { directory: WORKSPACE }, time: { created: 1, updated: 2 }, ...(parentID ? { parentID } : {}) });

// Use the pinned native client through its fetch seam, not a replacement
// provider or adapter. Only ownership-pressure transports ignore cancellation.
function recoveryScenario(options: { boundRetries?: boolean } = {}) {
  const held = Array.from({ length: 4 }, () => ({ ...gate(), signal: undefined as AbortSignal | undefined }));
  const capacity = gate(), excess = gate(), releaseExcess = gate();
  const startup = new AsyncLocalStorage<boolean>(), startupEntered = gate(), releaseStartup = gate();
  let wire!: ReadableStreamDefaultController<Uint8Array>, eventSequence = 0;
  const eventBarriers = new Map<string, () => void>();
  let pressureEntered = 0, opened = 0, closed = 0, refreshing = false;
  let childReads = 0, foreign: "parent" | "workspace" | undefined;
  const calls: string[] = [];
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), pathname = new URL(request.url).pathname;
    calls.push(`${request.method} ${pathname}`);
    if (request.method !== "GET") throw new Error(`Unexpected mutation: ${request.method} ${pathname}`);
    if (pathname === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller;
      opened++;
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      const close = () => { closed++; controller.close(); };
      if (request.signal.aborted) close(); else request.signal.addEventListener("abort", close, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (pathname === "/api/session") return Response.json({ data: [], cursor: {} });
    if (pathname === "/api/session/active") return Response.json({});
    if (pathname === "/api/permission/request" || pathname === "/api/form") return Response.json({ location: { directory: WORKSPACE }, data: [] });
    if (pathname.endsWith("/inbox")) return Response.json({ data: [] });
    const [, id, resource] = /^\/api\/session\/([^/]+)(?:\/(message))?$/.exec(pathname) ?? [];
    if (!id) throw new Error(`Unexpected native read: ${pathname}`);
    if (resource === "message") {
      let data: unknown[] = [];
      if (id === "ses_parent") data = [
        { id: "msg_own", type: "user", time: { created: 1 }, text: "Parent remains readable" },
        fixture.launch, fixture.stored,
      ];
      if (id.startsWith("ses_pressure_")) {
        const index = id.slice("ses_pressure_".length), launch = structuredClone(fixture.launch);
        launch.id = `msg_pressure_${index}`; launch.sessionID = id;
        launch.content[0].id = `call_pressure_${index}`;
        launch.content[0].state.metadata.sessionID = `ses_held_${index}`;
        data = [launch];
      }
      if (id === "ses_child") data = [{ id: "msg_priced", type: "assistant", time: { created: 2 }, content: [], cost: 0.125, model: { id: "fixture-model" } }];
      return Response.json({ data, cursor: {} });
    }
    if (id === "ses_parent" && refreshing && startup.getStore()) {
      startupEntered.release();
      // Park automatic reconnect recovery before it can start accounting.
      // Otherwise its shared accounting owner can race this explicit read's
      // capture and occasionally mask the loop. This gate honors cancellation.
      let abort!: () => void;
      try {
        await Promise.race([releaseStartup.promise, new Promise<never>((_resolve, reject) => {
          abort = () => reject(request.signal.reason);
          if (request.signal.aborted) abort(); else request.signal.addEventListener("abort", abort, { once: true });
        })]);
      } finally { request.signal.removeEventListener("abort", abort); }
    }
    if (id.startsWith("ses_held_")) {
      const index = Number(id.slice("ses_held_".length)), transport = held[index]!;
      transport.signal = request.signal;
      if (++pressureEntered === 4) capacity.release();
      await transport.promise;
      return Response.json({ data: session(id, `ses_pressure_${index}`) });
    }
    if (id === "ses_child") {
      if (refreshing && ++childReads === 4 && options.boundRetries) { excess.release(); await releaseExcess.promise; }
      return Response.json({ data: { ...session(id, foreign === "parent" ? "ses_other" : "ses_parent"),
        ...(foreign === "workspace" ? { location: { directory: "/other-workspace" } } : {}) } });
    }
    return Response.json({ data: session(id) });
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: "http://opencode.test", directory: WORKSPACE, password: "pw", fetch });
  const events = provider.events.bind(provider);
  provider.events = async function* (signal) { for await (const event of events(signal)) {
    eventBarriers.get(event.eventType)?.();
    yield event;
  } };
  const adapter = new ChatAdapter({ provider, workspacePath: WORKSPACE, coalesceWindowMs: 0 });
  const pressureOwners = Array.from({ length: 4 }, () => new AbortController());
  const pressureReads: Promise<unknown>[] = [];
  return {
    provider, adapter, calls, held, excess: excess.promise,
    get childReads() { return childReads; },
    setForeign(value: typeof foreign) { foreign = value; },
    async emit(type: string, data: unknown) {
      const barrier = gate(), marker = `diagnostic.recovery-progress.${++eventSequence}`;
      eventBarriers.set(marker, barrier.release);
      for (const event of [{ type, data }, { type: marker, data: {} }]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory: WORKSPACE } })}\n\n`));
      await barrier.promise; eventBarriers.delete(marker);
    },
    async reconnect() {
      await adapter.stopEventPump();
      void startup.run(true, () => adapter.startEventPump());
      await provider.waitForEventStream!(new AbortController().signal);
    },
    async prepare() {
      const seeded = await adapter.history("ses_parent");
      expect(seeded.items).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child", status: "completed" }));
      await adapter.stopEventPump();
      for (let index = 0; index < 4; index++) pressureReads.push(provider.listMessages(`ses_pressure_${index}`, { limit: 100, signal: pressureOwners[index]!.signal }).catch(error => error));
      await capacity.promise;
      pressureOwners.forEach(owner => owner.abort());
      await Promise.all(pressureReads);
      expect(held.every(transport => transport.signal?.aborted)).toBe(true);
      // Reconnect drops generation-scoped ownership reuse, but cannot free
      // any of the four still-unsettled native transport slots.
      refreshing = true;
      void startup.run(true, () => adapter.startEventPump());
      await provider.waitForEventStream!(new AbortController().signal);
      await startupEntered.promise;
    },
    releaseCapacity() { held.forEach(transport => transport.release()); },
    async dispose() {
      pressureOwners.forEach(owner => owner.abort());
      await adapter.stopEventPump();
      held.forEach(transport => transport.release()); releaseExcess.release(); releaseStartup.release();
      await adapter.dispose();
      expect(closed).toBe(opened);
      expect(calls.every(call => call.startsWith("GET "))).toBe(true);
    },
  };
}

test("retained settled worker reconnect keeps parent readable under exhausted ownership capacity", async () => {
  const scenario = recoveryScenario({ boundRetries: true });
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    await scenario.prepare();
    reading = scenario.adapter.history("ses_parent", { limit: 97 });
    void reading.catch(() => undefined);
    // Four repeated direct accounting lookups are enough to expose the
    // self-generated loop. Park the fourth request instead of running the
    // storm for the full 25-second production history deadline.
    const outcome = await Promise.race([
      reading.then(snapshot => ({ kind: "readable" as const, snapshot })),
      scenario.excess.then(() => ({ kind: "retry-loop" as const, childReads: scenario.childReads })),
    ]);
    expect(outcome).toMatchObject({ kind: "readable" });
    if (outcome.kind === "readable") {
      expect(outcome.snapshot.items).toContainEqual(expect.objectContaining({ type: "user_message", text: "Parent remains readable" }));
      expect(outcome.snapshot.items).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child", status: "completed" }));
      expect(scenario.childReads).toBeLessThan(4);
    }
  } finally { await scenario.dispose(); await reading?.catch(() => undefined); }
});

for (const observation of ["parent", "workspace", "compatible"] as const)
test(`later external ${observation} ownership evidence still invalidates a captured unavailable candidate`, async () => {
  const scenario = recoveryScenario();
  try {
    await scenario.prepare();
    const page = await scenario.provider.listMessages("ses_parent", { limit: 100 });
    expect(page.isWorkerSourceCurrent?.()).toBe(true);
    expect(page.items.some(item => item.type === "background_task")).toBe(false);
    scenario.setForeign(observation === "compatible" ? undefined : observation);
    await scenario.provider.getSession("ses_child");
    expect(page.isWorkerSourceCurrent?.()).toBe(false);
  } finally { await scenario.dispose(); }
});

test("a bounded watch carries observed confirmation across retries without verifying unavailable children", async () => {
  const scenario = recoveryScenario(), owner = new AbortController();
  try {
    await scenario.prepare();
    const watch = scenario.provider.watchWorkerAssociations!("ses_parent", ["ses_child"], { signal: owner.signal });
    const first = await scenario.provider.listMessages("ses_parent", { limit: 100 });
    expect(first.isWorkerSourceCurrent?.()).toBe(true);
    await scenario.provider.getSession("ses_child");
    expect(first.isWorkerSourceCurrent?.()).toBe(false); // Positive post-capture proof still invalidates.
    const retry = await scenario.provider.listMessages("ses_parent", { limit: 100 });
    expect(retry.items.some(item => "childConversationId" in item && item.childConversationId)).toBe(false);
    await scenario.provider.getSession("ses_child");
    expect(retry.isWorkerSourceCurrent?.()).toBe(true); // Reobserving the same fact makes progress.
    await expect(scenario.provider.reconcileBackgroundTasks!("ses_parent", { fresh: true })).rejects.toThrow("capacity");
    expect(watch.snapshot().contradictedChildren).toEqual([]);
    scenario.setForeign("parent");
    await scenario.provider.getSession("ses_child");
    expect(retry.isWorkerSourceCurrent?.()).toBe(false);
    expect(watch.snapshot().contradictedChildren).toEqual(["ses_child"]);
    scenario.setForeign(undefined);
    await scenario.provider.getSession("ses_child");
    // Retire every enclosing association watch, not just the explicit one.
    // A standalone later page cannot inherit a process-wide proof cache.
    owner.abort(); await scenario.adapter.stopEventPump();
    const later = await scenario.provider.listMessages("ses_parent", { limit: 100 });
    await scenario.provider.getSession("ses_child");
    expect(later.isWorkerSourceCurrent?.()).toBe(false);
  } finally { owner.abort(); await scenario.dispose(); }
});

for (const change of ["lifecycle", "generation"] as const)
test(`observed retry baseline does not survive a ${change} change`, async () => {
  const scenario = recoveryScenario(), owner = new AbortController();
  try {
    await scenario.prepare();
    const watch = scenario.provider.watchWorkerAssociations!("ses_parent", ["ses_child"], { signal: owner.signal });
    await scenario.provider.getSession("ses_child");
    const baseline = await scenario.provider.listMessages("ses_parent", { limit: 100 });
    await scenario.provider.getSession("ses_child");
    expect(baseline.isWorkerSourceCurrent?.()).toBe(true);
    if (change === "lifecycle") {
      await scenario.emit("session.updated", { sessionID: "ses_child", parentID: "ses_parent" });
      expect(baseline.isWorkerSourceCurrent?.()).toBe(false);
    } else await scenario.reconnect();
    const fresh = await scenario.provider.listMessages("ses_parent", { limit: 100 });
    expect(fresh.isWorkerSourceCurrent?.()).toBe(true);
    await scenario.provider.getSession("ses_child");
    expect(fresh.isWorkerSourceCurrent?.()).toBe(false);
    expect(watch.snapshot().contradictedChildren).toEqual([]);
  } finally { owner.abort(); await scenario.dispose(); }
});

test("actual ownership transport settlement leaves later parent recovery retryable", async () => {
  const scenario = recoveryScenario();
  try {
    await scenario.prepare();
    const unavailable = await scenario.provider.listMessages("ses_parent", { limit: 100 });
    expect(unavailable.items.some(item => item.type === "background_task")).toBe(false);
    scenario.releaseCapacity();
    // getSession traverses native response decoding; the following fresh
    // ownership verification must be able to use the settled slots again.
    await scenario.provider.getSession("ses_child");
    const verified = await scenario.provider.listMessages("ses_parent", { limit: 100 });
    expect(verified.items).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child", status: "completed" }));
    const recovered = await scenario.adapter.history("ses_parent", { limit: 96 });
    expect(recovered.items).toContainEqual(expect.objectContaining({ type: "background_task", childConversationId: "ses_child", status: "completed" }));
  } finally { await scenario.dispose(); }
});
