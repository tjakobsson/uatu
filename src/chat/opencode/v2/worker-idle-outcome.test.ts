import { expect, test } from "bun:test";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

for (const read of ["listMessages", "reconcileBackgroundTasks"] as const)
for (const scenario of ["straddling", "separate-intervals", "different-child"] as const)
test(`${read} cannot gain a child outcome by hiding a competing parent launch (${scenario})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, otherChild: string | undefined, staged = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const competitor = structuredClone(first);
      competitor.id = "hidden-launch"; competitor.time = { created: 15 };
      competitor.content[0].id = "competing-call";
      competitor.content[0].time = scenario === "separate-intervals"
        ? { created: 30, ran: 31, completed: 32 } : { created: 15, ran: 16, completed: 25 };
      if (scenario === "different-child") competitor.content[0].state.metadata.sessionID = otherChild;
      return Response.json({ data: [first, competitor], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-outcome", type: "idle", time: { created: 20 }, outcome: "succeeded" },
      ...(scenario === "separate-intervals" ? [{ id: "second-outcome", type: "idle", time: { created: 40 }, outcome: "failed" }] : []),
    ], cursor: {} });
    if (staged && route === `/api/session/${parent}`) {
      const body = await response.json(); body.data.revert = { messageID: "hidden-launch" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  try {
    parent = (await provider.createSession("Hidden competing admission")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (scenario === "different-child") {
      otherChild = fake.launchRequestWorker(parent).childId;
      fake.settleWorker(otherChild, "completed", "No unrelated parent report");
    }
    fake.settleWorker(child, "completed", "No parent report");
    const tasks = async () => read === "listMessages"
      ? (await provider.listMessages(parent!, { limit: 100 })).items.filter(item => item.type === "background_task")
      : await provider.reconcileBackgroundTasks!(parent!, { fresh: true });
    const complete = await tasks();
    expect(complete).toHaveLength(2);
    const status = scenario === "straddling" ? "running" : "completed";
    expect(complete.find(task => task.taskId === worker.taskId)?.status).toBe(status);
    expect(complete.find(task => task.toolUseId === "competing-call")?.status).toBe(scenario === "separate-intervals" ? "failed" : "running");
    staged = true;
    const prefix = await tasks();
    expect(prefix).toHaveLength(1);
    expect(prefix[0]).toMatchObject({ taskId: worker.taskId, status, stateUncertain: status === "running" });
    expect(prefix[0]?.control?.available).not.toBe(true);
    expect(prefix[0]?.resultId).toBeUndefined();
    expect(prefix[0]?.summary).toBeUndefined();
  } finally { await provider.dispose!(); await fake.stop(); }
});

// @opencode/client SessionMessageIdle records an explicit native outcome. This
// is stronger evidence than quiet/absent activity or an untyped legacy idle.
for (const [outcome, status] of [["succeeded", "completed"], ["failed", "failed"], ["interrupted", "stopped"]] as const)
test(`complete child history recovers ${outcome} without a parent notification`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let childId: string | undefined;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${childId}/message`) {
      const body = await response.json();
      for (const message of body.data) if (message.type === "idle") message.outcome = outcome;
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  try {
    const parent = (await provider.createSession("Native idle outcome recovery")).id;
    const worker = fake.launchRequestWorker(parent); childId = worker.childId;
    fake.settleWorker(childId, outcome === "succeeded" ? "completed" : outcome === "failed" ? "error" : "cancelled", "Native child finished");
    const tasks = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: worker.taskId, status, stateUncertain: false });
    expect(tasks[0]?.resultId).toBeUndefined();
    expect(tasks[0]?.summary).toBeUndefined();
    const history = await provider.listMessages(parent, { limit: 100 });
    expect(history.items.filter(item => item.type === "background_task")).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status }));
  } finally { await provider.dispose!(); await fake.stop(); }
});

