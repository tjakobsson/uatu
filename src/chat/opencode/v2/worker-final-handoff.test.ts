import { expect, test } from "bun:test";
import { ChatAdapter } from "../../adapter";
import type { BackgroundTaskItem } from "../../types";
import { workerDismissalEvidence } from "../../worker-dismissal-evidence";
import { createOpenCodeV2Provider } from "./provider";
import { startOpenCodeV2Fake } from "../../../../tests/e2e/opencode-v2-fake";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const workerRow = (items: readonly { type: string }[], taskId: string) =>
  items.find((item): item is BackgroundTaskItem => item.type === "background_task" && (item as BackgroundTaskItem).taskId === taskId);

for (const state of ["completed", "error"] as const)
test(`fresh explicit report replaces a retained report-free inference (${state})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  let parent: string | undefined, child: string | undefined, reported = false;
  const status = state === "error" ? "failed" : "completed";
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) return Response.json({ data: [] });
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch, ...(reported ? [{ id: "actual-report", type: "synthetic", time: { created: 45 },
        text: "Actual result", metadata: { source: "subagent", childID: child, state } }] : [])], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-input", type: "user", text: "Work", time: { created: 15 } },
      { id: "child-idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    if (route === `/api/session/${parent}` && reported) {
      // A changed parent record invalidates parent history reuse.
      const body = await response.json(); body.data.title = "Renamed parent"; return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  provider.reconcileBackgroundTasks = async () => { throw new Error("Optional inventory unavailable"); };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 2_000 });
  try {
    parent = (await provider.createSession("Fresh report over retained inference")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    const inferred = workerRow((await adapter.history(parent)).items, worker.taskId);
    expect(inferred).toMatchObject({ status: "completed" });
    expect(inferred?.resultId).toBeUndefined();
    reported = true;
    await provider.getSession(parent);
    const page = workerRow((await provider.listMessages(parent, { limit: 100 })).items, worker.taskId);
    expect(page).toMatchObject({ status, resultId: "actual-report", summary: "Actual result" });
    for (let read = 0; read < 2; read++) {
      const row = workerRow((await adapter.history(parent)).items, worker.taskId);
      expect(row).toMatchObject({ status, resultId: "actual-report", summary: "Actual result" });
    }
    expect(fake.state().unhandled).toEqual([]);
  } finally { await adapter.dispose(); await fake.stop(); }
}, 10_000);

for (const change of ["revert", "title", "quiet"] as const)
test(`latest page backfills an off-page worker withheld at the final handoff (${change})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const entered = gate(), release = gate();
  let parent: string | undefined, child: string | undefined, listed = false, held = false, changed = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) {
      if (listed && !held) { held = true; entered.release(); await release.promise; }
      return Response.json({ data: [] });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch, { id: "newest-input", type: "user", text: "Newest unrelated input", time: { created: 60 } }], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-input", type: "user", text: "Work", time: { created: 15 } },
      { id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    if (route === `/api/session/${child}` && changed) {
      const body = await response.json();
      body.data.title = "Changed child";
      if (change === "revert") body.data.revert = { messageID: "idle" };
      return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  provider.reconcileBackgroundTasks = async () => { throw new Error("Optional inventory unavailable"); };
  const listMessages = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    const page = await listMessages(...args);
    if (args[0] === parent && args[1]?.limit === 1) listed = true;
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 2_000 });
  let reading: ReturnType<typeof adapter.history> | undefined;
  try {
    parent = (await provider.createSession("Final handoff backfill")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    await listMessages(child, { limit: 100 });
    reading = adapter.history(parent, { limit: 1 });
    void reading.catch(() => undefined); await entered.promise;
    if (change !== "quiet") { changed = true; await provider.getSession(child); }
    release.release();
    const row = workerRow((await reading).items, worker.taskId);
    if (change === "quiet") expect(row).toBeUndefined();
    else {
      expect(row).toMatchObject({ status: "running", stateUncertain: true, outcomeWithheld: true, control: { available: false } });
      expect(workerDismissalEvidence(row)?.dismissible).not.toBe(true);
      expect(row?.resultId).toBeUndefined();
    }
    const next = workerRow((await adapter.history(parent, { limit: 1 })).items, worker.taskId);
    if (change === "revert") expect(next).toMatchObject({ status: "running", stateUncertain: true });
    else expect(next).toBeUndefined();
    expect(fake.state().unhandled).toEqual([]);
  } finally { release.release(); await reading?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
}, 10_000);

