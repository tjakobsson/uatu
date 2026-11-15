import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { ChatAdapter } from "../../adapter";
import type { BackgroundTaskItem, ConversationItem } from "../../types";
import { workerDismissalEvidence } from "../../worker-dismissal-evidence";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

for (const kind of ["record", "inbox"] as const)
for (const mode of ["overlap", "unchanged", "disjoint", "before-load"] as const)
for (const phase of kind === "record" && mode === "overlap" ? ["pending", "installed"] as const : ["pending"] as const)
// Pure qualification controls moved to the native-history interface. Keep the
// adapter's canonical outcome/evidence assertions and both failure seams.
for (const seam of mode === "overlap" ? ["provider", "adapter"] as const : ["adapter"] as const)
test(`pre-registration ${kind} response fences ${phase} raw history (${mode}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const oldEntered = gate(), oldRelease = gate(), rawEntered = gate(), rawRelease = gate();
  const oldContext = new AsyncLocalStorage<boolean>();
  let parent: string | undefined, child: string | undefined, other: string | undefined, changed = false, rawReads = 0;
  const nativeOrder: string[] = [];
  const report = () => ({ id: "overlapping-native-failure", type: "synthetic", time: { created: 45 }, payload: {
    text: "Actual delivered failure", metadata: { source: "subagent", childID: child, state: "error" },
  } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    // No automatic discovery may create worker consumers while raw cache IO warms.
    if (route === "/api/session" && request.method === "GET") return Response.json({ data: [], cursor: {} });
    if (route === "/api/session/active") return Response.json({ data: child ? { [child]: { status: "running" } } : {} });
    if (route.endsWith("/inbox")) {
      const old = kind === "inbox" && oldContext.getStore();
      const data = old && mode !== "unchanged" ? [report()] : [];
      if (old) { nativeOrder.push("old request entered"); oldEntered.release(); await oldRelease.promise; nativeOrder.push("old response delivered"); }
      else nativeOrder.push("empty inbox observed");
      return Response.json({ data });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message` || route === `/api/session/${child}/message`) {
      const parentHistory = route === `/api/session/${parent}/message`;
      let data: unknown[];
      if (parentHistory) {
        const body = await response.json(), launch = body.data[0];
        launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
        const result = report();
        data = [launch, ...(kind === "inbox" && changed ? [{ ...result.payload, id: result.id, type: result.type, time: result.time }] : [])];
      } else data = [{ id: "child-input", type: "user", time: { created: 15 }, text: "Work" },
        ...(!(kind === "record" && changed) ? [{ id: "old-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : [])];
      if (parentHistory === (kind === "inbox")) {
        if (++rawReads === 1) { nativeOrder.push("raw snapshot held"); rawEntered.release(); await rawRelease.promise; nativeOrder.push("raw snapshot returned"); }
      }
      return Response.json({ data, cursor: {} });
    }
    if (kind === "record" && oldContext.getStore() && route === `/api/session/${mode === "disjoint" ? other : child}`) {
      const body = await response.json();
      if (mode !== "unchanged") body.data.revert = { messageID: "old-idle" };
      nativeOrder.push("old request entered"); oldEntered.release(); await oldRelease.promise; nativeOrder.push("old response delivered");
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 }), owner = new AbortController();
  let old: Promise<unknown> | undefined, warm: Promise<unknown> | undefined, pump: Promise<void> | undefined;
  try {
    parent = (await provider.createSession("Ownerless pending raw history overlap")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    other = (await provider.createSession("Disjoint session")).id;
    pump = adapter.startEventPump(); void pump.catch(() => undefined); await provider.waitForEventStream!(owner.signal);
    const subject = mode === "disjoint" ? other : kind === "record" ? child : parent;
    old = oldContext.run(true, () => kind === "record" ? provider.getSession(subject!) : provider.listPendingInbox!(subject!));
    void old.catch(() => undefined); await oldEntered.promise;
    const warmSubject = kind === "record" ? child : parent;
    if (mode !== "before-load") { warm = provider.getReversibleHistoryState!(warmSubject); void warm.catch(() => undefined); await rawEntered.promise; }
    if (phase === "installed") { rawRelease.release(); await warm; }
    oldRelease.release(); await old;
    changed = mode === "overlap" || mode === "before-load";
    if (kind === "record") await provider.getSession(subject!);
    else await provider.listPendingInbox!(subject!);
    nativeOrder.push("transition observations finished");
    if (mode === "before-load") { warm = provider.getReversibleHistoryState!(warmSubject); void warm.catch(() => undefined); await rawEntered.promise; }
    expect(nativeOrder.indexOf("old request entered")).toBeLessThan(nativeOrder.indexOf("raw snapshot held"));
    if (mode !== "before-load") expect(nativeOrder.indexOf("raw snapshot held")).toBeLessThan(nativeOrder.indexOf("old response delivered"));
    rawRelease.release(); await warm;
    expect(rawReads).toBe(1); // Cache invalidation must not retry/cancel the existing raw waiter.
    nativeOrder.push("first worker consumer starts");
    expect(nativeOrder.indexOf("transition observations finished")).toBeLessThan(nativeOrder.indexOf("first worker consumer starts"));
    const page = seam === "provider" ? { items: await provider.reconcileBackgroundTasks!(parent) } : await adapter.history(parent);
    const items: ConversationItem[] = page.items;
    const row = items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    if (changed && kind === "record") {
      expect(row).toMatchObject({ status: "running" });
      expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
    } else if (changed) expect(row).toMatchObject({ status: "failed", resultId: "overlapping-native-failure", summary: "Actual delivered failure" });
    else expect(row).toMatchObject({ status: "completed" });
    expect(rawReads).toBe(mode === "overlap" ? 2 : 1); // Only a later independent read loads current truth.
    if (seam === "adapter") {
      const evidence = await adapter.workerEvidence(parent);
      expect(evidence.entries.find(entry => entry.executionId === row?.activity?.executionId)?.dismissible).toBe(kind === "record" && changed ? false : true);
    }
    const fresh = (await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    if (changed && kind === "record") expect(fresh).toMatchObject({ status: "running", activity: { kind: "working" } });
    else if (changed) expect(fresh).toMatchObject({ status: "failed", resultId: "overlapping-native-failure" });
    else expect(fresh).toMatchObject({ status: "completed" });
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    oldRelease.release(); rawRelease.release(); owner.abort(); await old?.catch(() => undefined); await warm?.catch(() => undefined);
    await adapter.dispose(); await pump?.catch(() => undefined); await fake.stop();
  }
}, 10_000);
