import { expect, test } from "bun:test";
import { injectableEvents, withProvider } from "../../../../tests/e2e/opencode-v2-provider-harness";
import type { BackgroundTaskItem } from "../../types";
import { nativeProof, type BackgroundWorkers } from "./background";

// Both ledgers record execution boundaries only for known or possible workers.
// A top-level conversation's own turns are not worker evidence: however many
// there are, they must not fill either ledger or disable live worker rows.

type Ledger = { controlEvidenceAvailable: boolean; preOwnershipBoundaries(session: string): unknown; terminalProofs: Map<string, unknown>; ended: Map<string, unknown>;
  preOwnership?: { terminalProofs: Map<string, unknown>; bytes: number } };
const ledger = (provider: unknown) => {
  const state = provider as { executionWorkers?: Ledger; eventMemory?: { workers: Ledger } };
  return state.executionWorkers ?? state.eventMemory?.workers;
};
const controls = (provider: unknown) => (provider as { controls: { usage: { entries: number; bytes: number }; closed: boolean } }).controls;
const controlEntries = (provider: unknown) => controls(provider).usage.entries;
const ledgerEntries = (provider: unknown) => { const state = ledger(provider)!; return state.terminalProofs.size + state.ended.size; };
const stopEligibility = (row: BackgroundTaskItem | undefined) => row && { status: row.status, activity: row.activity?.kind, control: row.control?.available };

for (const created of ["while subscribed", "before subscribing"] as const)
test(`a top-level conversation ends more than 128 turns and live worker rows still show up afterwards (created ${created})`, () => withProvider(async ({ fake, provider, subscribe }) => {
  let parent = created === "before subscribing" ? (await provider.createSession("Long top-level conversation")).id : undefined;
  const first = await subscribe();
  parent ??= (await provider.createSession("Long top-level conversation")).id;
  await provider.prompt(parent, { id: "warm-up", text: "Warm up", delivery: "queue" }); fake.finish(parent, "Ready");
  const ended = () => first.events.filter(event => event.conversationId === parent && event.eventType === "session.execution.succeeded").length;
  await first.seen(() => ended() >= 1);
  const baseline = { controls: controls(provider).usage, ledger: ledgerEntries(provider) }, turns = 1_200;
  for (let turn = 0; turn < turns; turn++) {
    await provider.prompt(parent, { id: `turn-${turn}`, text: `Turn ${turn}`, delivery: "queue" });
    fake.finish(parent, `Answer ${turn}`);
  }
  await first.seen(() => ended() >= turns + 1);
  // Never record-read: neither ledger holds anything for its turns.
  expect(controls(provider).usage).toEqual(baseline.controls); expect(ledgerEntries(provider)).toBe(baseline.ledger);
  expect(ledger(provider)?.controlEvidenceAvailable).toBe(true); expect(controls(provider).closed).toBe(false);
  // The same subscription, with no repair read or reconnect.
  const worker = fake.launchWorker(parent, true);
  await first.seen(() => first.row(worker.taskId)?.activity?.kind === "working");
  const rows = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
  expect(stopEligibility(rows.find(row => row.taskId === worker.taskId))).toEqual({ status: "running", activity: "working", control: true });
  await provider.stopTask!(parent, worker.taskId);
  expect(fake.state().unhandled).toEqual([]);
}), 60_000);

test("many never-read top-level conversations with turns lose nothing, a live-born worker gets Working and Stop, and listing clears them", () => withProvider(async ({ fake, provider, subscribe }) => {
  const conversations: string[] = [];
  for (let index = 0; index < 70; index++) conversations.push((await provider.createSession(`Conversation ${index}`)).id);
  const first = await subscribe();
  const baseline = { controls: controls(provider).usage, ledger: ledgerEntries(provider) };
  const ended = () => first.events.filter(event => event.eventType === "session.execution.succeeded").length;
  for (const conversation of conversations) for (let turn = 0; turn < 3; turn++) {
    await provider.prompt(conversation, { id: `turn-${turn}`, text: `Turn ${turn}`, delivery: "queue" });
    fake.finish(conversation, `Answer ${turn}`);
  }
  await first.seen(() => ended() >= conversations.length * 3);
  expect(controls(provider).usage).toEqual(baseline.controls); expect(ledgerEntries(provider)).toBe(baseline.ledger);
  expect(ledger(provider)!.preOwnership!.terminalProofs.size).toBe(conversations.length);
  expect(ledger(provider)!.preOwnership!.bytes).toBeLessThanOrEqual(1024 * 1024);
  expect((ledger(provider) as unknown as { preOwnershipLost: boolean }).preOwnershipLost).toBe(false);
  const worker = fake.launchWorker(conversations[0]!, true);
  await first.seen(() => first.row(worker.taskId)?.activity?.kind === "working");
  const rows = await provider.reconcileBackgroundTasks!(conversations[0]!, { fresh: true });
  expect(stopEligibility(rows.find(row => row.taskId === worker.taskId))).toEqual({ status: "running", activity: "working", control: true });
  await provider.stopTask!(conversations[0]!, worker.taskId);
  // Listing reads every conversation's parentless record: they leave the store.
  await provider.listSessions();
  expect(ledger(provider)!.preOwnership!.terminalProofs.size).toBe(0);
  expect(fake.state().unhandled).toEqual([]);
}), 60_000);

