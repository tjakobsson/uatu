import { expect, spyOn, test } from "bun:test";
import { HistoryReuse } from "../../history-reuse";
import { ChatAdapter } from "../../adapter";
import type { BackgroundTaskItem, ConversationItem } from "../../types";
import type { WorkerSourceGuard } from "../../provider";
import { workerDismissalEvidence } from "../../worker-dismissal-evidence";
import { workerCanStop } from "../../worker-state";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

for (const transition of ["commit-during-load", "unchanged-history", "clear-before-load", "unchanged-record"] as const)
for (const seam of ["provider", "adapter"] as const)
test(`completed pre-registration stage fences a crossing commit (${transition}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const rawEntered = gate(), rawRelease = gate(), owner = new AbortController();
  let parent: string | undefined, child: string | undefined, staged = transition !== "unchanged-record", removed = false, childReads = 0;
  const crossing = transition === "commit-during-load" || transition === "unchanged-history";
  const firstObservation = staged ? "stage observation completed before registration" : "clear observation completed before registration";
  const order: string[] = [], arrays: unknown[][] = [];
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/session" && request.method === "GET") return Response.json({ data: [], cursor: {} });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      // Capture the native array BEFORE the commit, not when its gate opens.
      const data = [{ id: "child-input", type: "user", time: { created: 15 }, text: "Work" },
        ...(!removed ? [{ id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : [])];
      arrays.push(structuredClone(data));
      if (++childReads === 1) { order.push("precommit array captured and held"); rawEntered.release(); await rawRelease.promise; order.push("precommit array returned"); }
      return Response.json({ data, cursor: {} });
    }
    if (route === `/api/session/${child}` && request.method === "GET") {
      const body = await response.json();
      if (staged) body.data.revert = { messageID: "old-idle" };
      else delete body.data.revert;
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let warm: Promise<unknown> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Completed stage before registration")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream!(owner.signal);
    await provider.getSession(child); order.push(firstObservation);
    if (transition === "clear-before-load") {
      staged = false; await provider.getSession(child); order.push("clear observation also completed before registration");
    }
    expect(childReads).toBe(0);
    warm = provider.getReversibleHistoryState!(child); void warm.catch(() => undefined); await rawEntered.promise;
    staged = false; removed = transition === "commit-during-load";
    await provider.getSession(child); order.push("clear observed while native array held");
    expect(childReads).toBe(1); // Native counterproof starts no IO.
    rawRelease.release(); expect(await warm).toBeDefined(); order.push("healthy warm waiter finished");
    expect(childReads).toBe(1); // Neither cancellation nor automatic retry.
    order.push("first worker consumer starts");
    expect(order).toEqual([firstObservation, ...(transition === "clear-before-load" ? ["clear observation also completed before registration"] : []), "precommit array captured and held",
      "clear observed while native array held", "precommit array returned", "healthy warm waiter finished", "first worker consumer starts"]);
    expect(arrays[0]).toContainEqual(expect.objectContaining({ id: "old-idle", outcome: "succeeded" }));
    const guards: WorkerSourceGuard[] = [];
    const items: ConversationItem[] = seam === "provider"
      ? await provider.reconcileBackgroundTasks!(parent, { onSource: source => guards.push(source.workerSource.retain(owner.signal)) })
      : (await adapter.history(parent)).items;
    const row = items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    const dismissible = row && workerDismissalEvidence(row)?.dismissible;
    const readsAtPublication = childReads;
    const beforeFresh = structuredClone(row);
    const canStopBeforeFresh = row && workerCanStop(row);
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    expect(row).toEqual(beforeFresh);
    expect(row && workerCanStop(row)).toBe(canStopBeforeFresh);
    console.log(JSON.stringify({ transition, seam, order, arrays, readsAtPublication, row, dismissible, fresh }));
    if (seam === "provider") expect(guards.length).toBeGreaterThan(0);
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    expect(row).toMatchObject({ taskId: worker.taskId, childConversationId: child });
    expect(row?.activity?.executionId).toBeDefined();
    if (transition === "commit-during-load") {
      expect(fresh).toMatchObject({ status: "running", activity: { kind: "working" } });
      expect(workerDismissalEvidence(fresh!)?.dismissible).not.toBe(true);
      // This independent consumer reloads current native history; eligibility
      // comes from its own owned execution/inventory, not the retired warm load.
      expect(beforeFresh).toMatchObject({ status: "running", activity: { kind: "working" }, control: { available: true } });
      expect(canStopBeforeFresh).toBe(true);
      expect(workerDismissalEvidence(beforeFresh!)?.dismissible).toBe(false);
      expect(row).toMatchObject({ status: "running", activity: { kind: "working" }, control: { available: true } });
      expect(fresh?.activity?.executionId).toBe(beforeFresh?.activity?.executionId);
      expect(dismissible).not.toBe(true);
      expect(readsAtPublication).toBe(2); // Only this independent consumer can reload.
      expect(arrays[1]).toEqual([{ id: "child-input", type: "user", time: { created: 15 }, text: "Work" }]);
    } else {
      expect(beforeFresh?.control?.available).toBe(false);
      expect(canStopBeforeFresh).toBe(false);
      expect(row?.control?.available).toBe(false);
      expect(row).toMatchObject({ status: "completed" });
      expect(dismissible).toBe(true);
      // A crossing clear cannot be distinguished from commit without an
      // independent reload. No-crossing/identical-record controls still reuse.
      expect(readsAtPublication).toBe(crossing ? 2 : 1);
    }
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    rawRelease.release(); owner.abort(); await warm?.catch(() => undefined);
    await adapter.dispose(); await pump?.catch(() => undefined); await fake.stop();
  }
}, 10_000);

// Without a connected stream the native-history version is undefined. Pending
// loads still coalesce, so a recovery joining a held pre-commit load must see the
// same record qualification: a crossing clear retires that in-flight load.
for (const transition of ["commit-during-load", "unchanged-record"] as const)
test(`unversioned in-flight child history is qualified before a later recovery joins it (${transition})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const rawEntered = gate(), rawRelease = gate(), joined = gate();
  let parent: string | undefined, child: string | undefined, staged = transition === "commit-during-load", removed = false, childReads = 0, armed = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(null, { status: 503 }); // No stream generation.
    if (route === "/api/session" && request.method === "GET") return Response.json({ data: [], cursor: {} });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      const data = [{ id: "child-input", type: "user", time: { created: 15 }, text: "Work" },
        ...(!removed ? [{ id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : [])];
      if (++childReads === 1) { rawEntered.release(); await rawRelease.promise; }
      return Response.json({ data, cursor: {} });
    }
    if (route === `/api/session/${child}` && request.method === "GET") {
      const body = await response.json();
      if (staged) body.data.revert = { messageID: "old-idle" };
      else delete body.data.revert;
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  // Observe only the synchronous join/registration point of the recovery's
  // child history read; the native-history path itself is unchanged.
  const readShared = HistoryReuse.prototype.readShared;
  const spy = spyOn(HistoryReuse.prototype, "readShared").mockImplementation(function (this: HistoryReuse<unknown, unknown>, ...args: Parameters<typeof readShared>) {
    const reading = readShared.apply(this, args);
    if (armed && args[0] === child) joined.release();
    return reading;
  } as typeof readShared);
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  let warm: Promise<unknown> | undefined, recovery: Promise<BackgroundTaskItem[]> | undefined;
  try {
    parent = (await provider.createSession("Unversioned in-flight stage")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    await provider.getSession(child); // The stage (or an unchanged record) is known before registration.
    warm = provider.getReversibleHistoryState!(child); void warm.catch(() => undefined); await rawEntered.promise;
    // The commit lands natively and its clear record is observed while held.
    staged = false; removed = transition === "commit-during-load";
    await provider.getSession(child);
    // Recovery starts after the clear and reaches the child history read.
    armed = true;
    recovery = provider.reconcileBackgroundTasks!(parent); void recovery.catch(() => undefined);
    await joined.promise;
    rawRelease.release(); await warm;
    const row = (await recovery).find(item => item.taskId === worker.taskId);
    if (transition === "commit-during-load") {
      expect(row).toMatchObject({ status: "running", activity: { kind: "working" } });
      expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
      expect(childReads).toBe(2); // The retired load is not joined; a new read starts.
    } else {
      expect(row).toMatchObject({ status: "completed" });
      expect(childReads).toBe(1); // No crossing change: the in-flight load is shared.
    }
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    expect(fresh).toMatchObject(transition === "commit-during-load" ? { status: "running", activity: { kind: "working" } } : { status: "completed" });
  } finally {
    spy.mockRestore(); rawRelease.release(); await warm?.catch(() => undefined); await recovery?.catch(() => undefined);
    await provider.dispose!(); await fake.stop();
  }
}, 10_000);
