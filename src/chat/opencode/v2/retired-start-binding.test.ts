import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BackgroundTaskItem } from "../../types";
import type { NormalizedProviderEvent } from "../../provider";
import { workerCanStop, workerState } from "../../worker-state";
import { createOpenCodeV2Provider } from "./provider";

for (const continuation of ["restated-launch", "duplicate-old-start", "new-start"] as const)
test(`retired native start positive binding (${continuation})`, async () => {
  const directory = "/ws", parent = "ses_parent", child = "ses_child";
  const { launch } = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/opencode-v2/background-2.0.29.json", import.meta.url), "utf8"));
  const requests: string[] = [];
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const record = (id: string) => ({ id, projectID: "global", title: id, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory }, time: { created: 10, updated: 50 }, ...(id === child ? { parentID: parent } : {}) });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    requests.push(`${request.method} ${route}`);
    if (request.method !== "GET") throw new Error(`Unexpected native mutation: ${request.method} ${route}`);
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller;
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route === `/api/session/${parent}` || route === `/api/session/${child}`) return Response.json({ data: record(route.split("/").at(-1)!) });
    if (route === `/api/session/${parent}/message`) return Response.json({ data: [launch], cursor: {} });
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-input", type: "user", time: { created: 25 }, text: "Inspect the safe fixture" },
      { id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    if (route === "/api/session/active") return Response.json({});
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/permission/request" || route === "/api/form") return Response.json({ location: { directory }, data: [] });
    if (route === "/api/session") return Response.json({ data: [], cursor: {} });
    throw new Error(`Unexpected native read: ${route}`);
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: "http://opencode.test", password: "pw", directory, fetch: transport });
  const streams: Array<{ abort: AbortController; iterator: AsyncIterator<NormalizedProviderEvent> }> = [];
  const connect = async () => {
    const abort = new AbortController(), iterator = provider.events(abort.signal)[Symbol.asyncIterator]();
    streams.push({ abort, iterator });
    expect((await iterator.next()).value?.eventType).toBe("server.connected");
    return { abort, iterator };
  };
  const emit = async (iterator: AsyncIterator<NormalizedProviderEvent>, event: object) => {
    const next = iterator.next();
    wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...event, location: { directory } })}\n\n`));
    return (await next).value;
  };
  const disconnect = async (stream: Awaited<ReturnType<typeof connect>>) => {
    stream.abort.abort();
    expect((await stream.iterator.next()).done).toBe(true);
  };
  try {
    const first = await connect();
    await emit(first.iterator, { id: "native-start", created: 25, type: "session.execution.started", data: { sessionID: child } });
    await disconnect(first); // The native end at 40 is deliberately missed.
    const second = await connect();
    if (continuation === "duplicate-old-start") {
      await emit(second.iterator, { id: "native-start", created: 25, type: "session.execution.started", data: { sessionID: child } });
    }
    if (continuation === "new-start") {
      // A distinct current-subscription start can still establish activity for
      // a new compatible launcher, never destructive control across the gap.
      await emit(second.iterator, { id: "new-native-start", created: 60, type: "session.execution.started", data: { sessionID: child } });
      launch.id = "new-launch";
      launch.time.created = 50;
      launch.content[0].id = "new-call";
      launch.content[0].time = { created: 50, completed: 70 };
    }
    const capture = requests.length;
    const event = await emit(second.iterator, { id: "launcher-restated", created: continuation === "new-start" ? 80 : 50, type: "session.message.content.updated",
      data: { sessionID: parent, messageID: launch.id, content: launch.content } });
    const row = event?.updates.find((update: import("../../provider").NormalizedProviderUpdate) => update.kind === "upsert" && update.item.type === "background_task");
    expect(row?.kind).toBe("upsert");
    if (row?.kind !== "upsert") throw new Error("Missing public worker row");
    const worker = row.item as BackgroundTaskItem;
    const receipt = { status: worker.status, taskId: worker.taskId, id: worker.id, childConversationId: worker.childConversationId,
      activity: worker.activity, state: workerState(worker.status, worker.stateUncertain, worker.activity), stop: workerCanStop(worker),
      control: worker.control, nativeCaptureRequests: requests.slice(capture) };
    console.log(`retired-start-binding receipt (${continuation})`, JSON.stringify(receipt));
    const call = continuation === "new-start" ? "new-call" : "call_worker";
    expect(worker).toMatchObject({ id: `task:v2:${parent}:${call}`, taskId: `v2:${parent}:${call}`, childConversationId: child, status: "running" });
    expect(workerCanStop(worker)).toBe(false);
    expect(worker.control?.available).toBe(false);
    expect(requests.slice(capture)).toEqual([`GET /api/session/${child}`]);
    if (continuation === "new-start") {
      expect(worker.activity?.kind).toBe("working");
      expect(workerState(worker.status, worker.stateUncertain, worker.activity)).toBe("working");
    } else {
      expect(worker.activity?.kind).toBe("unavailable");
      expect(workerState(worker.status, worker.stateUncertain, worker.activity)).not.toBe("working");
    }
  } finally {
    for (const stream of streams) { stream.abort.abort(); await stream.iterator.return?.(); }
    await provider.dispose!();
  }
});
