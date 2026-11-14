import { expect, test } from "bun:test";
import { ChatAdapter } from "../../adapter";
import type { BackgroundTaskItem } from "../../types";
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
function withheld(row: BackgroundTaskItem | undefined) {
  expect(workerDismissalEvidence(row)?.dismissible).toBe(false);
  expect(row).toMatchObject({ status: "running", outcomeWithheld: true, stateUncertain: true, control: { available: false } });
  expect(workerCanStop(row!)).toBe(false);
  expect(row?.resultId).toBeUndefined();
  expect(row?.summary).toBeUndefined();
}

for (const observation of ["relevant", "empty", "unrelated", "explicit"] as const)
for (const seam of ["provider", "adapter"] as const)
test(`first successful inbox after consumed history (${observation}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const entered = gate(), held = gate();
  let parent: string | undefined, child: string | undefined, observing = false;
  let inboxReads = 0, parentReads = 0, attempts = 0;
  const report = () => ({ id: "first-native-failure", type: "synthetic", time: { created: 45 }, payload: {
    text: "Actual native failure", metadata: { source: "subagent", childID: observation === "unrelated" ? "other-child" : child, state: "error" },
  } });
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === `/api/session/${parent}/inbox`) {
      if (!observing) { entered.release(); await held.promise; }
      inboxReads++;
      return Response.json({ data: observation === "empty" ? [] : [report()] });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      parentReads++;
      const body = await response.json(), first = body.data[0];
      first.time = { created: 10 }; first.content[0].time = { created: 10, ran: 11, completed: 12 };
      const result = report();
      return Response.json({ data: [first, ...(observation === "explicit" ? [{ ...result.payload, id: result.id, type: result.type, time: result.time }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [{ id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeHistory = provider.listMessages.bind(provider), owner = new AbortController();
  let page: Awaited<ReturnType<typeof provider.listMessages>> | undefined;
  let guard: WorkerSourceGuard | undefined;
  provider.listMessages = async (id, options) => {
    const result = await nativeHistory(id, options);
    if (id === parent) { attempts++; page = result; guard = result.workerSource!.retain(owner.signal); }
    return result;
  };
  provider.reconcileBackgroundTasks = async () => {
    throw new Error("Native inventory unavailable");
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 2_000 });
  let reading: ReturnType<typeof adapter.history> | undefined;
  try {
    parent = (await provider.createSession("First inbox after consumed history")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    reading = adapter.history(parent); void reading.catch(() => undefined);
    await entered.promise;
    expect(inboxReads).toBe(0);
    const row = page!.items.find((item): item is BackgroundTaskItem => item.type === "background_task");
    expect(row).toMatchObject({ status: observation === "explicit" ? "failed" : "completed" });
    expect(workerDismissalEvidence(row)?.dismissible).toBe(true);
    observing = true;
    await provider.listPendingInbox!(parent, { signal: owner.signal });
    expect(inboxReads).toBe(1);
    expect(guard!.isCurrent()).toBe(true);
    const projected = guard!.projectInferredOutcome!(row!);
    if (seam === "provider") {
      if (observation === "relevant") withheld(projected);
      else expect(projected).toEqual(row!);
    }
    held.release();
    const snapshot = await reading;
    const published = snapshot.items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    expect(attempts).toBe(1); expect(parentReads).toBe(1);
    if (observation === "relevant") withheld(published);
    else if (observation === "explicit") expect(published).toMatchObject({ status: "failed", resultId: "first-native-failure", summary: "Actual native failure" });
    else expect(published).toMatchObject({ status: "completed" });
    await provider.listPendingInbox!(parent, { signal: owner.signal });
    expect(guard!.isCurrent()).toBe(true);
    expect(guard!.projectInferredOutcome!(row!)).toEqual(projected);
    expect(parentReads).toBe(1);
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    held.release(); owner.abort(); await reading?.catch(() => undefined); await adapter.dispose(); await fake.stop();
  }
}, 10_000);

for (const operation of ["stage", "clear"] as const)
for (const outcome of ["success", "failure", "explicit"] as const)
for (const seam of ["provider", "adapter"] as const)
test(`local ${operation} acknowledgement before record or SSE (${outcome}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const admission = gate(), admit = gate(), recordEntered = gate(), recordRelease = gate();
  let parent: string | undefined, child: string | undefined, holdAdmission = false, holdRecord = false, rejectMutation = false;
  let acknowledgements = 0, parentReads = 0;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "connected", type: "server.connected", data: {} })}\n\n`));
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (holdAdmission && row && (route === "/api/form" || route === "/api/permission/request")) {
      admission.release(); await admit.promise;
    }
    if (holdRecord && route === `/api/session/${child}`) { recordEntered.release(); await recordRelease.promise; }
    const mutation = route === `/api/session/${child}/revert/stage` && request.method === "POST"
      || route === `/api/session/${child}/revert` && request.method === "DELETE";
    if (mutation && rejectMutation) return new Response("Mutation refused", { status: 400 });
    const response = await fetch(request);
    if (mutation && response.ok) acknowledgements++;
    if (route === `/api/session/${parent}/message`) {
      parentReads++;
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch, ...(outcome === "explicit" ? [{ id: "actual-parent-report", type: "synthetic", time: { created: 45 },
        text: "Actual parent result", metadata: { source: "subagent", childID: child, state: "completed" } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-input", type: "user", time: { created: 15 }, text: "Child input" },
      { id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      ...(operation === "clear" ? [{ id: "child-suffix", type: "user", time: { created: 50 }, text: "Later input" }] : []),
    ], cursor: {} });
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const owner = new AbortController(), nativeHistory = provider.listMessages.bind(provider);
  let row: BackgroundTaskItem | undefined, guard: WorkerSourceGuard | undefined;
  provider.listMessages = async (id, options) => {
    const page = await nativeHistory(id, options);
    if (id === parent) {
      row = page.items.find((item): item is BackgroundTaskItem => item.type === "background_task");
      guard = page.workerSource!.retain(owner.signal);
    }
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 2_000 });
  let reading: ReturnType<typeof adapter.history> | undefined, followup: ReturnType<typeof provider.getSession> | undefined;
  try {
    parent = (await provider.createSession("Local revert acknowledgement window")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    if (operation === "clear") expect(await provider.undo!(child)).toMatchObject({ outcome: "changed" });
    const before = acknowledgements;
    holdAdmission = true;
    reading = adapter.history(parent); void reading.catch(() => undefined);
    await Promise.race([admission.promise, reading.then(() => { throw new Error("History completed before the native admission barrier"); })]);
    expect(row).toMatchObject({ status: "completed" });
    expect(workerDismissalEvidence(row)?.dismissible).toBe(true);
    rejectMutation = outcome === "failure";
    const mutation = operation === "stage" ? provider.undo!(child) : provider.redo!(child);
    if (rejectMutation) await expect(mutation).rejects.toBeInstanceOf(Error);
    else expect(await mutation).toMatchObject({ outcome: "changed" });
    expect(acknowledgements - before).toBe(rejectMutation ? 0 : 1);
    // Do not let a subsequent native record or an event supply the missing fence.
    holdRecord = true;
    followup = provider.getSession(child); void followup.catch(() => undefined);
    await recordEntered.promise;
    expect(guard!.isCurrent()).toBe(true);
    const projected = guard!.projectInferredOutcome!(row!);
    if (seam === "provider") {
      if (outcome === "success") withheld(projected);
      else expect(projected).toEqual(row!);
    }
    admit.release();
    const snapshot = await reading;
    const published = snapshot.items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    expect(parentReads).toBe(1); // Connected history reuse avoids a second physical parent read.
    if (outcome === "success") withheld(published);
    else {
      expect(published).toMatchObject({ status: "completed" });
      expect(workerDismissalEvidence(published)?.dismissible).toBe(true);
      if (outcome === "explicit") expect(published).toMatchObject({ resultId: "actual-parent-report", summary: "Actual parent result" });
    }
    if (outcome === "success") {
      holdRecord = false; recordRelease.release(); await followup;
      // Restore the original native view and admit an independent quiet read.
      // A later acknowledgement must fence this new reader too, not merely the first one.
      expect(await (operation === "stage" ? provider.redo!(child) : provider.undo!(child))).toMatchObject({ outcome: "changed" });
      await provider.getSession(child); // Observe the reset record before the quiet capture, not during it.
      const quiet = await nativeHistory(parent, { limit: 100, signal: owner.signal });
      const quietRow = quiet.items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId)!;
      const quietGuard = quiet.workerSource!.retain(owner.signal);
      expect(quietRow).toMatchObject({ status: "completed" });
      expect(workerDismissalEvidence(quietRow)?.dismissible).toBe(true);
      expect(await (operation === "stage" ? provider.undo!(child) : provider.redo!(child))).toMatchObject({ outcome: "changed" });
      expect(acknowledgements - before).toBe(3);
      expect(quietGuard.isCurrent()).toBe(true);
      withheld(quietGuard.projectInferredOutcome!(quietRow));
    }
    expect(fake.state().unhandled).toEqual([]);
  } finally {
    admit.release(); recordRelease.release(); owner.abort();
    await reading?.catch(() => undefined); await followup?.catch(() => undefined); await adapter.dispose(); await fake.stop();
  }
}, 10_000);
