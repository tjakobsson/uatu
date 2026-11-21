import { expect, test } from "bun:test";
import { ChatAdapter } from "./adapter";
import { createOpenCodeV2Provider } from "./opencode/v2/provider";
import { startOpenCodeV2Fake } from "../../tests/e2e/opencode-v2-fake";
import { workerCanStop } from "./worker-state";
import { workerDismissalEvidence } from "./worker-dismissal-evidence";
import type { ChatTaskScheduler } from "./task-scheduler";
import type { BackgroundTaskItem } from "./types";

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Executes real adapter work; only the existing named timer seam uses a
 * logical clock. Settling awaits admitted tasks, never guessed IO turn counts. */
class RecoveryClock implements ChatTaskScheduler {
  private clock = 0;
  private token = 0;
  private running = new Set<Promise<unknown>>();
  private completed = new Map<string, number>();
  private acknowledgements = new Set<{ name: string; count: number; done: () => void }>();
  private timers = new Map<ReturnType<typeof setTimeout>, { name: string; at: number; work: () => void }>();
  now = () => this.clock;
  run<T>(name: string, work: () => T | Promise<T>): Promise<T> {
    const result = Promise.resolve().then(work);
    const tracked = result.finally(() => {
      this.running.delete(tracked);
      this.completed.set(name, (this.completed.get(name) ?? 0) + 1);
      for (const waiter of this.acknowledgements) if (waiter.name === name && this.completed.get(name)! >= waiter.count) {
        this.acknowledgements.delete(waiter); waiter.done();
      }
    });
    this.running.add(tracked);
    return tracked;
  }
  setTimeout(name: string, work: () => void, delay: number): ReturnType<typeof setTimeout> {
    const timer = { token: ++this.token, unref() {} } as unknown as ReturnType<typeof setTimeout>;
    this.timers.set(timer, { name, at: this.clock + delay, work }); return timer;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout> | null | undefined) { if (timer) this.timers.delete(timer); }
  async acknowledged(name: string, count = 1) {
    if ((this.completed.get(name) ?? 0) >= count) return;
    await new Promise<void>(done => { this.acknowledgements.add({ name, count, done }); });
  }
  async settled() { while (this.running.size) await Promise.all([...this.running]); }
  async advanceTo(until: number) {
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.clock = next[1].at; this.timers.delete(next[0]); next[1].work(); await this.settled();
    }
    this.clock = until;
  }
}

