import { expect, test } from "bun:test";
import { ChatAdapter } from "../../adapter";
import type { BackgroundTaskItem } from "../../types";
import { workerDismissalEvidence } from "../../worker-dismissal-evidence";
import { workerCanStop } from "../../worker-state";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
function unresolved(row: BackgroundTaskItem | undefined) {
  expect(row).toMatchObject({ status: "running", stateUncertain: true, control: { available: false } });
  expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
  expect(workerCanStop(row!)).toBe(false);
  expect(row?.resultId).toBeUndefined();
}

for (const seam of ["provider", "adapter"] as const)
for (const change of ["remove", "revert", "quiet", "explicit", "explicit-failed", "explicit-stopped", "complete-identity", "different-execution"] as const)
test(`native inferred outcome requires revocable origin (${change}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, changed = false;
  const explicit = change.startsWith("explicit");
  const reportStatus = change === "explicit-failed" ? "failed" : change === "explicit-stopped" ? "stopped" : "completed";
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 };
      launch.content[0].time = change === "different-execution" && changed ? { created: 20, ran: 21, completed: 22 }
        : { created: 10, ...(change === "complete-identity" || change === "different-execution" ? { ran: 11 } : {}), completed: 12 };
      return Response.json({ data: [launch, ...(explicit ? [{ id: "actual-report", type: "synthetic", time: { created: 45 },
        text: "Actual result", metadata: { source: "subagent", childID: child, state: change === "explicit-failed" ? "error" : change === "explicit-stopped" ? "cancelled" : "completed" } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-input", type: "user", text: "Work", time: { created: 15 } },
      ...(!changed || change !== "remove" ? [{ id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" }] : []),
    ], cursor: {} });
    if (route === `/api/session/${child}` && changed && (change === "remove" || change === "revert" || change === "different-execution")) {
      const body = await response.json(); body.data.revert = { messageID: "child-input" }; return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const nativeRecovery = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = async () => { throw new Error("Optional inventory unavailable"); };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 2_000 });
  const read = async () => seam === "adapter" ? adapter.history(parent!) : provider.listMessages(parent!, { limit: 100 });
  try {
    parent = (await provider.createSession("Alias-free outcome withdrawal")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const initial = await read();
    const old = initial.items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId)!;
    expect(old).toBeDefined();
    if (change !== "complete-identity" && change !== "different-execution") expect(old.activity?.executionAliases ?? []).toEqual([]);
    changed = true;
    // A real native record observation invalidates history reuse before the next
    // covered read. No private projection mutation or guessed flush tick.
    await provider.getSession(child);
    if (change === "different-execution") await nativeRecovery(parent, { fresh: true });
    const current = await read();
    const row = current.items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    if (explicit) expect(row).toMatchObject({ status: reportStatus, resultId: "actual-report", summary: "Actual result" });
    else if (change === "complete-identity") expect(row).toMatchObject({ status: "completed", stateUncertain: false });
    else if (change === "different-execution" && seam === "adapter") {
      expect(row).toMatchObject({ status: "completed", activity: { executionAliases: old.activity!.executionAliases } });
    }
    else if (change === "different-execution") {
      expect(row).toMatchObject({ status: "running", stateUncertain: true });
      expect(row?.activity?.executionAliases).not.toEqual(old.activity!.executionAliases);
    }
    else unresolved(row);
    const canonical = (await nativeRecovery(parent, { fresh: true })).find(item => item.taskId === worker.taskId);
    if (explicit) expect(canonical).toMatchObject({ status: reportStatus, resultId: "actual-report" });
    else if (change === "complete-identity") expect(canonical).toMatchObject({ status: "completed", stateUncertain: false });
    else if (change === "different-execution") {
      expect(canonical).toMatchObject({ status: "running", stateUncertain: true });
      expect(canonical!.activity?.executionAliases).not.toEqual(old.activity!.executionAliases);
    } else unresolved(canonical);
    expect(fake.state().unhandled).toEqual([]);
  } finally { await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const seam of ["provider", "adapter"] as const)
for (const change of ["changed", "quiet", "older"] as const)
test(`latest page includes projected off-page inference (${change}/${seam})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const entered = gate(), release = gate();
  let parent: string | undefined, child: string | undefined, hold = false, revision = 0, childReads = 0, parentReads = 0;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    if (route === `/api/session/${child}` && hold && childReads > 0) { hold = false; entered.release(); await release.promise; }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      parentReads++;
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch, { id: "newest-input", type: "user", text: "Newest unrelated input", time: { created: 60 } }], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) {
      childReads++;
      return Response.json({ data: [{ id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
        { id: "text", type: "assistant", time: { created: 41 }, content: [{ type: "text", text: `Native text ${revision}` }] }], cursor: {} });
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  provider.reconcileBackgroundTasks = async () => { throw new Error("Optional inventory unavailable"); };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 2_000 });
  let reading: Promise<Awaited<ReturnType<typeof provider.listMessages>> | Awaited<ReturnType<typeof adapter.history>>> | undefined;
  try {
    parent = (await provider.createSession("Projected newest-page membership")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    // Prime the actual child facet, not the adapter's worker projection.
    await provider.listMessages(child, { limit: 100 });
    const newest = change === "older" ? await provider.listMessages(parent, { limit: 1 }) : undefined;
    const before = parentReads;
    hold = true;
    reading = seam === "adapter" ? adapter.history(parent, { limit: 1 }) : provider.listMessages(parent, { limit: 1 });
    void reading.catch(() => undefined); await entered.promise;
    if (change !== "quiet") revision++;
    await provider.listMessages(child, { limit: 100 });
    release.release();
    const result = await reading;
    const row = result.items.find((item): item is BackgroundTaskItem => item.type === "background_task" && item.taskId === worker.taskId);
    if (change === "quiet") expect(row).toBeUndefined();
    else {
      unresolved(row); expect(row).toMatchObject({ outcomeWithheld: true });
      if ("completeItems" in result) expect(result.completeItems).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", outcomeWithheld: true }));
    }
    expect(parentReads - before).toBeLessThanOrEqual(1); // No retry on a counter mismatch.
    if (change === "older") expect(newest?.nextCursor).toBeDefined();
    if (newest?.nextCursor) {
      const older = await provider.listMessages(parent, { limit: 1, cursor: newest.nextCursor });
      expect(older.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
    }
    expect(fake.state().unhandled).toEqual([]);
  } finally { release.release(); await reading?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
}, 10_000);