test("read-only lookups of dormant parentless sessions add nothing to either ledger", () => withProvider(async ({ provider, subscribe }) => {
  const dormant: string[] = [];
  for (let index = 0; index < 300; index++) dormant.push((await provider.createSession(`Dormant ${index}`)).id);
  await subscribe();
  const baseline = { controls: controls(provider).usage, ledger: ledgerEntries(provider) };
  for (const id of dormant) expect((await provider.getSession(id))?.id).toBe(id);
  await provider.listSessions();
  expect(controls(provider).usage).toEqual(baseline.controls); expect(ledgerEntries(provider)).toBe(baseline.ledger);
}), 30_000);


test("pre-ownership ends of many sessions fill neither ledger; their loss stays sticky across a reconnect, and workers born live still get Stop", async () => {
  const events = injectableEvents();
  await withProvider(async ({ fake, provider, subscribe }) => {
    const directory = process.cwd(), first = await subscribe();
    const parent = (await provider.createSession("Busy parent")).id;
    const baseline = { controls: controls(provider).usage, ledger: ledgerEntries(provider) };
    // Native ends from many not-yet-owned sessions overflow the bounded
    // pre-ownership store, outside both budgets.
    for (let index = 0; index < 2_200; index++) events.frame("session.execution.succeeded", { sessionID: `child-${index}`.padEnd(500, "x") }, directory);
    events.frame("server.heartbeat", {}, directory);
    await first.seen(() => first.events.some(event => event.eventType === "server.heartbeat"));
    expect(controls(provider).usage).toEqual(baseline.controls); expect(ledgerEntries(provider)).toBe(baseline.ledger);
    expect(ledger(provider)?.controlEvidenceAvailable).toBe(true);
    // A pre-existing child recovered cold now fails closed for this subscription.
    expect(ledger(provider)!.preOwnershipBoundaries("pre-existing")).toEqual({ starts: null, ends: null });
    expect(ledger(provider)!.preOwnership!.bytes).toBeLessThanOrEqual(1024 * 1024);
    // Born live after the overflow, on the same subscription: Working and Stop.
    const worker = fake.launchWorker(parent, true);
    await first.seen(() => first.row(worker.taskId)?.activity?.kind === "working");
    const rows = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(stopEligibility(rows.find(row => row.taskId === worker.taskId))).toEqual({ status: "running", activity: "working", control: true });
    await first.close();
    const second = await subscribe();
    // An ordinary reconnect keeps the loss and the store's clocked evidence.
    expect(ledger(provider)!.preOwnershipBoundaries("pre-existing")).toEqual({ starts: null, ends: null });
    expect(ledger(provider)!.preOwnershipBoundaries(`child-0`.padEnd(500, "x"))).toEqual({ starts: null, ends: null });
    expect(ledger(provider)!.preOwnership!.terminalProofs.has(`child-2199`.padEnd(500, "x"))).toBe(true);
    const later = fake.launchWorker(parent, true);
    await second.seen(() => second.row(later.taskId)?.activity?.kind === "working");
    const after = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(stopEligibility(after.find(row => row.taskId === later.taskId))).toEqual({ status: "running", activity: "working", control: true });
    expect(fake.state().unhandled).toEqual([]);
  }, events.fetch);
}, 30_000);

