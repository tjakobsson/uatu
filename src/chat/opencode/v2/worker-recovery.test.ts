import { expect, test } from "bun:test";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

function eventStreams(provider: ReturnType<typeof createOpenCodeV2Provider>) {
  const streams: Array<{ abort: AbortController; pump: Promise<void> }> = [];
  const disconnect = async (stream: typeof streams[number]) => { stream.abort.abort(); await stream.pump; };
  return {
    connect: async () => {
      const abort = new AbortController();
      const pump = (async () => { for await (const _event of provider.events(abort.signal)) {} })();
      const stream = { abort, pump };
      streams.push(stream);
      await provider.waitForEventStream!(abort.signal);
      return stream;
    },
    disconnect,
    close: async () => {
      for (const stream of streams) stream.abort.abort();
      await Promise.all(streams.map(stream => stream.pump));
    },
  };
}

for (const launch of ["before-subscription", "during-subscription"] as const)
test(`fresh inventory re-verifies the same running worker after an event reconnect (${launch})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const streams = eventStreams(provider), { connect } = streams;
  try {
    const parent = (await provider.createSession("Worker reconnect regression")).id;
    const initial = launch === "during-subscription" ? await connect() : undefined;
    const { taskId } = fake.launchRequestWorker(parent);
    const before = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(before).toContainEqual(expect.objectContaining({ taskId, activity: expect.objectContaining({ kind: "working" }) }));
    const first = initial ?? await connect();
    await streams.disconnect(first);
    await connect();
    const after = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(after).toContainEqual(expect.objectContaining({ taskId, activity: expect.objectContaining({ kind: "working" }) }));
    // Read-side liveness must not restore a revoked destructive control.
    expect(after[0]?.control?.available).toBe(false);
  } finally {
    await streams.close();
    await provider.dispose!(); await fake.stop();
  }
});

test("a finished occurrence does not make the current resumed child ambiguous", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  try {
    const parent = (await provider.createSession("Resumed worker regression")).id;
    const first = fake.launchWorker(parent, true);
    fake.settleWorker(first.childId, "completed", "Earlier occurrence finished");
    const resumed = fake.launchWorker(parent, true, first.childId);
    const tasks = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(tasks).toHaveLength(2);
    expect(tasks).toContainEqual(expect.objectContaining({ taskId: first.taskId, status: "completed" }));
    expect(tasks).toContainEqual(expect.objectContaining({ taskId: resumed.taskId, status: "running", activity: expect.objectContaining({ kind: "working" }) }));
  } finally { await provider.dispose!(); await fake.stop(); }
});

test("disconnect discards last-seen cache when current activity cannot be verified", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const streams = eventStreams(provider);
  try {
    const initial = await streams.connect();
    const parent = (await provider.createSession("Disconnected last-seen regression")).id;
    // Suppress launch events so this is an inventory observation, not a retained
    // native execution witness with its own last-seen clock.
    fake.pauseEvents(true);
    await streams.disconnect(initial);
    const worker = fake.launchRequestWorker(parent);
    const before = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(before[0]?.activity?.kind).toBe("working");
    // Open and close a new covered stream after its cold inventory observation.
    fake.pauseEvents(false);
    const next = await streams.connect();
    try {
      expect((await provider.reconcileBackgroundTasks!(parent, { fresh: true }))[0]?.activity?.kind).toBe("working");
    } finally { await streams.disconnect(next); }
    fake.workerObservation(worker.childId, false);
    const after = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(after[0]?.activity?.kind).toBe("unavailable");
    expect(after[0]?.activity?.observedAt).toBeUndefined();
  } finally { await streams.close(); await provider.dispose!(); await fake.stop(); }
});

for (const missing of ["active", "child-history", "ownership", "newer-execution", "tied-launches", "straddling-launches"] as const)
test(`reconnect does not invent working evidence with ${missing}`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let childId: string | undefined, degrade = false, admissionBase = 0;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (degrade && route === "/api/session/active" && missing === "active") return Response.json({});
    if (degrade && route === `/api/session/${childId}/message` && missing === "child-history") return new Response(null, { status: 503 });
    const response = await fetch(request);
    if (degrade && route === `/api/session/${childId}` && missing === "ownership") {
      const body = await response.json(); body.data.parentID = "another-parent";
      return Response.json(body);
    }
    if (degrade && route === `/api/session/${childId}/message` && (missing === "newer-execution" || missing === "straddling-launches")) {
      const body = await response.json();
      body.data.push({ id: "idle-old-worker", type: "idle", time: { created: missing === "straddling-launches" ? admissionBase + 10 : Date.now() + 1_000 } });
      return Response.json(body);
    }
    if (degrade && route.endsWith("/message") && !route.includes(childId!) && (missing === "tied-launches" || missing === "straddling-launches")) {
      const body = await response.json(), duplicate = structuredClone(body.data[0]);
      duplicate.id = "message-competing"; duplicate.content[0].id = "call-competing";
      if (missing === "straddling-launches") {
        admissionBase = body.data[0].content[0].time.created;
        body.data[0].content[0].time = { created: admissionBase, ran: admissionBase, completed: admissionBase + 20 };
        duplicate.content[0].time = { created: admissionBase + 30, ran: admissionBase + 30, completed: admissionBase + 31 };
      }
      body.data.push(duplicate);
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const streams = eventStreams(provider), { connect } = streams;
  try {
    const parent = (await provider.createSession("Conservative reconnect")).id;
    ({ childId } = fake.launchRequestWorker(parent));
    expect((await provider.reconcileBackgroundTasks!(parent, { fresh: true }))[0]?.activity?.kind).toBe("working");
    const first = await connect(); await streams.disconnect(first);
    await connect(); degrade = true;
    const tasks = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(tasks.every(task => task.activity?.kind !== "working" && task.control?.available !== true)).toBe(true);
    if (missing !== "ownership") expect(tasks).toHaveLength(missing.endsWith("launches") ? 2 : 1);
  } finally {
    await streams.close(); await provider.dispose!(); await fake.stop();
  }
});