// Background recovery can replace the call-scoped row with its canonical alias
// while this latest-page read awaits the inbox. The final backfill must honor
// that concurrent removal instead of restoring the obsolete row from the page.
for (const prior of ["provider page", "adapter history"] as const)
test(`latest page backfill keeps a concurrently superseded worker removed (${prior})`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const entered = gate(), release = gate();
  let parent: string | undefined, child: string | undefined, listed = false, held = false, changed = false;
  const transport = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/inbox")) {
      if (listed && !held) { held = true; entered.release(); await release.promise; }
      return Response.json({ data: [] });
    }
    const response = await fetch(request);
    if (route === `/api/session/${parent}/message`) {
      const body = await response.json(), launch = body.data[0];
      launch.time = { created: 10 }; launch.content[0].time = { created: 10, ran: 11, completed: 12 };
      return Response.json({ data: [launch, { id: "newest-input", type: "user", text: "Newest unrelated input", time: { created: 60 } }], cursor: {} });
    }
    if (route === `/api/session/${child}/message`) return Response.json({ data: [
      { id: "child-input", type: "user", text: "Work", time: { created: 15 } },
      { id: "idle", type: "idle", time: { created: 40 }, outcome: "succeeded" },
    ], cursor: {} });
    if (route === `/api/session/${child}` && changed) {
      const body = await response.json(); body.data.title = "Changed child"; return Response.json(body);
    }
    return response;
  }) as typeof globalThis.fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  provider.reconcileBackgroundTasks = async () => { throw new Error("Optional inventory unavailable"); };
  const listMessages = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    const page = await listMessages(...args);
    if (args[0] === parent && args[1]?.limit === 1) listed = true;
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, historyReadTimeoutMs: 2_000 });
  let reading: ReturnType<typeof adapter.history> | undefined;
  try {
    parent = (await provider.createSession("Final handoff concurrent removal")).id;
    const worker = fake.launchRequestWorker(parent); child = worker.childId;
    await listMessages(child, { limit: 100 });
    const old = workerRow(prior === "provider page" ? (await listMessages(parent, { limit: 100 })).items : (await adapter.history(parent)).items, worker.taskId)!;
    expect(old).toBeDefined();
    reading = adapter.history(parent, { limit: 1 });
    void reading.catch(() => undefined); await entered.promise;
    changed = true; await provider.getSession(child);
    // The background recovery commit: remove the superseded call-scoped row
    // and publish its canonical alias (same launch) in one recovery batch.
    const canonical: BackgroundTaskItem = { ...old, id: `${old.id}:canonical`, taskId: `${old.taskId}:canonical` };
    const projection = (adapter as unknown as { projection(id: string): { recover(updates: unknown[]): boolean; items(): { type: string; id: string }[] } }).projection(parent);
    expect(projection.recover([{ kind: "remove", itemId: old.id }, { kind: "upsert", item: canonical }])).toBe(true);
    release.release();
    const workers = (items: readonly { type: string; id?: string }[]) => items.filter(item => item.type === "background_task").map(item => item.id);
    expect(workers((await reading).items)).toEqual([canonical.id]);
    expect(workers(projection.items())).toEqual([canonical.id]);
    expect(fake.state().unhandled).toEqual([]);
  } finally { release.release(); await reading?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
}, 10_000);