test("after worker-ledger saturation and a reconnect, a newly launched worker gets Stop and a pre-gap worker does not", () => withProvider(async ({ fake, provider, subscribe }) => {
  const first = await subscribe();
  const parent = (await provider.createSession("Busy parent")).id;
  const old = fake.launchWorker(parent, true);
  await first.seen(() => first.row(old.taskId)?.activity?.kind === "working");
  expect(stopEligibility((await provider.reconcileBackgroundTasks!(parent, { fresh: true })).find(row => row.taskId === old.taskId)))
    .toEqual({ status: "running", activity: "working", control: true });
  // Exhaust only the worker ledger, through owned children's native ends, so
  // the provider-lifetime control ledger keeps capacity.
  const workers = ledger(provider) as unknown as BackgroundWorkers;
  for (let index = 0; workers.controlEvidenceAvailable; index++) {
    const child = `child-${index}`.padEnd(500, "x");
    workers.verifyChild(child, parent);
    workers.executionEnded(child, index, nativeProof({ id: `end-${index}`, created: index }, { child, phase: "ended" }));
  }
  expect((provider as unknown as { controls: { closed: boolean } }).controls.closed).toBe(false);
  await first.close();
  const second = await subscribe();
  expect(ledger(provider)?.controlEvidenceAvailable).toBe(true);
  const worker = fake.launchWorker(parent, true);
  await second.seen(() => second.row(worker.taskId)?.activity?.kind === "working");
  const rows = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
  // Born after the gap: Stop, as before saturation.
  expect(stopEligibility(rows.find(row => row.taskId === worker.taskId))).toEqual({ status: "running", activity: "working", control: true });
  // Born before the gap: the evidence for its Stop basis was lost.
  expect(rows.find(row => row.taskId === old.taskId)?.control?.available).toBe(false);
  await provider.stopTask!(parent, worker.taskId);
  expect(fake.state().unhandled).toEqual([]);
}), 30_000);

test("a child with 129 old idle records keeps a clear newer launch verified in complete-history recovery", async () => {
  // Live retention caps ends per session; the complete-history fold must not.
  const children = new Set<string>();
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    const response = await globalThis.fetch(request);
    const child = route.match(/^\/api\/session\/([^/]+)\/message$/)?.[1];
    if (!child || !children.has(child)) return response;
    const body = await response.json() as { data: unknown[]; cursor: unknown };
    const idles = Array.from({ length: 129 }, (_, index) => ({ id: `old-idle-${index}`, type: "idle", time: { created: 1_000 + index }, outcome: "succeeded" }));
    return Response.json({ ...body, data: [...idles, ...body.data] });
  }) as typeof globalThis.fetch;
  await withProvider(async ({ fake, provider, subscribe }) => {
    const first = await subscribe();
    const parent = (await provider.createSession("Parent of a long-lived child")).id;
    const worker = fake.launchWorker(parent, true);
    children.add(worker.childId);
    await first.seen(() => first.row(worker.taskId)?.activity?.kind === "working");
    const rows = await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    const row = rows.find(item => item.taskId === worker.taskId);
    expect(row?.stateUncertain).toBeFalsy();
    expect(stopEligibility(row)).toEqual({ status: "running", activity: "working", control: true });
    expect(fake.state().unhandled).toEqual([]);
  }, fetch);
}, 30_000);

test("history reconciliation that verifies a child moves its pre-ownership boundaries under the shared budget", async () => {
  const events = injectableEvents();
  await withProvider(async ({ fake, provider, subscribe }) => {
    const directory = process.cwd();
    const parent = (await provider.createSession("Parent of a pre-existing worker")).id;
    // Launched before this subscription: a pre-existing child, not born live.
    const worker = fake.launchWorker(parent, true);
    const first = await subscribe();
    events.frame("session.execution.succeeded", { sessionID: worker.childId }, directory);
    events.frame("server.heartbeat", {}, directory);
    await first.seen(() => first.events.some(event => event.eventType === "server.heartbeat"));
    expect(ledger(provider)!.preOwnership!.terminalProofs.has(worker.childId)).toBe(true);
    expect(ledger(provider)!.ended.has(worker.childId)).toBe(false);
    await provider.reconcileBackgroundTasks!(parent, { fresh: true });
    expect(ledger(provider)!.preOwnership!.terminalProofs.has(worker.childId)).toBe(false);
    expect(ledger(provider)!.ended.has(worker.childId)).toBe(true);
    expect(fake.state().unhandled).toEqual([]);
  }, events.fetch);
}, 30_000);