for (const mode of ["sole", "mixed", "sequential"] as const)
test(`a counter-withheld publication cannot retry itself, while independent recovery remains enabled (${mode})`, async () => {
  const mixed = mode === "mixed";
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory }), clock = new RecoveryClock();
  let parent: string | undefined, child: string | undefined, pendingChild: string | undefined;
  let childVersion = 0, attempts = 0, requests = 0, heldPermission = false, failActivity = false;
  const permissionEntered = gate(), releasePermission = gate(), recovered = gate<BackgroundTaskItem[]>();
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const frame = (type: string, data: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: 50, location: { directory } })}\n\n`));
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    requests++;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      wire = controller; frame("server.connected", {});
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: failActivity ? { [child!]: { status: "running" } } : {} });
    if (route === "/api/permission/request" || route === "/api/form") {
      if (parent && !heldPermission) { heldPermission = true; permissionEntered.resolve(); await releasePermission.promise; }
      return Response.json({ data: [] });
    }
    if (route === `/api/session/${child}/message` && failActivity) return new Response("Child history unavailable", { status: 503 });
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      { id: "child-text", type: "assistant", time: { created: 41 }, content: [{ type: "text", text: `Native text ${childVersion}` }] },
    ], cursor: {} });
    if (route === `/api/session/${pendingChild}/message`) return Response.json({ data: [
      { id: "independent-idle", type: "idle", time: { created: "unknown" }, outcome: "succeeded" },
    ], cursor: {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json();
      for (const message of body.data) for (const tool of message.content ?? []) if (tool.type === "tool") {
        message.time = { created: 10 }; tool.time = { created: 10, ran: 11, completed: 12 };
      }
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = async (id, options) => {
    if (id === parent) attempts++;
    const rows = await nativeRecovery(id, options);
    if (id === parent && attempts === 1) recovered.resolve(rows);
    return rows;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, taskScheduler: clock });
  const owner = new AbortController(), withheld = gate<BackgroundTaskItem>(), completed = gate<BackgroundTaskItem>();
  let pump: Promise<void> | undefined, publications: Promise<void> | undefined;
  const publishedRows = new Map<string, BackgroundTaskItem>();
  try {
    // Discovery completes against an empty workspace before fixture admission.
    pump = adapter.startEventPump(); void pump.catch(() => undefined);
    await clock.acknowledged("stream.event:server.connected"); await clock.settled();
    parent = (await provider.createSession("Outcome counter retry contract")).id;
    const peer = (await provider.createSession("Independent cache invalidation")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const independent = mixed ? fake.launchRequestWorker(parent) : undefined; pendingChild = independent?.childId;
    const subscription = await adapter.subscribe(parent, { signal: owner.signal });
    publications = (async () => { for await (const event of subscription.events) if (event.type === "item.upsert" && event.item.type === "background_task") {
      publishedRows.set(event.item.taskId, event.item);
      if (event.item.taskId !== worker.taskId) continue;
      if (event.item.outcomeWithheld) withheld.resolve(event.item);
      if (event.item.status === "completed") completed.resolve(event.item);
    } })(); void publications.catch(() => undefined);
    frame("session.message.content.updated", { sessionID: parent, messageID: "first-trigger", content: [{ type: "text", text: "Native trigger" }] });
    await permissionEntered.promise;
    const captured = await recovered.promise;
    expect(captured.find(row => row.taskId === worker.taskId)).toMatchObject({ status: "completed" });
    childVersion++;
    await nativeRecovery(peer, { fresh: true, signal: owner.signal });
    await provider.listMessages(child, { limit: 100, signal: owner.signal });
    releasePermission.resolve();
    const row = await withheld.promise;
    await clock.settled(); // Includes the recovery completion that installs retry timers.
    expect(row).toMatchObject({ status: "running", stateUncertain: true, outcomeWithheld: true, activity: { kind: "unavailable" } });
    expect(workerCanStop(row)).toBe(false); expect(workerDismissalEvidence(row)?.dismissible).toBe(false);
    expect(attempts).toBe(1);
    if (independent) expect(publishedRows.get(independent.taskId)).toMatchObject({ status: "running", stateUncertain: true });
    const before = requests;
    // Cross every deadline in the existing 1s/2s inconclusive retry cycle and
    // its 30s exhausted cooldown; no real-time sleeps or speculative flushing.
    await clock.advanceTo(120_000);
    if (!mixed) {
      expect(attempts).toBe(1); expect(requests).toBe(before);
      if (mode === "sequential") {
        failActivity = true;
        await nativeRecovery(peer, { fresh: true, signal: owner.signal });
      }
      // A genuinely new native event is still allowed to recover the outcome.
      frame("session.message.content.updated", { sessionID: parent, messageID: "next-trigger", content: [{ type: "text", text: "New native trigger" }] });
    } else {
      // The sibling remains genuinely inconclusive. Discovering the main
      // row's terminal outcome is progress, preserving its existing retry budget.
      expect(attempts).toBe(4); expect(requests).toBeGreaterThan(before);
    }
    if (mode === "sequential") {
      await clock.acknowledged(`background.recovery:${parent}`, 2); await clock.settled();
      const uncertain = publishedRows.get(worker.taskId)!;
      expect(uncertain).toMatchObject({ status: "running", stateUncertain: true, outcomeWithheld: true, activity: { kind: "session-active" } });
      expect(workerCanStop(uncertain)).toBe(false); expect(workerDismissalEvidence(uncertain)?.dismissible).toBe(false);
      expect(attempts).toBe(2);
      await clock.advanceTo(240_000);
      expect(attempts).toBe(4); // The new same-row activity failure gets the existing bounded retry budget.
      const exhausted = publishedRows.get(worker.taskId)!;
      expect(exhausted.outcomeWithheld).toBe(true);
      expect(workerCanStop(exhausted)).toBe(false); expect(workerDismissalEvidence(exhausted)?.dismissible).toBe(false);
      expect(fake.state().unhandled).toEqual([]);
      return;
    }
    expect((await completed.promise).outcomeWithheld).toBeUndefined();
    await clock.settled();
    expect(attempts).toBe(mixed ? 4 : 2);
    if (independent) {
      expect(publishedRows.get(independent.taskId)).toMatchObject({ status: "running", stateUncertain: true });
      expect(publishedRows.get(independent.taskId)?.outcomeWithheld).not.toBe(true);
    }
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    releasePermission.resolve(); owner.abort(); await adapter.dispose(); await pump; await publications; await fake.stop();
  }
}, 10_000);
