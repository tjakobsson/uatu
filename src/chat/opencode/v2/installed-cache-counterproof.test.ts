import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { ChatAdapter } from "../../adapter";
import type { BackgroundTaskItem, ConversationItem } from "../../types";
import type { WorkerSourceGuard } from "../../provider";
import { workerDismissalEvidence } from "../../worker-dismissal-evidence";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

for (const mode of ["missing-report", "already-covered", "unrelated-child", "unrelated-session", "prelaunch", "empty"] as const)
// Scope/equality controls are primary native-history interface tests. Retain
// every compact worker-evidence control here, plus both reported public seams.
for (const seam of mode === "missing-report" || mode === "already-covered" ? ["provider", "adapter"] as const : ["adapter"] as const)
test(`delayed inbox response fences an installed raw parent (${mode}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const entered = gate(), release = gate(), older = new AsyncLocalStorage<boolean>();
  let parent: string | undefined, child: string | undefined, other: string | undefined;
  let delivered = mode === "already-covered", parentReads = 0;
  const order: string[] = [];
  const report = () => ({ id: "installed-native-failure", type: "synthetic", time: { created: mode === "prelaunch" ? 5 : 45 }, payload: {
    text: "Actual stored failure", metadata: { source: "subagent", childID: mode === "unrelated-child" ? "unrelated-child" : child, state: "error" },
  } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/session" && request.method === "GET") return Response.json({ data: [], cursor: {} });
    if (route.endsWith("/inbox")) {
      const old = older.getStore(), data = old && mode !== "empty" ? [report()] : [];
      if (old) { order.push("old inbox request entered"); entered.release(); await release.promise; order.push("old inbox response returned"); }
      else order.push("empty inbox observed");
      return Response.json({ data });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      parentReads++;
      const body = await response.json(), launch = body.data[0], result = report();
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch, ...(delivered ? [{ ...result.payload, id: result.id, type: result.type, time: result.time }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), owner = new AbortController();
  let pending: Promise<unknown> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Installed parent before older inbox response")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    other = (await provider.createSession("Unrelated parent")).id;
    pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream!(owner.signal);
    pending = older.run(true, () => provider.listPendingInbox!(mode === "unrelated-session" ? other! : parent!));
    void pending.catch(() => undefined); await entered.promise;
    await provider.getReversibleHistoryState!(parent);
    order.push("warm raw parent installed"); expect(parentReads).toBe(1);
    release.release(); await pending;
    delivered = mode === "missing-report" || mode === "already-covered";
    await provider.listPendingInbox!(parent);
    order.push("first worker consumer starts");
    expect(order.indexOf("old inbox request entered")).toBeLessThan(order.indexOf("warm raw parent installed"));
    expect(order.indexOf("warm raw parent installed")).toBeLessThan(order.indexOf("old inbox response returned"));
    expect(order.indexOf("old inbox response returned")).toBeLessThan(order.indexOf("first worker consumer starts"));
    expect(parentReads).toBe(1); // Counterproof alone starts no IO.
    const guards: WorkerSourceGuard[] = [];
    const items: ConversationItem[] = seam === "provider"
      ? await provider.reconcileBackgroundTasks!(parent, { onSource: source => guards.push(source.workerSource.retain(owner.signal)) })
      : (await adapter.history(parent)).items;
    if (seam === "provider") expect(guards.length).toBeGreaterThan(0);
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const row = items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    if (delivered) expect(row).toMatchObject({ status: "failed", resultId: "installed-native-failure", summary: "Actual stored failure" });
    else expect(row).toMatchObject({ status: "completed" });
    expect(parentReads).toBe(mode === "missing-report" ? 2 : 1);
    if (seam === "adapter") {
      const evidence = await adapter.workerEvidence(parent);
      expect(evidence.entries).toContainEqual(expect.objectContaining({ executionId: row!.activity!.executionId, dismissible: true }));
    }
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    expect(fresh).toMatchObject(delivered ? { status: "failed", resultId: "installed-native-failure" } : { status: "completed" });
    expect(fake.state().unhandled).toEqual([]);
  } finally { release.release(); owner.abort(); await pending?.catch(() => undefined); await adapter.dispose(); await pump?.catch(() => undefined); await fake.stop(); }
}, 10_000);

for (const mode of ["different", "equal", "disjoint", "before-replacement", "replacement-pending"] as const)
for (const seam of mode === "different" || mode === "replacement-pending" || mode === "equal" ? ["provider", "adapter"] as const : ["adapter"] as const)
test(`retired native transcript response fences contradictory pending or installed raw history (${mode}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const entered = gate(), release = gate(), replacementEntered = gate(), replacementRelease = gate();
  let parent: string | undefined, child: string | undefined, unrelated: string | undefined, retiringParent: string | undefined;
  let oldSubject: string | undefined, oldStarted = false, removed = false, childReads = 0;
  const order: string[] = [];
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
    if (route === `/api/session/${child}/message` || route === `/api/session/${unrelated}/message`) {
      const own = route === `/api/session/${child}/message`;
      if (own) childReads++;
      const old = route === `/api/session/${oldSubject}/message` && !oldStarted;
      if (old) { oldStarted = true; order.push("original native request entered"); entered.release(); await release.promise; }
      // Snapshot at actual response availability, after replacement installation
      // in the differing arm, not at the earlier fetch invocation.
      const data = [{ id: "child-input", type: "user", time: { created: 15 }, text: "Work" },
        ...(!(removed && (mode !== "disjoint" || !own)) ? [{ id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : [])];
      if (mode === "replacement-pending" && !old && own && childReads === 2) {
        order.push("replacement native body snapshotted"); replacementEntered.release(); await replacementRelease.promise;
      }
      if (old) order.push("original native array returned");
      return Response.json({ data, cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), owner = new AbortController();
  let original: Promise<unknown> | undefined, replacement: Promise<unknown> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Retired ownerless child history")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    unrelated = (await provider.createSession("Unrelated raw history")).id;
    retiringParent = (await provider.createSession("Independent fresh recovery")).id;
    oldSubject = mode === "disjoint" ? unrelated : child;
    pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream!(owner.signal);
    original = provider.getReversibleHistoryState!(oldSubject); void original.catch(() => undefined); await entered.promise;
    expect(await provider.reconcileBackgroundTasks!(retiringParent, { fresh: true })).toEqual([]);
    order.push("original registration retired");
    if (mode === "before-replacement") { removed = true; release.release(); await original; }
    replacement = provider.getReversibleHistoryState!(child); void replacement.catch(() => undefined);
    if (mode === "replacement-pending") {
      await replacementEntered.promise;
      removed = true; release.release(); await original;
      expect(childReads).toBe(2); // Contradiction starts no validation IO.
      replacementRelease.release();
    }
    await replacement;
    order.push("replacement raw history waiter finished");
    removed = mode !== "equal";
    release.release(); expect(await original).toBeDefined(); // Retired healthy waiter must still complete.
    expect(order.indexOf("original native request entered")).toBeLessThan(order.indexOf("original registration retired"));
    if (mode === "replacement-pending") {
      expect(order.indexOf("replacement native body snapshotted")).toBeLessThan(order.indexOf("original native array returned"));
      expect(order.indexOf("original native array returned")).toBeLessThan(order.indexOf("replacement raw history waiter finished"));
    } else if (mode !== "before-replacement") expect(order.indexOf("replacement raw history waiter finished")).toBeLessThan(order.indexOf("original native array returned"));
    order.push("first worker consumer starts");
    expect(order.indexOf("original native array returned")).toBeLessThan(order.indexOf("first worker consumer starts"));
    const before = childReads, guards: WorkerSourceGuard[] = [];
    const items: ConversationItem[] = seam === "provider"
      ? await provider.reconcileBackgroundTasks!(parent, { onSource: source => guards.push(source.workerSource.retain(owner.signal)) })
      : (await adapter.history(parent)).items;
    if (seam === "provider") expect(guards.length).toBeGreaterThan(0);
    expect(guards.every(guard => guard.isCurrent())).toBe(true);
    const row = items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    const withdrawn = mode === "different" || mode === "before-replacement" || mode === "replacement-pending";
    if (withdrawn) {
      expect(row).toMatchObject({ status: "running" });
      expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
    } else expect(row).toMatchObject({ status: "completed" });
    expect(childReads - before).toBe(mode === "different" || mode === "replacement-pending" ? 1 : 0);
    if (seam === "adapter") {
      const evidence = await adapter.workerEvidence(parent);
      expect(evidence.entries.find(entry => entry.executionId === row?.activity?.executionId)?.dismissible).toBe(!withdrawn);
    }
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    // Disjoint mutation concerns only the unrelated raw transcript.
    expect(fresh).toMatchObject(mode === "equal" || mode === "disjoint" ? { status: "completed" } : { status: "running", activity: { kind: "working" } });
    expect(fake.state().unhandled).toEqual([]);
  } finally { release.release(); replacementRelease.release(); owner.abort(); await original?.catch(() => undefined); await replacement?.catch(() => undefined); await adapter.dispose(); await pump?.catch(() => undefined); await fake.stop(); }
}, 10_000);