test("a concurrent child move revokes idle-outcome recovery before publication", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let childId: string | undefined, moved = false;
  let wire!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, release!: () => void, applied!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { applied = resolve; });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${childId}/message`) {
      const body = await response.json();
      for (const message of body.data) if (message.type === "idle") message.outcome = "succeeded";
      entered(); await held; return Response.json(body);
    }
    if (moved && route === `/api/session/${childId}`) {
      const body = await response.json(); body.data.location.directory = "/foreign";
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  let pump: Promise<void> | undefined, recovery: ReturnType<NonNullable<typeof provider.reconcileBackgroundTasks>> | undefined;
  try {
    const parent = (await provider.createSession("Outcome source fence")).id;
    const worker = fake.launchRequestWorker(parent); childId = worker.childId;
    fake.settleWorker(childId, "completed", "Child finished before moving");
    pump = (async () => { for await (const event of provider.events(signal)) if (event.eventType === "diagnostic.move-applied") applied(); })();
    await provider.waitForEventStream!(signal);
    recovery = provider.reconcileBackgroundTasks!(parent, { fresh: true, signal });
    void recovery.catch(() => undefined);
    await reading; moved = true;
    for (const event of [
      { id: "event-child-moved", type: "session.moved", created: Date.now(), durable: { aggregateID: childId, seq: 1, version: 1 }, data: { sessionID: childId, location: { directory: "/foreign" }, projectID: "global" } },
      { type: "diagnostic.move-applied", data: {} },
    ]) wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory } })}\n\n`));
    await observed; release();
    await expect(recovery).rejects.toThrow();
  } finally { release(); abort.abort(); await pump; await recovery?.catch(() => undefined); await provider.dispose!(); await fake.stop(); }
}, 10_000);

for (const scenario of ["missing-outcome", "unknown-outcome", "missing-clock", "malformed-idle", "tied-idles", "tied-launches", "straddling-launches", "settled-competitor", "separate-executions", "future-missing-clock"] as const)
test(`child outcome attribution preserves ${scenario}`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let childId: string | undefined;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    const response = await fetch(request);
    if (route.endsWith("/inbox")) {
      return Response.json({ data: [] });
    }
    if (route.endsWith("/message")) {
      const body = await response.json();
      if (route === `/api/session/${childId}/message`) {
        body.data = [{ id: "idle-first", type: "idle", time: { created: scenario === "malformed-idle" ? "invalid" : 20 },
          ...(scenario === "missing-outcome" ? {} : { outcome: scenario === "unknown-outcome" ? "unknown" : "succeeded" }) }];
        if (scenario === "tied-idles") body.data.push({ id: "idle-conflict", type: "idle", time: { created: 20 }, outcome: "failed" });
        if (scenario === "straddling-launches" || scenario === "separate-executions") body.data.push({ id: "idle-second", type: "idle", time: { created: 50 }, outcome: "failed" });
      } else {
        const message = body.data[0], part = message.content[0];
        part.time = { created: 10, ran: 11, completed: scenario === "straddling-launches" ? 30 : 12 };
        if (scenario === "missing-clock") delete part.time.completed;
        if (["tied-launches", "straddling-launches", "settled-competitor", "separate-executions", "future-missing-clock"].includes(scenario)) {
          const duplicate = structuredClone(message); duplicate.id = "message-competing"; duplicate.content[0].id = "call-competing";
          if (scenario !== "tied-launches") {
            const start = scenario === "settled-competitor" ? 14 : 40;
            duplicate.content[0].time = { created: start, ran: start, completed: start + 1 };
            if (scenario === "future-missing-clock") delete duplicate.content[0].time.completed;
          }
          body.data.push(duplicate);
          if (scenario === "settled-competitor") body.data.splice(1, 0, { id: "report-first", type: "synthetic", time: { created: 13 },
            text: "Explicit parent result", metadata: { source: "subagent", childID: childId, state: "completed" } });
        }
      }
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  try {
    const parent = (await provider.createSession("Outcome attribution safeguards")).id;
    const worker = fake.launchRequestWorker(parent); childId = worker.childId;
    fake.settleWorker(childId, "completed", "Explicit parent result");
    const tasks = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    if (scenario === "future-missing-clock") {
      expect(tasks.find(task => task.taskId === worker.taskId)?.status).toBe("completed");
      expect(tasks.find(task => task.toolUseId === "call-competing")?.status).toBe("running");
    } else if (scenario === "separate-executions") {
      expect(tasks.find(task => task.taskId === worker.taskId)?.status).toBe("completed");
      expect(tasks.find(task => task.toolUseId === "call-competing")?.status).toBe("failed");
    } else if (scenario === "settled-competitor") {
      expect(tasks).toHaveLength(2);
      expect(tasks.find(task => task.taskId === worker.taskId)).toMatchObject({ status: "completed", summary: "Explicit parent result" });
      expect(tasks.find(task => task.toolUseId === "call-competing")?.status).toBe("running");
    } else {
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.every(task => task.status === "running" && task.activity?.kind !== "working")).toBe(true);
    }
    expect(tasks.every(task => task.control?.available !== true)).toBe(true);
  } finally { await provider.dispose!(); await fake.stop(); }
});
