import { describe, expect, test, spyOn, jest } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";

import { BackgroundTasksUnsupportedError, ChatQueueFullError, CommandAttachmentsError, CommandSteeringError, ConversationRenameUnsupportedError, deriveConversationTitle, InteractionConflictError, InvalidConversationTitleError, InvalidModeSelectionError, InvalidModelSelectionError, InvalidVariantSelectionError, ChatAdapter, parseSlashCommand, QueuedMessageNotHeldError, ReversibleHistoryUnsupportedError, ScheduledWakeupsUnsupportedError, SendNowUnavailableError, SendNowUnsupportedError, SteerAlreadyDeliveredError, SteeringUnsupportedError, SteerWithdrawalUnconfirmedError, UnknownAttachmentError, UsageUnsupportedError } from "./adapter";
import { createClaudeEventMemory, normalizeClaudeMessage } from "./claude/normalization";
import { createProviderEventMemory, normalizeProviderEvent, normalizeProviderMessage, storedMessageUsage, storedPromptId, type ProviderEvent, type ProviderMessage } from "./opencode/v1/normalization";
import type { BackgroundTaskItem, ChatAgent, ChatActionContext } from "./types";
import type {
  InboxDelta,
  NormalizedProviderEvent,
  ChatProvider,
  PendingInboxEntry,
  ProviderHistoryPage,
  ProviderPermissionReply,
  ProviderSession,
  StoredMessageAccounting,
} from "./provider";
import { InterruptNotAppliedError, OperationOutcomeUnknownError, ReversibleHistoryTargetError, UnsupportedVariantSelectionError } from "./provider";
import type { ChatCommand, ChatEvent, ChatModel, ConversationItem, MessageDelivery, ToolItem, ModelSelection, ReversibleHistoryResult, ReversibleHistoryState } from "./types";
import { ConversationNotFoundError } from "./workspace";
import { MetricsRegistry } from "../debug/metrics";
import type { ConversationInventorySubscription } from "./inventory-broadcaster";
import { OpenCodeNotificationLifecycle } from "./opencode/notification-lifecycle";
import { createOpenCodeV2Provider } from "./opencode/v2/provider";
import { createOpenCodeV2Memory, createOpenCodeV2Normalizer } from "./opencode/v2/normalization";
import type { AgentNotificationEvent } from "./notifications";
import { notificationPipeline } from "../../tests/notification-pipeline";
import { startOpenCodeV2Fake } from "../../tests/e2e/opencode-v2-fake";
import { addAcceptedDraft, applyChatEvent, projectionFromSnapshot } from "./projection";

describe("production recovery Checking presentation", () => {
  const unavailable: BackgroundTaskItem = { id: "task:checking", type: "background_task", taskId: "checking", toolUseId: "checking-call",
    description: "Worker", createdAt: 1, status: "running", stateUncertain: true,
    activity: { kind: "unavailable", executionId: "execution:checking", executionAliases: ["launch:checking"], generation: 7, observedAt: 1234 },
    control: { available: false, reason: "No current proof" } };

  test("a hanging real read publishes Checking, expires despite unrelated updates, and accepts a late current result", async () => {
    const provider = new FakeProvider(); provider.sessions = [fixtureSession("session")];
    let release!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const working: BackgroundTaskItem = { ...unavailable, stateUncertain: false, activity: { ...unavailable.activity!, kind: "working", observedAt: 2345 } };
    Object.assign(provider, { reconcileBackgroundTasks: async () => { reads++; await gate; return [working]; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const projection = adapter.projectionForTests("session"); projection.upsert(unavailable);
    jest.useFakeTimers(); const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} }); await flushRecoveryIo();
      expect(reads).toBe(1);
      expect(projection.get(unavailable.id)).toMatchObject({ activity: { ...unavailable.activity!, kind: "checking" }, control: unavailable.control });
      const activityBefore = adapter.activity();
      jest.advanceTimersByTime(9000);
      provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.message.content.updated", updates: [], outcome: "handled" } });
      projection.upsert({ id: "message:unrelated", type: "assistant_message", markdown: "Unrelated update", createdAt: 2 });
      await flushRecoveryIo();
      jest.advanceTimersByTime(1000); await flushRecoveryIo();
      expect(projection.get(unavailable.id)).toMatchObject({ activity: unavailable.activity, control: unavailable.control });
      expect(adapter.activity()).toEqual(activityBefore); expect(reads).toBe(1);
      release(); await flushRecoveryIo();
      expect(projection.get(unavailable.id)).toMatchObject({ activity: working.activity, stateUncertain: false });
      expect(reads).toBe(1); // Presentation expiry did not invalidate its read fence.
      expect(provider.prompts).toEqual([]); expect(provider.interrupts).toEqual([]);
      expect(provider.permissionReplies).toEqual([]); expect(provider.questionReplies).toEqual([]);
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  for (const result of ["failed", "inconclusive"] as const) test(`${result} read ends Checking without resetting on retry reads`, async () => {
    const provider = new FakeProvider(); provider.sessions = [fixtureSession("session")];
    let release!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      if (++reads === 1) await gate;
      if (result === "failed") throw new Error("Unavailable");
      return [];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const projection = adapter.projectionForTests("session"); projection.upsert(unavailable);
    jest.useFakeTimers(); const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} }); await flushRecoveryIo();
      expect(projection.get(unavailable.id)).toMatchObject({ activity: { kind: "checking" } });
      release(); await flushRecoveryIo();
      expect(projection.get(unavailable.id)).toMatchObject({ activity: unavailable.activity });
      jest.advanceTimersByTime(1000); await flushRecoveryIo(); expect(reads).toBe(2);
      expect(projection.get(unavailable.id)).toMatchObject({ activity: unavailable.activity });
      jest.advanceTimersByTime(2000); await flushRecoveryIo(); expect(reads).toBe(3);
      expect(projection.get(unavailable.id)).toMatchObject({ activity: unavailable.activity });
      expect(provider.prompts).toEqual([]); expect(provider.interrupts).toEqual([]);
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  test("scheduled reads do not downgrade Working, canonical Needs your answer, or Ended", async () => {
    const provider = new FakeProvider(); provider.sessions = [fixtureSession("session")];
    let release!: () => void, reads = 0; const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => { reads++; await gate; return []; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const projection = adapter.projectionForTests("session");
    const workers = (["working", "needs-answer", "ended"] as const).map(kind => ({ ...unavailable, id: `task:${kind}`,
      activity: { ...unavailable.activity!, kind, ...(kind === "needs-answer" ? { request: { id: "canonical", kind: "permission" as const } } : {}) } }));
    workers.forEach(item => projection.upsert(item));
    jest.useFakeTimers(); const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} }); await flushRecoveryIo(); expect(reads).toBe(1);
      jest.advanceTimersByTime(10000); await flushRecoveryIo();
      for (const item of workers) expect(projection.get(item.id)).toEqual(item);
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  test("reconnect cancels the old presentation and result without increasing read concurrency", async () => {
    const provider = new FakeProvider(); provider.sessions = [fixtureSession("session")];
    let reads = 0; const releases: Array<() => void> = [];
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      const read = ++reads; await new Promise<void>(resolve => releases.push(resolve));
      return [{ ...unavailable, activity: { ...unavailable.activity!, kind: "working", observedAt: read } }];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const projection = adapter.projectionForTests("session"); projection.upsert(unavailable);
    jest.useFakeTimers(); const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} }); await flushRecoveryIo();
      jest.advanceTimersByTime(9000);
      provider.eventQueue.push({ type: "server.connected", data: {} }); await flushRecoveryIo();
      expect(reads).toBe(1); expect(projection.get(unavailable.id)).toMatchObject({ activity: unavailable.activity });
      releases.shift()!(); await flushRecoveryIo(); expect(reads).toBe(2);
      expect(projection.get(unavailable.id)).toMatchObject({ activity: { kind: "checking", observedAt: 1234 } });
      jest.advanceTimersByTime(1000); await flushRecoveryIo();
      expect(projection.get(unavailable.id)).toMatchObject({ activity: { kind: "checking" } });
      releases.shift()!(); await flushRecoveryIo();
      expect(projection.get(unavailable.id)).toMatchObject({ activity: { kind: "working", observedAt: 2 } });
    } finally { const disposing = adapter.dispose(); releases.splice(0).forEach(release => release()); await disposing; await pump; jest.useRealTimers(); }
  });

  for (const cancellation of ["ended", "disposed"] as const) test(`${cancellation} cancels a hanging Checking window and rejects its obsolete result`, async () => {
    const provider = new FakeProvider(); provider.sessions = [fixtureSession("session")];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => { await gate; return [{ ...unavailable, activity: { ...unavailable.activity!, kind: "working" } }]; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const projection = adapter.projectionForTests("session"); projection.upsert(unavailable);
    jest.useFakeTimers(); const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} }); await flushRecoveryIo();
      expect(projection.get(unavailable.id)).toMatchObject({ activity: { kind: "checking" } });
      const ended: BackgroundTaskItem = { ...unavailable, activity: { ...unavailable.activity!, kind: "ended", endedAt: 3456 } };
      const disposing = cancellation === "disposed" ? adapter.dispose() : undefined;
      if (cancellation === "ended") projection.upsert(ended);
      jest.advanceTimersByTime(20000); await flushRecoveryIo();
      expect(projection.get(unavailable.id)).toMatchObject({ activity: cancellation === "ended" ? ended.activity : unavailable.activity });
      release(); await flushRecoveryIo(); await disposing;
      expect(projection.get(unavailable.id)).toMatchObject({ activity: cancellation === "ended" ? ended.activity : unavailable.activity });
      expect(provider.prompts).toEqual([]); expect(provider.interrupts).toEqual([]);
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });
});

test("covered V2 snapshot preserves a rename published during its history read", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  try {
    const id = (await provider.createSession("Original title")).id;
    await adapter.history(id);
    const listMessages = provider.listMessages.bind(provider);
    let renamed = false;
    provider.listMessages = async (sessionId, options) => {
      const page = await listMessages(sessionId, options);
      if (sessionId === id && !renamed) {
        renamed = true;
        await adapter.renameConversation(id, "concurrent-rename", "Renamed while reading");
      }
      return page;
    };
    const snapshot = await adapter.history(id);
    const client = await adapter.subscribe(id, { cursor: snapshot.cursor });
    client.events.cancel();
    let browser = projectionFromSnapshot(snapshot);
    for await (const event of client.events) browser = applyChatEvent(browser, event).projection;
    expect(browser.conversation?.title).toBe("Renamed while reading");
  } finally { await adapter.dispose(); await fake.stop(); }
});

for (const large of [false, true]) test(`real V2 unchanged parent and child snapshots do not repeatedly request resync${large ? " with oversized settled worker output" : ""}`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  try {
    const parent = (await provider.createSession("Repeated recovery")).id;
    const worker = fake.launchWorker(parent, true);
    if (large) {
      fake.settleWorker(worker.childId, "completed", "Large worker result. ".repeat(14_000));
      fake.launchWorker(parent, true, worker.childId);
    }
    const listMessages = provider.listMessages.bind(provider);
    let report = 0, reporting = false;
    provider.listMessages = async (id, options) => {
      const page = await listMessages(id, options);
      if (large && reporting && id === parent) {
        const model = `Concurrent report ${++report}`;
        fake.workerReport(worker.childId, model, "high", 0.001);
        await waitUntil(() => adapter.projectionForTests(parent).items().some(item => (item.type === "tool" || item.type === "background_task") && item.workerSession?.model === model));
      }
      return page;
    };
    for (const id of large ? [parent] : [parent, worker.childId]) {
      await adapter.history(id);
      reporting = true;
      const resyncs: ChatEvent[][] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await adapter.history(id);
        const client = await adapter.subscribe(id, { cursor: snapshot.cursor });
        client.events.cancel();
        const replay: ChatEvent[] = [];
        for await (const event of client.events) replay.push(event);
        resyncs.push(replay.filter(event => event.type === "resync"));
      }
      expect(resyncs).toEqual([[], [], []]);
    }
  } finally { await adapter.dispose(); await fake.stop(); }
});

for (const kind of ["agent", "shell"] as const) for (const local of [false, true]) test(`real V2 ${local ? "local" : "external"} revert keeps live ${kind} but removes its hidden settlement`, async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  try {
    const parent = (await provider.createSession("Independent live work")).id;
    const branch = await adapter.prompt(parent, "branch", "Hide this transcript, not live work", undefined, undefined, undefined, undefined, "steer");
    const worker = kind === "agent" ? fake.launchWorker(parent, true) : fake.launchShell(parent, true);
    const taskId = `task:${worker.taskId}`;
    await adapter.history(parent);
    const client = await adapter.subscribe(parent), events: ChatEvent[] = [];
    const consuming = (async () => { for await (const event of client.events) events.push(event); })();
    try {
      if (local) await adapter.revert(parent, `message:${branch.messageId}`, "local-revert");
      else { await provider.interrupt(parent, { resume: false }); fake.externalRevert(parent, branch.messageId); }
      const snapshot = await adapter.history(parent);
      expect(snapshot.items).toContainEqual(expect.objectContaining({ id: taskId, status: "running", stateUncertain: false }));
      expect(snapshot.items.some(item => item.type === "user_message" || item.type === "tool")).toBe(false);
      const next = await adapter.subscribe(parent);
      try { expect(next.snapshot.items).toContainEqual(expect.objectContaining({ id: taskId, status: "running", stateUncertain: false })); }
      finally { next.events.cancel(); }
      await provider.stopTask!(parent, worker.taskId);
      const settledFrom = events.length;
      if ("childId" in worker) fake.settleWorker(worker.childId, "completed", "Hidden completion");
      else { fake.shellPhase(worker.shellId, "exit"); fake.shellPhase(worker.shellId, "capture"); }
      await waitUntil(() => !adapter.projectionForTests(parent).has(taskId));
      expect(events.slice(settledFrom).some(event => event.type === "item.upsert" && event.item.type === "background_task" && event.item.status !== "running")).toBe(false);
      expect((await adapter.history(parent)).items.some(item => item.id === taskId)).toBe(false);
      fake.externalRevert(parent, null);
      expect((await adapter.history(parent)).items).toContainEqual(expect.objectContaining({ id: taskId, status: kind === "agent" ? "completed" : "failed" }));
      expect(fake.state().unhandled).toEqual([]);
    } finally { client.events.cancel(); await consuming; }
  } finally { await adapter.dispose(); await fake.stop(); }
});

test("real V2 reverted live worker survives reconnect as unknown without restoring revoked Stop", async () => {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump: Promise<void> | undefined;
  try {
    const parent = (await provider.createSession("Live worker across native gap")).id;
    const branch = await adapter.prompt(parent, "branch", "Reverted launch turn", undefined, undefined, undefined, undefined, "steer");
    const worker = fake.launchWorker(parent, true), taskId = `task:${worker.taskId}`;
    await adapter.history(parent);
    await adapter.revert(parent, `message:${branch.messageId}`, "revert");
    await adapter.stopEventPump();
    pump = adapter.startEventPump();
    const snapshot = await adapter.history(parent);
    expect(snapshot.items).toContainEqual(expect.objectContaining({ id: taskId, status: "running", stateUncertain: true }));
    await expect(provider.stopTask!(parent, worker.taskId)).rejects.toThrow(/unavailable|no longer/);
    expect(fake.state().calls.filter(call => call.startsWith(`POST /api/session/${worker.childId}/interrupt`))).toEqual([]);
    expect(fake.state().sessions[worker.childId]?.running).toBe(true);
    expect(snapshot.items.some(item => item.type === "user_message" || item.type === "tool")).toBe(false);
  } finally { await adapter.dispose(); await pump; await fake.stop(); }
});

test("real V2 reconnect removes the exact offline-reverted branch for existing and next subscribers", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump: Promise<void> | undefined;
  try {
    const session = await provider.createSession("Offline revert recovery");
    const first = await adapter.prompt(session.id, "initial", "Branch to revert");
    fake.finish(session.id);
    await adapter.history(session.id);
    const client = await adapter.subscribe(session.id);
    let browser = projectionFromSnapshot(client.snapshot);
    const events: ChatEvent[] = [];
    const consuming = (async () => {
      for await (const event of client.events) {
        events.push(event);
        browser = applyChatEvent(browser, event).projection;
      }
    })();
    try {
      const oldId = `message:${first.messageId}`;
      expect(browser.items.some(item => item.id === oldId)).toBe(true);
      await adapter.stopEventPump();
      await provider.revert!(session.id, oldId);
      pump = adapter.startEventPump();
      const recovered = await adapter.history(session.id);
      expect(recovered.reversibleHistory?.staged).toBe(true);
      expect(recovered.items.some(item => item.id === oldId)).toBe(false);
      // Await the stream effect, not a fixed delay or the HTTP result alone.
      await waitUntil(() => events.some(event => event.type === "item.remove" && event.itemId === oldId));
      expect(browser.items.some(item => item.id === oldId)).toBe(false);
      const next = await adapter.subscribe(session.id);
      try {
        expect(next.snapshot.items.some(item => item.id === oldId)).toBe(false);
        expect(next.snapshot.reversibleHistory?.staged).toBe(true);
      } finally { next.events.cancel(); }
      expect(events).toContainEqual(expect.objectContaining({ type: "resync", reason: "conversation-rewritten" }));
      expect(fake.state().unhandled).toEqual([]);
    } finally { client.events.cancel(); await consuming; }
  } finally { await adapter.dispose(); await pump; await fake.stop(); }
});

test("real V2 delayed reconnect inventory cannot republish a worker after exact revert removal", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  let hold = false, captured!: () => void, release!: () => void;
  const capture = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = provider.listSessions.bind(provider);
  provider.listSessions = async () => {
    const result = await list();
    if (hold) { captured(); await gate; }
    return result;
  };
  let recoveries = 0;
  const recover = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = async (...args) => { recoveries++; return recover(...args); };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump: Promise<void> | undefined;
  try {
    const parent = (await provider.createSession("Delayed inventory revert")).id;
    const branch = await adapter.prompt(parent, "branch-to-revert", "Externally reverted turn");
    const worker = fake.launchWorker(parent, true);
    fake.settleWorker(worker.childId, "completed", "Terminal worker report");
    fake.step(parent);
    const taskId = `task:${worker.taskId}`;
    expect((await adapter.history(parent)).items).toContainEqual(expect.objectContaining({ id: taskId, status: "completed" }));
    const client = await adapter.subscribe(parent);
    const events: ChatEvent[] = [];
    const consuming = (async () => { for await (const event of client.events) events.push(event); })();
    try {
      await adapter.stopEventPump();
      fake.externalRevert(parent, branch.messageId);
      hold = true;
      pump = adapter.startEventPump();
      await capture;
      const rewritten = await adapter.history(parent);
      expect(rewritten.items.some(item => item.id === taskId)).toBe(false);
      await waitUntil(() => events.some(event => event.type === "item.remove" && event.itemId === taskId));
      const removal = events.findIndex(event => event.type === "item.remove" && event.itemId === taskId);
      const beforeRelease = recoveries;
      hold = false; release();
      await waitUntil(() => recoveries > beforeRelease);
      // Await the real recovery lane, not an early sample of its empty DOM.
      const pending = (adapter as unknown as { backgroundPending: Set<Promise<unknown>> }).backgroundPending;
      await Promise.all([...pending]);
      expect(adapter.projectionForTests(parent).has(taskId)).toBe(false);
      expect(events.slice(removal + 1).some(event => event.type === "item.upsert" && event.item.id === taskId)).toBe(false);
      const next = await adapter.subscribe(parent);
      try { expect(next.snapshot.items.some(item => item.id === taskId)).toBe(false); }
      finally { next.events.cancel(); }
      expect(fake.state().unhandled).toEqual([]);
    } finally { client.events.cancel(); await consuming; }
  } finally { release(); await adapter.dispose(); await pump; await fake.stop(); }
});

test("real V2 paged recovery never treats omission as removal and restores an offline-unreverted prefix", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump: Promise<void> | undefined;
  try {
    const session = await provider.createSession("Paged revert coverage");
    const first = await adapter.prompt(session.id, "initial", "Keep before paging");
    fake.finish(session.id);
    fake.appendHistory(session.id, 70); // Native AND visible pages, beyond the default 100.
    const loaded = await adapter.history(session.id, { limit: 200 });
    const oldest = `message:${first.messageId}`;
    const newestPrompt = loaded.items.filter(item => item.type === "user_message").at(-1)!;
    const client = await adapter.subscribe(session.id);
    const events: ChatEvent[] = [];
    let browser = projectionFromSnapshot(client.snapshot);
    const consuming = (async () => {
      for await (const event of client.events) {
        events.push(event);
        const result = applyChatEvent(browser, event);
        if (result.outcome === "resync") {
          // The browser's existing protocol reloads on rewrite; no new field.
          const current = await adapter.subscribe(session.id);
          browser = projectionFromSnapshot(current.snapshot);
          current.events.cancel();
        } else browser = result.projection;
      }
    })();
    try {
      const page = await adapter.history(session.id, { limit: 1 });
      expect(page.olderCursor).toBeDefined();
      expect(page.items.some(item => item.id === oldest)).toBe(false);
      expect(browser.items.some(item => item.id === oldest)).toBe(true);
      expect(events.some(event => event.type === "item.remove")).toBe(false);
      await adapter.stopEventPump();
      await provider.revert!(session.id, oldest);
      pump = adapter.startEventPump();
      await adapter.history(session.id);
      await waitUntil(() => !browser.items.some(item => item.id === oldest) && browser.reversibleHistory?.staged === true);
      expect(browser.items.some(item => item.id === newestPrompt.id)).toBe(false);
      await adapter.stopEventPump();
      await pump;
      // Another subscription during the gap must not declare its metadata
      // reconciled and thereby hide the restore from the reconnect owner.
      await provider.restore!(session.id, newestPrompt.id);
      const duringGap = await adapter.subscribe(session.id);
      duringGap.events.cancel();
      pump = adapter.startEventPump();
      const restored = await adapter.history(session.id);
      expect(restored.reversibleHistory?.staged).toBe(false);
      await waitUntil(() => browser.items.some(item => item.id === oldest) && browser.reversibleHistory?.staged === false);
      expect(browser.items.some(item => item.id === newestPrompt.id)).toBe(true);
      const next = await adapter.subscribe(session.id);
      try {
        expect(next.snapshot.items.some(item => item.id === oldest)).toBe(true);
        expect(next.snapshot.reversibleHistory?.staged).toBe(false);
      } finally { next.events.cancel(); }
      expect(fake.state().unhandled).toEqual([]);
    } finally { client.events.cancel(); await consuming; }
  } finally { await adapter.dispose(); await pump; await fake.stop(); }
});

for (const change of ["revert", "restore", "replacement", "replacement-before-events"] as const) test(`real V2 discards a captured history view when ${change} changes its exact boundary`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let holdEvents = false, releaseEvents!: () => void;
  const eventGate = new Promise<void>(resolve => { releaseEvents = resolve; });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (new URL(request.url).pathname !== "/api/event") return response;
    return new Response(response.body!.pipeThrough(new TransformStream({
      async transform(chunk, controller) { if (holdEvents) await eventGate; controller.enqueue(chunk); },
    })), { status: response.status, headers: response.headers });
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const other = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  let hold = false, captured!: () => void, release!: () => void;
  const capture = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    const delayed = hold;
    if (delayed) hold = false;
    const page = await list(...args);
    if (delayed) { captured(); await gate; }
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    const session = await provider.createSession("Boundary capture fence");
    await adapter.prompt(session.id, "keep", "Keep this prefix");
    fake.finish(session.id);
    const branch = await other.prompt(session.id, { id: "branch", text: "Discard or restore this branch", delivery: "queue" });
    fake.finish(session.id);
    await adapter.history(session.id);
    const branchId = `message:${branch.messageId}`;
    if (change === "restore") {
      await other.revert!(session.id, branchId);
      await adapter.history(session.id);
    }
    const client = await adapter.subscribe(session.id);
    const events: ChatEvent[] = [];
    const consuming = (async () => { for await (const event of client.events) events.push(event); })();
    try {
      // For replacement, the staged boundary is intentionally NOT yet applied
      // to Uatu's view: its exact exclusions must survive the dirty reread.
      if (change.startsWith("replacement")) await other.revert!(session.id, branchId);
      hold = true;
      reading = adapter.history(session.id);
      await capture;
      holdEvents = change === "replacement-before-events";
      let replacementId: string | undefined;
      if (change === "revert") await other.revert!(session.id, branchId);
      else if (change === "restore") await other.restore!(session.id, branchId);
      else {
        replacementId = (await other.prompt(session.id, { id: "external-replacement", text: "New turn after capture", delivery: "queue" })).messageId;
        fake.finish(session.id);
        if (!holdEvents) await waitUntil(() => events.some(event => event.type === "item.upsert" && event.item.type === "user_message" && event.item.text === "New turn after capture"));
      }
      release();
      const recovered = await reading;
      expect(recovered.reversibleHistory?.staged).toBe(change === "revert");
      expect(recovered.items.some(item => item.id === branchId)).toBe(change === "restore");
      const next = await adapter.subscribe(session.id);
      try {
        expect(next.snapshot.items.some(item => item.id === branchId)).toBe(change === "restore");
        expect(next.snapshot.items.some(item => item.type === "user_message" && item.text === "Keep this prefix")).toBe(true);
        if (replacementId) expect(next.snapshot.items.some(item => item.id === `message:${replacementId}`)).toBe(true);
      } finally { next.events.cancel(); }
      if (change === "restore") expect(events.some(event => event.type === "item.remove" && event.itemId === branchId)).toBe(false);
      expect(fake.state().unhandled).toEqual([]);
    } finally { client.events.cancel(); await consuming; }
  } finally { release(); releaseEvents(); await reading?.catch(() => undefined); await adapter.dispose(); await other.dispose?.(); await fake.stop(); }
});

test("real V2 obsolete-generation revert exclusions cannot prune an offline-restored view", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const other = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  let hold = false, captured!: () => void, release!: () => void, returned!: () => void;
  const capture = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lateReturn = new Promise<void>(resolve => { returned = resolve; });
  const list = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    const delayed = hold;
    if (delayed) hold = false;
    const page = await list(...args);
    if (delayed) { captured(); await gate; returned(); }
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let reading: Promise<unknown> | undefined, pump: Promise<void> | undefined;
  try {
    const session = await provider.createSession("Obsolete revert read");
    const first = await adapter.prompt(session.id, "initial", "Restored branch");
    fake.finish(session.id);
    await adapter.history(session.id);
    const oldId = `message:${first.messageId}`;
    await other.revert!(session.id, oldId);
    hold = true;
    reading = adapter.history(session.id).catch(error => error);
    await capture;
    await adapter.stopEventPump();
    expect(await reading).toBeInstanceOf(Error);
    await other.restore!(session.id, oldId);
    pump = adapter.startEventPump();
    const current = await adapter.history(session.id);
    expect(current.items.some(item => item.id === oldId)).toBe(true);
    release();
    await lateReturn;
    const next = await adapter.subscribe(session.id);
    try {
      expect(next.snapshot.items.some(item => item.id === oldId)).toBe(true);
      expect(next.snapshot.reversibleHistory?.staged).toBe(false);
    } finally { next.events.cancel(); }
    expect(fake.state().unhandled).toEqual([]);
  } finally { release(); await reading; await adapter.dispose(); await pump; await other.dispose?.(); await fake.stop(); }
});

test("real V2 narrow revert recovery preserves uncertain original requests, held pause and newer terminal worker metadata", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "DELETE" && new URL(request.url).pathname.includes("/inbox/")) return Response.json({ error: "cancellation unavailable" }, { status: 503 });
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const other = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  let hold = false, captured!: () => void, release!: () => void;
  const capture = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    const delayed = hold;
    if (delayed) hold = false;
    const page = await list(...args);
    if (delayed) { captured(); await gate; }
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerWithdrawTimeoutMs: 80 });
  let pump: Promise<void> | undefined;
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    const session = await provider.createSession("Narrow recovery ownership");
    await adapter.prompt(session.id, "prefix", "Keep the worker's prefix");
    const worker = fake.launchWorker(session.id, true);
    fake.workerReport(worker.childId, "old-model", "low", 0.25);
    await adapter.history(session.id);
    const client = await adapter.subscribe(session.id);
    let browser = projectionFromSnapshot(client.snapshot);
    const consuming = (async () => {
      for await (const event of client.events) {
        const result = applyChatEvent(browser, event);
        if (result.outcome === "resync") {
          const current = await adapter.subscribe(session.id);
          browser = projectionFromSnapshot(current.snapshot);
          current.events.cancel();
        } else browser = result.projection;
      }
    })();
    try {
      fake.finish(session.id);
      await waitUntil(() => browser.status === "background");
      const branch = await other.prompt(session.id, { id: "branch", text: "Revert only this branch", delivery: "queue" });
      await waitUntil(() => browser.status === "running");
      fake.loseNextPromptResponse();
      await expect(adapter.prompt(session.id, "original-client-request", "Keep pending native input", undefined, undefined, undefined, undefined, "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const pending = (await adapter.history(session.id)).queued!.find(entry => entry.requestId === "original-client-request")!;
      expect(pending).toBeDefined();
      const held = await adapter.prompt(session.id, "held-client-request", "Keep held input");
      await expect(adapter.changeDelivery(session.id, pending.id, "uncertain-withdrawal", "queue")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      await adapter.stopEventPump();
      await other.interrupt(session.id, { resume: false });
      await other.revert!(session.id, `message:${branch.messageId}`);
      const beforeRecovery = fake.state().calls.length;
      hold = true;
      pump = adapter.startEventPump();
      reading = adapter.history(session.id);
      void reading.catch(() => undefined);
      await capture;
      fake.settleWorker(worker.childId, "completed", "Terminal report during recovery");
      fake.workerReport(worker.childId, "latest-model", "high", 0.5);
      await waitUntil(() => browser.items.some(item => item.type === "background_task" && item.taskId === worker.taskId && item.status === "completed")
        && browser.items.some(item => item.type === "tool" && item.workerSession?.model === "latest-model" && item.workerSession.costUsd === 0.75));
      release();
      const recovered = await reading;
      expect(recovered.reversibleHistory?.staged).toBe(true);
      expect(recovered.items.some(item => item.id === `message:${branch.messageId}`)).toBe(false);
      for (const snapshot of [recovered, (await adapter.history(session.id))]) {
        expect(snapshot.queued).toContainEqual(expect.objectContaining({ id: pending.id, requestId: "original-client-request", delivery: "steer", unconfirmed: true, paused: true }));
        expect(snapshot.queued).toContainEqual(expect.objectContaining({ id: held.messageId, requestId: "held-client-request", paused: true }));
        expect(snapshot.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
        expect(snapshot.items).toContainEqual(expect.objectContaining({ id: `tool:${worker.callId}`, workerSession: { model: "latest-model", effort: "high", costUsd: 0.75 } }));
      }
      expect(fake.state().calls.slice(beforeRecovery).every(call => call.startsWith("GET "))).toBe(true);
      expect(fake.state().unhandled).toEqual([]);
    } finally { client.events.cancel(); await consuming; }
  } finally { release(); await reading?.catch(() => undefined); await adapter.dispose(); await pump; await other.dispose?.(); await fake.stop(); }
});

test("real V2 restores out-of-page rows when distinct non-user boundaries have identical reversible UI state", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  try {
    const session = await provider.createSession("Exact non-user boundary");
    await adapter.prompt(session.id, "initial", "Prefix prompt");
    const first = fake.finish(session.id, "Restored out-of-page assistant")!;
    fake.appendHistory(session.id, 70);
    const loaded = await adapter.history(session.id, { limit: 200 });
    const oldAssistant = loaded.items.find(item => item.type === "assistant_message" && item.markdown === "Restored out-of-page assistant")!;
    expect(oldAssistant).toBeDefined();
    const lastAssistant = fake.state().sessions[session.id]!.messages.filter(message => message.type === "assistant").at(-1)!;
    const stage = async (messageID: string) => {
      // A different native client can stage a non-user record. The UI's turn
      // list intentionally cannot encode that exact marker; native evidence can.
      const response = await fetch(`${fake.url}/api/session/${session.id}/revert/stage`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`opencode:${fake.password}`).toString("base64")}`, "content-type": "application/json" },
        body: JSON.stringify({ messageID }),
      });
      expect(response.ok).toBe(true);
      await response.arrayBuffer();
    };
    await stage(first.assistantMessageId);
    const hidden = await adapter.history(session.id, { limit: 1 });
    const during = await adapter.subscribe(session.id);
    expect(during.snapshot.items.some(item => item.id === oldAssistant.id)).toBe(false);
    during.events.cancel();
    await stage(lastAssistant.id);
    const restored = await adapter.history(session.id, { limit: 1 });
    expect(restored.reversibleHistory).toEqual(hidden.reversibleHistory);
    const next = await adapter.subscribe(session.id);
    try { expect(next.snapshot.items.some(item => item.id === oldAssistant.id)).toBe(true); }
    finally { next.events.cancel(); }
    expect(fake.state().unhandled).toEqual([]);
  } finally { await adapter.dispose(); await fake.stop(); }
});

test("real V2 initial history includes a steer delivered before the native handshake", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let requested!: () => void, connect!: () => void;
  const eventRequested = new Promise<void>(resolve => { requested = resolve; });
  const connection = new Promise<void>(resolve => { connect = resolve; });
  let historyBeforeConnected = 0, attaching = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/event") { requested(); await connection; }
    if (attaching && pathname.endsWith("/message") && fake.state().eventSubscribers === 0) historyBeforeConnected++;
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  try {
    const session = await provider.createSession("Initial history coverage");
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "steer", "Delivered in the handshake gap", undefined, undefined, undefined, undefined, "steer");
    attaching = true;
    const reading = adapter.history(session.id);
    await eventRequested;
    fake.step(session.id);
    connect();
    const snapshot = await reading;
    expect(snapshot.items.filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
    expect(snapshot.queued).toEqual([]);
    expect(historyBeforeConnected).toBe(0);
  } finally { connect(); await adapter.dispose(); await fake.stop(); }
});

for (const reconnect of [false, true]) test(`real V2 disconnect aborts a snapshot's worker read and retains its ${reconnect ? "new-generation completion" : "uncertain owner"}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let hold = false, captured!: () => void, release!: () => void, returned!: () => void;
  const activeCaptured = new Promise<void>(resolve => { captured = resolve; });
  const activeGate = new Promise<void>(resolve => { release = resolve; });
  const activeReturned = new Promise<void>(resolve => { returned = resolve; });
  let activeSignal: AbortSignal | undefined;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (hold && new URL(request.url).pathname === "/api/session/active") {
      hold = false;
      const body = await response.text();
      activeSignal = request.signal;
      captured();
      await activeGate; // Deliberately return a late result even after abort.
      returned();
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let reading: Promise<unknown> | undefined;
  let pump: Promise<void> | undefined;
  try {
    const session = await provider.createSession("Worker snapshot generation");
    await adapter.prompt(session.id, "initial", "Initial work");
    const worker = fake.launchWorker(session.id, true);
    expect((await adapter.history(session.id)).items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, stateUncertain: false }));
    hold = true;
    reading = adapter.history(session.id).catch(error => error);
    await activeCaptured;
    fake.disconnect();
    await adapter.stopEventPump();
    expect(activeSignal?.aborted).toBe(true);
    expect(await reading).toBeInstanceOf(Error);
    const client = await adapter.subscribe(session.id);
    expect(client.snapshot.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: true }));
    let browser = projectionFromSnapshot(client.snapshot);
    const clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    try {
      if (reconnect) {
        fake.settleWorker(worker.childId, "completed", "Finished while disconnected");
        pump = adapter.startEventPump();
        // The current read must not coalesce with the still-pending old one.
        await waitUntil(() => browser.items.some(item => item.type === "background_task" && item.taskId === worker.taskId && item.status === "completed"));
        expect(fake.state().eventSubscribers).toBe(1);
      }
      release();
      await activeReturned;
      const current = await adapter.subscribe(session.id);
      expect(current.snapshot.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: reconnect ? "completed" : "running", stateUncertain: !reconnect }));
      current.events.cancel();
    } finally { client.events.cancel(); await clientPump; }
  } finally { release(); await reading; await adapter.dispose(); await pump; await fake.stop(); }
});

test("real V2 live delivery completion and worker metadata survive an older in-flight history snapshot", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  let hold = false, captured!: () => void, release!: () => void;
  const capturedPage = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = provider.listMessages.bind(provider);
  provider.listMessages = async (...args) => {
    const delayed = hold;
    if (delayed) hold = false;
    const page = await list(...args);
    if (delayed) { captured(); await gate; }
    return page;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    const session = await provider.createSession("Live history fence");
    await adapter.prompt(session.id, "initial", "Initial work");
    const worker = fake.launchWorker(session.id, true);
    fake.workerReport(worker.childId, "old-model", "low", 0.1);
    await adapter.history(session.id);
    const client = await adapter.subscribe(session.id);
    let browser = projectionFromSnapshot(client.snapshot);
    const clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    try {
      const steer = await adapter.prompt(session.id, "steer", "Delivered while history waits", undefined, undefined, undefined, undefined, "steer");
      await waitUntil(() => browser.queued.some(item => item.id === steer.messageId));
      hold = true;
      reading = adapter.history(session.id);
      await capturedPage;
      fake.step(session.id);
      fake.workerReport(worker.childId, "latest-model", "high", 0.2);
      await waitUntil(() => browser.items.some(item => item.type === "tool" && item.workerSession?.model === "latest-model" && item.workerSession.effort === "high"));
      fake.settleWorker(worker.childId, "completed", "Completed during history read");
      await waitUntil(() => browser.items.some(item => item.id === `message:${steer.messageId}`));
      // The native final step reports its own default model and no effort or
      // price. Those deliberate metadata clears outrank the older page too.
      await waitUntil(() => browser.items.some(item => item.type === "tool" && item.workerSession?.model === "fake-model" && item.workerSession.effort === null && item.workerSession.costUsd === null)
        && browser.items.some(item => item.type === "background_task" && item.taskId === worker.taskId && item.status === "completed"));
      release();
      const snapshot = await reading;
      expect(snapshot.items.filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
      expect(snapshot.queued).toEqual([]);
      expect(browser.items.filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
      expect(snapshot.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "completed" }));
      expect(snapshot.items).toContainEqual(expect.objectContaining({ id: `tool:${worker.callId}`, workerSession: { model: "fake-model", effort: null, costUsd: null } }));
    } finally { client.events.cancel(); await clientPump; }
  } finally { release(); await reading?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
});

test("real V2 reconnect refreshes child model effort and cost without reusing the previous generation", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump: Promise<void> | undefined;
  try {
    const session = await provider.createSession("Child recovery generation");
    await adapter.prompt(session.id, "initial", "Initial work");
    const worker = fake.launchWorker(session.id, true);
    fake.workerReport(worker.childId, "old-model", "low", 0.1);
    const initial = await adapter.history(session.id);
    expect(initial.items).toContainEqual(expect.objectContaining({ id: `tool:${worker.callId}`, workerSession: { model: "old-model", effort: "low", costUsd: 0.1 } }));
    const client = await adapter.subscribe(session.id);
    let browser = projectionFromSnapshot(client.snapshot);
    const clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    try {
      await adapter.stopEventPump();
      fake.workerReport(worker.childId, "new-model", "high", 0.2);
      pump = adapter.startEventPump();
      await waitUntil(() => browser.items.some(item => item.type === "tool" && item.workerSession?.model === "new-model"));
      expect(browser.items).toContainEqual(expect.objectContaining({ id: `tool:${worker.callId}`, workerSession: { model: "new-model", effort: "high", costUsd: 0.30000000000000004 } }));
    } finally { client.events.cancel(); await clientPump; }
  } finally { await adapter.dispose(); await pump; await fake.stop(); }
});

for (const kind of ["worker", "history"] as const) test(`real V2 abort releases a covered ${kind}-read owner even when its transport returns late`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let hold = false, captured!: () => void, release!: () => void;
  const activeCaptured = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    const pathname = new URL(request.url).pathname;
    if (hold && (kind === "worker" ? pathname === "/api/session/active" : pathname.endsWith("/message"))) {
      hold = false;
      const body = await response.text();
      captured();
      await gate;
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let reading: Promise<unknown> | undefined;
  try {
    const session = await provider.createSession("Bounded worker read ownership");
    await adapter.prompt(session.id, "initial", "Initial work");
    const worker = fake.launchWorker(session.id, true);
    await adapter.history(session.id);
    const target = kind === "worker" ? session : await provider.createSession("Cold covered history read");
    const controller = new AbortController();
    hold = true;
    let settled = false;
    reading = (kind === "worker" ? provider.reconcileBackgroundTasks!(target.id, { signal: controller.signal })
      : provider.listMessages(target.id, { limit: 50, signal: controller.signal })).catch(error => error).finally(() => { settled = true; });
    await activeCaptured;
    controller.abort();
    await flushUntil(() => settled);
    expect(await reading).toBeInstanceOf(Error);
    // A new current read is neither blocked on the retired owner nor forced
    // to create another event subscription to recover its worker controls.
    const snapshot = await adapter.history(target.id);
    if (kind === "worker") expect(snapshot.items).toContainEqual(expect.objectContaining({ taskId: worker.taskId, status: "running", stateUncertain: false }));
    else expect(snapshot.items).toEqual([]);
    expect(fake.state().eventSubscribers).toBe(1);
  } finally { release(); await reading; await adapter.dispose(); await fake.stop(); }
});

test("real V2 covered history preserves cursor validation and missing-session errors", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  try {
    const session = await provider.createSession("Covered history errors");
    await expect(adapter.history(session.id, { cursor: "invalid" })).rejects.toThrow("invalid history cursor");
    await expect(adapter.history("ses_missing")).rejects.toBeInstanceOf(ConversationNotFoundError);
  } finally { await adapter.dispose(); await fake.stop(); }
});

test("real V2 resolved questions and public provider removals survive an older covered form read", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let owner = "", pending = true, hold = false, captured!: () => void, release!: () => void;
  const formCaptured = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/api/form") {
      const data = pending ? [{ id: "frm_covered", sessionID: owner, title: "Choose", fields: [{ key: "choice", type: "string", label: "Choice" }] }] : [];
      if (hold) { captured(); await gate; }
      return Response.json({ data });
    }
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const events = provider.events.bind(provider);
  const normalize = createOpenCodeV2Normalizer(directory);
  const memory = createOpenCodeV2Memory();
  const injected: NormalizedProviderEvent[] = [];
  // Extend the fake at the public event seam; the form frame still goes
  // through the actual V2 normalizer, not a projection/private-state patch.
  provider.events = async function* (signal) {
    for await (const event of events(signal)) {
      yield event;
      while (injected.length) yield injected.shift()!;
    }
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    const session = await provider.createSession("Question history fence");
    owner = session.id;
    const initial = await adapter.prompt(session.id, "initial", "Initial work");
    expect((await adapter.history(session.id)).items).toContainEqual(expect.objectContaining({ id: "question:frm_covered", status: "pending" }));
    const client = await adapter.subscribe(session.id);
    let browser = projectionFromSnapshot(client.snapshot);
    const clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    try {
      hold = true;
      reading = adapter.history(session.id);
      await formCaptured;
      pending = false;
      injected.push(normalize({ id: "evt_form_cancelled", type: "form.cancelled", created: Date.now(), location: { directory }, data: { id: "frm_covered", sessionID: owner } }, memory));
      // Exercise the seam's removal contract without claiming a stronger
      // native V2 removal/replay protocol than the provider exposes.
      injected.push({ conversationId: owner, eventType: "fixture.remove", outcome: "handled", updates: [{ kind: "remove", itemId: `message:${initial.messageId}` }] });
      await provider.prompt(session.id, { id: "form-event-tick", text: "Explicit fake event tick", delivery: "steer" });
      await waitUntil(() => browser.items.some(item => item.id === "question:frm_covered" && item.type === "question" && item.status === "resolved") && !browser.items.some(item => item.id === `message:${initial.messageId}`));
      release();
      const snapshot = await reading;
      expect(snapshot.items).toContainEqual(expect.objectContaining({ id: "question:frm_covered", status: "resolved" }));
      expect(snapshot.items.some(item => item.id === `message:${initial.messageId}`)).toBe(false);
      expect(browser.items.filter(item => item.type === "question" && item.status === "pending")).toEqual([]);
    } finally { client.events.cancel(); await clientPump; }
  } finally { release(); await reading?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
});

test("real V2 reconnect establishes its subscription before reading the native inbox", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let reconnect = false, inboxReads = 0, eventRequests = 0;
  let requested!: () => void, release!: () => void;
  const eventRequested = new Promise<void>(resolve => { requested = resolve; });
  const eventGate = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (reconnect && pathname.endsWith("/inbox")) inboxReads++;
    if (pathname === "/api/event") {
      eventRequests++;
      if (reconnect) { requested(); await eventGate; }
    }
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump = adapter.startEventPump();
  try {
    await waitUntil(() => fake.state().eventSubscribers === 1);
    const session = await provider.createSession("Reconnect handoff");
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "steer", "Old native instruction", undefined, undefined, undefined, undefined, "steer");
    const held = await adapter.prompt(session.id, "held", "Held until a later turn", undefined, undefined, undefined, undefined, "queue");
    const client = await adapter.subscribe(session.id);
    let browser = projectionFromSnapshot(client.snapshot);
    const clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    await adapter.stopEventPump(); await pump;
    await waitUntil(() => fake.state().eventSubscribers === 0);
    reconnect = true;
    pump = adapter.startEventPump();
    await eventRequested;
    // Instantiating an async generator (or starting a pump) is not a subscription.
    expect(inboxReads).toBe(0);
    fake.step(session.id);
    const external = await provider.prompt(session.id, { id: "external-gap", text: "Another client's instruction", delivery: "steer" });
    release();
    await waitUntil(() => inboxReads > 0 && adapter.pendingSteersForTests(session.id).some(entry => entry.id === external.messageId));
    expect(adapter.pendingSteersForTests(session.id).map(entry => entry.id)).toEqual([external.messageId]);
    // Already-listening clients recover the entire missed handoff, without a
    // manual history request or replaying any delivery operation.
    try {
      await waitUntil(() => browser.items.some(item => item.id === `message:${steer.messageId}`) && browser.queued.some(item => item.id === external.messageId));
      expect(browser.items.filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
    } finally { client.events.cancel(); await clientPump; }
    const snapshot = await adapter.history(session.id);
    expect(snapshot.items.filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
    expect(snapshot.queued?.map(entry => entry.id)).toEqual([external.messageId, held.messageId]);
    await adapter.history(session.id);
    expect(eventRequests).toBe(2); // Already-connected reads reuse this subscription.
    expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(3);
    expect(fake.state().calls.some(call => call.includes("resume=true") || call.includes("/background"))).toBe(false);
  } finally { release(); await adapter.dispose(); await pump; await fake.stop(); }
});

for (const failure of ["http-503", "transport"] as const) test(`real V2 reconnect reports ${failure} inbox recovery unavailable after a successful handshake`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let reconnect = false, failInbox = false, failedReads = 0, subscriptions = 0;
  const inboxOwner = new AsyncLocalStorage<{ kind: "covered" | "background"; generation: number }>();
  let holdBackground = true, backgroundReleased!: () => void, releaseBackground!: () => void;
  const backgroundDone = new Promise<void>(resolve => { backgroundReleased = resolve; });
  const backgroundGate = new Promise<void>(resolve => { releaseBackground = resolve; });
  let delayedProbe: { generation: number; enteredWith: number; releasedWith?: number; aborted?: boolean } | undefined;
  let handshakes = 0;
  const handshakesAtFailure: number[] = [];
  const reads: { owner: string; generation: number; enteredAt: number; enteredWith: number; abortedAtEntry: boolean; injectedAt?: number; injectedWith?: number }[] = [];
  const requests: string[] = [];
  const subscribersAtFailure: number[] = [];
  let requested!: () => void, release!: () => void;
  const eventRequested = new Promise<void>(resolve => { requested = resolve; });
  const eventGate = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname === "/api/event") {
      subscriptions++;
      if (reconnect) { requested(); await eventGate; }
    }
    const owner = inboxOwner.getStore();
    const inbox = request.method === "GET" && pathname.endsWith("/inbox");
    const read: typeof reads[number] | undefined = inbox ? { owner: owner?.kind ?? "unknown", generation: owner?.generation ?? -1, enteredAt: performance.now(), enteredWith: fake.state().eventSubscribers, abortedAtEntry: request.signal.aborted } : undefined;
    if (read) reads.push(read);
    // Background inventory also reads /inbox. Let a real old-generation probe
    // reach the fault seam while the new stream is gated: it is not the
    // authoritative pending-steer read this failure is meant to exercise.
    if (inbox && owner?.kind === "background" && holdBackground) {
      holdBackground = false;
      delayedProbe = { generation: owner.generation, enteredWith: fake.state().eventSubscribers };
      await backgroundGate;
      delayedProbe.releasedWith = fake.state().eventSubscribers;
      delayedProbe.aborted = request.signal.aborted;
      backgroundReleased();
    }
    if (failInbox && inbox && owner?.kind === "covered") {
      failedReads++;
      subscribersAtFailure.push(fake.state().eventSubscribers);
      handshakesAtFailure.push(handshakes);
      read!.injectedAt = performance.now();
      read!.injectedWith = fake.state().eventSubscribers;
      if (failure === "transport") throw new Error("Scripted inbox transport failure");
      return Response.json({ error: "Scripted inbox unavailable" }, { status: 503 });
    }
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  // Tag public calls without replacing their implementation or transport.
  // Async ownership matters: a global /inbox flag can fault an unrelated old
  // inventory probe after stop, and mistake that probe for reconnect recovery.
  const listInbox = provider.listPendingInbox!.bind(provider);
  provider.listPendingInbox = (...args) => inboxOwner.run({ kind: "covered", generation: subscriptions }, () => listInbox(...args));
  const background = provider.reconcileBackgroundTasks!.bind(provider);
  provider.reconcileBackgroundTasks = (...args) => inboxOwner.run({ kind: "background", generation: subscriptions }, () => background(...args));
  const events = provider.events.bind(provider);
  provider.events = async function* (signal) {
    for await (const event of events(signal)) {
      if (event.eventType === "server.connected") handshakes++;
      yield event;
    }
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump = adapter.startEventPump();
  try {
    await waitUntil(() => fake.state().eventSubscribers === 1);
    const session = await provider.createSession("Failed reconnect read");
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "steer", "A delivered before handshake", undefined, undefined, undefined, undefined, "steer");
    const held = await adapter.prompt(session.id, "held", "Retain the held owner", undefined, undefined, undefined, undefined, "queue");
    await waitUntil(() => delayedProbe !== undefined);
    await adapter.stopEventPump(); await pump;
    await waitUntil(() => fake.state().eventSubscribers === 0);
    reconnect = true;
    failInbox = true;
    pump = adapter.startEventPump();
    await eventRequested;
    releaseBackground();
    await backgroundDone;
    expect(delayedProbe).toEqual({ generation: 1, enteredWith: 1, releasedWith: 0, aborted: true });
    fake.step(session.id);
    const external = await provider.prompt(session.id, { id: "external-before-failed-read", text: "B pending before handshake", delivery: "steer" });
    expect(fake.state().sessions[session.id]!.pending.map(entry => entry.id)).toEqual([external.messageId]);
    const beforeRecovery = requests.length;
    expect(reads.filter(read => read.owner === "covered" && read.generation === 2)).toEqual([]);
    release();
    await waitUntil(() => failedReads > 0);
    // The live stream is healthy, but missed A/B changes cannot be recovered
    // from it: V2 has no replay. A failed authoritative list is not current.
    const result = await adapter.history(session.id).catch(error => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Inbox recovery unavailable");
    expect(subscribersAtFailure.length).toBeGreaterThan(0);
    expect(subscribersAtFailure.every(count => count === 1), JSON.stringify({ failure, subscribersAtFailure, handshakesAtFailure, reads })).toBe(true);
    expect(handshakesAtFailure.every(generation => generation === 2)).toBe(true);
    expect(adapter.pendingSteersForTests(session.id).map(entry => entry.id)).toEqual([steer.messageId]);
    expect(fake.state().sessions[session.id]!.pending.map(entry => entry.id)).toEqual([external.messageId]);
    failInbox = false;
    await adapter.stopEventPump(); await pump;
    await waitUntil(() => fake.state().eventSubscribers === 0);
    pump = adapter.startEventPump();
    await waitUntil(() => adapter.pendingSteersForTests(session.id).some(entry => entry.id === external.messageId));
    const recovered = await adapter.history(session.id);
    expect(recovered.queued?.map(entry => entry.id)).toEqual([external.messageId, held.messageId]);
    expect(recovered.items.filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
    expect(adapter.pendingSteersForTests(session.id).map(entry => entry.id)).toEqual([external.messageId]);
    expect(subscriptions).toBe(3);
    expect(requests.slice(beforeRecovery).every(call => call.startsWith("GET "))).toBe(true);
    expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(3);
  } finally { releaseBackground(); release(); await adapter.dispose(); await pump; await fake.stop(); }
});

for (const snapshotKind of ["stale", "empty"] as const) test(`real V2 initial attach fences a late ${snapshotKind} inbox snapshot behind live delivery and enqueue`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let eventRequested!: () => void, connect!: () => void, listCaptured!: () => void, releaseList!: () => void;
  const requested = new Promise<void>(resolve => { eventRequested = resolve; });
  const connection = new Promise<void>(resolve => { connect = resolve; });
  const captured = new Promise<void>(resolve => { listCaptured = resolve; });
  const listGate = new Promise<void>(resolve => { releaseList = resolve; });
  let lists = 0, subscriptions = 0;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/event") { subscriptions++; eventRequested(); await connection; }
    const response = await fetch(request);
    if (pathname.endsWith("/inbox")) {
      lists++;
      const body = await response.json() as { data: unknown[] };
      // Both attach and connected recovery are in flight before live deltas.
      if (lists === 2) listCaptured();
      await listGate;
      return Response.json(snapshotKind === "empty" ? { ...body, data: [] } : body);
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    const session = await provider.createSession("Initial read handoff");
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "steer", "Deliver during read", undefined, undefined, undefined, undefined, "steer");
    const before = fake.state().calls.length;
    reading = adapter.history(session.id); // No pump was started by the caller.
    await requested;
    expect(lists).toBe(0);
    expect(fake.state().eventSubscribers).toBe(0);
    connect();
    await captured;
    fake.step(session.id);
    const external = await provider.prompt(session.id, { id: "external-during-read", text: "Newer than snapshot", delivery: "steer" });
    await waitUntil(() => !adapter.pendingSteersForTests(session.id).some(entry => entry.id === steer.messageId) && adapter.pendingSteersForTests(session.id).some(entry => entry.id === external.messageId));
    releaseList();
    const snapshot = await reading;
    expect(snapshot.queued?.map(entry => entry.id)).toEqual([external.messageId]);
    expect(snapshot.items.filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
    expect(adapter.pendingSteersForTests(session.id).map(entry => entry.id)).toEqual([external.messageId]);
    // This generation missed the original enqueue payload; its native stored
    // transcript, rather than an invented delivery row, supplies that input.
    expect((await adapter.history(session.id)).items.filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
    expect(subscriptions).toBe(1);
    expect(fake.state().calls.slice(before).filter(call => !call.startsWith("GET "))).toHaveLength(1); // Only the explicit external prompt.
  } finally { connect(); releaseList(); await reading?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
});

for (const failure of ["refused", "disposed", "timeout"] as const) test(`real V2 ${failure} readiness releases attach without treating unread inbox state as empty`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let requested!: () => void;
  const eventRequested = new Promise<void>(resolve => { requested = resolve; });
  let lists = 0, closed = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith("/inbox")) lists++;
    if (pathname === "/api/event") {
      requested();
      if (failure === "refused") return Response.json({ _tag: "UnauthorizedError", message: "Stream refused" }, { status: 401 });
      let abort!: () => void;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          abort = () => { closed = true; controller.close(); request.signal.removeEventListener("abort", abort); };
          request.signal.addEventListener("abort", abort, { once: true });
        },
        cancel() { closed = true; request.signal.removeEventListener("abort", abort); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let reading: Promise<Awaited<ReturnType<ChatAdapter["history"]>> | Error> | undefined;
  try {
    const session = await provider.createSession("Unavailable subscription");
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "steer", "Retain on unavailable recovery", undefined, undefined, undefined, undefined, "steer");
    const before = fake.state().calls.length;
    reading = adapter.history(session.id).catch(error => error);
    await eventRequested;
    if (failure === "disposed") await adapter.dispose();
    let timer!: ReturnType<typeof setTimeout>;
    const stalled = new Promise<"still blocked">(resolve => { timer = setTimeout(() => resolve("still blocked"), failure === "timeout" ? 6_500 : 1_000); });
    const result = await Promise.race([reading, stalled]).finally(() => clearTimeout(timer));
    expect(result).not.toBe("still blocked");
    if (failure !== "disposed") {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("Inbox recovery unavailable");
    }
    expect(adapter.pendingSteersForTests(session.id).map(entry => entry.id)).toEqual([steer.messageId]);
    expect(lists).toBe(0);
    expect(fake.state().calls.slice(before).every(call => call.startsWith("GET "))).toBe(true);
    await adapter.dispose();
    if (failure !== "refused") expect(closed).toBe(true);
  } finally { await adapter.dispose(); await reading; await fake.stop(); }
}, 10_000);

test("real V2 an inbox read from an ended subscription cannot overwrite the next generation", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let delay = false, captured!: () => void, release!: () => void, returned!: () => void;
  const listCaptured = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const listReturned = new Promise<void>(resolve => { returned = resolve; });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const list = provider.listPendingInbox!.bind(provider);
  provider.listPendingInbox = async (...args) => {
    const delayed = delay;
    if (delayed) delay = false;
    try {
      // Delay this public inbox read's result, not an unrelated worker read
      // of the same HTTP endpoint. The real V2 provider still performs I/O.
      const entries = await list(...args);
      if (delayed) { captured(); await gate; }
      return entries;
    } finally { if (delayed) returned(); }
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  let pump = adapter.startEventPump();
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    await waitUntil(() => fake.state().eventSubscribers === 1);
    const session = await provider.createSession("Ended read generation");
    await adapter.prompt(session.id, "initial", "Initial work");
    await adapter.prompt(session.id, "steer", "Old instruction", undefined, undefined, undefined, undefined, "steer");
    delay = true;
    reading = adapter.history(session.id);
    void reading.catch(() => undefined); // Observe abort while stopEventPump drains.
    await listCaptured;
    await adapter.stopEventPump(); await pump;
    // Stopping the covering stream releases attach even if its read transport
    // refuses to return yet. Neither its last handshake nor its reply is fresh.
    await expect(reading).rejects.toThrow("Inbox recovery unavailable");
    await waitUntil(() => fake.state().eventSubscribers === 0);
    fake.step(session.id);
    const external = await provider.prompt(session.id, { id: "next-generation", text: "Current native instruction", delivery: "steer" });
    pump = adapter.startEventPump();
    await waitUntil(() => adapter.pendingSteersForTests(session.id).some(entry => entry.id === external.messageId));
    release(); await listReturned;
    expect(adapter.pendingSteersForTests(session.id).map(entry => entry.id)).toEqual([external.messageId]);
    expect((await adapter.history(session.id)).queued?.map(entry => entry.id)).toEqual([external.messageId]);
  } finally { release(); await reading?.catch(() => undefined); await adapter.dispose(); await pump; await fake.stop(); }
});

for (const origin of ["composer", "held"] as const) for (const delivery of ["stored", "covered", "covered-with-eviction"] as const) test(`real V2 lost steer acknowledgement keeps original ${origin} correlation after ${delivery} delivery recovery`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let blockEvents = false, requested!: () => void, release!: () => void;
  const reconnect = new Promise<void>(resolve => { requested = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (blockEvents && new URL(request.url).pathname === "/api/event") { requested(); await gate; }
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  let captureInbox = false, captured!: () => void, releaseInbox!: () => void;
  const inboxCaptured = new Promise<void>(resolve => { captured = resolve; });
  const inboxGate = new Promise<void>(resolve => { releaseInbox = resolve; });
  const list = provider.listPendingInbox!.bind(provider);
  provider.listPendingInbox = async (...args) => {
    const entries = await list(...args);
    if (captureInbox) { captured(); await inboxGate; }
    return entries;
  };
  const stored = { id: "11111111-2222-4333-8444-555555555555", mimeType: "image/png", absolutePath: "/fixture/11111111-2222-4333-8444-555555555555.png" };
  const attachment = { id: stored.id, name: "original.png", mimeType: stored.mimeType };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, maxProjections: delivery === "covered-with-eviction" ? 1 : undefined, resolveAttachment: async id => id === stored.id ? stored : null });
  let reading: ReturnType<ChatAdapter["history"]> | undefined;
  try {
    const session = await provider.createSession("Recovered original correlation");
    await adapter.prompt(session.id, "initial", "Initial work");
    const initial = await adapter.history(session.id);
    await adapter.stopEventPump();
    blockEvents = true;
    void adapter.startEventPump().catch(() => undefined);
    await reconnect;
    const draft = { requestId: "original-client-request", messageId: "pending:original-client-request", text: "Accepted before recovery", attachments: [attachment], unconfirmed: true as const };
    const held = origin === "held" ? await adapter.prompt(session.id, draft.requestId, draft.text, undefined, undefined, undefined, draft.attachments, "queue") : undefined;
    fake.loseNextPromptResponse();
    await expect(held ? adapter.changeDelivery(session.id, held.messageId, "switch-request-not-the-original", "steer")
      : adapter.prompt(session.id, draft.requestId, draft.text, undefined, undefined, undefined, draft.attachments, "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    let snapshot: Awaited<ReturnType<ChatAdapter["history"]>>;
    if (delivery === "stored") {
      fake.step(session.id);
      release();
      snapshot = await adapter.history(session.id);
    } else {
      const client = await adapter.subscribe(session.id);
      let browser = projectionFromSnapshot(client.snapshot, [draft]);
      const clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
      try {
        captureInbox = true;
        release();
        reading = adapter.history(session.id);
        void reading.catch(() => undefined);
        await inboxCaptured;
        fake.step(session.id); // This generation never saw the enqueue payload.
        await waitUntil(() => browser.queued.length === 0);
        if (delivery === "covered-with-eviction") {
          client.events.cancel();
          await clientPump; // Navigation permits eviction of the read's projection too.
          // More than the bounded positive-delivery cache can retain. The
          // first row has no stream payload/projection copy to rescue it.
          const sibling = await provider.createSession("Unrelated bounded-cache pressure");
          await adapter.prompt(sibling.id, "sibling-initial", "Other running work");
          const observer = await adapter.subscribe(sibling.id);
          let other = projectionFromSnapshot(observer.snapshot);
          const observerPump = (async () => { for await (const event of observer.events) other = applyChatEvent(other, event).projection; })();
          try {
            for (let index = 0; index < 65; index++) {
              const next = await adapter.prompt(sibling.id, `pressure-${index}`, `Other input ${index}`, undefined, undefined, undefined, undefined, "steer");
              fake.step(sibling.id);
              await waitUntil(() => other.items.some(item => item.id === `message:${next.messageId}`));
            }
          } finally { observer.events.cancel(); await observerPump; }
        }
        releaseInbox();
        snapshot = await reading;
        if (delivery !== "covered-with-eviction") {
          await waitUntil(() => browser.items.some(item => item.type === "user_message" && item.text === draft.text));
          expect(browser.items.find(item => item.type === "user_message" && item.text === draft.text)).toHaveProperty("requestId", draft.requestId);
        } else {
          const replacement = await adapter.subscribe(session.id);
          expect(replacement.snapshot.items.find(item => item.type === "user_message" && item.text === draft.text)).toHaveProperty("requestId", draft.requestId);
          replacement.events.cancel();
        }
      } finally { client.events.cancel(); await clientPump; }
    }
    const rows = snapshot.items.filter(item => item.type === "user_message" && item.text === draft.text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("requestId", draft.requestId);
    const native = (await provider.listMessages(session.id, { limit: 100 })).items.find(item => item.id === rows[0]!.id);
    if (native?.type !== "user_message") throw new Error("Expected the real native stored user row");
    expect(rows[0]).toEqual({ ...native, requestId: draft.requestId }); // Native text, images and execution timestamp are unchanged.
    expect(snapshot.configuration).toEqual(initial.configuration);
    expect(snapshot.queued).toEqual([]);
    expect(projectionFromSnapshot(snapshot, [draft]).acceptedDrafts).toEqual([]);
    expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(delivery === "covered-with-eviction" ? 68 : 2);
  } finally { release(); releaseInbox(); await reading?.catch(() => undefined); await adapter.dispose(); await fake.stop(); }
});

for (const projected of [false, true]) test(`real V2 bounded correlation expiry ${projected ? "preserves an already projected request" : "does not invent an expired request"}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let unavailableSession = "";
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (unavailableSession && new URL(request.url).pathname === `/api/session/${unavailableSession}/message`) return Response.json({ error: "History unavailable" }, { status: 503 });
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  try {
    const session = await provider.createSession("Bounded correlation authority");
    await adapter.prompt(session.id, "initial", "Initial work");
    await adapter.history(session.id);
    await adapter.stopEventPump();
    const draft = { requestId: "original-before-expiry", messageId: "pending:original-before-expiry", text: "Original input before expiry", unconfirmed: true as const };
    fake.loseNextPromptResponse();
    await expect(adapter.prompt(session.id, draft.requestId, draft.text, undefined, undefined, undefined, undefined, "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    const client = await adapter.subscribe(session.id);
    let browser = projectionFromSnapshot(client.snapshot);
    const clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    try {
      if (projected) await adapter.history(session.id);
      else {
        unavailableSession = session.id;
        await expect(adapter.history(session.id)).rejects.toBeInstanceOf(Error);
      }
      fake.step(session.id);
      await waitUntil(() => browser.queued.length === 0);
      if (projected) await waitUntil(() => browser.items.some(item => item.type === "user_message" && item.requestId === draft.requestId));
      else await expect(adapter.history(session.id)).rejects.toBeInstanceOf(Error); // No successful read owner can pin the old evidence.
      const sibling = await provider.createSession("Bounded evidence expiry pressure");
      await adapter.prompt(sibling.id, "sibling-initial", "Other running work");
      const observer = await adapter.subscribe(sibling.id);
      let other = projectionFromSnapshot(observer.snapshot);
      const observerPump = (async () => { for await (const event of observer.events) other = applyChatEvent(other, event).projection; })();
      try {
        for (let index = 0; index < 65; index++) {
          const next = await adapter.prompt(sibling.id, `expire-${index}`, `Unrelated ${index}`, undefined, undefined, undefined, undefined, "steer");
          fake.step(sibling.id);
          await waitUntil(() => other.items.some(item => item.id === `message:${next.messageId}`));
        }
      } finally { observer.events.cancel(); await observerPump; }
      unavailableSession = "";
      const snapshot = await adapter.history(session.id);
      const row = snapshot.items.find(item => item.type === "user_message" && item.text === draft.text);
      expect(row).toBeDefined();
      if (projected) expect(row).toHaveProperty("requestId", draft.requestId);
      else expect(row).not.toHaveProperty("requestId");
      expect(projectionFromSnapshot(snapshot, [draft]).acceptedDrafts).toEqual(projected ? [] : [draft]);
      expect(snapshot.queued).toEqual([]);
      expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(68);
    } finally { client.events.cancel(); await clientPump; }
  } finally { await adapter.dispose(); await fake.stop(); }
});

for (const acknowledgement of ["lost", "late"] as const) test(`real V2 ${acknowledgement} acknowledgement correlation survives an ended read and the next native generation`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let delayPrompt = false, releaseAck!: () => void, ackReturned!: () => void;
  const ackGate = new Promise<void>(resolve => { releaseAck = resolve; });
  const returned = new Promise<void>(resolve => { ackReturned = resolve; });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (delayPrompt && new URL(request.url).pathname.endsWith("/prompt")) {
      delayPrompt = false;
      await ackGate;
      ackReturned();
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  let holdInbox = false, captured!: () => void, releaseInbox!: () => void;
  const capturedRead = new Promise<void>(resolve => { captured = resolve; });
  const inboxGate = new Promise<void>(resolve => { releaseInbox = resolve; });
  const list = provider.listPendingInbox!.bind(provider);
  provider.listPendingInbox = async (...args) => {
    const entries = await list(...args);
    if (holdInbox) { captured(); await inboxGate; }
    return entries;
  };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerAdmissionTimeoutMs: 80 });
  let reading: Promise<unknown> | undefined;
  try {
    const session = await provider.createSession("Correlation across native generations");
    await adapter.prompt(session.id, "initial", "Initial work");
    fake.launchWorker(session.id, false); // A late acknowledgement must not background this worker.
    await adapter.history(session.id);
    await adapter.stopEventPump();
    if (acknowledgement === "lost") fake.loseNextPromptResponse(); else delayPrompt = true;
    const draft = { requestId: "original-after-ended-read", messageId: "pending:original-after-ended-read", text: "Original submitted input", unconfirmed: true as const };
    await expect(adapter.prompt(session.id, draft.requestId, draft.text, undefined, undefined, undefined, undefined, "steer", { receiptScope: "alice", automaticBackground: "on" })).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    const client = await adapter.subscribe(session.id);
    let browser = projectionFromSnapshot(client.snapshot, [draft]);
    const clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    try {
      holdInbox = true;
      reading = adapter.history(session.id).catch(error => error);
      await capturedRead;
      fake.step(session.id);
      await waitUntil(() => browser.queued.length === 0);
      await adapter.stopEventPump();
      expect(await reading).toBeInstanceOf(Error);
      holdInbox = false;
      const recovered = await adapter.history(session.id);
      releaseInbox();
      releaseAck();
      if (acknowledgement === "late") await returned;
      const stable = await adapter.history(session.id);
      for (const snapshot of [recovered, stable]) {
        expect(snapshot.items.filter(item => item.type === "user_message" && item.requestId === draft.requestId)).toHaveLength(1);
        expect(snapshot.queued).toEqual([]);
        expect(projectionFromSnapshot(snapshot, [draft]).acceptedDrafts).toEqual([]);
      }
      expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(2);
      expect(fake.state().calls.some(call => call.includes("/background") || call.includes("resume=true"))).toBe(false);
    } finally { client.events.cancel(); await clientPump; }
  } finally { releaseAck(); releaseInbox(); await reading; await adapter.dispose(); await fake.stop(); }
});

test("real V2 correlation is native-ID scoped across account nonce collisions and unavailable history", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let failHistory = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (failHistory && new URL(request.url).pathname.endsWith("/message")) return Response.json({ error: "History unavailable" }, { status: 503 });
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  try {
    const session = await provider.createSession("Independent account submissions");
    await adapter.prompt(session.id, "initial", "Initial work");
    await adapter.history(session.id);
    await adapter.stopEventPump();
    const draft = { requestId: "same-client-nonce", messageId: "pending:same-client-nonce", text: "Identical input", unconfirmed: true as const };
    for (const receiptScope of ["alice", "bob"]) {
      fake.loseNextPromptResponse();
      await expect(adapter.prompt(session.id, draft.requestId, draft.text, undefined, undefined, undefined, undefined, "steer", { receiptScope, automaticBackground: "off" })).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    }
    const external = await provider.prompt(session.id, { id: "external-identical-input", text: draft.text, delivery: "steer" });
    const client = await adapter.subscribe(session.id);
    let browser = projectionFromSnapshot(client.snapshot, [draft]);
    const clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    try {
      const knownIds = browser.queued.map(entry => entry.id);
      expect(new Set(knownIds).size).toBe(2);
      expect(browser.queued.every(entry => entry.requestId === draft.requestId && entry.submissionId !== draft.requestId && entry.unconfirmed)).toBe(true);
      failHistory = true;
      await expect(adapter.history(session.id)).rejects.toBeInstanceOf(Error);
      expect(browser.queued.map(entry => entry.id)).toEqual(knownIds);
      expect(browser.items.some(item => item.type === "user_message" && item.text === draft.text)).toBe(false);
      failHistory = false;
      await adapter.stopEventPump();
      fake.step(session.id);
      const recovered = await adapter.history(session.id);
      const rows = recovered.items.filter(item => item.type === "user_message" && item.text === draft.text);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map(item => item.id)).size).toBe(3);
      for (const id of knownIds) expect(rows.find(item => item.id === `message:${id}`)).toHaveProperty("requestId", draft.requestId);
      expect(rows.find(item => item.id === `message:${external.messageId}`)).not.toHaveProperty("requestId");
      expect(projectionFromSnapshot(recovered, [draft]).acceptedDrafts).toEqual([]);
      expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(4);
      expect(fake.state().calls.some(call => call.includes("/background") || call.includes("resume=true"))).toBe(false);
    } finally { client.events.cancel(); await clientPump; }
  } finally { await adapter.dispose(); await fake.stop(); }
});

for (const acknowledgement of ["lost", "late"] as const) for (const responseState of ["pending", "delivered"] as const) test(`real V2 enqueue before a ${acknowledgement} composer acknowledgement retires its optimistic echo (${responseState} before response)`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let release!: () => void, responseArrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { responseArrived = resolve; });
  let delayNextPrompt = false;
  const delayedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (delayNextPrompt && url.pathname.endsWith("/prompt")) { delayNextPrompt = false; responseArrived(); await gate; }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: delayedFetch });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerAdmissionTimeoutMs: acknowledgement === "late" ? 80 : undefined });
  const pump = adapter.startEventPump();
  let clientPump: Promise<void> | undefined, cancelClient: (() => void) | undefined;
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const session = await provider.createSession("Lost acknowledgement");
    await adapter.prompt(session.id, "initial", "Initial work");
    const client = await adapter.subscribe(session.id);
    cancelClient = () => client.events.cancel();
    const draft = { requestId: "original-request", messageId: "pending:original-request", text: "Redirect work", unconfirmed: true as const };
    let browser = addAcceptedDraft(projectionFromSnapshot(client.snapshot), draft);
    clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    if (acknowledgement === "lost") fake.loseNextPromptResponse();
    delayNextPrompt = true;
    const context: ChatActionContext = { receiptScope: "alice", automaticBackground: "on" };
    const send = () => adapter.prompt(session.id, draft.requestId, draft.text, undefined, undefined, undefined, undefined, "steer", context);
    const submission = send().catch(error => error);
    await arrived;
    await waitUntil(() => browser.queued.some(entry => entry.text === draft.text));
    if (responseState === "delivered") {
      fake.step(session.id);
      await waitUntil(() => browser.items.some(item => item.type === "user_message" && item.text === draft.text));
    }
    if (acknowledgement === "lost") release();
    expect(await submission).toBeInstanceOf(OperationOutcomeUnknownError);
    await expect(send()).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    release();
    expect(browser.acceptedDrafts).toEqual([]);
    // The unknown response can arrive after the draft's authoritative row.
    // Reapplying that local echo must not resurrect it or retire another draft.
    const other = { requestId: "new-draft-B", messageId: "pending:new-draft-B", text: "Private new input B" };
    browser = addAcceptedDraft(addAcceptedDraft(browser, other), draft);
    expect(browser.acceptedDrafts).toEqual([other]);
    const pending = await adapter.history(session.id);
    if (responseState === "pending") {
      expect(pending.queued).toEqual([expect.objectContaining({ requestId: draft.requestId, delivery: "steer" })]);
      expect(pending.queued![0]!).not.toHaveProperty("unconfirmed");
      expect(pending.queued![0]!.submissionId).not.toBe(draft.requestId);
    } else expect(pending.queued).toEqual([]);
    expect(projectionFromSnapshot(pending, [draft]).acceptedDrafts).toEqual([]);
    fake.step(session.id);
    await waitUntil(() => browser.items.some(item => item.type === "user_message" && item.text === draft.text));
    const delivered = await adapter.history(session.id);
    expect(projectionFromSnapshot(delivered, [draft]).acceptedDrafts).toEqual([]);
    expect(delivered.items.filter(item => item.type === "user_message" && item.text === draft.text)).toHaveLength(1);
    expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(2);
    expect(fake.state().calls.some(call => call.includes("/background") || call.includes("/interrupt?resume=true"))).toBe(false);
  } finally { release(); cancelClient?.(); await clientPump; await adapter.dispose(); await pump; await fake.stop(); }
});

test("real V2 Queue conversion configuration failure leaves the original native instruction pending without cancellation", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, maxProjections: 1, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  const configuration = provider.getConversationConfiguration.bind(provider);
  try {
    if (!provider.listPendingInbox) throw new Error("V2 fixture requires pending inbox inspection");
    const listPendingInbox = provider.listPendingInbox.bind(provider);
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const session = await provider.createSession("Conversion configuration failure");
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "steer", "Retain this pending instruction", undefined, undefined, undefined, undefined, "steer");
    const other = await provider.createSession("Other conversation");
    await adapter.history(other.id); // Navigation evicts the original configuration.
    let reads = 0;
    provider.getConversationConfiguration = async id => {
      if (id === session.id) { reads++; throw new Error("configuration temporarily unavailable"); }
      return configuration(id);
    };
    const before = fake.state().calls.length;
    await expect(adapter.changeDelivery(session.id, steer.messageId, "convert", "queue")).rejects.toThrow("configuration temporarily unavailable");
    expect(reads).toBe(1);
    expect((await listPendingInbox(session.id)).map(entry => entry.id)).toEqual([steer.messageId]);
    expect(fake.state().calls.slice(before).some(call => call.startsWith("DELETE ") || call.includes("/prompt") || call.includes("/interrupt"))).toBe(false);
    provider.getConversationConfiguration = configuration;
    const snapshot = await adapter.history(session.id);
    expect(snapshot.queued).toEqual([expect.objectContaining({ id: steer.messageId, text: "Retain this pending instruction", delivery: "steer" })]);
    expect(snapshot.queued![0]).not.toHaveProperty("unconfirmed");
    expect(snapshot.items.some(item => item.id === `message:${steer.messageId}`)).toBe(false);
  } finally {
    provider.getConversationConfiguration = configuration;
    await adapter.dispose(); await pump; await fake.stop();
  }
});

test("real V2 Queue conversion freezes image, model, mode and variant once before cancellation", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const dispatches: Array<{ path: string; body: Record<string, unknown> }> = [];
  const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST") dispatches.push({ path: new URL(request.url).pathname, body: await request.clone().json().catch(() => ({})) });
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: recordingFetch });
  const stored = { id: "11111111-2222-4333-8444-555555555555", mimeType: "image/png", absolutePath: "/fixture/11111111-2222-4333-8444-555555555555.png" };
  const attachment = { id: stored.id, name: "frozen.png", mimeType: stored.mimeType };
  const adapter = new ChatAdapter({ provider, workspacePath: directory, maxProjections: 1, coalesceWindowMs: 0, resolveAttachment: async id => id === stored.id ? stored : null });
  const pump = adapter.startEventPump();
  const configuration = provider.getConversationConfiguration.bind(provider);
  try {
    if (!provider.cancelInbox) throw new Error("V2 fixture requires inbox cancellation");
    const cancel = provider.cancelInbox.bind(provider);
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const frozen = { model: { providerId: "opencode", modelId: "fake-model" }, mode: "plan", variant: "high" };
    const session = await provider.createSession("Frozen conversion", frozen);
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "image", "", undefined, undefined, undefined, [attachment], "steer");
    const other = await provider.createSession("Other conversation");
    await adapter.history(other.id);
    let reads = 0;
    provider.getConversationConfiguration = async id => { if (id === session.id) reads++; return configuration(id); };
    provider.cancelInbox = async (id, inboxId) => {
      expect(reads).toBe(1);
      // Once withdrawal begins, another configuration read cannot be relied on.
      provider.getConversationConfiguration = async () => { throw new Error("read after cancellation"); };
      await cancel(id, inboxId);
    };
    const converted = await adapter.changeDelivery(session.id, steer.messageId, "convert", "queue");
    expect(converted.messageId).not.toBe(steer.messageId);
    expect((await adapter.history(session.id)).queued).toEqual([expect.objectContaining({ id: converted.messageId, text: "", attachments: [expect.objectContaining({ name: "frozen.png", mimeType: "image/png" })], delivery: "queue" })]);
    const before = dispatches.length;
    fake.finish(session.id);
    await waitUntil(() => dispatches.slice(before).some(call => call.path.endsWith("/prompt")));
    expect(dispatches.slice(before).find(call => call.path.endsWith("/model"))?.body).toEqual({ model: { id: "fake-model", providerID: "opencode", variant: "high" } });
    expect(dispatches.slice(before).find(call => call.path.endsWith("/agent"))?.body).toEqual({ agent: "plan" });
    const dispatched = dispatches.slice(before).find(call => call.path.endsWith("/prompt"))!.body;
    expect(dispatched).toMatchObject({ text: "", files: [expect.objectContaining({ name: "frozen.png" })] });
    expect(dispatched.id).not.toBe(steer.messageId);
    await waitUntil(() => adapter.projectionForTests(session.id).has(`message:${dispatched.id}`));
    await admissionsApplied(adapter);
    expect(reads).toBe(1);
  } finally {
    provider.getConversationConfiguration = configuration;
    await adapter.stopEventPump(); await pump; await adapter.dispose(); await fake.stop();
  }
});

for (const outcome of ["unknown", "cancel-refused", "delivered-on-cancel", "delivered-during-configuration"] as const) test(`real V2 prepared Queue conversion keeps one owner when ${outcome}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (outcome === "cancel-refused" && request.method === "DELETE" && new URL(request.url).pathname.includes("/inbox/")) return Response.json({ error: "cancellation refused" }, { status: 403 });
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, maxProjections: 1, coalesceWindowMs: 0, steerWithdrawTimeoutMs: 30 });
  const pump = adapter.startEventPump();
  const configuration = provider.getConversationConfiguration.bind(provider);
  let release = () => {};
  try {
    if (!provider.listPendingInbox) throw new Error("V2 fixture requires pending inbox inspection");
    const listPendingInbox = provider.listPendingInbox.bind(provider);
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const session = await provider.createSession("Conversion race");
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "steer", "Deliver at most once", undefined, undefined, undefined, undefined, "steer");
    const other = await provider.createSession("Other conversation");
    await adapter.history(other.id);
    let reads = 0;
    provider.getConversationConfiguration = async id => {
      const current = await configuration(id);
      if (id === session.id) {
        reads++;
        if (outcome === "delivered-during-configuration") {
          fake.step(session.id);
          await waitUntil(() => adapter.projectionForTests(session.id).has(`message:${steer.messageId}`));
        }
      }
      return current;
    };
    if (outcome === "unknown") provider.cancelInbox = async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error("cancel response unavailable"); };
    else if (outcome === "delivered-on-cancel") fake.raceDeliverOnCancel(steer.messageId);
    const conversion = adapter.changeDelivery(session.id, steer.messageId, "convert", "queue");
    const uncertain = outcome === "unknown" || outcome === "cancel-refused";
    await expect(conversion).rejects.toBeInstanceOf(uncertain ? SteerWithdrawalUnconfirmedError : SteerAlreadyDeliveredError);
    expect(reads).toBe(1);
    const snapshot = await adapter.history(session.id);
    if (uncertain) {
      expect(snapshot.queued).toEqual([expect.objectContaining({ id: steer.messageId, delivery: "steer", unconfirmed: true })]);
      expect((await listPendingInbox(session.id)).map(entry => entry.id)).toEqual([steer.messageId]);
      await expect(adapter.changeDelivery(session.id, steer.messageId, "retry-convert", "queue")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
    } else {
      expect(snapshot.queued).toEqual([]);
      expect(snapshot.items.filter(item => item.id === `message:${steer.messageId}`)).toHaveLength(1);
      expect(await listPendingInbox(session.id)).toEqual([]);
    }
    expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(2);
    expect(fake.state().calls.some(call => call.includes("/interrupt"))).toBe(false);
  } finally {
    release();
    provider.getConversationConfiguration = configuration;
    await adapter.dispose(); await pump; await fake.stop();
  }
});

for (const failure of [
  { name: "validation", tag: "InvalidRequestError", status: 400, definite: true },
  { name: "unauthorized", tag: "UnauthorizedError", status: 401, definite: true },
  { name: "forbidden", tag: "ForbiddenError", status: 403, definite: true },
  { name: "missing session", tag: "SessionNotFoundError", status: 404, definite: true },
  { name: "connection refused", definite: true },
  { name: "generic failed", definite: false },
  { name: "network loss", definite: false },
  { name: "HTTP 502", status: 502, definite: false },
  { name: "native internal failure", tag: "UnknownError", status: 500, definite: false },
] as const) test(`real V2 Stop ${failure.name} ${failure.definite ? "restores natural delivery" : "retains intent without stream settlement"}`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let refuse = false;
  let interrupts = 0;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (refuse && new URL(request.url).pathname.endsWith("/interrupt")) {
      interrupts++;
      if ("status" in failure) return Response.json({ ...("tag" in failure ? { _tag: failure.tag } : {}), message: "Stop failed" }, { status: failure.status });
      if (failure.name === "connection refused") throw Object.assign(new Error("Stop failed"), { code: "ECONNREFUSED" });
      throw new Error(failure.name === "generic failed" ? "failed" : "socket lost");
    }
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const session = await provider.createSession("Definite Stop refusal");
    await adapter.prompt(session.id, "initial", "Initial work");
    const held = await adapter.prompt(session.id, "held", "Natural next work", undefined, undefined, undefined, undefined, "queue");
    refuse = true;
    await expect(adapter.abort(session.id, "stop")).rejects.toBeDefined();
    expect((await adapter.history(session.id)).conversation.status).toBe("running");
    expect((await adapter.history(session.id)).queued).toEqual([expect.objectContaining({ id: held.messageId })]);
    expect((await adapter.history(session.id)).queued![0]!.paused ?? false).toBe(!failure.definite);
    fake.finish(session.id);
    if (failure.definite) await waitUntil(() => fake.state().calls.filter(call => call.includes("/prompt")).length === 2);
    else {
      await waitUntil(() => adapter.projectionForTests(session.id).status === "completed");
      await admissionsApplied(adapter);
      expect((await adapter.history(session.id)).queued).toEqual([expect.objectContaining({ id: held.messageId, paused: true })]);
      expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(1);
    }
    expect(interrupts).toBe(1);
  } finally { await adapter.dispose(); await pump.catch(error => { if (!String(error).includes("operation was aborted")) throw error; }); await fake.stop(); }
});

test("real V2 late steer acknowledgement preserves an external interruption", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const accepted = new Promise<void>(resolve => { arrived = resolve; });
  let hold = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (hold && new URL(request.url).pathname.endsWith("/prompt")) {
      hold = false; arrived(); await gate;
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const session = await provider.createSession("Late steer receipt");
    await adapter.prompt(session.id, "initial", "Initial work");
    hold = true;
    const steering = adapter.prompt(session.id, "steer", "Pending through interruption", undefined, undefined, undefined, undefined, "steer");
    await accepted;
    await provider.interrupt(session.id, { resume: false });
    await waitUntil(() => adapter.projectionForTests(session.id).status === "interrupted");
    expect((await adapter.history(session.id)).queued).toEqual([expect.objectContaining({ paused: true })]);
    release();
    const result = await steering;
    expect((await adapter.history(session.id)).queued).toEqual([
      expect.objectContaining({ id: result.messageId, delivery: "steer", paused: true }),
    ]);
    expect(fake.state().sessions[session.id]!.running).toBe(false);
  } finally { release(); await adapter.dispose(); await pump; await fake.stop(); }
});

test("real V2 confirmed Stop with a lost response keeps Queue conversion dormant", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const applied = new Promise<void>(resolve => { arrived = resolve; });
  let loseStop = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (loseStop && new URL(request.url).pathname.endsWith("/interrupt")) {
      loseStop = false; arrived(); await gate;
      throw new Error("Stop response lost after application");
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const session = await provider.createSession("Lost Stop response");
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "steer", "Must stay pending", undefined, undefined, undefined, undefined, "steer");
    loseStop = true;
    const stopping = adapter.abort(session.id, "stop").catch(error => error);
    await applied;
    await waitUntil(() => adapter.projectionForTests(session.id).status === "interrupted");
    release();
    expect(await stopping).toBeInstanceOf(Error);
    const held = await adapter.changeDelivery(session.id, steer.messageId, "hold", "queue");
    await admissionsApplied(adapter);
    expect((await adapter.history(session.id)).queued).toEqual([
      expect.objectContaining({ id: held.messageId, delivery: "queue", paused: true }),
    ]);
    expect(fake.state().sessions[session.id]!.running).toBe(false);
    expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(2);
  } finally { release(); await adapter.dispose(); await pump; await fake.stop(); }
});

for (const acknowledgement of ["accepted", "lost"] as const) for (const nextPhase of ["running", "completed"] as const) test(`real V2 late Stop ${acknowledgement} acknowledgement preserves a newer parent execution (${nextPhase})`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const responseArrived = new Promise<void>(resolve => { arrived = resolve; });
  let delay = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (delay && request.method === "POST" && new URL(request.url).pathname.endsWith("/interrupt")) {
      delay = false; arrived(); await gate;
      if (acknowledgement === "lost") throw new Error("old Stop response lost");
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const parent = await provider.createSession("Late Stop vs native wake");
    await adapter.prompt(parent.id, "initial", "Initial work");
    const held = await adapter.prompt(parent.id, "held", "Must remain paused", undefined, undefined, undefined, undefined, "queue");
    const child = fake.launchWorker(parent.id, true);
    await waitUntil(() => adapter.projectionForTests(parent.id).items().some(item => item.type === "background_task"));
    delay = true;
    const stopping = adapter.abort(parent.id, "stop").then(value => ({ value }), error => ({ error }));
    await responseArrived;
    await waitUntil(() => !["running", "sending"].includes(adapter.projectionForTests(parent.id).status));
    fake.settleWorker(child.childId, "completed", "Detached worker completed");
    fake.wakeParent(parent.id);
    await waitUntil(() => adapter.projectionForTests(parent.id).status === "running");
    if (nextPhase === "completed") {
      fake.finish(parent.id);
      await waitUntil(() => adapter.projectionForTests(parent.id).status === "completed");
    }
    release();
    const result = await stopping;
    if (acknowledgement === "lost") expect(result).toHaveProperty("error");
    else expect(result).toEqual({ value: { cancelled: true } });
    expect(adapter.projectionForTests(parent.id).status).toBe(nextPhase);
    expect(fake.state().sessions[parent.id]!.running).toBe(nextPhase === "running");
    expect(adapter.activity().working).toBe(nextPhase === "running");
    const snapshot = await adapter.history(parent.id);
    expect(snapshot.queued).toEqual([expect.objectContaining({ id: held.messageId, paused: true })]);
    expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(1);
    // The new run is stoppable in its own right; Stop is not a future-turn ban.
    if (nextPhase === "running") {
      await adapter.abort(parent.id, "stop-new-run");
      expect(adapter.projectionForTests(parent.id).status).toBe("interrupted");
      expect(fake.state().sessions[parent.id]!.running).toBe(false);
    }
  } finally { release(); await adapter.stopEventPump(); await pump; await adapter.dispose(); await fake.stop(); }
});

for (const acknowledgement of ["accepted", "lost"] as const) for (const nextPhase of ["running", "completed"] as const) test(`real V2 public snapshots and summaries retain newer ${nextPhase} truth across eviction and the old Stop ${acknowledgement} response`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const responseArrived = new Promise<void>(resolve => { arrived = resolve; });
  let delay = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (delay && request.method === "POST" && new URL(request.url).pathname.endsWith("/interrupt")) {
      delay = false; arrived(); await gate;
      if (acknowledgement === "lost") throw new Error("old Stop response lost after eviction");
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, maxProjections: 1, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const parent = await provider.createSession("Evicted native wake");
    await adapter.prompt(parent.id, "initial", "Initial work");
    const child = fake.launchWorker(parent.id, true);
    await waitUntil(() => adapter.projectionForTests(parent.id).items().some(item => item.type === "background_task"));
    delay = true;
    const stopping = adapter.abort(parent.id, "stop").then(value => ({ value }), error => ({ error }));
    await responseArrived;
    await waitUntil(() => !["running", "sending"].includes(adapter.projectionForTests(parent.id).status));
    fake.settleWorker(child.childId, "completed", "Wake after Stop");
    fake.wakeParent(parent.id);
    await waitUntil(() => adapter.projectionForTests(parent.id).status === "running");
    if (nextPhase === "completed") {
      fake.finish(parent.id);
      await waitUntil(() => adapter.projectionForTests(parent.id).status === "completed");
    }
    const other = await provider.createSession("Navigation");
    await adapter.history(other.id);
    release();
    const result = await stopping;
    if (acknowledgement === "lost") expect(result).toHaveProperty("error");
    else expect(result).toEqual({ value: { cancelled: true } });
    expect(fake.state().sessions[parent.id]!.running).toBe(nextPhase === "running");
    expect(adapter.activity().working).toBe(nextPhase === "running");
    expect((await adapter.listConversations()).find(conversation => conversation.id === parent.id)!.status).toBe(nextPhase);
    expect((await adapter.getConversation(parent.id)).status).toBe(nextPhase);
    expect((await adapter.history(parent.id)).conversation.status).toBe(nextPhase);
    const client = await adapter.subscribe(parent.id);
    expect(client.snapshot.conversation.status).toBe(nextPhase);
    client.events.cancel();
    if (nextPhase === "running") {
      await adapter.abort(parent.id, "stop-new-run");
      expect(fake.state().sessions[parent.id]!.running).toBe(false);
    }
  } finally { release(); await adapter.stopEventPump(); await pump; await adapter.dispose(); await fake.stop(); }
});

test("real V2 fresh views use live event truth, not an unknown stored run or an obsolete pre-completion phase", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, maxProjections: 1, coalesceWindowMs: 0 });
  let pump: Promise<void> | undefined;
  try {
    const unknown = await provider.createSession("No observed execution");
    await provider.prompt(unknown.id, { id: "external-initial", text: "Unobserved native run", delivery: "queue" });
    expect(fake.state().sessions[unknown.id]!.running).toBe(true);
    expect((await adapter.getConversation(unknown.id)).status).not.toBe("running");
    expect((await adapter.history(unknown.id)).conversation.status).not.toBe("running");
    expect(adapter.activity().working).toBe(false);
    pump = adapter.startEventPump();
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const observed = await provider.createSession("Observed execution");
    await adapter.prompt(observed.id, "initial", "Observed native run");
    await waitUntil(() => adapter.projectionForTests(observed.id).status === "running");
    fake.finish(observed.id);
    await waitUntil(() => adapter.projectionForTests(observed.id).status === "completed");
    const other = await provider.createSession("Evict completed view");
    await adapter.history(other.id);
    expect((await adapter.getConversation(observed.id)).status).not.toBe("running");
    expect((await adapter.history(observed.id)).conversation.status).not.toBe("running");
    expect(adapter.activity().working).toBe(false);
  } finally { await adapter.stopEventPump(); await pump; await adapter.dispose(); await fake.stop(); }
});

test("real V2 unrelated inbox and sibling activity do not suppress a valid Stop acknowledgement after projection eviction", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const responseArrived = new Promise<void>(resolve => { arrived = resolve; });
  let delay = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (delay && request.method === "POST" && new URL(request.url).pathname.endsWith("/interrupt")) {
      delay = false; arrived(); await gate;
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, maxProjections: 1, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const parent = await provider.createSession("Stop parent");
    const sibling = await provider.createSession("Other parent");
    await adapter.prompt(parent.id, "initial", "Initial work");
    const child = fake.launchWorker(parent.id, true);
    await waitUntil(() => adapter.projectionForTests(parent.id).items().some(item => item.type === "background_task"));
    delay = true;
    const stopping = adapter.abort(parent.id, "stop");
    await responseArrived;
    await waitUntil(() => !["running", "sending"].includes(adapter.projectionForTests(parent.id).status));
    fake.settleWorker(child.childId, "completed", "Notification is not a parent execution");
    await waitUntil(() => adapter.projectionForTests(parent.id).items().some(item => item.type === "background_task" && item.status === "completed"));
    await adapter.prompt(sibling.id, "sibling", "Unrelated running conversation");
    await waitUntil(() => adapter.projectionForTests(sibling.id).status === "running");
    await adapter.history(sibling.id); // Evict the captured parent projection.
    release();
    expect(await stopping).toEqual({ cancelled: true });
    expect(adapter.projectionForTests(parent.id).status).toBe("interrupted");
    expect(fake.state().sessions[parent.id]!.running).toBe(false);
    expect(fake.state().sessions[sibling.id]!.running).toBe(true);
  } finally { release(); await adapter.stopEventPump(); await pump; await adapter.dispose(); await fake.stop(); }
});

for (const firstDelivery of ["steer", "queue"] as const) test(`real V2 same-tick conversion preserves submission order (${firstDelivery} first)`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerWithdrawTimeoutMs: 80 });
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    const session = await provider.createSession("Same tick order");
    await adapter.prompt(session.id, "initial", "Initial work");
    const tick = Date.now();
    clock = spyOn(Date, "now").mockReturnValue(tick);
    const first = await adapter.prompt(session.id, "first", "A", undefined, undefined, undefined, undefined, firstDelivery);
    const second = await adapter.prompt(session.id, "second", "B", undefined, undefined, undefined, undefined, firstDelivery === "steer" ? "queue" : "steer");
    const native = firstDelivery === "steer" ? first : second;
    const converted = await adapter.changeDelivery(session.id, native.messageId, "convert", "queue");
    expect(await adapter.changeDelivery(session.id, native.messageId, "convert", "queue")).toEqual(converted);
    const queued = (await adapter.history(session.id)).queued!;
    expect(queued.map(entry => entry.text)).toEqual(["A", "B"]);
    expect(queued.map(entry => entry.queuedAt)).toEqual([tick, tick]);
    expect(new Set(queued.map(entry => entry.submissionId)).size).toBe(2);
  } finally { clock?.mockRestore(); await adapter.dispose(); await fake.stop(); }
});

test("real V2 native list order places an earlier recovered entry before a locally known admission", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerWithdrawTimeoutMs: 80 });
  try {
    const session = await provider.createSession("Native order vs local discovery");
    await adapter.prompt(session.id, "initial", "Initial work");
    const external = await provider.prompt(session.id, { id: "external-B", text: "B external first", delivery: "steer" });
    const known = await adapter.prompt(session.id, "local-A", "A locally known", undefined, undefined, undefined, undefined, "steer");
    expect((await provider.listPendingInbox!(session.id)).map(entry => entry.id)).toEqual([external.messageId, known.messageId]);
    expect((await adapter.history(session.id)).queued!.map(entry => entry.text)).toEqual(["B external first", "A locally known"]);
  } finally { await adapter.dispose(); await fake.stop(); }
});

test("real V2 recovering native enqueue order does not rewrite an older held submission's original position", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerWithdrawTimeoutMs: 80 });
  try {
    const session = await provider.createSession("Distinct ordering domains");
    await adapter.prompt(session.id, "initial", "Initial work");
    const held = await adapter.prompt(session.id, "held-A", "A original held", undefined, undefined, undefined, undefined, "queue");
    const original = (await adapter.history(session.id)).queued![0]!;
    const external = await provider.prompt(session.id, { id: "external-B", text: "B external", delivery: "steer" });
    const native = await adapter.changeDelivery(session.id, held.messageId, "steer-A", "steer");
    expect((await adapter.history(session.id)).queued!.map(entry => entry.text)).toEqual(["B external", "A original held"]);
    await adapter.changeDelivery(session.id, external.messageId, "hold-B", "queue");
    await adapter.changeDelivery(session.id, native.messageId, "hold-A", "queue");
    const restored = (await adapter.history(session.id)).queued!;
    expect(restored.map(entry => entry.text)).toEqual(["A original held", "B external"]);
    expect(restored[0]!.submissionId).toBe(original.submissionId);
    expect(restored[0]!.queuedAt).toBe(original.queuedAt);
  } finally { await adapter.dispose(); await fake.stop(); }
});

test("real V2 native events order an earlier external enqueue before an admission whose HTTP acknowledgement arrived first", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let holdEvents = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (new URL(request.url).pathname === "/api/event" && response.body) {
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) { if (holdEvents) await gate; controller.enqueue(chunk); },
      })), { status: response.status, headers: response.headers });
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  let clientPump: Promise<void> | undefined, cancelClient: (() => void) | undefined;
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const session = await provider.createSession("Native event order vs acknowledgement");
    await adapter.prompt(session.id, "initial", "Initial work");
    const client = await adapter.subscribe(session.id);
    cancelClient = () => client.events.cancel();
    let browser = projectionFromSnapshot(client.snapshot);
    clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    holdEvents = true;
    await provider.prompt(session.id, { id: "external-B", text: "B external first", delivery: "steer" });
    await adapter.prompt(session.id, "local-A", "A locally known", undefined, undefined, undefined, undefined, "steer");
    await waitUntil(() => browser.queued.some(entry => entry.text === "A locally known"));
    expect(browser.queued.map(entry => entry.text)).toEqual(["A locally known"]);
    release(); holdEvents = false;
    await waitUntil(() => browser.queued.some(entry => entry.text === "B external first"));
    // No history/list reconciliation can mask stream ordering here.
    expect(browser.queued.map(entry => entry.text)).toEqual(["B external first", "A locally known"]);
  } finally { release(); cancelClient?.(); await clientPump; await adapter.stopEventPump(); await pump; await adapter.dispose(); await fake.stop(); }
});

for (const omitted of ["A", "B", "C"] as const) test(`real V2 a filtered native list retains uncertain ${omitted} at its stable neighbour position`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let filter = false, omittedId = "";
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "DELETE") return Response.json({ error: "cancellation refused" }, { status: 403 });
    const response = await fetch(request);
    if (filter && request.method === "GET" && new URL(request.url).pathname.endsWith("/inbox")) {
      const body = await response.json() as { data: Array<{ id: string }> };
      return Response.json({ ...body, data: body.data.filter(entry => entry.id !== omittedId) });
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerWithdrawTimeoutMs: 60 });
  try {
    const session = await provider.createSession("Filtered native list");
    await adapter.prompt(session.id, "initial", "Initial work");
    for (const text of ["A", "B", "C"]) {
      const accepted = await adapter.prompt(session.id, text, text, undefined, undefined, undefined, undefined, "steer");
      if (text === omitted) omittedId = accepted.messageId;
    }
    await adapter.history(session.id); // Establish native list order first.
    await expect(adapter.changeDelivery(session.id, omittedId, "uncertain", "queue")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
    filter = true;
    const snapshot = await adapter.history(session.id);
    expect(snapshot.queued!.map(entry => entry.text)).toEqual(["A", "B", "C"]);
    expect(snapshot.queued!.filter(entry => entry.id === omittedId)).toEqual([expect.objectContaining({ unconfirmed: true })]);
    expect(fake.state().sessions[session.id]!.pending.map(entry => entry.id)).toHaveLength(3);
    expect(snapshot.queued!.some(entry => "nativeOrderKnown" in entry)).toBe(false);
    filter = false;
    expect((await adapter.history(session.id)).queued!.map(entry => entry.text)).toEqual(["A", "B", "C"]);
  } finally { await adapter.dispose(); await fake.stop(); }
});

test("real V2 a newer native enqueue survives an older list read without reordering that list", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const listArrived = new Promise<void>(resolve => { arrived = resolve; });
  let delay = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (delay && request.method === "GET" && new URL(request.url).pathname.endsWith("/inbox")) {
      delay = false; arrived(); await gate;
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  let clientPump: Promise<void> | undefined, cancelClient: (() => void) | undefined;
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const session = await provider.createSession("List vs newer event");
    await adapter.prompt(session.id, "initial", "Initial work");
    const client = await adapter.subscribe(session.id);
    cancelClient = () => client.events.cancel();
    let browser = projectionFromSnapshot(client.snapshot);
    clientPump = (async () => { for await (const event of client.events) browser = applyChatEvent(browser, event).projection; })();
    await provider.prompt(session.id, { id: "external-B", text: "B", delivery: "steer" });
    await adapter.prompt(session.id, "local-A", "A", undefined, undefined, undefined, undefined, "steer");
    await waitUntil(() => browser.queued.length === 2);
    delay = true;
    const reading = adapter.history(session.id);
    await listArrived;
    await provider.prompt(session.id, { id: "external-C", text: "C", delivery: "steer" });
    await waitUntil(() => browser.queued.some(entry => entry.text === "C"));
    release();
    expect((await reading).queued!.map(entry => entry.text)).toEqual(["B", "A", "C"]);
    expect((await adapter.history(session.id)).queued!.map(entry => entry.text)).toEqual(["B", "A", "C"]);
  } finally { release(); cancelClient?.(); await clientPump; await adapter.stopEventPump(); await pump; await adapter.dispose(); await fake.stop(); }
});

test("real V2 previously unknown native entries retain observed provider order through reverse withdrawal", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerWithdrawTimeoutMs: 80 });
  try {
    const session = await provider.createSession("Recovered native order");
    await adapter.prompt(session.id, "initial", "Initial work");
    const first = await provider.prompt(session.id, { id: "z-first", text: "Z first", delivery: "steer" });
    const second = await provider.prompt(session.id, { id: "a-second", text: "A second", delivery: "steer" });
    const recovered = (await adapter.history(session.id)).queued!;
    expect(recovered.map(entry => entry.text)).toEqual(["Z first", "A second"]);
    expect(recovered.map(entry => entry.submissionId)).toEqual([first.messageId, second.messageId]);
    // The list establishes only native ordering, not unavailable chronology
    // against submissions that an earlier/different client did not record.
    await adapter.prompt(session.id, "later", "Held later", undefined, undefined, undefined, undefined, "queue");
    await adapter.changeDelivery(session.id, second.messageId, "hold-second", "queue");
    await adapter.changeDelivery(session.id, first.messageId, "hold-first", "queue");
    expect((await adapter.history(session.id)).queued!.map(entry => entry.text)).toEqual(["Z first", "A second", "Held later"]);
  } finally { await adapter.dispose(); await fake.stop(); }
});

test("real V2 late held-to-steer acknowledgement and list recovery retain one submission-order owner", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const responseArrived = new Promise<void>(resolve => { arrived = resolve; });
  let delay = false;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    if (delay && request.method === "POST" && new URL(request.url).pathname.endsWith("/prompt")) {
      delay = false; arrived(); await gate;
    }
    return response;
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerAdmissionTimeoutMs: 30, steerWithdrawTimeoutMs: 80 });
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    const session = await provider.createSession("Late conversion recovery");
    await adapter.prompt(session.id, "initial", "Initial work");
    clock = spyOn(Date, "now").mockReturnValue(Date.now());
    const first = await adapter.prompt(session.id, "first", "A", undefined, undefined, undefined, undefined, "queue");
    const second = await adapter.prompt(session.id, "second", "B", undefined, undefined, undefined, undefined, "steer");
    await adapter.prompt(session.id, "third", "C", undefined, undefined, undefined, undefined, "queue");
    const original = (await adapter.history(session.id)).queued!.find(entry => entry.text === "A")!;
    delay = true;
    const switching = adapter.changeDelivery(session.id, first.messageId, "switch-A", "steer");
    const rejected = expect(switching).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    await responseArrived; await rejected;
    const recovered = (await adapter.history(session.id)).queued!;
    expect(recovered.filter(entry => entry.text === "A")).toHaveLength(1);
    // B entered the native inbox before held A was switched to Steer. Its
    // native position differs from A's original held submission position.
    expect(recovered.filter(entry => entry.delivery === "steer").map(entry => entry.text)).toEqual(["B", "A"]);
    expect(recovered.find(entry => entry.text === "A")!.submissionId).toBe(original.submissionId);
    const nativeA = recovered.find(entry => entry.text === "A")!.id;
    release();
    // Withdrawal is now independent of the old, uncertain composite receipt.
    await adapter.changeDelivery(session.id, second.messageId, "hold-B", "queue");
    await adapter.changeDelivery(session.id, nativeA, "hold-A", "queue");
    const held = (await adapter.history(session.id)).queued!;
    expect(held.map(entry => entry.text)).toEqual(["A", "B", "C"]);
    expect(held.filter(entry => entry.submissionId === original.submissionId)).toHaveLength(1);
    expect(held.find(entry => entry.text === "A")!.queuedAt).toBe(original.queuedAt);
    await expect(adapter.changeDelivery(session.id, first.messageId, "switch-A", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
  } finally { release(); clock?.mockRestore(); await adapter.dispose(); await fake.stop(); }
});

test("real V2 uncertain withdrawal preserves pending order and ownership across reconnect and explicit cancellation retry", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  let refuse = true;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (refuse && request.method === "DELETE") return Response.json({ error: "cancellation refused" }, { status: 403 });
    return fetch(request);
  }) as typeof fetch;
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, fetch: transport });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerWithdrawTimeoutMs: 80 });
  let clock: ReturnType<typeof spyOn> | undefined;
  let pump: Promise<void> | undefined;
  try {
    const session = await provider.createSession("Uncertain withdrawal ordering");
    await adapter.prompt(session.id, "initial", "Initial work");
    clock = spyOn(Date, "now").mockReturnValue(Date.now());
    const first = await adapter.prompt(session.id, "first", "A", undefined, undefined, undefined, undefined, "steer");
    const second = await adapter.prompt(session.id, "second", "B", undefined, undefined, undefined, undefined, "queue");
    await adapter.prompt(session.id, "third", "C", undefined, undefined, undefined, undefined, "steer");
    await expect(adapter.changeDelivery(session.id, first.messageId, "uncertain", "queue")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
    clock.mockRestore(); clock = undefined;
    await adapter.abort(session.id, "stop");
    pump = adapter.startEventPump();
    await waitUntil(() => fake.state().eventSubscribers > 0);
    await adapter.stopEventPump(); await pump;
    pump = adapter.startEventPump();
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const pending = (await adapter.history(session.id)).queued!;
    expect(pending.filter(entry => entry.delivery === "steer").map(entry => entry.text)).toEqual(["A", "C"]);
    expect(pending.filter(entry => entry.text === "A")).toEqual([expect.objectContaining({ unconfirmed: true, paused: true })]);
    expect(pending.filter(entry => entry.id === second.messageId)).toHaveLength(1);
    await expect(adapter.changeDelivery(session.id, first.messageId, "no-duplicate", "queue")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
    refuse = false;
    await adapter.removeQueued(session.id, first.messageId, "retry-remove");
    const remaining = (await adapter.history(session.id)).queued!;
    expect(remaining.map(entry => entry.text)).toEqual(["C", "B"]); // Native group, then held group.
    expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(3);
  } finally { clock?.mockRestore(); await adapter.stopEventPump(); await pump; await adapter.dispose(); await fake.stop(); }
});

for (const timestamps of ["equal", "increasing", "backwards"] as const) test(`real V2 repeated delivery switches preserve known order with ${timestamps} timestamps through Stop and reconnect`, async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0, steerWithdrawTimeoutMs: 80 });
  let clock: ReturnType<typeof spyOn> | undefined;
  let pump: Promise<void> | undefined;
  try {
    const session = await provider.createSession("Repeated switches");
    await adapter.prompt(session.id, "initial", "Initial work");
    const base = Date.now();
    let tick = base;
    clock = spyOn(Date, "now").mockImplementation(() => tick);
    const ids = new Map<string, string>();
    const submissions = new Map<string, string | undefined>();
    const stamps = new Map<string, number>();
    for (const [index, text] of ["A", "B", "C", "D"].entries()) {
      tick = base + (timestamps === "equal" ? 0 : timestamps === "increasing" ? index * 10 : -index * 10);
      const accepted = await adapter.prompt(session.id, `submit-${text}`, text, undefined, undefined, undefined, undefined, index % 2 ? "queue" : "steer");
      ids.set(text, accepted.messageId);
      const entry = (await adapter.history(session.id)).queued!.find(entry => entry.text === text)!;
      submissions.set(text, entry.submissionId);
      stamps.set(text, entry.queuedAt);
    }
    const switchTo = async (text: string, delivery: MessageDelivery, request: string) => {
      const result = await adapter.changeDelivery(session.id, ids.get(text)!, request, delivery);
      ids.set(text, result.messageId);
    };
    // Withdraw the later native entry first, then the earlier one. Repeating
    // both directions must not turn conversion order into submission order.
    await switchTo("C", "queue", "hold-C");
    await switchTo("A", "queue", "hold-A");
    for (let round = 0; round < 2; round++) {
      expect((await adapter.history(session.id)).queued!.map(entry => entry.text)).toEqual(["A", "B", "C", "D"]);
      for (const text of ["D", "B", "A", "C"]) await switchTo(text, "steer", `steer-${round}-${text}`);
      expect((await adapter.history(session.id)).queued!.map(entry => entry.text)).toEqual(["D", "B", "A", "C"]);
      for (const text of ["B", "D", "C", "A"]) await switchTo(text, "queue", `hold-${round}-${text}`);
    }
    clock.mockRestore(); clock = undefined;
    await adapter.abort(session.id, "stop");
    pump = adapter.startEventPump();
    await waitUntil(() => fake.state().eventSubscribers > 0);
    await adapter.stopEventPump(); await pump;
    pump = adapter.startEventPump();
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const recovered = (await adapter.history(session.id)).queued!;
    expect(recovered.map(entry => entry.text)).toEqual(["A", "B", "C", "D"]);
    expect(recovered.every(entry => entry.paused)).toBe(true);
    for (const entry of recovered) {
      expect(entry.submissionId).toBe(submissions.get(entry.text));
      expect(entry.queuedAt).toBe(stamps.get(entry.text)!);
      expect(entry).not.toHaveProperty("submissionOrder");
    }
    // Explicitly wake in known submission order, then verify the real native
    // batch is delivered once, with no additional prompt from the held queue.
    for (const text of ["A", "B", "C", "D"]) await switchTo(text, "steer", `resume-${text}`);
    fake.step(session.id);
    await waitUntil(() => adapter.projectionForTests(session.id).items().filter(item => item.type === "user_message" && ["A", "B", "C", "D"].includes(item.text)).length === 4);
    expect((await adapter.history(session.id)).queued).toEqual([]);
    const messages = adapter.projectionForTests(session.id).items().filter(item => item.type === "user_message" && ["A", "B", "C", "D"].includes(item.text));
    expect(messages.map(item => item.type === "user_message" ? item.text : "")).toEqual(["A", "B", "C", "D"]);
    expect(new Set(messages.map(item => item.id)).size).toBe(4);
  } finally {
    clock?.mockRestore();
    await adapter.stopEventPump(); await pump; await adapter.dispose(); await fake.stop();
  }
});

test("real V2 Stop with only native steers keeps a later Queue conversion dormant", async () => {
  const directory = process.cwd();
  const fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory });
  const adapter = new ChatAdapter({ provider, workspacePath: directory, coalesceWindowMs: 0 });
  const pump = adapter.startEventPump();
  try {
    await waitUntil(() => fake.state().eventSubscribers > 0);
    const session = await provider.createSession("Stop conversion");
    await adapter.prompt(session.id, "initial", "Initial work");
    const steer = await adapter.prompt(session.id, "steer", "Do this later", undefined, undefined, undefined, undefined, "steer");
    await adapter.abort(session.id, "stop");
    const before = fake.state().calls.filter(call => call.includes("/prompt")).length;
    const converted = await adapter.changeDelivery(session.id, steer.messageId, "convert", "queue");
    await admissionsApplied(adapter);
    expect((await adapter.history(session.id)).queued).toEqual([
      expect.objectContaining({ id: converted.messageId, text: "Do this later", delivery: "queue", paused: true }),
    ]);
    expect(fake.state().calls.filter(call => call.includes("/prompt"))).toHaveLength(before);
    expect(fake.state().sessions[session.id]!.running).toBe(false);
  } finally { await adapter.dispose(); await pump; await fake.stop(); }
});

test("side answers preserve foreground/history, never share cached personal responses and reject foreign/unsupported sessions", async () => {
  const provider = new FakeProvider();
  provider.agent.capabilities.push("side-generation");
  provider.sessions.push(fixtureSession("local", process.cwd(), 1), fixtureSession("foreign", "/outside-workspace", 2));
  const calls: string[] = [];
  provider.generate = async (_id, question) => { calls.push(question); return "Independent answer"; };
  const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });
  const before = await adapter.history("local");
  expect(await adapter.generate("local", "request", "Why?")).toEqual({ text: "Independent answer" });
  expect(await adapter.generate("local", "request", "Why?")).toEqual({ text: "Independent answer" });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("Do not call any tools and do not take any actions.");
  expect((await adapter.history("local")).items).toEqual(before.items);
  expect(provider.prompts).toEqual([]); expect(provider.interrupts).toEqual([]);
  await expect(adapter.generate("foreign", "request", "Why?")).rejects.toBeInstanceOf(ConversationNotFoundError);
  provider.agent.capabilities = [];
  await expect(adapter.generate("local", "other", "Why?")).rejects.toThrow("Side answers are not supported");
  await expect(adapter.prompt("local", "prompt", "/btw Why?")).rejects.toThrow("separate side-answer action");
});

class EventQueue implements AsyncIterable<ProviderEvent> {
  private values: ProviderEvent[] = [];
  private waiters: Array<(result: IteratorResult<ProviderEvent>) => void> = [];
  private closed = false;

  push(event: ProviderEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.values.push(event);
  }

  // True while a consumer is parked on the queue. The adapter's pump asks
  // for the next event only after it has fully handled the previous one, so
  // after a push this turning true again means that event was processed.
  get waiting(): boolean {
    return this.waiters.length > 0;
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}

class FakeProvider implements ChatProvider {
  // A fake declares less than OpenCode on purpose: it is the only thing in
  // the suite that can exercise a surface whose agent is missing a capability.
  agent: ChatAgent = { id: "fake", name: "Fake Agent", capabilities: ["models", "commands", "permissions"] };
  describe(): ChatAgent { return this.agent; }
  commands: ChatCommand[] = [
    { name: "review", description: "Review", argumentHint: "[focus]", kind: "command" },
    { name: "compact", description: "Compact", argumentHint: "", kind: "command" },
  ];
  models: ChatModel[] = [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude" }];
  sessions: ProviderSession[] = [];
  pages = new Map<string, RawPage>();
  eventQueue = new EventQueue();
  notificationLifecycle = new OpenCodeNotificationLifecycle();
  prompts: Array<{ sessionId: string; id: string; text: string; delivery: MessageDelivery; model?: ModelSelection; mode?: string; variant?: string; attachments?: import("./provider").ProviderAttachment[] }> = [];
  commandOperation?: "reload";
  commandCalls: Array<{ sessionId: string; id: string; name: string; arguments: string; listed?: ChatCommand; model?: ModelSelection }> = [];
  permissionReplies: Array<{ sessionId: string; requestId: string; reply: ProviderPermissionReply }> = [];
  questionReplies: Array<{ sessionId: string; requestId: string; answers?: string[][]; rejected?: true }> = [];
  interrupts: string[] = [];
  // What each interrupt asked for (opencode-v2-steering D9): Cancel passes
  // `resume: false`, a Send now on a paused steer `resume: true`.
  interruptOptions: Array<{ resume?: boolean } | undefined> = [];
  // The agent's own inbox, for a fake declaring `steering`.
  pendingInbox: PendingInboxEntry[] = [];
  cancelledInbox: string[] = [];
  listPendingInbox?: ChatProvider["listPendingInbox"];
  generate?: ChatProvider["generate"];
  cancelInbox?: ChatProvider["cancelInbox"];
  modelSwitches: Array<{ sessionId: string; selection: ModelSelection }> = [];
  renameSession?: ChatProvider["renameSession"];
  listPermissions?: ChatProvider["listPermissions"];
  listQuestions?: ChatProvider["listQuestions"];
  listModes?: ChatProvider["listModes"];
  getReversibleHistoryState?: ChatProvider["getReversibleHistoryState"];
  undo?: ChatProvider["undo"];
  redo?: ChatProvider["redo"];
  revert?: ChatProvider["revert"];
  restore?: ChatProvider["restore"];
  configurations = new Map<string, import("./types").ConversationConfiguration>();
  newConfiguration: import("./types").ConversationConfiguration = {};

  async listCommands() { return this.commands; }
  async listModels() { return this.models; }
  async switchModel(sessionId: string, selection: ModelSelection) { this.modelSwitches.push({ sessionId, selection }); }

  async listSessions() { return this.sessions; }
  async newConversationConfiguration() { return this.newConfiguration; }
  async createSession(id: string, configuration = {}) {
    const session = fixtureSession(id, process.cwd(), this.sessions.length + 1);
    this.sessions.push(session);
    this.configurations.set(id, configuration);
    return session;
  }
  async getSession(id: string) { return this.sessions.find(session => session.id === id) ?? null; }
  async getConversationConfiguration(id: string) { return this.configurations.get(id) ?? {}; }
  // Tests author raw OpenCode payloads; the stub normalizes them at the seam
  // boundary exactly as the real provider does. Override readMessages, not
  // listMessages, to keep raw fixtures.
  readMessages = async (_sessionId: string, options: { cursor?: string; limit: number }): Promise<RawPage> => {
    return this.pages.get(options.cursor ?? "first") ?? { items: [] };
  };
  async listMessages(sessionId: string, options: { cursor?: string; limit: number }): Promise<ProviderHistoryPage> {
    return normalizeRawPage(await this.readMessages(sessionId, options));
  }
  async *events(signal: AbortSignal): AsyncIterable<NormalizedProviderEvent> {
    signal.addEventListener("abort", () => this.eventQueue.close(), { once: true });
    const memory = createProviderEventMemory();
    for await (const event of this.eventQueue) {
      // A pre-normalized event, for shapes only another generation's mapper
      // produces (a sparse 2.x lifecycle update).
      const passthrough = (event as { normalized?: NormalizedProviderEvent }).normalized;
      if (passthrough) { yield passthrough; continue; }
      try {
        const normalized = normalizeProviderEvent(event, memory);
        const turns = this.notificationLifecycle.observe(event, normalized);
        if (turns.length) normalized.notificationTurns = turns;
        yield normalized;
      } catch {
        yield { updates: [], outcome: "unparseable", eventType: "" };
      }
    }
  }
  async prompt(sessionId: string, input: { id: string; text: string; delivery: MessageDelivery; model?: ModelSelection; mode?: string; variant?: string; attachments?: import("./provider").ProviderAttachment[] }) {
    this.prompts.push({ sessionId, ...input });
    return { messageId: input.id };
  }
  // What a command's row reads as when the provider sent something else.
  commandText: string | undefined;
  async command(sessionId: string, input: { id: string; name: string; arguments: string; listed?: ChatCommand; model?: ModelSelection }) {
    this.commandCalls.push({ sessionId, ...input });
    return { messageId: input.id, ...(this.commandText ? { text: this.commandText } : {}), ...(this.commandOperation ? { operation: this.commandOperation } : {}) };
  }
  async interrupt(sessionId: string, options?: { resume?: boolean }) { this.interrupts.push(sessionId); this.interruptOptions.push(options); }
  async replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply) {
    this.permissionReplies.push({ sessionId, requestId, reply });
  }
  async replyQuestion(sessionId: string, requestId: string, answers: string[][]) {
    this.questionReplies.push({ sessionId, requestId, answers });
  }
  async rejectQuestion(sessionId: string, requestId: string) {
    this.questionReplies.push({ sessionId, requestId, rejected: true });
  }
}

type RawPage = { items: ProviderMessage[]; nextCursor?: string; configurationItems?: ProviderMessage[] };

function normalizeRawPage(page: RawPage): ProviderHistoryPage {
  // As the real provider does: a reply that names no prompt answers the
  // newest user message before it.
  const accounting: StoredMessageAccounting[] = [];
  let newestPrompt: string | undefined;
  for (const message of page.items) {
    newestPrompt = storedPromptId(message) ?? newestPrompt;
    const reported = storedMessageUsage(message);
    if (reported) accounting.push(reported.promptId === undefined && newestPrompt !== undefined ? { ...reported, promptId: newestPrompt } : reported);
  }
  return {
    items: page.items.flatMap(message => normalizeProviderMessage(message)),
    accounting,
    ...(page.configurationItems ? { completeItems: page.configurationItems.flatMap(message => normalizeProviderMessage(message)) } : {}),
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
  };
}

function fixtureSession(id: string, directory = process.cwd(), updatedAt = 1): ProviderSession {
  return { id, title: `Conversation ${id}`, directory, createdAt: updatedAt, updatedAt };
}

function sumInput(item: ConversationItem | undefined): number | undefined {
  return item?.type === "tool" ? item.usage?.input : undefined;
}

function applyEvent(adapter: ChatAdapter, conversationId: string, event: ProviderEvent): void {
  for (const update of normalizeProviderEvent(event).updates) adapter.projectionForTests(conversationId).apply(update);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !predicate(); attempt += 1) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

// For promise-only fixtures under a frozen clock: drain work without advancing
// deadlines (Bun.sleep is itself controlled by native fake timers).
async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !predicate(); attempt++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

// Let actual workspace-confinement IO settle without advancing fake deadlines.
async function flushRecoveryIo(): Promise<void> {
  for (let turn = 0; turn < 32; turn++) await realpath(process.cwd());
}

async function admissionsApplied(adapter: ChatAdapter): Promise<void> {
  const admissions = (adapter as unknown as { promptAdmissions: Map<string, Promise<void>> }).promptAdmissions;
  await Promise.all([...admissions.values()]);
}

// Every live event pushed so far has been handled and its updates applied:
// the pump has parked on the queue again (it asks for the next event only
// after the previous one is fully handled) and the coalescer holds nothing
// buffered or mid-flush. What a fixed sleep only hoped for, which a loaded
// machine running `bun test --parallel` did not grant.
async function liveEventsApplied(adapter: ChatAdapter, provider: FakeProvider): Promise<void> {
  await waitUntil(() => provider.eventQueue.waiting);
  const coalescer = (adapter as unknown as {
    eventCoalescer: { timer: unknown; buffers: Map<string, unknown>; settled(): Promise<void> } | null;
  }).eventCoalescer;
  if (!coalescer) return;
  await waitUntil(() => coalescer.timer === null && coalescer.buffers.size === 0);
  await coalescer.settled();
}

async function expectInventorySignal(subscription: ConversationInventorySubscription): Promise<void> {
  const result = await Promise.race([
    subscription.next(),
    Bun.sleep(500).then(() => "timeout" as const),
  ]);
  expect(result).not.toBe("timeout");
  expect((result as IteratorResult<void>).done).toBe(false);
}

describe("live notification confinement", () => {
  test("worker recovery and child completion do not notify a parent success; its later real turn still does", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("one"), { ...fixtureSession("child"), parentId: "one" }];
    const result = { id: "task:worker", type: "background_task" as const, taskId: "worker", childConversationId: "child", createdAt: 1, description: "Worker", status: "completed" as const, summary: "Report", resultId: "notice" };
    Object.assign(provider, { reconcileBackgroundTasks: async () => [result] });
    const events: AgentNotificationEvent[] = [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), onNotification: event => events.push(event) });
    await adapter.history("one");
    const pump = adapter.startEventPump();
    const now = Date.now();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    provider.eventQueue.push({ type: "session.next.step.started", data: { sessionID: "child", assistantMessageID: "child-answer", timestamp: now } });
    provider.eventQueue.push({ type: "session.next.step.ended", data: { sessionID: "child", assistantMessageID: "child-answer", finish: "stop", timestamp: now + 1 } });
    provider.eventQueue.push({ normalized: { conversationId: "one", eventType: "session.inbox.enqueued", outcome: "handled", updates: [{ kind: "upsert", item: result }] } } as unknown as ProviderEvent);
    await waitUntil(() => provider.eventQueue.waiting);
    expect(events.filter(event => event.type === "notification")).toEqual([]);
    // OpenCode, not Uatu, resumes the parent to consume the notification.
    provider.eventQueue.push({ type: "session.next.step.started", data: { sessionID: "one", assistantMessageID: "parent-answer", timestamp: now + 2 } });
    provider.eventQueue.push({ type: "session.next.step.ended", data: { sessionID: "one", assistantMessageID: "parent-answer", finish: "stop", timestamp: now + 3 } });
    await waitUntil(() => events.some(event => event.type === "notification"));
    expect(events.filter(event => event.type === "notification")).toEqual([expect.objectContaining({ notification: expect.objectContaining({ conversationId: "one", kind: "turn-completed" }) })]);
    expect(adapter.projectionForTests("one").items().filter(item => item.type === "background_task")).toEqual([result]);
    expect(provider.prompts).toEqual([]);
    expect(provider.interrupts).toEqual([]);
    await adapter.dispose(); await pump;
  });
  test("OpenCode events reach both enrolled devices without an open page", async () => {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, id: "opencode" };
    provider.sessions = [fixtureSession("one")];
    const pipeline = await notificationPipeline(provider, process.cwd());
    try {
      const timestamp = Date.now();
      provider.eventQueue.push({ type: "session.next.step.started", data: { sessionID: "one", assistantMessageID: "a", timestamp } });
      provider.eventQueue.push({ type: "question.asked", data: { sessionID: "one", id: "q", timestamp, questions: [{ question: "Choose?", options: [{ label: "A" }] }] } });
      await pipeline.waitForSends(2);
      await pipeline.restartHub();
      provider.eventQueue.push({ type: "session.next.step.ended", data: { sessionID: "one", assistantMessageID: "a", finish: "stop", timestamp: Date.now() } });
      await pipeline.waitForSends(4);
      expect(pipeline.opens()).toBe(2);
      expect(pipeline.sent.map(send => send.payload.kind).sort()).toEqual(["question-pending", "question-pending", "turn-completed", "turn-completed"]);
      expect(pipeline.sent.every(send => send.payload.url.includes("opencode%3Aone"))).toBe(true);
    } finally { await pipeline.dispose(); }
  });
  test("a question held while the user looks survives a hub restart and is sent once when they leave", async () => {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, id: "opencode" };
    provider.sessions = [fixtureSession("one")];
    const pipeline = await notificationPipeline(provider, process.cwd());
    try {
      pipeline.setPresence("present");
      provider.eventQueue.push({ type: "question.asked", data: { sessionID: "one", id: "q", timestamp: Date.now(), questions: [{ question: "Choose?", options: [{ label: "A" }] }] } });
      await pipeline.waitForDeliveries(2);
      for (let i = 0; i < 500 && pipeline.heldCount() < 2; i++) await Bun.sleep(2);
      expect(pipeline.heldCount()).toBe(2);
      expect(pipeline.sent).toHaveLength(0);
      await pipeline.restartHub();
      expect(pipeline.heldCount()).toBe(2);
      pipeline.setPresence("away");
      await pipeline.waitForSends(2);
      await pipeline.restartHub();
      await Bun.sleep(20);
      await pipeline.waitForSends(2);
      expect(pipeline.sent.map(send => send.endpoint).sort()).toEqual(["https://web.push.apple.com/desktop", "https://web.push.apple.com/phone"]);
    } finally { await pipeline.dispose(); }
  });
  test("unselected conversations notify, while child completions and outside workspaces do not", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("one"), fixtureSession("two"), { ...fixtureSession("child"), parentId: "one" }, fixtureSession("outside", "/tmp/uatu-outside")];
    const events: AgentNotificationEvent[] = [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), onNotification: event => events.push(event) });
    const pump = adapter.startEventPump();
    const now = Date.now();
    for (const sessionID of ["one", "two", "child", "outside"]) {
      provider.eventQueue.push({ type: "session.next.step.started", data: { sessionID, assistantMessageID: "a", timestamp: now } });
    }
    for (const sessionID of ["one", "child", "outside"]) {
      provider.eventQueue.push({ type: "session.next.step.ended", data: { sessionID, assistantMessageID: "a", finish: "stop", timestamp: now + 1 } });
    }
    provider.eventQueue.push({ type: "question.asked", data: { sessionID: "child", id: "q", questions: [{ question: "Choose?", options: [{ label: "A" }] }] } });
    provider.eventQueue.close();
    await pump;
    expect(events.filter(event => event.type === "notification").map(event => event.type === "notification" ? [event.notification.conversationId, event.notification.kind] : [])).toEqual([
      ["one", "turn-completed"], ["one", "question-pending"],
    ]);
    await adapter.dispose();
  });
});

describe("OpenCode conversation inventory and history", () => {
  test("repairs a persisted default title from its first user message", async () => {
    const provider = new FakeProvider();
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - 2026-08-15T12:00:00Z" }];
    provider.pages.set("first", { items: [
      { id: "assistant", type: "assistant", time: { created: 2 }, text: "Answer" },
      { id: "first", type: "user", time: { created: 1 }, text: "Investigate authenticated model discovery" },
    ] });
    provider.renameSession = async (id, title) => {
      const renamed = { ...provider.sessions.find(session => session.id === id)!, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);

    expect((await adapter.listConversations())[0]?.title).toBe("Investigate authenticated model discovery");
    await expectInventorySignal(inventory);
    inventory.cancel();
  });

  test("every priced usage carrier rides the first page, so the cost fold sees the whole conversation", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const priced = (id: string, created: number, cost: number) => ({
      id, type: "assistant", time: { created }, modelID: "gpt-5.6-sol", providerID: "openai",
      tokens: { input: 100, output: 10 }, cost, content: [{ id: `prt_${id}`, type: "text", text: `Reply ${id}` }],
    });
    const older = priced("older", 1, 0.5);
    const newer = priced("newer", 101, 0.25);
    // A subagent launched from the older page: its spend lives on the row
    // that launched it, so the row rides the first page and is attributed.
    const launch = {
      id: "launch", type: "assistant", time: { created: 2 }, modelID: "gpt-5.6-sol", providerID: "openai",
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: { status: "completed", input: { description: "Review renderer", subagent_type: "explore" }, metadata: { sessionId: "child" }, output: "done" } }],
    };
    // The provider pages locally over the complete transcript: the newest
    // page holds one message, the transcript everything.
    provider.pages.set("first", { items: [newer], nextCursor: "older-page", configurationItems: [older, launch, newer] });
    provider.pages.set("older-page", { items: [older, launch], configurationItems: [older, launch, newer] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      return { items: [{ id: "child_a", type: "assistant", modelID: "gpt-5.6-sol", time: { created: 3 }, tokens: { input: 50, output: 5 }, cost: 0.125 }] as never[] };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });

    const first = await adapter.history("session");
    const carriers = (items: readonly ConversationItem[]) => items.filter(item => item.type === "assistant_message" && item.markdown === "" && item.usage).map(item => item.id).sort();
    // The older message's text is not on the page; its price is, and so is
    // the subagent's row with its child's aggregate.
    expect(first.items.some(item => item.id === "part:prt_older")).toBe(false);
    expect(carriers(first.items)).toEqual(["usage:newer", "usage:older"]);
    expect(first.items.find(item => item.id === "tool:prt_task")).toEqual(expect.objectContaining({ childConversationId: "child", model: "gpt-5.6-sol", usage: expect.objectContaining({ costUsd: 0.125 }) }));
    expect(first.olderCursor).toBeDefined();

    // Loading the older page restates the carrier under the same id: one
    // item in the projection, not two.
    const older_page = await adapter.history("session", { cursor: first.olderCursor });
    expect(older_page.items.some(item => item.id === "part:prt_older")).toBe(true);
    expect(carriers(adapter.projectionForTests("session").items())).toEqual(["usage:newer", "usage:older"]);
    expect(adapter.projectionForTests("session").items().filter(item => item.id === "tool:prt_task")).toHaveLength(1);
  });

  test("repairs a persisted default title from before the newest message page", async () => {
    const provider = new FakeProvider();
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - 2026-08-15T12:00:00Z" }];
    const first = { id: "first", type: "user", time: { created: 1 }, text: "Name the conversation from this prompt" };
    const later = { id: "later", type: "user", time: { created: 101 }, text: "Do not use this later prompt" };
    provider.pages.set("first", { items: [later], configurationItems: [first, later] });
    provider.renameSession = async (id, title) => {
      const renamed = { ...provider.sessions.find(session => session.id === id)!, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);

    expect((await adapter.listConversations())[0]?.title).toBe("Name the conversation from this prompt");
    await expectInventorySignal(inventory);
    inventory.cancel();
  });


  test("subagent child sessions stay out of the conversation list", async () => {
    const provider = new FakeProvider();
    provider.sessions = [
      fixtureSession("parent", process.cwd(), 2),
      { ...fixtureSession("child", process.cwd(), 3), parentId: "parent" },
    ];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });

    const conversations = await adapter.listConversations();
    expect(conversations.map(conversation => conversation.id)).toEqual(["parent"]);
    // The child stays reachable directly — it is hidden, not gone.
    await expect(adapter.history("child")).resolves.toBeDefined();
  });

  test("replay preserves provider part order when timestamps tie", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.pages.set("first", { items: [{
      info: { id: "msg", role: "assistant", time: { created: 5 } },
      parts: [
        { id: "prt_z", type: "reasoning", text: "why", time: { start: 900, end: 950 } },
        { id: "prt_a", type: "text", text: "answer" },
      ],
    }] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });

    const snapshot = await adapter.history("session");
    // Alphabetical ids and later part-level times would both reorder this;
    // the provider emitted reasoning first, so replay shows reasoning first.
    expect(snapshot.items.map(item => item.type)).toEqual(["reasoning", "assistant_message"]);
  });

  test("an event landing during the history read is replayable from the snapshot cursor", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    // The pump publishes while listMessages is in flight — the torn-snapshot
    // window: the update reaches the replay log but not the items history()
    // is assembling.
    provider.readMessages = async () => {
      provider.eventQueue.push({ id: "during", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "missed" } });
      await Bun.sleep(10);
      return { items: [] };
    };

    const snapshot = await adapter.history("local");
    expect(snapshot.items).toEqual([]);
    // Wait until the pump event is fully published, so nothing can arrive
    // "live" after the handoff and mask a cursor that acknowledged too much.
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    // The SSE route forwards only replayed events, not the handoff snapshot —
    // a cursor taken after the read would acknowledge the event and lose it.
    const { events } = await adapter.subscribe("local", { cursor: snapshot.cursor });
    const iterator = events[Symbol.asyncIterator]();
    const first = await Promise.race([iterator.next(), Bun.sleep(500).then(() => "timeout" as const)]);
    expect(first).not.toBe("timeout");
    expect(JSON.stringify((first as IteratorResult<unknown>).value)).toContain("missed");
    events.cancel();

    await adapter.stopEventPump();
    await pump;
  });

  test("pending questions from the provider join the snapshot as answerable items", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.pages.set("first", { items: [] });
    (provider as FakeProvider & { listQuestions?: unknown }).listQuestions = async () => [{
      requestId: "que_1",
      conversationId: "session",
      questions: [{ prompt: "Proceed?", header: "Next", options: [{ label: "Yes", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });

    const snapshot = await adapter.history("session");
    expect(snapshot.items).toEqual([expect.objectContaining({
      id: "question:que_1",
      type: "question",
      requestId: "que_1",
      status: "pending",
    })]);
  });

  test("discovers persisted sessions after restart, filters foreign directories, and orders deterministically", async () => {
    const provider = new FakeProvider();
    provider.sessions = [
      fixtureSession("older", process.cwd(), 2),
      fixtureSession("newer-z", process.cwd(), 4),
      fixtureSession("newer-a", process.cwd(), 4),
      fixtureSession("foreign", `${process.cwd()}-foreign`, 10),
    ];
    const first = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "first" });
    const restarted = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "second" });

    expect((await first.listConversations()).map(item => item.id)).toEqual(["newer-a", "newer-z", "older"]);
    expect((await restarted.listConversations()).map(item => item.id)).toEqual(["newer-a", "newer-z", "older"]);
    await expect(restarted.getConversation("foreign")).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  test("creates and looks up an empty workspace conversation", async () => {
    const provider = new FakeProvider();
    provider.newConfiguration = { model: { providerId: "recent", modelId: "model" }, mode: "build" };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "created" });
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const created = await adapter.createConversation();
    expect(created).toEqual(expect.objectContaining({
      conversation: expect.objectContaining({ id: "created" }),
      configuration: provider.newConfiguration,
      generation: "g",
      items: [],
    }));
    expect((await adapter.history("created")).configuration).toEqual(provider.newConfiguration);
    expect(await adapter.getConversation("created")).toEqual(expect.objectContaining({ id: "created" }));
    await expectInventorySignal(inventory);
    inventory.cancel();
  });

  test("stale running activity from a dead server is closed out on load", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    // OpenCode died mid-turn (hub quit): the store never received a terminal
    // state for these parts, so they still read as running.
    provider.pages.set("first", { items: [{
      info: { id: "m1", role: "assistant", time: { created: 10 } },
      parts: [
        { id: "p1", type: "tool", tool: "task", state: { status: "running", input: { description: "Audit styles" } } },
        { id: "p2", type: "tool", tool: "task", state: { status: "completed" } },
        { id: "p3", type: "reasoning", text: "thinking", time: { start: 10 } },
      ],
    } as never] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const items = (await adapter.history("local")).items;
    expect(items).toEqual([
      expect.objectContaining({ id: "tool:p1", status: "cancelled" }),
      expect.objectContaining({ id: "tool:p2", status: "completed" }),
      expect.objectContaining({ id: "part:p3", type: "reasoning", status: "cancelled" }),
    ]);
  });

  test("a live turn keeps its running activity across a reload", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    provider.pages.set("first", { items: [{
      info: { id: "m1", role: "assistant", time: { created: 10 } },
      parts: [{ id: "p1", type: "tool", tool: "task", state: { status: "running", input: { description: "Audit styles" } } }],
    } as never] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    adapter.projectionForTests("local").statusUpdate("running");

    const items = (await adapter.history("local")).items;
    expect(items).toEqual([expect.objectContaining({ id: "tool:p1", status: "running" })]);
  });

  test("an evicted projection does not cancel a turn that is still running", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local"), fixtureSession("other")];
    provider.pages.set("first", { items: [{
      info: { id: "m1", role: "assistant", time: { created: 10 } },
      parts: [{ id: "p1", type: "tool", tool: "task", state: { status: "running", input: { description: "Audit styles" } } }],
    } as never] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", maxProjections: 1 });
    adapter.projectionForTests("local").statusUpdate("running");
    // Touching another conversation evicts "local"; its projection comes back
    // fresh ("idle") while the turn still runs. Liveness must survive that.
    adapter.projectionForTests("other");

    const items = (await adapter.history("local")).items;
    expect(items).toEqual([expect.objectContaining({ id: "tool:p1", status: "running" })]);
  });

  test("uses opaque stable provider page boundaries without duplicate or reordered items", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.pages.set("first", {
      items: [
        { id: "u2", type: "user", time: { created: 3 }, text: "Second" },
        { id: "a1", type: "assistant", time: { created: 2 }, content: [{ id: "p1", type: "text", text: "First answer" }] },
      ],
      nextCursor: "provider-boundary-a1",
    });
    provider.pages.set("provider-boundary-a1", {
      items: [{ id: "u1", type: "user", time: { created: 1 }, text: "First" }],
    });
    const firstAdapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g1" });
    const first = await firstAdapter.history("session", { limit: 2 });
    expect(first.items.map(item => item.id)).toEqual(["part:p1", "message:u2"]);
    expect(first.olderCursor).toBeDefined();
    expect(first.olderCursor).not.toContain("provider-boundary");

    const restarted = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g2" });
    const older = await restarted.history("session", { cursor: first.olderCursor });
    expect(older.items.map(item => item.id)).toEqual(["message:u1"]);
    expect(new Set([...first.items, ...older.items].map(item => item.id)).size).toBe(3);
  });
});

describe("filtered provider event pump", () => {
  test("a list fetch cannot acknowledge a delayed lifecycle event for another client", async () => {
    const provider = new FakeProvider();
    const external = fixtureSession("external");
    provider.sessions = [external];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    expect((await adapter.listConversations()).map(conversation => conversation.id)).toEqual(["external"]);
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const pump = adapter.startEventPump();
    await expectInventorySignal(inventory);

    provider.eventQueue.push({ type: "session.created", data: { info: external } });
    await expectInventorySignal(inventory);

    await adapter.dispose();
    await pump;
  });

  test("invalidates only for top-level lifecycle changes in the canonical workspace", async () => {
    const provider = new FakeProvider();
    const local = fixtureSession("local");
    const child = { ...fixtureSession("child"), parentId: "local" };
    const foreign = fixtureSession("foreign", `${process.cwd()}-foreign`);
    provider.sessions = [local, child, foreign];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.listConversations();
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const pump = adapter.startEventPump();
    await expectInventorySignal(inventory);

    // A list fetch does not acknowledge lifecycle metadata. The first unknown
    // local update invalidates conservatively, even if only timestamps changed.
    provider.eventQueue.push({ type: "session.updated", data: { info: { ...local, time: { updated: 99 } } } });
    await expectInventorySignal(inventory);

    let settled = false;
    const afterNoise = inventory.next().then(result => { settled = true; return result; });
    provider.eventQueue.push({ type: "session.updated", data: { info: { ...local, time: { updated: 100 } } } });
    provider.eventQueue.push({ type: "session.updated", data: { info: { ...child, title: "Child renamed" } } });
    provider.eventQueue.push({ type: "session.updated", data: { info: { ...foreign, title: "Foreign renamed" } } });
    await Bun.sleep(20);
    expect(settled).toBe(false);

    const renamed = { ...local, title: "Local renamed" };
    provider.eventQueue.push({ type: "session.updated", data: { info: renamed } });
    expect((await afterNoise).done).toBe(false);

    settled = false;
    const afterDuplicate = inventory.next().then(result => { settled = true; return result; });
    provider.eventQueue.push({ type: "session.updated", data: { info: { ...renamed, time: { updated: 100 } } } });
    provider.eventQueue.push({ type: "session.created", data: { info: { ...child, id: "new-child" } } });
    await Bun.sleep(20);
    expect(settled).toBe(false);

    const created = fixtureSession("created");
    provider.eventQueue.push({ type: "session.created", data: { info: created } });
    expect((await afterDuplicate).done).toBe(false);

    const promotedChild = inventory.next();
    provider.eventQueue.push({ type: "session.updated", data: { info: { ...child, parentId: undefined, title: "Child promoted" } } });
    expect((await promotedChild).done).toBe(false);

    const demotedChild = inventory.next();
    provider.eventQueue.push({ type: "session.updated", data: { info: child } });
    expect((await demotedChild).done).toBe(false);

    const deleted = inventory.next();
    provider.eventQueue.push({ type: "session.deleted", data: { info: created } });
    expect((await deleted).done).toBe(false);

    settled = false;
    const afterDuplicateDelete = inventory.next().then(result => { settled = true; return result; });
    provider.eventQueue.push({ type: "session.deleted", data: { info: created } });
    await Bun.sleep(20);
    expect(settled).toBe(false);

    await adapter.dispose();
    expect((await afterDuplicateDelete).done).toBe(true);
    await pump;
  });

  test("a sparse lifecycle update keeps a child's parent; a full record without one promotes it", async () => {
    const provider = new FakeProvider();
    const local = fixtureSession("local");
    const child = { ...fixtureSession("child"), parentId: "local" };
    provider.sessions = [local, child];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    expect((await adapter.listConversations()).map(conversation => conversation.id)).toEqual(["local"]);
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const pump = adapter.startEventPump();
    await expectInventorySignal(inventory);

    // 2.x's rename names the id and the title only. The child stays a child:
    // nothing to list, so nothing to invalidate.
    let settled = false;
    const afterSparse = inventory.next().then(result => { settled = true; return result; });
    provider.eventQueue.push({ normalized: { conversationId: "child", updates: [], outcome: "handled", eventType: "session.renamed", sessionLifecycle: { kind: "updated", id: "child", directory: process.cwd(), title: "Child renamed", sparse: true } } });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    expect((await adapter.listConversations()).map(conversation => conversation.id)).toEqual(["local"]);

    // A full record with no parent is the promotion it says it is.
    provider.eventQueue.push({ type: "session.updated", data: { info: { ...child, parentId: undefined, title: "Child promoted" } } });
    expect((await afterSparse).done).toBe(false);

    await adapter.dispose();
    await pump;
  });

  test("classifies deleted sessions from event metadata without looking them up", async () => {
    const provider = new FakeProvider();
    let lookups = 0;
    provider.getSession = async () => { lookups += 1; return null; };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const pump = adapter.startEventPump();
    await expectInventorySignal(inventory);

    provider.eventQueue.push({ type: "session.deleted", data: { info: fixtureSession("deleted") } });
    await expectInventorySignal(inventory);
    expect(lookups).toBe(0);

    await adapter.dispose();
    await pump;
  });

  test("a sparse deletion invalidates only for a session the adapter listed, and never looks it up", async () => {
    const provider = new FakeProvider();
    let lookups = 0;
    provider.getSession = async () => { lookups += 1; return null; };
    const listed = fixtureSession("listed");
    provider.sessions = [listed];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.listConversations();
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const pump = adapter.startEventPump();
    await expectInventorySignal(inventory);

    // 2.x's deletion names an id and nothing else. Unknown here, it may be
    // another directory's on a shared server: nothing listed can have gone.
    let settled = false;
    const afterUnknown = inventory.next().then(result => { settled = true; return result; });
    provider.eventQueue.push({ normalized: { conversationId: "elsewhere", updates: [], outcome: "handled", eventType: "session.deleted", sessionLifecycle: { kind: "deleted", id: "elsewhere", directory: process.cwd(), title: "", sparse: true } } });
    await Bun.sleep(20);
    expect(settled).toBe(false);

    // A listed session's deletion is a change to the list.
    provider.eventQueue.push({ normalized: { conversationId: "listed", updates: [], outcome: "handled", eventType: "session.deleted", sessionLifecycle: { kind: "deleted", id: "listed", directory: process.cwd(), title: "", sparse: true } } });
    expect((await afterUnknown).done).toBe(false);
    expect(lookups).toBe(0);

    await adapter.dispose();
    await pump;
  });

  test("pump stops are restartable while adapter disposal closes inventory subscriptions", async () => {
    const provider = new FakeProvider();
    let starts = 0;
    provider.events = signal => ({
      async *[Symbol.asyncIterator]() {
        starts += 1;
        while (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      },
    });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);

    const first = adapter.startEventPump();
    await expectInventorySignal(inventory);
    expect(adapter.startEventPump()).toBe(first);
    await adapter.stopEventPump();
    await first;

    const restarted = adapter.startEventPump();
    await expectInventorySignal(inventory);
    expect(starts).toBe(2);
    await adapter.stopEventPump();
    await restarted;

    const waiting = inventory.next();
    await adapter.dispose();
    expect((await waiting).done).toBe(true);
    expect((await adapter.subscribeInventory().next()).done).toBe(true);
  });

  test("validates the current session directory before every publication", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local"), fixtureSession("foreign", `${process.cwd()}-foreign`)];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ id: "foreign-event", type: "session.next.text.delta", data: { sessionID: "foreign", partID: "x", delta: "secret" } });
    provider.eventQueue.push({ id: "local-event", type: "session.next.text.delta", data: { sessionID: "local", partID: "x", delta: "safe" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);
    provider.sessions[0] = fixtureSession("local", `${process.cwd()}-moved`);
    provider.eventQueue.push({ id: "moved-event", type: "session.next.text.delta", data: { sessionID: "local", partID: "x", delta: " hidden" } });
    await Bun.sleep(1);
    await adapter.stopEventPump();
    await pump;

    expect(adapter.projectionForTests("foreign").items()).toEqual([]);
    expect(adapter.projectionForTests("local").items()).toEqual([expect.objectContaining({ markdown: "safe" })]);
  });

  test("a pump failure aborts the provider event signal so surviving streams shut down", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    let observed: AbortSignal | undefined;
    provider.events = (signal: AbortSignal) => {
      observed = signal;
      return {
        async *[Symbol.asyncIterator]() {
          throw new Error("stream died");
        },
      };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    await expect(adapter.startEventPump()).rejects.toThrow("stream died");
    expect(observed?.aborted).toBe(true);
  });

  test("a message.updated echo without parts keeps a history-loaded user message's text", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    provider.pages.set("first", { items: [{ id: "msg_history", type: "user", time: { created: 1 }, text: "hello from history" }] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.history("local");
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ id: "echo", type: "message.updated", data: { info: { id: "msg_history", role: "user", sessionID: "local", time: { created: 1 } } } });
    await Bun.sleep(1);
    await adapter.stopEventPump();
    await pump;

    expect(adapter.projectionForTests("local").items()).toEqual([expect.objectContaining({ type: "user_message", text: "hello from history" })]);
  });

  test("coalesces streamed deltas into a single published event per window", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    // The window is real time; it has to outlast the pump's handling of three queued deltas on a loaded machine, or
    // they straddle two windows.
    const windowMs = 100;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: windowMs });
    const pump = adapter.startEventPump();
    const { events } = await adapter.subscribe("local");
    const received: ChatEvent[] = [];
    void (async () => { for await (const event of events) received.push(event); })();

    for (const delta of ["He", "ll", "o"]) {
      provider.eventQueue.push({ id: `e-${delta}`, type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta } });
    }
    for (let i = 0; i < 200 && received.length === 0; i++) await Bun.sleep(10);
    // A second window passes, so a split publication would have arrived.
    await Bun.sleep(windowMs * 2);
    await adapter.stopEventPump();
    await pump;

    expect(adapter.projectionForTests("local").items()).toEqual([expect.objectContaining({ markdown: "Hello" })]);
    // Three provider deltas within one window publish a single event.
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(expect.objectContaining({ type: "item.upsert", item: expect.objectContaining({ markdown: "Hello" }) }));
    events.cancel();
  });

  // OpenCode 2.x announces a tool call's input on `session.tool.called` and
  // follows it inside the same window with a `session.tool.progress` that
  // carries none. Replacing the buffered frame with the sparse one left the
  // row without its input for the rest of its life, and a wildcard
  // permission pointing at that row had nothing to show (GitHub #476).
  test("a sparse tool frame in the same window as the call keeps the call's input", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const windowMs = 100;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: windowMs });
    const pump = adapter.startEventPump();
    const { events } = await adapter.subscribe("local");
    const received: ChatEvent[] = [];
    void (async () => { for await (const event of events) received.push(event); })();

    provider.eventQueue.push({ id: "e-called", type: "session.tool.called", data: { sessionID: "local", callID: "call_1", tool: "execute", input: { code: "await tools.tracker.create_issue({ title: \"Login fails\" })" }, timestamp: 1 } });
    provider.eventQueue.push({ id: "e-progress", type: "session.tool.progress", data: { sessionID: "local", callID: "call_1", tool: "execute", timestamp: 2 } });
    for (let i = 0; i < 200 && received.length === 0; i++) await Bun.sleep(10);
    await Bun.sleep(windowMs * 2);
    await adapter.stopEventPump();
    await pump;

    const row = adapter.projectionForTests("local").items().find(item => item.id === "tool:call_1");
    expect(row).toEqual(expect.objectContaining({ type: "tool", name: "execute", status: "running", input: JSON.stringify({ code: "await tools.tracker.create_issue({ title: \"Login fails\" })" }) }));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(expect.objectContaining({ type: "item.upsert", item: expect.objectContaining({ id: "tool:call_1", input: expect.stringContaining("create_issue") }) }));
    events.cancel();
  });

  test("evicts the least recently used idle conversation and keeps subscribed ones", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("a"), fixtureSession("b"), fixtureSession("c")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", maxProjections: 2 });
    const { events } = await adapter.subscribe("a");
    await adapter.subscribe("b").then(result => result.events.cancel());
    const before = adapter.projectionForTests("a");

    await adapter.getConversation("c");
    await adapter.subscribe("c").then(result => result.events.cancel());

    // "a" still has a live subscriber, so "b" is the eviction target.
    expect(adapter.projectionForTests("a")).toBe(before);
    events.cancel();
  });
});

describe("reversible history coordination", () => {
  type TestHistoryState = Omit<ReversibleHistoryState, "revertedMessages"> & Partial<Pick<ReversibleHistoryState, "revertedMessages">>;
  const completeState = (state: TestHistoryState): ReversibleHistoryState => ({ ...state, revertedMessages: state.revertedMessages ?? [] });

  function enabled(initial: TestHistoryState, messages: ProviderMessage[] = []) {
    const provider = new FakeProvider();
    provider.agent.capabilities.push("reversible-history");
    provider.sessions = [fixtureSession("session")];
    let state = completeState(initial);
    let visible = messages;
    provider.getReversibleHistoryState = async () => state;
    provider.revert = async () => ({ outcome: "changed", state });
    provider.restore = async () => ({ outcome: "changed", state });
    provider.readMessages = async () => ({ items: visible });
    return {
      provider,
      state: () => state,
      setState: (next: TestHistoryState) => { state = completeState(next); },
      setVisible: (next: ProviderMessage[]) => { visible = next; },
    };
  }

  test("a completed Undo boundary invalidates an older worker read, including rows not previously projected", async () => {
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false }, [{ id: "old-prompt", type: "user", time: { created: 1 }, text: "old branch" }]);
    fixture.provider.undo = async () => {
      fixture.setState({ staged: true, canUndo: false, canRedo: true });
      fixture.setVisible([]);
      return { outcome: "changed", state: fixture.state() };
    };
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(fixture.provider, { reconcileBackgroundTasks: async () => {
      if (++reads !== 1) return [];
      await gate;
      return [{ id: "task:old-branch", type: "background_task", taskId: "old-branch", description: "Old branch", createdAt: 1, status: "running" }];
    } });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    adapter.projectionForTests("session").apply({ kind: "upsert", item: { id: "message:old-prompt", type: "user_message", text: "old branch", createdAt: 1 } });
    const pump = adapter.startEventPump();
    try {
      fixture.provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      expect((await adapter.undo("session", "undo")).outcome).toBe("changed");
      jest.useFakeTimers(); release(); await flushRecoveryIo();
      expect(adapter.projectionForTests("session").has("task:old-branch")).toBe(false);
      jest.advanceTimersByTime(100); await flushRecoveryIo();
      expect(reads).toBe(2);
      expect(adapter.projectionForTests("session").items()).toEqual([]);
      expect(fixture.provider.prompts).toEqual([]);
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  test("requires both the capability and every provider operation, and avoids interrupting a no-op", async () => {
    const incomplete = new FakeProvider();
    incomplete.sessions = [fixtureSession("session")];
    incomplete.agent.capabilities.push("reversible-history");
    const unsupported = new ChatAdapter({ provider: incomplete, workspacePath: process.cwd() });
    await expect(unsupported.undo("session", "u1")).rejects.toBeInstanceOf(ReversibleHistoryUnsupportedError);

    const fixture = enabled({ staged: false, canUndo: false, canRedo: false });
    let undoCalls = 0;
    fixture.provider.undo = async () => {
      undoCalls += 1;
      return { outcome: "nothing-to-undo", state: fixture.state() };
    };
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd() });
    adapter.projectionForTests("session").statusUpdate("running");

    await expect(adapter.undo("session", "u2")).resolves.toEqual({
      outcome: "nothing-to-undo",
      state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] },
    });
    expect(undoCalls).toBe(0);
    expect(fixture.provider.interrupts).toEqual([]);
  });

  test("sets and restores a selected boundary once while reconciling authoritative history", async () => {
    const first = { id: "first", type: "user", time: { created: 1 }, text: "first prompt" };
    const second = { id: "second", type: "user", time: { created: 2 }, text: "second prompt" };
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false }, [first, second]);
    const targeted: Array<["revert" | "restore", string]> = [];
    fixture.provider.revert = async (_sessionId, messageId) => {
      targeted.push(["revert", messageId]);
      fixture.setState({
        staged: true,
        canUndo: true,
        canRedo: true,
        revertedMessages: [{ id: "message:second", text: "second prompt" }],
      });
      fixture.setVisible([first]);
      return { outcome: "changed", state: fixture.state(), restoredDraft: { text: "second prompt" } };
    };
    fixture.provider.restore = async (_sessionId, messageId) => {
      targeted.push(["restore", messageId]);
      fixture.setState({ staged: false, canUndo: true, canRedo: false });
      fixture.setVisible([first, second]);
      return { outcome: "changed", state: fixture.state() };
    };
    fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.history("session");
    adapter.projectionForTests("session").statusUpdate("running");

    const [firstCall, retry] = await Promise.all([
      adapter.revert("session", "message:second", "revert-1"),
      adapter.revert("session", "message:second", "revert-1"),
    ]);
    expect(retry).toEqual(firstCall);
    expect(firstCall).toEqual({
      outcome: "changed",
      state: {
        staged: true,
        canUndo: true,
        canRedo: true,
        revertedMessages: [{ id: "message:second", text: "second prompt" }],
      },
      restoredDraft: { text: "second prompt" },
    });
    expect(targeted).toEqual([["revert", "message:second"]]);
    expect(fixture.provider.interrupts).toEqual(["session"]);
    expect((await adapter.history("session")).items).toEqual([expect.objectContaining({ text: "first prompt" })]);

    await expect(adapter.restore("session", "message:second", "restore-1")).resolves.toEqual({
      outcome: "changed",
      state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
    });
    expect(targeted).toEqual([
      ["revert", "message:second"],
      ["restore", "message:second"],
    ]);
    expect((await adapter.history("session")).items).toEqual([
      expect.objectContaining({ text: "first prompt" }),
      expect.objectContaining({ text: "second prompt" }),
    ]);
  });

  test("rejects a stale selected target before interrupting active work or releasing its queue", async () => {
    const visible = { id: "visible", type: "user", time: { created: 1 }, text: "visible prompt" };
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false }, [visible]);
    let revertCalls = 0;
    fixture.provider.revert = async () => {
      revertCalls += 1;
      return { outcome: "changed", state: fixture.state() };
    };
    fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd() });
    await adapter.history("session");
    adapter.projectionForTests("session").statusUpdate("running");
    const held = await adapter.prompt("session", "held", "keep queued");

    await expect(adapter.revert("session", "message:stale", "revert-stale")).rejects.toBeInstanceOf(ReversibleHistoryTargetError);
    expect(revertCalls).toBe(0);
    expect(fixture.provider.interrupts).toEqual([]);
    expect(fixture.provider.prompts).toEqual([]);
    expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: held.messageId, text: "keep queued" })]);
  });

  test("joins lost-response retries, closes the interrupt-idle race, and keeps restored drafts private", async () => {
    const availableId = "11111111-2222-4333-8444-555555555555";
    const missingId = "99999999-0000-4000-8000-000000000000";
    const latest = { id: "latest", type: "user", time: { created: 1 }, text: "private draft" };
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false }, [latest]);
    let undoCalls = 0;
    fixture.provider.undo = async () => {
      undoCalls += 1;
      fixture.setState({ staged: true, canUndo: false, canRedo: true });
      fixture.setVisible([]);
      return {
        outcome: "changed",
        state: fixture.state(),
        restoredDraft: {
          text: "private draft",
          attachments: [
            { id: availableId, name: "available.png", mimeType: "image/png" },
            { id: missingId, name: "missing.png", mimeType: "image/png" },
            { name: "provider-placeholder.png", mimeType: "image/webp" },
          ],
        },
      };
    };
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({
      provider: fixture.provider,
      workspacePath: process.cwd(),
      generation: "g",
      id: () => "held",
      resolveAttachment: async id => id === availableId
        ? { id, mimeType: "image/png", absolutePath: "/state/available.png" }
        : null,
    });
    await adapter.history("session");
    adapter.projectionForTests("session").statusUpdate("running");
    const held = await adapter.prompt("session", "queued", "older queued message");
    expect(held.pending).toBe(true);
    const firstClient = await adapter.subscribe("session");
    const secondClient = await adapter.subscribe("session");

    fixture.provider.interrupt = async sessionId => {
      fixture.provider.interrupts.push(sessionId);
      adapter.projectionForTests("session").statusUpdate("idle");
      await Bun.sleep(5);
    };
    const [first, retry] = await Promise.all([
      adapter.undo("session", "undo-1"),
      adapter.undo("session", "undo-1"),
    ]);

    expect(retry).toEqual(first);
    expect(undoCalls).toBe(1);
    expect(fixture.provider.interrupts).toEqual(["session"]);
    expect(fixture.provider.prompts).toEqual([]);
    expect(first).toEqual({
      outcome: "changed",
      state: { staged: true, canUndo: false, canRedo: true, revertedMessages: [] },
      restoredDraft: {
        text: "private draft",
        attachments: [
          { id: availableId, name: "available.png", mimeType: "image/png" },
          { name: "missing.png", mimeType: "image/png" },
          { name: "provider-placeholder.png", mimeType: "image/webp" },
        ],
      },
    });
    for (const subscription of [firstClient.events, secondClient.events]) {
      const iterator = subscription[Symbol.asyncIterator]();
      const events: ChatEvent[] = [];
      while (!events.some(event => event.type === "resync")) events.push((await iterator.next()).value!);
      expect(events.find(event => event.type === "resync")).toEqual(expect.objectContaining({ reason: "conversation-rewritten" }));
      expect(JSON.stringify(events)).not.toContain("private draft");
      subscription.cancel();
    }
    const snapshot = await adapter.history("session");
    expect(snapshot.reversibleHistory).toEqual({ staged: true, canUndo: false, canRedo: true, revertedMessages: [] });
    expect(snapshot.queued).toEqual([expect.objectContaining({ id: held.messageId, text: "older queued message" })]);
    await expect(adapter.removeQueued("session", held.messageId, "remove-held")).resolves.toEqual({ removed: true });
  });

  test("local and repeated lifecycle triggers converge to one rewrite and discard stale coalesced updates", async () => {
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false }, [
      { id: "latest", type: "user", time: { created: 1 }, text: "discard me" },
    ]);
    fixture.provider.undo = async () => {
      fixture.setState({ staged: true, canUndo: false, canRedo: true });
      fixture.setVisible([]);
      fixture.provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "session" } });
      return { outcome: "changed", state: fixture.state(), restoredDraft: { text: "discard me" } };
    };
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 40 });
    await adapter.history("session");
    const subscription = await adapter.subscribe("session");
    const iterator = subscription.events[Symbol.asyncIterator]();
    const pump = adapter.startEventPump();
    fixture.provider.eventQueue.push({ type: "session.next.text.delta", data: { sessionID: "session", partID: "stale", delta: "stale branch" } });

    await adapter.undo("session", "undo-1");
    fixture.provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "session" } });
    const first = await iterator.next();
    expect(first.value).toEqual(expect.objectContaining({ type: "resync", reason: "conversation-rewritten" }));
    await Bun.sleep(80);
    expect(adapter.projectionForTests("session").items()).toEqual([]);
    const duplicate = await Promise.race([iterator.next(), Bun.sleep(30).then(() => "timeout" as const)]);
    expect(duplicate).toBe("timeout");

    subscription.events.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("external staged, cleared, and committed events reconcile provider history and state", async () => {
    const original = { id: "original", type: "user", time: { created: 1 }, text: "original" };
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false }, [original]);
    fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.history("session");
    const subscription = await adapter.subscribe("session");
    const iterator = subscription.events[Symbol.asyncIterator]();
    const pump = adapter.startEventPump();

    fixture.setState({ staged: true, canUndo: false, canRedo: true });
    fixture.setVisible([]);
    fixture.provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "session" } });
    expect((await iterator.next()).value).toEqual(expect.objectContaining({ type: "resync", reason: "conversation-rewritten" }));
    expect(adapter.projectionForTests("session").items()).toEqual([]);

    fixture.setState({ staged: false, canUndo: true, canRedo: false });
    fixture.setVisible([original]);
    fixture.provider.eventQueue.push({ type: "session.next.revert.cleared", data: { sessionID: "session" } });
    expect((await iterator.next()).value).toEqual(expect.objectContaining({ type: "resync", reason: "conversation-rewritten" }));
    expect(adapter.projectionForTests("session").items()).toEqual([expect.objectContaining({ text: "original" })]);

    fixture.setVisible([]);
    fixture.provider.eventQueue.push({ type: "session.next.revert.committed", data: { sessionID: "session" } });
    expect((await iterator.next()).value).toEqual(expect.objectContaining({ type: "resync", reason: "conversation-rewritten" }));
    expect(adapter.projectionForTests("session").items()).toEqual([]);
    const refreshed = await adapter.subscribe("session");
    expect(refreshed.snapshot.reversibleHistory).toEqual({ staged: false, canUndo: true, canRedo: false, revertedMessages: [] });
    refreshed.events.cancel();

    subscription.events.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("a staged outage beyond the former retry window still recovers with one paused queue", async () => {
    const original = { id: "original", type: "user", time: { created: 1 }, text: "discard me" };
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false }, [original]);
    fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.history("session");
    adapter.projectionForTests("session").statusUpdate("running");
    const held = await adapter.prompt("session", "held", "wait until the revert settles");
    const subscription = await adapter.subscribe("session");
    const iterator = subscription.events[Symbol.asyncIterator]();

    let historyReads = 0;
    let recovered = false;
    fixture.provider.readMessages = async () => {
      historyReads += 1;
      if (!recovered) throw new Error("provider restarting");
      return { items: [] };
    };
    fixture.setState({ staged: true, canUndo: false, canRedo: true });
    fixture.setVisible([]);
    const pump = adapter.startEventPump();
    for (let duplicate = 0; duplicate < 3; duplicate += 1) {
      fixture.provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "session" } });
    }
    await waitUntil(() => historyReads >= 1);
    // The idle event caused by the external interrupt cannot release the head
    // while the authoritative reads are backing off.
    adapter.projectionForTests("session").statusUpdate("idle");
    await Bun.sleep(1_050);
    expect(historyReads).toBeGreaterThanOrEqual(5);
    expect(adapter.projectionForTests("session").items()).toEqual([expect.objectContaining({ text: "discard me" })]);
    expect(fixture.provider.prompts).toEqual([]);

    recovered = true;
    await waitUntil(() => adapter.projectionForTests("session").items().length === 0);

    const events: ChatEvent[] = [];
    while (!events.some(event => event.type === "resync")) events.push((await iterator.next()).value!);
    expect(events.filter(event => event.type === "resync")).toHaveLength(1);
    expect(events.some(event => event.type === "item.upsert" && event.item.type === "notice")).toBe(false);
    expect(fixture.provider.prompts).toEqual([]);
    const snapshot = await adapter.subscribe("session");
    expect(snapshot.snapshot.reversibleHistory).toEqual({ staged: true, canUndo: false, canRedo: true, revertedMessages: [] });
    expect(snapshot.snapshot.queued).toEqual([expect.objectContaining({ id: held.messageId })]);
    snapshot.events.cancel();
    const duplicateEvent = await Promise.race([iterator.next(), Bun.sleep(120).then(() => "timeout" as const)]);
    expect(duplicateEvent).toBe("timeout");

    subscription.events.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("transient cleared and committed reconciliation failures replace history and resume one held queue", async () => {
    for (const lifecycle of ["cleared", "committed"] as const) {
      const authoritative = { id: `authoritative-${lifecycle}`, type: "user", time: { created: 2 }, text: `after ${lifecycle}` };
      const fixture = enabled({ staged: false, canUndo: true, canRedo: false });
      fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
      fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
      const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd(), generation: `g-${lifecycle}` });
      adapter.projectionForTests("session").statusUpdate("running");
      const held = await adapter.prompt("session", `held-${lifecycle}`, `resume after ${lifecycle}`);
      fixture.setState({ staged: true, canUndo: false, canRedo: true });
      fixture.setVisible([]);
      await adapter.history("session");
      adapter.projectionForTests("session").statusUpdate("interrupted");
      adapter.projectionForTests("session").upsert({ id: "message:stale", type: "user_message", createdAt: 1, text: "stale branch" });
      const subscription = await adapter.subscribe("session");
      const iterator = subscription.events[Symbol.asyncIterator]();

      let stateReads = 0;
      fixture.provider.getReversibleHistoryState = async () => {
        stateReads += 1;
        if (stateReads <= 2) throw new Error("transient state failure");
        return fixture.state();
      };
      fixture.setState({ staged: false, canUndo: true, canRedo: false });
      fixture.setVisible([authoritative]);
      const pump = adapter.startEventPump();
      for (let duplicate = 0; duplicate < 3; duplicate += 1) {
        fixture.provider.eventQueue.push({ type: `session.next.revert.${lifecycle}`, data: { sessionID: "session" } });
      }

      await waitUntil(() => stateReads >= 3 && fixture.provider.prompts.length === 1);
      expect(fixture.provider.prompts[0]).toEqual(expect.objectContaining({ id: held.messageId, text: `resume after ${lifecycle}` }));
      expect(adapter.projectionForTests("session").items()).toContainEqual(expect.objectContaining({ text: `after ${lifecycle}` }));
      expect(adapter.projectionForTests("session").has("message:stale")).toBe(false);

      const events: ChatEvent[] = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const next = await Promise.race([iterator.next(), Bun.sleep(20).then(() => "timeout" as const)]);
        if (next === "timeout") break;
        events.push((next as IteratorResult<ChatEvent>).value!);
      }
      expect(events.filter(event => event.type === "resync")).toHaveLength(1);
      expect(events.some(event => event.type === "item.upsert" && event.item.type === "notice")).toBe(false);

      subscription.events.cancel();
      await adapter.stopEventPump();
      await pump;
    }
  });

  test("disposing the adapter cancels a pending lifecycle retry", async () => {
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false });
    fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd() });
    await adapter.history("session");
    let reads = 0;
    fixture.provider.readMessages = async () => {
      reads += 1;
      throw new Error("provider unavailable");
    };
    const pump = adapter.startEventPump();
    fixture.provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "session" } });
    await waitUntil(() => reads === 1);
    await Bun.sleep(5); // let the failed attempt arm its retry timer
    await adapter.dispose();
    await pump;
    await Bun.sleep(120);
    expect(reads).toBe(1);
  });

  test("deleting a conversation cancels its pending lifecycle retry", async () => {
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false });
    fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd() });
    await adapter.history("session");
    let reads = 0;
    fixture.provider.readMessages = async () => {
      reads += 1;
      throw new Error("provider unavailable");
    };
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const pump = adapter.startEventPump();
    await expectInventorySignal(inventory);
    fixture.provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "session" } });
    await waitUntil(() => reads === 1);
    await Bun.sleep(5);

    const deleted = inventory.next();
    fixture.provider.eventQueue.push({ type: "session.deleted", data: { info: fixtureSession("session") } });
    expect((await deleted).done).toBe(false);
    await Bun.sleep(120);
    expect(reads).toBe(1);

    inventory.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("moving a conversation out of the workspace cancels an in-flight lifecycle reconciliation", async () => {
    const original = { id: "original", type: "user", time: { created: 1 }, text: "keep after move" };
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false }, [original]);
    fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd() });
    await adapter.history("session");
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const pump = adapter.startEventPump();
    await expectInventorySignal(inventory);
    const known = inventory.next();
    fixture.provider.eventQueue.push({ type: "session.updated", data: { info: fixture.provider.sessions[0]! } });
    expect((await known).done).toBe(false);

    let reads = 0;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>(resolve => {
      fixture.provider.readMessages = async () => {
        reads += 1;
        if (reads === 1) {
          resolve();
          await new Promise<void>(release => { releaseRead = release; });
          return { items: [], nextCursor: "must-not-be-read" };
        }
        return { items: [] };
      };
    });
    fixture.setState({ staged: true, canUndo: false, canRedo: true });
    fixture.provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "session" } });
    await readStarted;

    const moved = fixtureSession("session", `${process.cwd()}-moved`);
    fixture.provider.sessions[0] = moved;
    const movedSignal = inventory.next();
    fixture.provider.eventQueue.push({ type: "session.updated", data: { info: moved } });
    expect((await movedSignal).done).toBe(false);
    releaseRead();
    await Bun.sleep(120);

    expect(reads).toBe(1);
    expect(adapter.projectionForTests("session").items()).toEqual([expect.objectContaining({ text: "keep after move" })]);

    inventory.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("a replacement prompt commits first and older held messages resume after its turn", async () => {
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false });
    fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
    fixture.provider.redo = async () => ({ outcome: "nothing-to-redo", state: fixture.state() });
    const order: string[] = [];
    fixture.provider.prompt = async (sessionId, input) => {
      fixture.provider.prompts.push({ sessionId, ...input });
      order.push(input.text);
      if (input.text === "replacement") {
        fixture.setState({ staged: false, canUndo: true, canRedo: false });
        fixture.setVisible([{ id: input.id, type: "user", time: { created: 2 }, text: input.text }]);
      }
      return { messageId: input.id };
    };
    let id = 0;
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd(), id: () => `id-${++id}` });
    adapter.projectionForTests("session").statusUpdate("running");
    const older = await adapter.prompt("session", "older", "older queued");
    fixture.setState({ staged: true, canUndo: false, canRedo: true });
    await adapter.history("session");
    adapter.projectionForTests("session").statusUpdate("interrupted");

    const replacement = await adapter.prompt("session", "replacement", "replacement");
    expect(replacement.pending).toBe(false);
    expect(order).toEqual(["replacement"]);
    expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: older.messageId })]);
    adapter.projectionForTests("session").statusUpdate("completed");
    await waitUntil(() => order.length === 2);
    expect(order).toEqual(["replacement", "older queued"]);
  });

  test("Redo clearing the boundary resumes the held queue while failures keep it paused", async () => {
    const fixture = enabled({ staged: false, canUndo: true, canRedo: false });
    fixture.provider.undo = async () => ({ outcome: "nothing-to-undo", state: fixture.state() });
    let fail = true;
    fixture.provider.redo = async (): Promise<ReversibleHistoryResult> => {
      if (fail) throw new Error("redo failed");
      fixture.setState({ staged: false, canUndo: true, canRedo: false });
      return { outcome: "changed", state: fixture.state() };
    };
    const adapter = new ChatAdapter({ provider: fixture.provider, workspacePath: process.cwd() });
    adapter.projectionForTests("session").statusUpdate("running");
    const held = await adapter.prompt("session", "held", "held while staged");
    fixture.setState({ staged: true, canUndo: false, canRedo: true });
    await adapter.history("session");
    adapter.projectionForTests("session").statusUpdate("interrupted");

    await expect(adapter.redo("session", "redo-failed")).rejects.toThrow("redo failed");
    await Bun.sleep(20);
    expect(fixture.provider.prompts).toEqual([]);
    expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: held.messageId })]);

    fail = false;
    await expect(adapter.redo("session", "redo-clear")).resolves.toEqual({
      outcome: "changed",
      state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
    });
    await waitUntil(() => fixture.provider.prompts.length === 1);
    expect(fixture.provider.prompts[0]).toEqual(expect.objectContaining({ text: "held while staged" }));
  });
});

describe("prompt, abort, permission, and question mutations", () => {
  test("catalog changes advance the agent revision and invalidate inventory without a conversation", async () => {
    const provider = new FakeProvider();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const inventory = adapter.subscribeInventory();
    await inventory.next();
    const pump = adapter.startEventPump();
    try {
      expect(adapter.catalogRevision()).toBeUndefined();
      provider.eventQueue.push({ type: "catalog.updated", normalized: { updates: [], outcome: "handled", eventType: "catalog.updated", catalogsChanged: true } });
      await liveEventsApplied(adapter, provider);
      await expectInventorySignal(inventory);
      expect(adapter.catalogRevision()).toBe("g:1");
      expect(provider.sessions).toEqual([]);
    } finally { inventory.cancel(); await adapter.stopEventPump(); await pump; await adapter.dispose(); }
  });
  test("provider-held window metadata survives projection eviction", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("a"), fixtureSession("b")];
    const window: ConversationItem = { id: "window", type: "context_window", createdAt: 1, model: { providerId: "anthropic", modelId: "opus" }, limit: 1_000_000, window: { source: "session", freshness: "current" } };
    provider.listMessages = async id => ({ items: id === "a" ? [window] : [], accounting: [] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), maxProjections: 1 });
    try {
      expect((await adapter.history("a")).items).toContainEqual(window);
      await adapter.history("b");
      expect((await adapter.history("a")).items).toContainEqual(window);
    } finally { await adapter.dispose(); }
  });
  test("snapshots recover provider-owned configuration and cache only while projected", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("a"), fixtureSession("b")];
    provider.configurations.set("a", { model: { providerId: "openai", modelId: "gpt" }, mode: "build", variant: "high" });
    let reads = 0;
    const recover = provider.getConversationConfiguration.bind(provider);
    provider.getConversationConfiguration = async id => { reads += 1; return recover(id); };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), maxProjections: 1 });

    expect((await adapter.history("a")).configuration).toEqual(provider.configurations.get("a")!);
    expect((await adapter.history("a")).configuration).toEqual(provider.configurations.get("a")!);
    expect(reads).toBe(1);
    await adapter.history("b");
    await adapter.history("a");
    expect(reads).toBe(3);
  });

  test("configuration recovery is delegated to the provider by id alone", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const user = { info: { id: "user", role: "user", variant: "high" }, parts: [] };
    const assistant = { info: { id: "assistant", role: "assistant" }, parts: [] };
    provider.pages.set("first", { items: [assistant], configurationItems: [user, assistant] });
    // The provider owns recovery over its complete source; the adapter hands
    // it nothing page-shaped to second-guess with.
    provider.getConversationConfiguration = async id => {
      expect(id).toBe("session");
      return { model: { providerId: "openai", modelId: "gpt" }, mode: "build", variant: "high" };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });

    expect((await adapter.history("session", { limit: 1 })).configuration.variant).toBe("high");
  });

  test("a cold configuration read cannot overwrite a newer provider event", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const stale = { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan" };
    let reads = 0;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    let releaseRead!: () => void;
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    provider.getConversationConfiguration = async () => {
      reads += 1;
      if (reads === 1) {
        readStarted();
        await gate;
      }
      return stale;
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const events = adapter.projectionForTests("session").replay.handoff(() => null).subscription;
    const iterator = events[Symbol.asyncIterator]();
    const pump = adapter.startEventPump();

    const pendingHistory = adapter.history("session");
    await started;
    provider.eventQueue.push({
      type: "session.next.model.switched",
      properties: { sessionID: "session", model: { providerID: "openai", id: "gpt" } },
    });
    await Bun.sleep(0);
    releaseRead();
    await pendingHistory;
    let event: ChatEvent | undefined;
    while (event?.type !== "conversation.configuration") event = (await iterator.next()).value;

    expect(reads).toBe(1);
    expect(event.configuration).toEqual({ model: { providerId: "openai", modelId: "gpt" }, mode: "plan" });
    expect((await adapter.history("session")).configuration).toEqual(event.configuration);
    events.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("accepted configuration is returned and published once to live and replay subscribers", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.configurations.set("session", { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan" });
    provider.models[0] = { ...provider.models[0]!, variants: ["high"] };
    provider.listModes = async () => [{ name: "plan", description: "" }, { name: "build", description: "" }];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const first = await adapter.subscribe("session");
    const second = await adapter.subscribe("session");
    const cursor = first.snapshot.cursor;
    const configuration = { model: { providerId: "anthropic", modelId: "claude" }, mode: "build", variant: "high" };

    const accepted = await adapter.prompt("session", "request", "go", configuration.model, configuration.mode, configuration.variant);
    expect(accepted.configuration).toEqual(configuration);
    for (const subscription of [first.events, second.events]) {
      const iterator = subscription[Symbol.asyncIterator]();
      let event: ChatEvent | undefined;
      while (event?.type !== "conversation.configuration") event = (await iterator.next()).value;
      expect(event).toEqual(expect.objectContaining({ type: "conversation.configuration", configuration }));
      subscription.cancel();
    }

    await adapter.prompt("session", "request", "go", configuration.model, configuration.mode, configuration.variant);
    const replayed = await adapter.subscribe("session", { cursor });
    const iterator = replayed.events[Symbol.asyncIterator]();
    const events: ChatEvent[] = [];
    while (!events.some(event => event.type === "conversation.configuration")) events.push((await iterator.next()).value!);
    expect(events.filter(event => event.type === "conversation.configuration")).toHaveLength(1);
    replayed.events.cancel();
  });

  test("a new conversation follows the last configuration accepted by this adapter", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("existing")];
    provider.newConfiguration = { model: { providerId: "anthropic", modelId: "claude" }, mode: "build" };
    provider.models.push({ selection: { providerId: "openai", modelId: "gpt" }, provider: "OpenAI", name: "GPT" });
    provider.listModes = async () => [{ name: "build", description: "" }, { name: "plan", description: "" }];
    let nextId = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), id: () => nextId++ === 0 ? "message" : "created" });
    const selected = { model: { providerId: "openai", modelId: "gpt" }, mode: "plan" };

    expect((await adapter.prompt("existing", "request", "go", selected.model, selected.mode)).configuration).toEqual(selected);
    expect((await adapter.createConversation()).configuration).toEqual(selected);
    expect(provider.configurations.get("created")).toEqual(selected);
  });

  test("an unknown accepted prompt does not erase durable new-conversation defaults", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("existing")];
    provider.newConfiguration = { model: { providerId: "anthropic", modelId: "claude" }, mode: "build" };
    let nextId = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), id: () => nextId++ === 0 ? "message" : "created" });

    expect((await adapter.prompt("existing", "request", "go")).configuration).toEqual({});
    expect((await adapter.createConversation()).configuration).toEqual(provider.newConfiguration);
  });

  test("provider-reported model and mode switches update effective configuration", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.configurations.set("session", { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan", variant: "old" });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const { events } = await adapter.subscribe("session");
    const iterator = events[Symbol.asyncIterator]();
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "session.next.model.switched", properties: { sessionID: "session", model: { providerID: "openai", id: "gpt" } } });
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "conversation.configuration",
      configuration: { model: { providerId: "openai", modelId: "gpt" }, mode: "plan" },
    }));
    provider.eventQueue.push({ type: "session.next.agent.switched", properties: { sessionID: "session", agent: "build" } });
    expect((await iterator.next()).value).toEqual(expect.objectContaining({
      type: "conversation.configuration",
      configuration: { model: { providerId: "openai", modelId: "gpt" }, mode: "build" },
    }));
    events.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("accepted prompts merge onto provider events processed during admission", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.configurations.set("session", { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan" });
    provider.listModes = async () => [{ name: "plan", description: "" }, { name: "build", description: "" }];
    let admitPrompt!: () => void;
    const promptAdmitted = new Promise<void>(resolve => { admitPrompt = resolve; });
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>(resolve => { releasePrompt = resolve; });
    provider.prompt = async (_sessionId, input) => {
      admitPrompt();
      await promptGate;
      return { messageId: input.id };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const subscription = await adapter.subscribe("session");
    const iterator = subscription.events[Symbol.asyncIterator]();
    const pump = adapter.startEventPump();

    const pending = adapter.prompt("session", "request", "go", undefined, "build");
    await promptAdmitted;
    provider.eventQueue.push({
      type: "session.next.model.switched",
      properties: { sessionID: "session", model: { providerID: "openai", id: "gpt" } },
    });
    let event: ChatEvent | undefined;
    while (event?.type !== "conversation.configuration") event = (await iterator.next()).value;
    expect(event.configuration).toEqual({ model: { providerId: "openai", modelId: "gpt" }, mode: "plan" });
    releasePrompt();

    expect((await pending).configuration).toEqual({ model: { providerId: "openai", modelId: "gpt" }, mode: "build" });
    subscription.events.cancel();
    await adapter.stopEventPump();
    await pump;
  });

  test("concurrent prompts commit configuration in admission order", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const anthropic = { providerId: "anthropic", modelId: "claude" };
    const openai = { providerId: "openai", modelId: "gpt" };
    provider.configurations.set("session", { model: anthropic });
    provider.models.push({ selection: openai, provider: "OpenAI", name: "GPT" });
    let enterFirst!: () => void;
    let enterSecond!: () => void;
    const firstEntered = new Promise<void>(resolve => { enterFirst = resolve; });
    const secondEntered = new Promise<void>(resolve => { enterSecond = resolve; });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const gates = [
      new Promise<void>(resolve => { releaseFirst = resolve; }),
      new Promise<void>(resolve => { releaseSecond = resolve; }),
    ];
    let calls = 0;
    provider.prompt = async (_sessionId, input) => {
      const call = calls++;
      (call === 0 ? enterFirst : enterSecond)();
      await gates[call];
      return { messageId: input.id };
    };
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `message-${++message}` });

    const first = adapter.prompt("session", "request-1", "use GPT", openai);
    await firstEntered;
    const second = adapter.prompt("session", "request-2", "use Claude", anthropic);
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst();
    await first;
    // The second submission was accepted while the turn ran: held by the
    // workspace with its configuration committed in admission order, and
    // nothing dispatched to the provider yet.
    expect((await second).pending).toBe(true);
    expect((await second).configuration).toEqual({ model: anthropic });
    expect(calls).toBe(1);

    // The turn ending on its own releases the held message to the provider.
    adapter.projectionForTests("session").statusUpdate("completed");
    await secondEntered;
    releaseSecond();
    expect((await adapter.history("session")).configuration).toEqual({ model: anthropic });
    expect((await adapter.history("session")).queued).toEqual([]);
  });

  test("manual rename is confined, idempotent, preserves active turns, and prevents first-prompt overwrite", async () => {
    const provider = new FakeProvider();
    provider.agent.capabilities.push("conversation-rename");
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - now" }];
    let renames = 0;
    provider.renameSession = async (id, title) => {
      renames += 1;
      const renamed = { ...provider.sessions.find(session => session.id === id)!, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const subscriber = await adapter.subscribe("session");
    const [first, retry] = await Promise.all([
      adapter.renameConversation("session", "rename-1", "  Manual title  "),
      adapter.renameConversation("session", "rename-1", "different retry payload"),
    ]);
    expect(first).toEqual(retry);
    expect(first.conversation.title).toBe("Manual title");
    expect(renames).toBe(1);
    await expectInventorySignal(inventory);
    expect((await subscriber.events[Symbol.asyncIterator]().next()).value).toEqual(expect.objectContaining({ type: "conversation.updated" }));
    subscriber.events.cancel();
    await adapter.prompt("session", "prompt-1", "This must not replace the manual title");
    expect(renames).toBe(1);

    await expect(adapter.renameConversation("session", "empty", "  ")).rejects.toBeInstanceOf(InvalidConversationTitleError);
    await expect(adapter.renameConversation("session", "large", "é".repeat(101))).rejects.toBeInstanceOf(InvalidConversationTitleError);
    adapter.projectionForTests("session").statusUpdate("running");
    const whileRunning = await adapter.renameConversation("session", "running", "Renamed while running");
    await expectInventorySignal(inventory);
    expect(whileRunning.conversation).toEqual(expect.objectContaining({ title: "Renamed while running", status: "running" }));
    expect(adapter.projectionForTests("session").status).toBe("running");
    inventory.cancel();
  });

  test("a manual rename during prompt validation wins over first-prompt naming", async () => {
    const provider = new FakeProvider();
    provider.agent.capabilities.push("conversation-rename");
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - now" }];
    let renames = 0;
    provider.renameSession = async (id, title) => {
      renames += 1;
      const renamed = { ...provider.sessions.find(session => session.id === id)!, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    let validationStarted!: () => void;
    const validating = new Promise<void>(resolve => { validationStarted = resolve; });
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>(resolve => { releaseValidation = resolve; });
    provider.readMessages = async () => {
      validationStarted();
      await validationGate;
      return { items: [] };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });

    const pending = adapter.prompt("session", "prompt-1", "Automatic title candidate");
    await validating;
    await adapter.renameConversation("session", "rename-1", "Manual title");
    releaseValidation();
    await pending;

    expect(provider.sessions[0]?.title).toBe("Manual title");
    expect(renames).toBe(1);
  });

  test("rename rejects unsupported and foreign-workspace provider outcomes", async () => {
    const unsupported = new FakeProvider();
    unsupported.sessions = [fixtureSession("session")];
    await expect(new ChatAdapter({ provider: unsupported, workspacePath: process.cwd() })
      .renameConversation("session", "r1", "Title")).rejects.toBeInstanceOf(ConversationRenameUnsupportedError);

    const foreign = new FakeProvider();
    foreign.agent.capabilities.push("conversation-rename");
    foreign.sessions = [fixtureSession("session")];
    foreign.renameSession = async (id, title) => ({ ...fixtureSession(id, "/foreign"), title });
    await expect(new ChatAdapter({ provider: foreign, workspacePath: process.cwd() })
      .renameConversation("session", "r2", "Title")).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  test("recognizes only well-formed listed slash commands and separates arguments", () => {
    const commands = new FakeProvider().commands;
    expect(parseSlashCommand("/review   routing behavior ", commands)).toMatchObject({ name: "review", arguments: "routing behavior" });
    for (const text of ["/unknown args", "/ review", "//review", "prefix /review"]) {
      expect(parseSlashCommand(text, commands)).toBeUndefined();
    }
  });

  test("the acceptance carries the operation the provider says it ran", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.commandOperation = "reload";
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const accepted = await adapter.prompt("session", "request", "/review");
    expect(accepted).toMatchObject({ messageId: "message", pending: false, operation: "reload" });
  });

  test("dispatches recognized slash commands without changing the prompt contract", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const model = { providerId: "anthropic", modelId: "claude" };

    const accepted = await adapter.prompt("session", "request", "/review   API compatibility", model);
    expect(accepted).toEqual({ messageId: "message", pending: false, delivery: "queue", configuration: { model } });
    // The listed entry the text matched rides along, so the provider dispatches what was classified.
    expect(provider.commandCalls).toEqual([{ sessionId: "session", id: "message", name: "review", arguments: "API compatibility", listed: expect.objectContaining({ name: "review", kind: "command" }), model }]);
    expect(provider.prompts).toEqual([]);

    adapter.projectionForTests("session").statusUpdate("completed");
    await adapter.prompt("session", "ordinary", "/missing stays ordinary");
    expect(provider.prompts[0]).toEqual(expect.objectContaining({ text: "/missing stays ordinary" }));
  });

  test("a command's row reads as the text the provider says it sent, whichever row lands first", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.commandText = "@review focus";
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    // The provider's own row can land before the acceptance does.
    adapter.projectionForTests("session").upsert({ id: "message:message", type: "user_message", createdAt: 1, text: "@review focus", requestId: "message" });
    await adapter.prompt("session", "request", "/review focus");
    const rows = adapter.projectionForTests("session").items().filter(item => item.type === "user_message");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "message:message", text: "@review focus" });
  });

  test("derives concise titles without reducing numeric prompts to a generic label", () => {
    expect(deriveConversationTitle("123 investigate flaky model routing")).toBe("123 investigate flaky model routing");
    expect(deriveConversationTitle("# Implement a deliberately long model selection request that should be shortened at a word boundary for the chooser"))
      .toBe("Implement a deliberately long model selection request that...");
  });

  test("a command's placeholder is published at acceptance, so a retirement during the first-prompt rename still finds it", async () => {
    const provider = new FakeProvider();
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - 2026-08-15T12:00:00Z" }];
    provider.renameSession = async (id, title) => {
      await Bun.sleep(40);
      const session = provider.sessions.find(candidate => candidate.id === id)!;
      const renamed = { ...session, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    // The provider reports the local id (window closed), and the server's
    // row lands, with the placeholder's retirement, while the rename runs.
    provider.command = async () => {
      setTimeout(() => provider.eventQueue.push({ normalized: { conversationId: "session", outcome: "handled", eventType: "session.inbox.enqueued", updates: [
        { kind: "upsert", item: { id: "message:msg_server", type: "user_message", createdAt: 2, text: "Review focus", requestId: "msg_server" } },
        { kind: "remove", itemId: "message:msg_local" },
      ] } }), 10);
      return { messageId: "msg_local" };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    await Bun.sleep(10);
    await adapter.prompt("session", "request", "/review focus");
    await Bun.sleep(60);
    // The live projection, which is what a client renders between events.
    const live = await adapter.subscribe("session");
    const ids = live.snapshot.items.filter(item => item.type === "user_message").map(item => item.id);
    expect(ids).toEqual(["message:msg_server"]);
    live.events.cancel();
    await adapter.dispose();
    await pump;
  });

  test("strictly selects a model and gives the first prompt a provider-owned title", async () => {
    const provider = new FakeProvider();
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - 2026-08-15T12:00:00Z" }];
    provider.renameSession = async (id, title) => {
      const session = provider.sessions.find(candidate => candidate.id === id)!;
      const renamed = { ...session, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    const selection = { providerId: "anthropic", modelId: "claude" };

    const accepted = await adapter.prompt("session", "request", "Implement model selection cleanly across the workspace", selection);
    expect(provider.modelSwitches).toEqual([]);
    expect(accepted.conversation?.title).toBe("Implement model selection cleanly across the workspace");
    expect(provider.sessions[0]!.title).toBe("Implement model selection cleanly across the workspace");
    await expectInventorySignal(inventory);

    await expect(adapter.prompt("session", "other", "retry", { providerId: "anthropic", modelId: "missing" }))
      .rejects.toBeInstanceOf(InvalidModelSelectionError);
    inventory.cancel();
  });

  test("passes a listed mode through and refuses an unknown one", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.listModes = async () => [{ name: "build", description: "" }, { name: "plan", description: "" }];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    await adapter.prompt("session", "r1", "switch me", undefined, "build");
    expect(provider.prompts[0]).toEqual(expect.objectContaining({ mode: "build" }));
    await expect(adapter.prompt("session", "r2", "nope", undefined, "reviewer")).rejects.toBeInstanceOf(InvalidModeSelectionError);
  });

  test("passes a listed reasoning variant through and refuses an unknown one", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.models = [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude", variants: ["high", "xhigh"] }];
    const model = { providerId: "anthropic", modelId: "claude" };
    let modelLists = 0;
    const listModels = provider.listModels.bind(provider);
    provider.listModels = async () => { modelLists += 1; return listModels(); };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    await adapter.prompt("session", "r1", "think hard", model, undefined, "high");
    expect(provider.prompts[0]).toEqual(expect.objectContaining({ variant: "high" }));
    // The model changed and the variant is new, but one list answers both
    // checks — and a variant is re-sent with every prompt, so an unchanged
    // one must not pay a provider round trip per message.
    expect(modelLists).toBe(1);
    adapter.projectionForTests("session").statusUpdate("completed");
    await adapter.prompt("session", "r2", "keep thinking", model, undefined, "high");
    expect(modelLists).toBe(1);
    adapter.projectionForTests("session").statusUpdate("completed");
    // Unknown for this model — refused before dispatch.
    await expect(adapter.prompt("session", "r3", "nope", model, undefined, "ultra")).rejects.toBeInstanceOf(InvalidVariantSelectionError);

    // A variant without a restated model means "this conversation's model,
    // harder": the last applied model stands in for the check AND rides the
    // dispatch — on the v2 path the variant travels on the model reference,
    // so a variant with no model to ride would be silently dropped.
    await adapter.prompt("session", "r4", "go deeper", undefined, undefined, "xhigh");
    expect(provider.prompts[2]).toEqual(expect.objectContaining({ variant: "xhigh", model }));

    // A conversation whose model this adapter never learned has nothing to
    // check the variant against, and nothing for it to ride — refused.
    const fresh = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g2" });
    await expect(fresh.prompt("session", "r5", "nope", undefined, undefined, "high")).rejects.toBeInstanceOf(InvalidVariantSelectionError);
  });

  test("maps a provider's unsupported variant to the client selection error", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.models = [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude", variants: ["high"] }];
    provider.command = async () => { throw new UnsupportedVariantSelectionError("reasoning variants are not supported for compatibility compaction"); };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const error = adapter.prompt("session", "r1", "/compact", { providerId: "anthropic", modelId: "claude" }, undefined, "high");
    await expect(error).rejects.toBeInstanceOf(InvalidVariantSelectionError);
    await expect(error).rejects.toThrow("compatibility compaction");
  });

  test("delivers held messages in order on the turn's own end, and a cancellation pauses the queue until the next submission", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });
    const until = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
      expect(predicate()).toBe(true);
    };

    expect((await adapter.prompt("session", "r1", "first")).pending).toBe(false);
    const second = await adapter.prompt("session", "r2", "second");
    const third = await adapter.prompt("session", "r3", "third");
    expect([second.pending, third.pending]).toEqual([true, true]);
    expect(provider.prompts).toHaveLength(1);
    expect((await adapter.history("session")).queued).toEqual([
      expect.objectContaining({ id: second.messageId, text: "second", requestId: "r2" }),
      expect.objectContaining({ id: third.messageId, text: "third", requestId: "r3" }),
    ]);

    // The turn ending on its own releases exactly the queue head.
    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => provider.prompts.length === 2);
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ text: "second", id: second.messageId }));

    // Cancel pauses the queue: the interrupt and its trailing idle deliver
    // nothing, and "third" stays held.
    await adapter.abort("session", "cancel-1");
    adapter.projectionForTests("session").statusUpdate("idle");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(2);

    // The next submission joins the back of the queue and resumes delivery
    // from its head, preserving submission order.
    const fourth = await adapter.prompt("session", "r4", "fourth");
    expect(fourth.pending).toBe(true);
    await until(() => provider.prompts.length === 3);
    expect(provider.prompts[2]).toEqual(expect.objectContaining({ text: "third" }));
    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => provider.prompts.length === 4);
    expect(provider.prompts[3]).toEqual(expect.objectContaining({ text: "fourth" }));
    expect((await adapter.history("session")).queued).toEqual([]);
  });

  test("cancellation waits for an in-flight delivery and then interrupts the turn it started", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).pending).toBe(false);
    await adapter.prompt("session", "r2", "second");
    const third = await adapter.prompt("session", "r3", "third");

    // Delivery of "second" enters dispatch and stalls at the provider.
    let releaseDelivery!: () => void;
    const gate = new Promise<void>(resolve => { releaseDelivery = resolve; });
    let entered!: () => void;
    const enteredDelivery = new Promise<void>(resolve => { entered = resolve; });
    const accept = provider.prompt.bind(provider);
    provider.prompt = async (sessionId, input) => {
      entered();
      await gate;
      return accept(sessionId, input);
    };
    adapter.projectionForTests("session").statusUpdate("completed");
    await enteredDelivery;

    // Cancellation queues behind the started delivery rather than letting it
    // slip past the pause and start work after the interrupt.
    const cancelled = adapter.abort("session", "cancel-1");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(provider.interrupts).toEqual([]);
    releaseDelivery();
    await cancelled;
    expect(provider.interrupts).toEqual(["session"]);
    expect(provider.prompts).toHaveLength(2);

    // The delivery that had started was admitted and then interrupted; the
    // one that had not stays held through the trailing idle.
    adapter.projectionForTests("session").statusUpdate("idle");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(2);
    expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: third.messageId, text: "third" })]);
  });

  test("a fast completion during the first-prompt rename is not swallowed by the straggler guard", async () => {
    const provider = new FakeProvider();
    provider.agent.capabilities.push("conversation-rename");
    provider.sessions = [{ ...fixtureSession("session"), title: "New session - now" }];
    let releaseRename!: () => void;
    const gate = new Promise<void>(resolve => { releaseRename = resolve; });
    let entered!: () => void;
    const enteredRename = new Promise<void>(resolve => { entered = resolve; });
    provider.renameSession = async (id, title) => {
      entered();
      await gate;
      const renamed = { ...provider.sessions.find(session => session.id === id)!, title };
      provider.sessions[0] = renamed;
      return renamed;
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => "message" });

    const pending = adapter.prompt("session", "r1", "fast turn");
    await enteredRename;
    // The just-accepted turn finishes while the rename round trips are still
    // in flight. "sending" ended at acceptance, so this genuine completion
    // must apply — swallowing it as a straggler would leave the conversation
    // "running" forever and the queue never delivering.
    adapter.projectionForTests("session").apply({ kind: "status", status: "completed" });
    expect(adapter.projectionForTests("session").status).toBe("completed");
    releaseRename();
    await pending;
    expect(adapter.projectionForTests("session").status).toBe("completed");
  });

  test("a completion that outruns the acceptance response wins over the optimistic promotion", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    // The classic command route resolves only when the whole turn finishes,
    // so the turn's genuine completion can reach the pump before the
    // acceptance response does. It must apply — dropping it would leave the
    // conversation "running" forever with the queue frozen.
    let releaseAcceptance!: () => void;
    const gate = new Promise<void>(resolve => { releaseAcceptance = resolve; });
    let entered!: () => void;
    const enteredDispatch = new Promise<void>(resolve => { entered = resolve; });
    const accept = provider.prompt.bind(provider);
    provider.prompt = async (sessionId, input) => {
      entered();
      await gate;
      return accept(sessionId, input);
    };
    const pending = adapter.prompt("session", "r1", "finishes before acceptance");
    await enteredDispatch;
    adapter.projectionForTests("session").apply({ kind: "status", status: "completed" });
    releaseAcceptance();
    await pending;
    expect(adapter.projectionForTests("session").status).toBe("completed");
  });

  test("a straggling completion hands the next head to the provider's own queue rather than corrupting it", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).pending).toBe(false);
    await adapter.prompt("session", "r2", "second");
    await adapter.prompt("session", "r3", "third");

    // Delivery of "second" stalls in dispatch while the merged provider
    // streams restate the PREVIOUS turn's completion. Without turn identity
    // on status events this straggler cannot be told apart from a genuine
    // fast completion, so it applies — the accepted trade-off is that
    // "third" is admitted early under the provider's own queue delivery
    // (OpenCode holds it until the active turn ends); it only leaves the
    // removable workspace queue sooner than ideal.
    let releaseDelivery!: () => void;
    const gate = new Promise<void>(resolve => { releaseDelivery = resolve; });
    let entered!: () => void;
    const enteredDelivery = new Promise<void>(resolve => { entered = resolve; });
    const accept = provider.prompt.bind(provider);
    provider.prompt = async (sessionId, input) => {
      entered();
      await gate;
      return accept(sessionId, input);
    };
    adapter.projectionForTests("session").apply({ kind: "status", status: "completed" });
    await enteredDelivery;
    adapter.projectionForTests("session").apply({ kind: "status", status: "completed" });
    releaseDelivery();
    for (let attempt = 0; attempt < 200 && provider.prompts.length < 3; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    expect(provider.prompts[2]).toEqual(expect.objectContaining({ text: "third", delivery: "queue" }));
    expect((await adapter.history("session")).queued).toEqual([]);
  });

  test("a delivery-time session lookup failure pauses the queue instead of stranding it", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).pending).toBe(false);
    const held = await adapter.prompt("session", "r2", "second");
    expect(held.pending).toBe(true);

    const lookup = provider.getSession.bind(provider);
    provider.getSession = async () => { throw new Error("transient lookup failure"); };
    adapter.projectionForTests("session").statusUpdate("completed");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(1);

    // The queue paused rather than silently stranding the message: a later
    // idle transition alone delivers nothing...
    provider.getSession = lookup;
    adapter.projectionForTests("session").statusUpdate("idle");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(1);
    // ...and the documented exit — the next submission — resumes delivery.
    await adapter.prompt("session", "r3", "third");
    for (let attempt = 0; attempt < 200 && provider.prompts.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ text: "second", id: held.messageId }));
  });

  test("a busy report landing during the delivery-time lookup keeps the head held", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).pending).toBe(false);
    const held = await adapter.prompt("session", "r2", "second");
    expect(held.pending).toBe(true);

    // The merged stream corrects a stale terminal report while the delivery's
    // session lookup is still awaiting. The busy guard already passed before
    // the lookup, so it is rechecked after — the head stays held and
    // removable instead of dispatching into the corrected, still-active turn.
    const lookup = provider.getSession.bind(provider);
    provider.getSession = async sessionId => {
      provider.getSession = lookup;
      adapter.projectionForTests("session").statusUpdate("running");
      return lookup(sessionId);
    };
    adapter.projectionForTests("session").statusUpdate("completed");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(1);
    expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: held.messageId, text: "second" })]);

    // The corrected turn's own end retries and delivers the same head.
    adapter.projectionForTests("session").statusUpdate("completed");
    for (let attempt = 0; attempt < 200 && provider.prompts.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ text: "second", id: held.messageId }));
  });

  test("a delivery publishes to the replacement projection after an eviction during its lookup", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("a"), fixtureSession("b"), fixtureSession("c")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", maxProjections: 2, id: () => `id-${++message}` });

    expect((await adapter.prompt("a", "r1", "first")).pending).toBe(false);
    const held = await adapter.prompt("a", "r2", "second");
    expect(held.pending).toBe(true);
    const original = adapter.projectionForTests("a");

    // The delivery's session lookup stalls; meanwhile activity on other
    // conversations evicts "a"'s projection and a client reopens it,
    // receiving a replacement whose snapshot still shows the held head. The
    // delivered event must reach that replacement — it has no provider-side
    // echo, so a subscriber who missed it would show the departed head as
    // still held until the next queue change.
    let releaseLookup!: () => void;
    const gate = new Promise<void>(resolve => { releaseLookup = resolve; });
    let entered!: () => void;
    const enteredLookup = new Promise<void>(resolve => { entered = resolve; });
    const lookup = provider.getSession.bind(provider);
    provider.getSession = async sessionId => {
      if (sessionId !== "a") return lookup(sessionId);
      provider.getSession = lookup;
      entered();
      await gate;
      return lookup(sessionId);
    };
    original.statusUpdate("completed");
    await enteredLookup;

    await adapter.subscribe("b").then(result => result.events.cancel());
    await adapter.subscribe("c").then(result => result.events.cancel());
    const snapshot = await adapter.history("a");
    expect(snapshot.queued).toEqual([expect.objectContaining({ id: held.messageId })]);
    expect(adapter.projectionForTests("a")).not.toBe(original);
    const { events } = await adapter.subscribe("a", { cursor: snapshot.cursor });

    releaseLookup();
    const iterator = events[Symbol.asyncIterator]();
    const seen: string[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const next = await Promise.race([iterator.next(), Bun.sleep(500).then(() => "timeout" as const)]);
      if (next === "timeout" || (next as IteratorResult<unknown>).done) break;
      seen.push(JSON.stringify((next as IteratorResult<unknown>).value));
      if (seen[seen.length - 1].includes(`"delivered"`)) break;
    }
    events.cancel();
    expect(seen.some(frame => frame.includes(`"delivered"`) && frame.includes(held.messageId))).toBe(true);
  });

  test("background work is not a live turn: a prompt is accepted, not held, and stop reaches the provider", async () => {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, "background-tasks"] };
    provider.sessions = [fixtureSession("session")];
    const stops: Array<{ sessionId: string; taskId: string }> = [];
    (provider as unknown as { stopTask: (sessionId: string, taskId: string) => Promise<void> }).stopTask = async (sessionId, taskId) => { stops.push({ sessionId, taskId }); };
    (provider as unknown as { listBackgroundTasks: () => Promise<unknown[]> }).listBackgroundTasks = async () => [
      { conversationId: "session", taskId: "b1", description: "Sleep then echo", taskType: "local_bash", toolUseId: "toolu_1", startedAt: 5, outputFile: "/tmp/claude-501/-w/s/tasks/b1.output" },
      { conversationId: "session", taskId: "ada2", description: "Explore", taskType: "local_agent", toolUseId: "toolu_2", startedAt: 6, subagentType: "Explore", prompt: "look around", usage: { totalTokens: 10, toolUses: 1, durationMs: 100 }, childConversationId: "sub:session:ada2" },
      { conversationId: "other", taskId: "b2", description: "Elsewhere", startedAt: 6 },
    ];
    const outputReads: Array<{ sessionId: string; taskId: string; tailBytes: number }> = [];
    (provider as unknown as { taskOutput: (sessionId: string, taskId: string, options: { tailBytes: number }) => Promise<unknown> }).taskOutput = async (sessionId, taskId, options) => {
      outputReads.push({ sessionId, taskId, tailBytes: options.tailBytes });
      return taskId === "b1" ? { text: "so far", truncated: false, settled: false } : null;
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const projection = adapter.projectionForTests("session");
    projection.statusUpdate("running");
    projection.statusUpdate("completed");
    projection.statusUpdate("background");
    // Not live: the next prompt is delivered, not held (spec: prompting
    // remains possible while background work runs).
    expect((await adapter.prompt("session", "r1", "meanwhile")).pending).toBe(false);
    expect(provider.prompts).toHaveLength(1);
    // Stop is idempotent per request id and addressed to the owning session.
    expect(await adapter.stopTask("session", "b1", "req-1")).toEqual({ stopped: true });
    expect(await adapter.stopTask("session", "b1", "req-1")).toEqual({ stopped: true });
    expect(stops).toEqual([{ sessionId: "session", taskId: "b1" }]);
    // A reopened conversation is seeded with the provider's live tasks —
    // this conversation's only.
    const snapshot = await adapter.history("session");
    const tasks = snapshot.items.filter(item => item.type === "background_task");
    // The seeded rows carry the facts the live ones would have.
    expect(tasks).toEqual([
      expect.objectContaining({ id: "task:b1", status: "running", description: "Sleep then echo", toolUseId: "toolu_1", createdAt: 5, outputFile: "/tmp/claude-501/-w/s/tasks/b1.output" }),
      expect.objectContaining({ id: "task:ada2", status: "running", subagentType: "Explore", prompt: "look around", usage: { totalTokens: 10, toolUses: 1, durationMs: 100 }, childConversationId: "sub:session:ada2" }),
    ]);
    // The output read reaches the provider for the owning session; a task
    // with no output yet is null, not an error.
    expect(await adapter.taskOutput("session", "b1", { tailBytes: 512 })).toEqual({ text: "so far", truncated: false, settled: false });
    expect(await adapter.taskOutput("session", "ada2", { tailBytes: 512 })).toBeNull();
    expect(outputReads).toEqual([{ sessionId: "session", taskId: "b1", tailBytes: 512 }, { sessionId: "session", taskId: "ada2", tailBytes: 512 }]);
    await expect(adapter.taskOutput("missing", "b1", { tailBytes: 512 })).rejects.toBeInstanceOf(ConversationNotFoundError);
    await adapter.dispose();
  });

  test("a settled background task is terminal: a stale running snapshot or a late patch cannot reopen it", async () => {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, "background-tasks"] };
    provider.sessions = [fixtureSession("session")];
    const listed: Array<{ conversationId: string; taskId: string; description: string; startedAt: number }> = [{ conversationId: "session", taskId: "b1", description: "Job", startedAt: 5 }];
    (provider as unknown as { listBackgroundTasks: () => Promise<unknown[]> }).listBackgroundTasks = async () => listed;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const projection = adapter.projectionForTests("session");
    projection.apply({ kind: "upsert", item: { id: "task:b1", type: "background_task", createdAt: 5, taskId: "b1", description: "Job", status: "running", progress: "Using Bash" } });
    projection.apply({ kind: "upsert", item: { id: "task:b1", type: "background_task", createdAt: 5, taskId: "b1", description: "Job", status: "completed", summary: "done" } });
    // A late patch without the summary keeps it and the terminal status.
    projection.apply({ kind: "upsert", item: { id: "task:b1", type: "background_task", createdAt: 5, taskId: "b1", description: "Job", status: "running" } });
    expect(projection.find(item => item.id === "task:b1")).toEqual(expect.objectContaining({ status: "completed", summary: "done" }));
    // The provider's list still says running (its level signal lags): the
    // settled row wins, and a row the provider does not list at all is closed.
    projection.apply({ kind: "upsert", item: { id: "task:b2", type: "background_task", createdAt: 6, taskId: "b2", description: "Gone", status: "running" } });
    const snapshot = await adapter.history("session");
    const rows = snapshot.items.filter(item => item.type === "background_task");
    expect(rows).toEqual([
      expect.objectContaining({ id: "task:b1", status: "completed", summary: "done" }),
      expect.objectContaining({ id: "task:b2", status: "stopped" }),
    ]);
    // With live work listed, a reopened conversation reports background.
    listed.push({ conversationId: "session", taskId: "b3", description: "Still going", startedAt: 7 });
    const reopened = await adapter.history("session");
    expect(reopened.conversation.status).toBe("background");
    // A named working state (a retry, a compaction) is still a live turn:
    // the list must not demote it to background.
    projection.statusUpdate("retrying");
    expect((await adapter.history("session")).conversation.status).toBe("retrying");
    await adapter.dispose();
  });

  test("evidence-bearing background recovery never turns missing or failed reads into stopped", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const task = { id: "task:v2:session:call", type: "background_task" as const, taskId: "v2:session:call", createdAt: 1, description: "Worker", status: "running" as const };
    let fail = false;
    Object.assign(provider, { reconcileBackgroundTasks: async () => { if (fail) throw new Error("offline"); return [{ ...task, stateUncertain: false }]; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    expect((await adapter.history("session")).items).toContainEqual({ ...task, stateUncertain: false });
    expect(adapter.activity().working).toBe(true);
    fail = true;
    expect((await adapter.history("session")).items).toContainEqual({ ...task, stateUncertain: true });
    expect(adapter.activity().working).toBe(true);
    fail = false;
    expect((await adapter.history("session")).items).toContainEqual({ ...task, stateUncertain: false });
    await adapter.dispose();
  });
  for (const path of ["snapshot", "stream"] as const) for (const alias of ["joined-call", "result"] as const) test(`${path} recovery replaces a live ${alias} identity with the canonical history worker, not a second worker`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const canonical = { id: "task:first", type: "background_task" as const, taskId: "first", createdAt: 1, description: "Worker", status: "running" as const, ...(alias === "result" ? { resultId: "result" } : { toolUseId: "first", toolUseIds: ["first", "joined"] }) };
    Object.assign(provider, { reconcileBackgroundTasks: async () => [canonical] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    adapter.projectionForTests("session").apply({ kind: "upsert", item: { ...canonical, id: "task:joined", taskId: "joined", ...(alias === "joined-call" ? { toolUseId: "joined", toolUseIds: undefined } : {}) } });
    const pump = path === "stream" ? adapter.startEventPump() : undefined;
    try {
      if (path === "snapshot") {
        const snapshot = await adapter.history("session");
        expect(snapshot.items.filter(item => item.type === "background_task")).toEqual([canonical]);
      } else {
        provider.eventQueue.push({ type: "server.connected", data: {} });
        await waitUntil(() => adapter.projectionForTests("session").has(canonical.id));
      }
      expect(adapter.projectionForTests("session").items().filter(item => item.type === "background_task")).toEqual([canonical]);
    } finally { await adapter.dispose(); await pump; }
  });
  for (const evict of [false, true]) test(`idle-parent snapshot recovers an out-of-page worker and its pending result${evict ? " after projection eviction" : ""}`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session"), fixtureSession("other")];
    const worker = { id: "task:old-launch", type: "background_task" as const, taskId: "old-launch", createdAt: 1, description: "Worker", toolUseId: "old-launch", childConversationId: "child", status: "running" as const };
    let completed = false;
    // The visible page contains no launch. Scoped recovery has the complete
    // history and pending synthetic inbox, independently of this page.
    Object.assign(provider, { reconcileBackgroundTasks: async (id: string) => id === "session" ? [{ ...worker, ...(completed ? { status: "completed", resultId: "pending-result", summary: "Done" } : {}) }] : [] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", maxProjections: 1 });
    const first = await adapter.history("session", { limit: 1 });
    expect(first.items).toContainEqual(worker);
    expect(first.conversation.status).toBe("background");
    expect(adapter.activity().working).toBe(true);
    if (evict) await adapter.history("other");
    completed = true;
    const after = await adapter.history("session", { limit: 1 });
    expect(after.items.filter(item => item.type === "background_task")).toEqual([expect.objectContaining({ status: "completed", resultId: "pending-result" })]);
    expect(after.conversation.status).not.toBe("background");
    expect(adapter.activity().working).toBe(false);
    await adapter.dispose();
  });
  test("verified uncontrollable activity survives recovery but a stream gap withdraws its live clock and authority", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const worker: BackgroundTaskItem = { id: "task:worker", type: "background_task", taskId: "worker", description: "Worker", childConversationId: "child", createdAt: 1, status: "running", stateUncertain: true,
      activity: { kind: "working", executionId: "fixture-execution", observedAt: 50 }, control: { available: false, reason: "Retained Stop proof unavailable" } };
    Object.assign(provider, { reconcileBackgroundTasks: async (id: string) => id === "parent" ? [worker] : [] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => adapter.projectionForTests("parent").find(item => item.type === "background_task" && item.activity?.kind === "working") !== undefined);
      expect(adapter.activity().working).toBe(true);
      expect(adapter.projectionForTests("parent").find(item => item.id === worker.id)).toMatchObject({ stateUncertain: true, activity: { kind: "working" }, control: { available: false } });
      provider.eventQueue.close();
      await waitUntil(() => adapter.projectionForTests("parent").find(item => item.type === "background_task" && item.activity?.kind === "unavailable") !== undefined);
      expect(adapter.projectionForTests("parent").find(item => item.id === worker.id)).toMatchObject({ activity: { kind: "unavailable", executionId: "fixture-execution", observedAt: 50 }, control: { available: false } });
      // Inconclusive disappearance does not manufacture a workspace-finished transition.
      expect(adapter.activity().working).toBe(true);
      expect(provider.prompts).toEqual([]);
      expect(provider.interrupts).toEqual([]);
    } finally { await adapter.dispose(); await pump; }
  });

  test("connected-before-read recovery discovers unselected parents with at most four reads and no text-delta rereads", async () => {
    const provider = new FakeProvider();
    provider.sessions = Array.from({ length: 6 }, (_, i) => fixtureSession(`parent-${i}`));
    const releases: Array<() => void> = [];
    const seen: string[] = [];
    let concurrent = 0;
    let maximum = 0;
    Object.assign(provider, { reconcileBackgroundTasks: async (id: string) => {
      seen.push(id); concurrent++; maximum = Math.max(maximum, concurrent);
      await new Promise<void>(resolve => releases.push(resolve));
      concurrent--;
      return [{ id: `task:${id}`, type: "background_task", taskId: id, description: "Worker", createdAt: 1, status: "running", stateUncertain: false }];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    void adapter.startEventPump();
    await waitUntil(() => provider.eventQueue.waiting);
    expect(seen).toEqual([]);
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => seen.length === 4);
    expect(maximum).toBe(4);
    releases.splice(0).forEach(release => release());
    await waitUntil(() => seen.length === 6);
    releases.splice(0).forEach(release => release());
    await waitUntil(() => adapter.activity().working);
    provider.eventQueue.push({ type: "session.next.text.delta", data: { sessionID: "parent-0", textID: "text", delta: "text" } });
    await waitUntil(() => provider.eventQueue.waiting);
    expect(seen).toHaveLength(6);
    await adapter.dispose();
  });
  test("disposing bounded recovery retires queued parents and awaits reads without execution mutations", async () => {
    const provider = new FakeProvider();
    provider.sessions = Array.from({ length: 6 }, (_, index) => fixtureSession(`parent-${index}`));
    let reads = 0;
    const releases: Array<() => void> = [];
    Object.assign(provider, {
      reconcileBackgroundTasks: async () => { reads++; await new Promise<void>(resolve => releases.push(resolve)); return []; },
      dispose: async () => { releases.splice(0).forEach(release => release()); },
    });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => reads === 4);
    await adapter.dispose(); await pump;
    expect(reads).toBe(4);
    expect(provider.prompts).toEqual([]);
    expect(provider.interrupts).toEqual([]);
  });
  for (const kind of ["permission", "question"] as const) test(`unselected inventory recovery discovers a child's pending ${kind} without opening history`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    let reads = 0;
    Object.assign(provider, {
      reconcileBackgroundTasks: async () => [{ id: "task:worker", type: "background_task", taskId: "worker", childConversationId: "child", description: "Worker", createdAt: 1, status: "running" }],
      listPermissions: async () => { if (kind === "permission") reads++; return kind === "permission" ? [{ conversationId: "child", requestId: "pending", action: "read", resources: ["safe-fixture"] }] : []; },
      listQuestions: async () => { if (kind === "question") reads++; return kind === "question" ? [{ conversationId: "child", requestId: "pending", questions: [{ prompt: "Choose?", header: "", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }] }] : []; },
    });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => adapter.activity().working);
    expect(reads).toBeGreaterThan(0);
    expect(adapter.activity()).toEqual({ working: true, awaiting: true });
    expect(adapter.projectionForTests("parent").find(item => item.id === `${kind}:pending`)).toMatchObject({ type: kind, status: "pending", conversationId: "child" });
    expect(provider.prompts).toEqual([]);
    expect(provider.interrupts).toEqual([]);
    await adapter.dispose(); await pump;
  });
  for (const kind of ["permission", "question"] as const) test(`inventory ${kind} recovery discards a read raced by a child resolution`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stale = kind === "permission"
      ? { conversationId: "child", requestId: "stale", action: "read", resources: ["safe-fixture"] }
      : { conversationId: "child", requestId: "stale", questions: [{ prompt: "Choose?", header: "", options: [], multiple: false, allowFreeForm: true }] };
    Object.assign(provider, {
      reconcileBackgroundTasks: async () => [{ id: "task:worker", type: "background_task", taskId: "worker", childConversationId: "child", description: "Worker", createdAt: 1, status: "running" }],
      [kind === "permission" ? "listPermissions" : "listQuestions"]: async () => { if (++reads === 1) { await gate; return [stale]; } return []; },
    });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => reads === 1);
    provider.eventQueue.push({ normalized: { conversationId: "child", eventType: `${kind}.resolved`, outcome: "handled", updates: [{ kind: "remove", itemId: `${kind}:stale` }] } } as unknown as ProviderEvent);
    await waitUntil(() => provider.eventQueue.waiting);
    release();
    await waitUntil(() => reads >= 2 && adapter.activity().working);
    expect(adapter.activity().awaiting).toBe(false);
    expect(adapter.projectionForTests("parent").find(item => item.id === `${kind}:stale`)).toBeUndefined();
    await adapter.dispose(); await pump;
  });
  test("failed inventory permission reads preserve needs-answer until a successful retry revokes the request", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    let reads = 0;
    let fail = false;
    let pending = true;
    Object.assign(provider, {
      reconcileBackgroundTasks: async () => [{ id: "task:worker", type: "background_task", taskId: "worker", childConversationId: "child", description: "Worker", createdAt: 1, status: "running" }],
      listPermissions: async () => { reads++; if (fail) throw new Error("Transient pending read failure"); return pending ? [{ conversationId: "child", requestId: "pending", action: "read", resources: ["safe-fixture"] }] : []; },
    });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => adapter.activity().awaiting);
    fail = true;
    provider.eventQueue.push({ normalized: { conversationId: "child", eventType: "session.execution.succeeded", outcome: "handled", updates: [] } } as unknown as ProviderEvent);
    await waitUntil(() => reads >= 2);
    expect(adapter.activity()).toEqual({ working: true, awaiting: true });
    fail = false; pending = false;
    await waitUntil(() => reads >= 3 && !adapter.activity().awaiting);
    expect(adapter.activity().working).toBe(true);
    await adapter.dispose(); await pump;
  });
  test("recovered detached work survives parent completion and child requests retain needs-answer priority", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const worker = { id: "task:worker", type: "background_task" as const, taskId: "worker", childConversationId: "child", createdAt: 1, description: "Worker", status: "running" as const };
    Object.assign(provider, { reconcileBackgroundTasks: async (id: string) => id === "parent" ? [worker] : [] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => adapter.activity().working);
    provider.eventQueue.push({ type: "session.status", properties: { sessionID: "parent", status: { type: "idle" } } });
    provider.eventQueue.push({ type: "question.asked", data: { sessionID: "child", id: "q", questions: [{ question: "Choose?", options: [{ label: "A" }] }] } });
    await waitUntil(() => adapter.activity().awaiting);
    expect(adapter.activity().working).toBe(true);
    await waitUntil(() => adapter.projectionForTests("parent").items().some(item => item.type === "question"));
    provider.listQuestions = async () => [{ conversationId: "child", requestId: "q", questions: [{ prompt: "Choose?", header: "", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }] }];
    expect((await adapter.history("parent")).items).toContainEqual(expect.objectContaining({ type: "question", requestId: "q", conversationId: "child" }));
    await adapter.dispose(); await pump;
  });
  test("snapshot worker recovery waits for an already-starting provider stream's connected marker", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let reads = 0;
    let configurationRead = false;
    provider.getConversationConfiguration = async () => { configurationRead = true; return {}; };
    Object.assign(provider, { reconcileBackgroundTasks: async () => { reads++; return []; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    await waitUntil(() => provider.eventQueue.waiting);
    const snapshot = adapter.history("session");
    // Observe the actual gate rather than assuming a 20 ms scheduling window.
    await waitUntil(() => configurationRead);
    expect(reads).toBe(0);
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await snapshot;
    expect(reads).toBeGreaterThan(0);
    await adapter.dispose(); await pump;
  });
  test("a terminal update racing recovery wins, and disconnect marks only unresolved work uncertain", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const running = { id: "task:worker", type: "background_task" as const, taskId: "worker", description: "Worker", createdAt: 1, status: "running" as const };
    let release!: () => void;
    let reads = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      reads++;
      if (reads === 1) { await waiting; return [running]; }
      return [{ ...running, status: "completed", summary: "Done" }, { ...running, id: "task:other", taskId: "other" }];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => reads === 1);
    provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.inbox.enqueued", outcome: "handled", updates: [{ kind: "upsert", item: { ...running, status: "completed", summary: "Done" } }] } } as unknown as ProviderEvent);
    await waitUntil(() => adapter.projectionForTests("session").find(item => item.id === running.id)?.type === "background_task");
    release();
    await waitUntil(() => reads === 2 && !!adapter.projectionForTests("session").find(item => item.id === "task:other"));
    provider.eventQueue.close();
    await pump;
    expect(adapter.projectionForTests("session").find(item => item.id === running.id)).toMatchObject({ status: "completed", summary: "Done" });
    expect(adapter.projectionForTests("session").find(item => item.id === "task:other")).toMatchObject({ status: "running", stateUncertain: true });
    expect(adapter.activity().working).toBe(true);
    await adapter.dispose();
  });
  test("a new provider stream fences a still-pending older recovery and reads again without duplicating the worker", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const worker = { id: "task:worker", taskId: "worker", type: "background_task" as const, createdAt: 1, description: "Worker", status: "running" as const };
    let reads = 0;
    let concurrent = 0;
    let maximum = 0;
    let release!: () => void;
    const older = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      maximum = Math.max(maximum, ++concurrent);
      try {
        if (++reads === 1) { await older; return [worker]; }
        return [{ ...worker, status: "completed", summary: "New generation result", stateUncertain: false }];
      } finally { concurrent--; }
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const firstPump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => reads === 1);
    provider.eventQueue.close();
    await firstPump;
    provider.eventQueue = new EventQueue();
    const secondPump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => provider.eventQueue.waiting);
    release();
    await waitUntil(() => adapter.projectionForTests("session").find(item => item.id === worker.id && item.type === "background_task" && item.status === "completed") !== undefined);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(maximum).toBe(1);
    expect(adapter.projectionForTests("session").filter(item => item.type === "background_task")).toEqual([expect.objectContaining({ status: "completed", summary: "New generation result", stateUncertain: false })]);
    expect(provider.prompts).toEqual([]);
    expect(provider.interrupts).toEqual([]);
    await adapter.dispose(); await secondPump;
  });
  async function exhaustedRecoveryFixture(terminal = false) {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const unknown = { id: "task:unknown", type: "background_task" as const, taskId: "unknown", description: "Unknown", createdAt: 1, status: "running" as const, stateUncertain: true };
    const known = { ...unknown, id: "task:known", taskId: "known", toolUseId: "same-call", stateUncertain: false,
      status: terminal ? "completed" as const : "running" as const, ...(terminal ? { terminalReportedAt: 2 } : {}) };
    let reads = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => { if (++reads === 1) await gate; return [unknown, known]; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    adapter.projectionForTests("session").apply({ kind: "upsert", item: known });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => reads === 1);
    jest.useFakeTimers();
    release(); await flushRecoveryIo();
    jest.advanceTimersByTime(1_000); await flushRecoveryIo();
    jest.advanceTimersByTime(2_000); await flushRecoveryIo();
    expect(reads).toBe(3);
    return { adapter, provider, pump, unknown, known, reads: () => reads,
      event: async (eventType = "session.tool.success", updates: NormalizedProviderEvent["updates"] = []) => {
        provider.eventQueue.push({ normalized: { conversationId: "session", eventType, updates, outcome: "handled" } });
        await flushRecoveryIo();
        jest.advanceTimersByTime(0); await flushRecoveryIo();
      },
    };
  }

  test("exhausted recovery ignores chatter until thirty seconds after exhaustion and never polls a quiet parked cycle", async () => {
    const f = await exhaustedRecoveryFixture();
    const exhaustedAt = (f.adapter as unknown as { backgroundRecoveries: Map<string, { exhaustedAt: number }> }).backgroundRecoveries.get("session")!.exhaustedAt;
    // Bun's fake timer clock still advances with confinement IO. Pin wall time
    // independently so this asserts the exact boundary, not scheduler speed.
    const now = spyOn(Date, "now").mockReturnValue(exhaustedAt);
    try {
      await f.event(); expect(f.reads()).toBe(3);
      jest.advanceTimersByTime(29_999); now.mockReturnValue(exhaustedAt + 29_999); await f.event("session.message.content.updated"); expect(f.reads()).toBe(3);
      jest.advanceTimersByTime(1); now.mockReturnValue(exhaustedAt + 30_000); await f.event(); expect(f.reads()).toBe(4);
      jest.advanceTimersByTime(1_000); await flushRecoveryIo();
      jest.advanceTimersByTime(2_000); await flushRecoveryIo(); expect(f.reads()).toBe(6);
      jest.advanceTimersByTime(120_000); await flushRecoveryIo(); expect(f.reads()).toBe(6);
      expect(f.adapter.projectionForTests("session").get(f.unknown.id)).toMatchObject({ status: "running", stateUncertain: true });
    } finally { now.mockRestore(); await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  for (const evidence of ["worker", "refresh", "reconnect"] as const) test(`${evidence} evidence remains immediately usable during the exhausted recovery cooldown`, async () => {
    const f = await exhaustedRecoveryFixture();
    try {
      if (evidence === "worker") await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, createdAt: 2 } }]);
      else if (evidence === "refresh") await f.adapter.history("session");
      else { f.provider.eventQueue.push({ type: "server.connected", data: {} }); await flushRecoveryIo(); }
      expect(f.reads()).toBe(4);
      expect(f.provider.prompts).toEqual([]); expect(f.provider.interrupts).toEqual([]);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  for (const uncertain of [false, true]) test(`unchanged native worker rediscovery and ${uncertain ? "uncertain " : ""}alias flapping do not rearm an exhausted recovery cycle`, async () => {
    const f = await exhaustedRecoveryFixture();
    try {
      let previous = f.known.id;
      for (let index = 0; index < 6; index++) {
        const id = `task:alias-${index}`;
        const stateUncertain = uncertain && index % 2 === 0;
        await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: previous }, { kind: "upsert", item: { ...f.known, id, taskId: id, stateUncertain, createdAt: stateUncertain ? 0 : f.known.createdAt } }]);
        previous = id;
      }
      expect(f.reads()).toBe(3);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  test("capacity rotation preserves an evicted live target's cooldown, including its exact boundary and fresh-evidence exits", async () => {
    const f = await exhaustedRecoveryFixture();
    const records = (f.adapter as unknown as { backgroundRecoveries: Map<string, { exhaustedAt?: number; progress: Map<string, unknown> }> }).backgroundRecoveries;
    const parked = records.get("session")!;
    const exhaustedAt = parked.exhaustedAt!;
    const now = spyOn(Date, "now").mockReturnValue(exhaustedAt + 1);
    const event = async (id: string, updates: NormalizedProviderEvent["updates"] = []) => {
      f.provider.eventQueue.push({ normalized: { conversationId: id, eventType: "session.tool.success", updates, outcome: "handled" } });
      await flushRecoveryIo(); jest.advanceTimersByTime(0); await flushRecoveryIo();
    };
    try {
      for (let index = 1; index < 2_048; index++) records.set(`parked-${index}`, { ...parked, progress: new Map() });
      f.provider.sessions.push(fixtureSession("fresh"), fixtureSession("another"), fixtureSession("new-worker"));
      await event("fresh"); expect(f.reads()).toBe(4);
      expect(records.has("session")).toBe(false);
      expect(f.adapter.projectionForTests("session").get(f.unknown.id)).toMatchObject({ stateUncertain: true });
      await f.event(); await event("another"); expect(f.reads()).toBe(4);
      expect(records.size).toBe(2_048);
      now.mockReturnValue(exhaustedAt + 29_999); await f.event(); expect(f.reads()).toBe(4);
      // Explicit reads and genuinely new native invocation evidence remain
      // usable even while incidental untracked cycles are conservatively held.
      await f.adapter.history("session"); expect(f.reads()).toBe(5);
      await event("new-worker", [{ kind: "upsert", item: { ...f.known, id: "task:new", taskId: "new", toolUseId: "new-native-call", createdAt: 2 } }]);
      expect(f.reads()).toBe(6);
      now.mockReturnValue(exhaustedAt + 30_000); await f.event(); expect(f.reads()).toBe(7);
      expect(records.size).toBe(2_048);
      expect(f.provider.prompts).toEqual([]); expect(f.provider.interrupts).toEqual([]);
    } finally { now.mockRestore(); await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  for (const terminal of [false, true]) test(`split-flush ${terminal ? "terminal" : "running"} alias replacement retains native high-water knowledge until genuine new invocation evidence`, async () => {
    const f = await exhaustedRecoveryFixture(terminal);
    try {
      await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: f.known.id }]);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "task:alias", taskId: "alias" } }]);
      expect(f.reads()).toBe(3);
      await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: "task:alias" }]);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "task:uncertain", taskId: "uncertain", stateUncertain: true, createdAt: 0 } }]);
      await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: "task:uncertain" }]);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "task:restated", taskId: "restated" } }]);
      expect(f.reads()).toBe(3);
      // A distinct native invocation, not a renamed UI row, is new evidence.
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "task:new", taskId: "new", toolUseId: "new-native-call", status: "running", terminalReportedAt: undefined } }]);
      expect(f.reads()).toBe(4);
      expect(f.provider.prompts).toEqual([]); expect(f.provider.interrupts).toEqual([]);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  for (const renamed of [false, true]) test(`read-side unchanged ${renamed ? "alias" : "native"} rediscovery after source removal cannot renew the three-read cycle`, async () => {
    const f = await exhaustedRecoveryFixture();
    const records = (f.adapter as unknown as { backgroundRecoveries: Map<string, { exhaustedAt?: number; timer?: unknown; sourceProgress?: Map<string, unknown> }> }).backgroundRecoveries;
    const exhaustedAt = records.get("session")!.exhaustedAt!;
    const now = spyOn(Date, "now").mockReturnValue(exhaustedAt + 30_000);
    const provider = f.provider as ChatProvider;
    const reconcile = provider.reconcileBackgroundTasks!.bind(provider);
    let recoveredId = f.known.id;
    provider.reconcileBackgroundTasks = async (...args) => (await reconcile(...args)).map(item => item.id === f.known.id ? { ...item, id: recoveredId, taskId: recoveredId } : item);
    try {
      await f.event(); expect(f.reads()).toBe(4);
      for (let index = 0; index < 6; index++) {
        const previous = recoveredId;
        recoveredId = renamed ? `read-alias-${index}` : f.known.id;
        await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: previous }]);
        expect(records.get("session")?.sourceProgress?.has("call:same-call")).toBe(true);
        const before = f.reads();
        jest.advanceTimersByTime(2_000); await flushRecoveryIo();
        if (f.reads() > before) expect(f.adapter.projectionForTests("session").get(recoveredId)).toMatchObject({ status: "running", stateUncertain: false });
      }
      expect(f.reads()).toBe(6);
      expect(records.get("session")?.exhaustedAt).toEqual(expect.any(Number));
      expect(records.get("session")?.timer).toBeUndefined();
      expect(f.adapter.projectionForTests("session").get(f.unknown.id)).toMatchObject({ status: "running", stateUncertain: true });
    } finally { now.mockRestore(); await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  for (const limit of ["count", "bytes"] as const) for (const verifiedStart of [false, true]) test(`read-side ${limit} fingerprint overflow cannot renew unchanged native rediscovery${verifiedStart ? " but a verified new worker start extends discovery" : ""}`, async () => {
    const f = await exhaustedRecoveryFixture();
    const records = (f.adapter as unknown as { backgroundRecoveries: Map<string, { exhaustedAt?: number; timer?: unknown; sourceProgressLost?: true }> }).backgroundRecoveries;
    const exhaustedAt = records.get("session")!.exhaustedAt!;
    const now = spyOn(Date, "now").mockReturnValue(exhaustedAt + 1);
    const nativeCall = limit === "bytes" ? "x".repeat(20_000) : "removed-call-79";
    let recoveredId = "overflow-original";
    try {
      for (let index = 0; index < (limit === "count" ? 80 : 1); index++) {
        const id = `overflow-${index}`;
        f.adapter.projectionForTests("session").apply({ kind: "upsert", item: { ...f.known, id, taskId: id, toolUseId: limit === "bytes" ? nativeCall : `removed-call-${index}` } });
        await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: id }]);
      }
      expect(records.get("session")?.sourceProgressLost).toBe(true);
      const provider = f.provider as ChatProvider;
      const reconcile = provider.reconcileBackgroundTasks!.bind(provider);
      provider.reconcileBackgroundTasks = async (...args) => [...await reconcile(...args), { ...f.known, id: recoveredId, taskId: recoveredId, toolUseId: nativeCall },
        ...(verifiedStart && f.reads() >= 5 ? [{ ...f.known, id: "verified-read-start", taskId: "verified-read-start", toolUseId: undefined, createdAt: 2 }] : [])];
      now.mockReturnValue(exhaustedAt + 30_000); await f.event(); expect(f.reads()).toBe(4);
      for (let index = 0; index < 6; index++) {
        const previous = recoveredId; recoveredId = `overflow-read-${index}`;
        await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: previous }]);
        const before = f.reads();
        jest.advanceTimersByTime(2_000); await flushRecoveryIo();
        if (f.reads() > before) expect(f.adapter.projectionForTests("session").get(recoveredId)).toMatchObject({ status: "running", stateUncertain: false });
      }
      expect(f.reads()).toBe(verifiedStart ? 7 : 6);
      if (verifiedStart) expect(f.adapter.projectionForTests("session").get("verified-read-start")).toMatchObject({ createdAt: 2, status: "running", stateUncertain: false });
      expect(records.get("session")?.exhaustedAt).toEqual(expect.any(Number));
      expect(records.get("session")?.timer).toBeUndefined();
    } finally { now.mockRestore(); await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  test("conclusive unchanged read evidence clears uncertainty and completes recovery without manufactured progress", async () => {
    const f = await exhaustedRecoveryFixture();
    const records = (f.adapter as unknown as { backgroundRecoveries: Map<string, { exhaustedAt?: number }> }).backgroundRecoveries;
    const now = spyOn(Date, "now").mockReturnValue(records.get("session")!.exhaustedAt! + 30_000);
    const provider = f.provider as ChatProvider;
    const reconcile = provider.reconcileBackgroundTasks!.bind(provider);
    provider.reconcileBackgroundTasks = async (...args) => (await reconcile(...args)).map(item => ({ ...item, stateUncertain: false }));
    try {
      await f.event(); expect(f.reads()).toBe(4);
      expect(records.has("session")).toBe(false);
      expect(f.adapter.projectionForTests("session").get(f.unknown.id)).toMatchObject({ status: "running", stateUncertain: false });
      jest.advanceTimersByTime(120_000); await flushRecoveryIo(); expect(f.reads()).toBe(4);
    } finally { now.mockRestore(); await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  test("newer source terminal state fences an older read while safe independent discovery still applies", async () => {
    const f = await exhaustedRecoveryFixture();
    const records = (f.adapter as unknown as { backgroundRecoveries: Map<string, { exhaustedAt?: number }> }).backgroundRecoveries;
    const now = spyOn(Date, "now").mockReturnValue(records.get("session")!.exhaustedAt! + 30_000);
    const provider = f.provider as ChatProvider;
    const reconcile = provider.reconcileBackgroundTasks!.bind(provider);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    provider.reconcileBackgroundTasks = async (...args) => { const tasks = await reconcile(...args); await gate; return [...tasks, { ...f.known, id: "independent", taskId: "independent", toolUseId: "independent-native-call" }]; };
    try {
      await f.event(); expect(f.reads()).toBe(4);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, status: "completed", terminalReportedAt: 3 } }]);
      release(); await flushRecoveryIo();
      expect(f.adapter.projectionForTests("session").get(f.known.id)).toMatchObject({ status: "completed", terminalReportedAt: 3 });
      expect(f.adapter.projectionForTests("session").get("independent")).toMatchObject({ status: "running", stateUncertain: false });
      expect(f.provider.prompts).toEqual([]); expect(f.provider.interrupts).toEqual([]);
    } finally { release(); now.mockRestore(); await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  test("retained terminal-report progress remains usable across split-flush row replacement", async () => {
    const f = await exhaustedRecoveryFixture(true);
    try {
      await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: f.known.id }]);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "terminal-alias", taskId: "terminal-alias" } }]);
      expect(f.reads()).toBe(3);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "terminal-alias", taskId: "terminal-alias", terminalReportedAt: 3 } }]);
      expect(f.reads()).toBe(4);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  test("projection eviction cannot turn an old native invocation into a fresh cooldown exception", async () => {
    const f = await exhaustedRecoveryFixture();
    try {
      for (let index = 0; index < 70; index++) f.adapter.projectionForTests(`gone-${index}`);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "old-alias", taskId: "old-alias" } }]);
      expect(f.reads()).toBe(3);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "fresh-alias", taskId: "fresh-alias", toolUseId: "new-native-call", createdAt: 2 } }]);
      expect(f.reads()).toBe(4);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  for (const limit of ["count", "bytes"] as const) test(`removed native source fingerprints stay bounded by ${limit} without turning a retention gap into progress`, async () => {
    const f = await exhaustedRecoveryFixture();
    const records = (f.adapter as unknown as { backgroundRecoveries: Map<string, { sourceProgress: Map<string, unknown>; sourceProgressBytes: number; sourceProgressLost?: true }> }).backgroundRecoveries;
    try {
      for (let index = 0; index < (limit === "count" ? 70 : 1); index++) {
        const id = `removed-${index}`;
        const item = { ...f.known, id, taskId: id, toolUseId: limit === "bytes" ? "x".repeat(20_000) : `native-${index}` };
        // Existing source knowledge, not a new launch event. Removing the row
        // through the real stream must retain bounded invocation continuity.
        f.adapter.projectionForTests("session").apply({ kind: "upsert", item });
        await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: id }]);
      }
      const record = records.get("session")!;
      expect(record.sourceProgress.size).toBeLessThanOrEqual(64);
      expect(record.sourceProgressBytes).toBeLessThanOrEqual(16 * 1024);
      expect(record.sourceProgressBytes).toBe([...record.sourceProgress].reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0));
      expect(record.sourceProgressLost).toBe(true);
      const alias = limit === "bytes" ? "x".repeat(20_000) : "native-69";
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "gap-placeholder", taskId: "gap", toolUseId: alias, stateUncertain: true, createdAt: 0 } }]);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "gap-placeholder", taskId: "gap", toolUseId: alias } }]);
      expect(f.reads()).toBe(3);
      // Fresh native-call clock evidence is still eligible after metadata loss.
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "fresh-proof", taskId: "fresh-proof", toolUseId: "fresh-native-call", createdAt: 2 } }]);
      expect(f.reads()).toBe(4);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  for (const cleanup of ["reconnect", "dispose"] as const) test(`${cleanup} retires scalar cooldown fallback and source fingerprint ownership`, async () => {
    const f = await exhaustedRecoveryFixture();
    const state = f.adapter as unknown as { backgroundRecoveryFloorUntil: number; backgroundRecoverySourceStartedAt: number; backgroundRecoveries: Map<string, unknown> };
    try {
      // These scalars summarize lost scheduling metadata only, never workers.
      state.backgroundRecoveryFloorUntil = Date.now() + 30_000;
      state.backgroundRecoverySourceStartedAt = 1;
      if (cleanup === "reconnect") { f.provider.eventQueue.push({ type: "server.connected", data: {} }); await flushRecoveryIo(); expect(f.reads()).toBe(4); }
      else await f.adapter.dispose();
      expect(state.backgroundRecoveryFloorUntil).toBe(0);
      expect(state.backgroundRecoverySourceStartedAt).toBe(-Infinity);
      if (cleanup === "dispose") expect(state.backgroundRecoveries.size).toBe(0);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  test("deletion retires split-flush source fingerprints and stale source frames cannot recreate recovery ownership", async () => {
    const f = await exhaustedRecoveryFixture();
    const records = (f.adapter as unknown as { backgroundRecoveries: Map<string, { sourceProgress?: Map<string, unknown> }> }).backgroundRecoveries;
    try {
      await f.event("session.inbox.enqueued", [{ kind: "remove", itemId: f.known.id }]);
      expect(records.get("session")?.sourceProgress?.has("call:same-call")).toBe(true);
      f.provider.sessions = [];
      f.provider.eventQueue.push({ normalized: { eventType: "session.deleted", updates: [], outcome: "handled", sessionLifecycle: { kind: "deleted", id: "session", directory: process.cwd(), title: "Session", createdAt: 1, updatedAt: 1 } } });
      await flushRecoveryIo();
      expect(records.has("session")).toBe(false);
      await f.event("session.inbox.enqueued", [{ kind: "upsert", item: { ...f.known, id: "stale-alias", taskId: "stale-alias" } }]);
      expect(records.has("session")).toBe(false);
      expect(f.reads()).toBe(3);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  for (const [readMs, eventMs] of [[0, 3_000], [300, 100]] as const) test(`exhausted recovery bounds unrelated chatter over sixty seconds with ${readMs}ms reads and ${eventMs}ms events`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const worker = { id: "task:lost", type: "background_task" as const, taskId: "lost", description: "Lost worker", createdAt: 1, status: "running" as const, stateUncertain: true };
    let reads = 0;
    Object.assign(provider, { reconcileBackgroundTasks: async () => { reads++; if (readMs) await new Promise(resolve => setTimeout(resolve, readMs)); return [worker]; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    adapter.projectionForTests("session").apply({ kind: "upsert", item: worker });
    jest.useFakeTimers();
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} }); await flushRecoveryIo();
      for (let elapsed = 100; elapsed <= 60_000; elapsed += 100) {
        jest.advanceTimersByTime(100);
        if (elapsed % eventMs === 0) provider.eventQueue.push({ normalized: { conversationId: "session", eventType: elapsed % (2 * eventMs) ? "session.tool.success" : "session.message.content.updated", updates: [], outcome: "handled" } });
        await flushRecoveryIo();
      }
      expect(adapter.projectionForTests("session").get(worker.id)).toMatchObject({ status: "running", stateUncertain: true });
      expect(provider.prompts).toEqual([]); expect(provider.interrupts).toEqual([]);
      // Initial cycle plus at most two source-triggered cycles. The floor
      // starts at exhaustion, not at cycle admission, and quiet never polls.
      expect(reads).toBeLessThanOrEqual(9);
    } finally {
      const disposing = adapter.dispose(); jest.advanceTimersByTime(1_000); await flushRecoveryIo();
      await disposing; await pump; jest.useRealTimers();
    }
  });

  for (const cleanup of ["deleted", "evicted", "disposed"] as const) test(`parked recovery metadata is retired when its projection is ${cleanup}`, async () => {
    const f = await exhaustedRecoveryFixture();
    const records = (f.adapter as unknown as { backgroundRecoveries: Map<string, { exhaustedAt?: number; timer?: unknown }> }).backgroundRecoveries;
    try {
      expect(records.get("session")).toMatchObject({ exhaustedAt: expect.any(Number) });
      expect(records.get("session")?.timer).toBeUndefined();
      if (cleanup === "deleted") {
        f.provider.eventQueue.push({ normalized: { eventType: "session.deleted", updates: [], outcome: "handled", sessionLifecycle: { kind: "deleted", id: "session", directory: process.cwd(), title: "Session", createdAt: 1, updatedAt: 1 } } });
        await flushRecoveryIo();
      } else if (cleanup === "evicted") for (let index = 0; index < 70; index++) f.adapter.projectionForTests(`evict-${index}`);
      else await f.adapter.dispose();
      expect(records.has("session")).toBe(false);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  test("recovery scheduling records have a hard 2048-entry bound including active and queued conversations", async () => {
    const provider = new FakeProvider();
    provider.sessions = Array.from({ length: 2_050 }, (_, index) => fixtureSession(`parent-${index}`));
    let release!: () => void, maximum = 0, concurrent = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => { maximum = Math.max(maximum, ++concurrent); await gate; concurrent--; return []; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const records = (adapter as unknown as { backgroundRecoveries: Map<string, unknown> }).backgroundRecoveries;
    const pump = adapter.startEventPump();
    const classification = spyOn(provider, "listSessions");
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => records.size >= 2_048);
      // Let the two remaining inventory candidates run their confinement reads.
      await flushRecoveryIo();
      expect(classification).toHaveBeenCalledTimes(1);
      expect(records.size).toBe(2_048);
      expect(maximum).toBe(4);
    } finally { classification.mockRestore(); const disposing = adapter.dispose(); release(); await disposing; await pump; }
    expect(records.size).toBe(0);
  });

  test("a full parked scheduling cohort admits new recovery by evicting only disposable parked metadata", async () => {
    const f = await exhaustedRecoveryFixture();
    const records = (f.adapter as unknown as { backgroundRecoveries: Map<string, { dirty: boolean; running: boolean; failures: number; inconclusiveReads: number; exhaustedAt?: number; progress: Map<string, unknown> }> }).backgroundRecoveries;
    try {
      // Populate only scheduling state, not worker/control evidence. The real
      // exhausted session is the oldest parked record; a native event below
      // exercises normal scheduler admission at the retained-count boundary.
      const parked = records.get("session")!;
      for (let index = 1; index < 2_048; index++) records.set(`parked-${index}`, { ...parked, progress: new Map() });
      f.provider.sessions.push(fixtureSession("fresh"));
      f.provider.eventQueue.push({ normalized: { conversationId: "fresh", eventType: "session.tool.success", updates: [], outcome: "handled" } });
      await flushRecoveryIo();
      expect(records.size).toBe(2_048);
      expect(records.has("session")).toBe(false);
      expect(records.has("fresh")).toBe(true);
      expect(f.reads()).toBe(4);
      expect(f.adapter.projectionForTests("session").get(f.unknown.id)).toMatchObject({ status: "running", stateUncertain: true });
      expect(f.provider.prompts).toEqual([]); expect(f.provider.interrupts).toEqual([]);
    } finally { await f.adapter.dispose(); await f.pump; jest.useRealTimers(); }
  });

  test("successful inconclusive recovery has three reads per external cycle, not endless failure polling", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let reads = 0;
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const worker = { id: "task:unknown", type: "background_task" as const, taskId: "unknown", description: "Unknown", createdAt: 1, status: "running" as const, stateUncertain: true };
    Object.assign(provider, { reconcileBackgroundTasks: async () => { if (++reads === 1) await first; return [worker]; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      jest.useFakeTimers();
      release();
      await flushRecoveryIo();
      for (let retry = 0; retry < 8; retry++) { jest.advanceTimersByTime(30_000); await flushRecoveryIo(); }
      expect(reads).toBe(3);
      expect(adapter.projectionForTests("session").get(worker.id)).toMatchObject({ status: "running", stateUncertain: true });
      provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.tool.success", outcome: "handled", updates: [] } });
      await flushRecoveryIo();
      expect(reads).toBe(4);
      for (let retry = 0; retry < 4; retry++) { jest.advanceTimersByTime(30_000); await flushRecoveryIo(); }
      expect(reads).toBe(6);
      expect(provider.prompts).toEqual([]);
      expect(provider.interrupts).toEqual([]);
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  test("dirty source bursts apply independent workers, preserve newer rows and coalesce one fixed-delay follow-up", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const existing = { id: "task:existing", type: "background_task" as const, taskId: "existing", description: "Existing", createdAt: 1, status: "running" as const };
    const discovered = { ...existing, id: "task:discovered", taskId: "discovered", description: "Discovered" };
    let reads = 0;
    const releases: Array<() => void> = [];
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      reads++;
      await new Promise<void>(resolve => releases.push(resolve));
      return [existing, discovered];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    adapter.projectionForTests("session").apply({ kind: "upsert", item: existing });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.tool.success", outcome: "handled", updates: [{ kind: "upsert", item: { ...existing, status: "completed", summary: "Newer terminal result" } }] } });
      for (let event = 0; event < 100; event++) provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.message.content.updated", outcome: "handled", updates: [] } });
      await liveEventsApplied(adapter, provider);
      await flushRecoveryIo();
      jest.useFakeTimers();
      releases.shift()!();
      await flushRecoveryIo();
      expect(adapter.projectionForTests("session").get(discovered.id)).toMatchObject({ status: "running" });
      expect(adapter.projectionForTests("session").get(existing.id)).toMatchObject({ status: "completed", summary: "Newer terminal result" });
      expect(reads).toBe(1);
      jest.advanceTimersByTime(99);
      await flushRecoveryIo();
      expect(reads).toBe(1);
      // Continuous arrivals do not move the already-scheduled deadline.
      provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.message.content.updated", outcome: "handled", updates: [] } });
      await flushRecoveryIo();
      jest.advanceTimersByTime(1);
      await flushRecoveryIo();
      expect(reads).toBe(2);
      releases.shift()!();
      await flushRecoveryIo();
      jest.advanceTimersByTime(60_000);
      await flushRecoveryIo();
      expect(reads).toBe(2);
    } finally {
      const disposing = adapter.dispose();
      releases.splice(0).forEach(release => release());
      await disposing; await pump; jest.useRealTimers();
    }
  });

  for (const alias of ["call", "result"] as const) for (const coalesceWindowMs of [0, 25]) test(`normalized transient ${alias} alias removal fences older recovery with ${coalesceWindowMs}ms coalescing without discarding independent workers`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const occurrence = alias === "call" ? { toolUseId: "same-native-call" } : { resultId: "same-native-result" };
    const placeholder = { id: "task:transient", type: "background_task" as const, taskId: "transient", description: "Transient", createdAt: 1, status: "running" as const, ...occurrence };
    const canonical = { ...placeholder, id: "task:canonical", taskId: "canonical", description: "Old capture" };
    const independent = { ...placeholder, id: "task:independent", taskId: "independent", toolUseId: "independent-call", resultId: "independent-result" };
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fresh = false;
    Object.assign(provider, { reconcileBackgroundTasks: async () => { if (++reads !== 1) return fresh ? [canonical, independent] : []; await gate; return [canonical, independent]; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      const projection = adapter.projectionForTests("session");
      if (coalesceWindowMs) jest.useFakeTimers();
      provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.tool.success", outcome: "handled", updates: [{ kind: "upsert", item: placeholder }] } });
      if (!coalesceWindowMs) { await liveEventsApplied(adapter, provider); expect(projection.has(placeholder.id)).toBe(true); }
      provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.tool.success", outcome: "handled", updates: [{ kind: "remove", itemId: placeholder.id }] } });
      if (coalesceWindowMs) {
        await flushRecoveryIo();
        expect(projection.has(placeholder.id)).toBe(false); // Upsert never materialized.
        jest.advanceTimersByTime(coalesceWindowMs);
        await flushRecoveryIo();
      } else await liveEventsApplied(adapter, provider);
      expect(projection.has(placeholder.id)).toBe(false);
      jest.useFakeTimers(); release(); await flushRecoveryIo();
      expect(projection.has(canonical.id)).toBe(false);
      expect(projection.get(independent.id)).toMatchObject({ status: "running", toolUseId: "independent-call" });
      // The removal fence belongs only to that read, not a permanent tombstone.
      fresh = true;
      jest.advanceTimersByTime(100); await flushRecoveryIo();
      expect(reads).toBe(2);
      expect(projection.get(canonical.id)).toMatchObject({ status: "running", ...occurrence });
      expect(provider.prompts).toEqual([]);
      expect(provider.interrupts).toEqual([]);
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  test("a deleted parent retires its in-flight worker recovery instead of restoring activity", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      reads++; await gate;
      return [{ id: "task:deleted", type: "background_task", taskId: "deleted", description: "Deleted owner", createdAt: 1, status: "running" }];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      provider.sessions = [];
      provider.eventQueue.push({ type: "session.deleted", data: { info: fixtureSession("session") } });
      await liveEventsApplied(adapter, provider);
      release();
      await flushRecoveryIo();
      expect(adapter.projectionForTests("session").has("task:deleted")).toBe(false);
      expect(adapter.activity().working).toBe(false);
      expect(reads).toBe(1);
    } finally { release(); await adapter.dispose(); await pump; }
  });

  test("rejected recovery reads retain exponential error backoff, independently of the inconclusive budget", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => { const read = ++reads; if (read === 1) await gate; if (read < 3) throw new Error("read unavailable"); return []; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      jest.useFakeTimers(); release(); await flushRecoveryIo();
      jest.advanceTimersByTime(999); await flushRecoveryIo(); expect(reads).toBe(1);
      jest.advanceTimersByTime(1); await flushRecoveryIo(); expect(reads).toBe(2);
      jest.advanceTimersByTime(1_999); await flushRecoveryIo(); expect(reads).toBe(2);
      jest.advanceTimersByTime(1); await flushRecoveryIo(); expect(reads).toBe(3);
      jest.advanceTimersByTime(60_000); await flushRecoveryIo(); expect(reads).toBe(3);
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  test("verified discovery progress can continue beyond three reads without polling unchanged unknown work forever", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const unknown = { id: "task:unknown", type: "background_task" as const, taskId: "unknown", description: "Unknown", createdAt: 1, status: "running" as const, stateUncertain: true };
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      const read = ++reads; if (read === 1) await gate;
      return [unknown, ...Array.from({ length: Math.min(read, 5) }, (_, index) => ({ ...unknown, id: `task:verified-${index}`, taskId: `verified-${index}`, stateUncertain: false }))];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      jest.useFakeTimers(); release(); await flushRecoveryIo();
      for (let probe = 0; probe < 12; probe++) { jest.advanceTimersByTime(30_000); await flushRecoveryIo(); }
      expect(reads).toBe(7); // Five progress reads, then two unchanged probes.
      expect(adapter.projectionForTests("session").get("task:verified-4")).toMatchObject({ stateUncertain: false });
      expect(adapter.projectionForTests("session").get(unknown.id)).toMatchObject({ status: "running", stateUncertain: true });
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  for (const missing of ["omitted", "uncertain", "alias", "uncertain-alias"] as const) test(`unchanged worker ${missing}/reconfirmation flapping cannot reset its recovery cycle budget`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const unknown = { id: "task:unknown", type: "background_task" as const, taskId: "unknown", description: "Unknown", createdAt: 1, status: "running" as const, stateUncertain: true };
    const known = { ...unknown, id: "task:known", taskId: "known", toolUseId: "same-call", stateUncertain: false };
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      const read = ++reads; if (read === 1) await gate;
      return [unknown, ...(read % 2 ? [known] : missing === "omitted" ? [] : missing === "uncertain" ? [{ ...known, stateUncertain: true }] : [{ ...known, id: "task:canonical", taskId: "canonical", stateUncertain: missing === "uncertain-alias" }])];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      jest.useFakeTimers(); release(); await flushRecoveryIo();
      for (let probe = 0; probe < 16; probe++) { jest.advanceTimersByTime(30_000); await flushRecoveryIo(); }
      expect(reads).toBe(3);
      expect(adapter.projectionForTests("session").get(unknown.id)).toMatchObject({ status: "running", stateUncertain: true });
      expect(adapter.projectionForTests("session").get(known.id)).toMatchObject({ status: "running", stateUncertain: false });
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  for (const clock of ["start", "terminal-report"] as const) test(`new verified native ${clock} clocks can extend recovery while repeated old clocks cannot`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const unknown = { id: "task:unknown", type: "background_task" as const, taskId: "unknown", description: "Unknown", createdAt: 1, status: "running" as const, stateUncertain: true };
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      const read = ++reads; if (read === 1) await gate;
      const reported = read <= 5 ? read : read % 2 ? 5 : 4;
      return [unknown, { ...unknown, id: "task:progress", taskId: "progress", stateUncertain: false,
        ...(clock === "start" ? { createdAt: reported } : { status: "completed", terminalReportedAt: reported * 10 }) }];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      jest.useFakeTimers(); release(); await flushRecoveryIo();
      for (let probe = 0; probe < 12; probe++) { jest.advanceTimersByTime(30_000); await flushRecoveryIo(); }
      expect(reads).toBe(7);
      expect(adapter.projectionForTests("session").get("task:progress")).toMatchObject(clock === "start" ? { createdAt: 5 } : { status: "completed", terminalReportedAt: 50 });
      expect(adapter.projectionForTests("session").get(unknown.id)).toMatchObject({ status: "running", stateUncertain: true });
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  test("zero-progress dirty redos share the three-read budget under continuous source bursts", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const worker = { id: "task:unknown", type: "background_task" as const, taskId: "unknown", description: "Unknown", createdAt: 1, status: "running" as const, stateUncertain: true };
    let reads = 0;
    const releases: Array<() => void> = [];
    Object.assign(provider, { reconcileBackgroundTasks: async () => { reads++; await new Promise<void>(resolve => releases.push(resolve)); return [worker]; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      jest.useFakeTimers();
      for (let read = 0; read < 3; read++) {
        for (let event = 0; event < 20; event++) provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.message.content.updated", outcome: "handled", updates: [] } });
        await flushRecoveryIo();
        releases.shift()!(); await flushRecoveryIo();
        jest.advanceTimersByTime(100); await flushRecoveryIo();
      }
      expect(reads).toBe(3);
      jest.advanceTimersByTime(120_000); await flushRecoveryIo();
      expect(reads).toBe(3);
      expect(adapter.projectionForTests("session").get(worker.id)).toMatchObject({ stateUncertain: true });
    } finally {
      const disposing = adapter.dispose(); releases.splice(0).forEach(release => release());
      await disposing; await pump; jest.useRealTimers();
    }
  });

  test("a new connected generation immediately rearms the inconclusive cycle instead of inheriting its old timer", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => {
      if (++reads === 1) await gate;
      return [{ id: "task:unknown", type: "background_task", taskId: "unknown", description: "Unknown", createdAt: 1, status: "running", stateUncertain: true }];
    } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 0 });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      jest.useFakeTimers(); release(); await flushRecoveryIo();
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await flushRecoveryIo();
      expect(reads).toBe(2);
      for (let retry = 0; retry < 5; retry++) { jest.advanceTimersByTime(30_000); await flushRecoveryIo(); }
      expect(reads).toBe(4);
    } finally { release(); await adapter.dispose(); await pump; jest.useRealTimers(); }
  });

  test("inconclusive recovery backs off and clears uncertainty after evidence returns", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let reads = 0;
    const item = { id: "task:worker", taskId: "worker", type: "background_task" as const, createdAt: 1, description: "Worker", status: "running" as const };
    let release!: () => void;
    const firstRead = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, { reconcileBackgroundTasks: async () => { const first = ++reads === 1; if (first) await firstRead; return [{ ...item, stateUncertain: first }]; } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    try {
      provider.eventQueue.push({ type: "server.connected", data: {} });
      await waitUntil(() => reads === 1);
      jest.useFakeTimers();
      release();
      await flushUntil(() => [...(adapter as unknown as { backgroundRecoveries: Map<string, { timer?: unknown }> }).backgroundRecoveries.values()].some(recovery => recovery.timer !== undefined));
      jest.advanceTimersByTime(999);
      expect(reads).toBe(1);
      jest.advanceTimersByTime(1);
      // The next read validates the session directory through real filesystem
      // IO; it is not a timer, so unfreeze after crossing the exact deadline.
      jest.useRealTimers();
      await waitUntil(() => reads === 2 && !(adapter.projectionForTests("session").find(item => item.id === "task:worker") as { stateUncertain?: boolean } | undefined)?.stateUncertain);
      expect(adapter.projectionForTests("session").find(item => item.id === "task:worker")).toMatchObject({ stateUncertain: false });
    } finally {
      await adapter.dispose(); await pump;
      jest.useRealTimers();
    }
  });
  for (const expired of [false, true]) test(`background completion ${expired ? "uses a fresh read after an expired cursor" : "replays from a retained cursor"} without execution mutations`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const worker = { id: "task:worker", taskId: "worker", type: "background_task" as const, createdAt: 1, description: "Worker", status: "running" as const };
    let completed = false;
    Object.assign(provider, { reconcileBackgroundTasks: async () => [{ ...worker, ...(completed ? { status: "completed", summary: "Confirmed result" } : {}) }] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", replayBytes: expired ? 128 : 256 * 1024, coalesceWindowMs: 0 });
    const before = await adapter.history("session");
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ type: "server.connected", data: {} });
    await waitUntil(() => provider.eventQueue.waiting);
    completed = true;
    provider.eventQueue.push({ normalized: { conversationId: "session", eventType: "session.inbox.enqueued", outcome: "handled", updates: [{ kind: "upsert", item: { ...worker, status: "completed", summary: "Confirmed result" } }] } } as unknown as ProviderEvent);
    await waitUntil(() => adapter.projectionForTests("session").find(item => item.id === worker.id && item.type === "background_task" && item.status === "completed") !== undefined);
    const subscription = await adapter.subscribe("session", { cursor: before.cursor });
    const iterator = subscription.events[Symbol.asyncIterator]();
    if (expired) {
      expect((await iterator.next()).value).toMatchObject({ type: "resync", reason: "retention-gap" });
      expect((await adapter.history("session")).items.filter(item => item.type === "background_task")).toEqual([expect.objectContaining({ status: "completed", summary: "Confirmed result" })]);
    } else {
      let terminal: ChatEvent | undefined;
      for (let i = 0; i < 10; i++) {
        const next = await iterator.next();
        if (next.value?.type === "item.upsert" && next.value.item.type === "background_task" && next.value.item.status === "completed") { terminal = next.value; break; }
      }
      expect(terminal).toMatchObject({ type: "item.upsert", item: { id: worker.id, status: "completed", summary: "Confirmed result" } });
    }
    expect(subscription.snapshot.items.filter(item => item.type === "background_task")).toHaveLength(1);
    expect(provider.prompts).toEqual([]);
    expect(provider.interrupts).toEqual([]);
    subscription.events.cancel();
    await adapter.dispose(); await pump;
  });
  for (const first of ["background", "stop"] as const) test(`${first} admission serializes against the other parent action without sending held input`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.agent.capabilities.push("background-blocking-work");
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, {
      backgroundBlockingWork: async () => { calls.push("background"); if (first === "background") await gate; },
      interrupt: async (_id: string, options: { resume: boolean }) => { expect(options).toEqual({ resume: false }); calls.push("stop"); if (first === "stop") await gate; },
    });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    adapter.projectionForTests("session").statusUpdate("running");
    await adapter.prompt("session", "held", "Keep queued", undefined, undefined, undefined, undefined, "queue");
    const start = (kind: "background" | "stop") => kind === "background" ? adapter.backgroundBlockingWork("session", "background") : adapter.abort("session", "stop");
    const one = start(first);
    await waitUntil(() => calls.length === 1);
    const two = start(first === "background" ? "stop" : "background");
    // Admission is still held by the first native call.
    expect(calls).toEqual([first]);
    release();
    await Promise.all([one, two]);
    expect(calls).toEqual([first, first === "background" ? "stop" : "background"]);
    expect(provider.prompts).toEqual([]);
    expect((await adapter.history("session")).queued?.map(item => item.text)).toEqual(["Keep queued"]);
    await adapter.dispose();
  });
  test("background-all retains an unknown receipt rather than replaying against newer blockers", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.agent.capabilities.push("background-blocking-work");
    let calls = 0;
    Object.assign(provider, { backgroundBlockingWork: async () => { calls++; throw new OperationOutcomeUnknownError(); } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await expect(adapter.backgroundBlockingWork("session", "request")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    await expect(adapter.backgroundBlockingWork("session", "request")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    expect(calls).toBe(1);
    await expect(adapter.backgroundBlockingWork("session", "new-request")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    expect(calls).toBe(2);
    expect(provider.prompts).toEqual([]);
    await adapter.dispose();
  });
  test("a worker-stop unknown receipt is retained without changing unrelated error retry policy", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    provider.agent.capabilities.push("background-tasks");
    let calls = 0;
    Object.assign(provider, { stopTask: async () => { calls++; throw new OperationOutcomeUnknownError(); } });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await expect(adapter.stopTask("session", "worker", "request")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    await expect(adapter.stopTask("session", "worker", "request")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    expect(calls).toBe(1);
    await adapter.dispose();
  });
  for (const operation of ["background", "stop"] as const) {
    test(`${operation} rejected before dispatch does not create an accepted or unknown receipt`, async () => {
      const provider = new FakeProvider();
      provider.sessions = [fixtureSession("session")];
      let calls = 0;
      Object.assign(provider, { backgroundBlockingWork: async () => { calls++; }, stopTask: async () => { calls++; } });
      const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
      const run = () => operation === "background" ? adapter.backgroundBlockingWork("session", "same-id") : adapter.stopTask("session", "worker", "same-id");
      await expect(run()).rejects.toBeInstanceOf(BackgroundTasksUnsupportedError);
      expect(calls).toBe(0);
      provider.agent.capabilities.push("background-tasks", "background-blocking-work");
      await run(); await run();
      expect(calls).toBe(1);
      await adapter.dispose();
    });
  }
  for (const operation of ["background", "stop"] as const) for (const unknown of [false, true]) {
    for (const budget of [{ receiptEntries: 1 }, { receiptBytes: 180 }]) {
      test(`${operation} ${unknown ? "unknown" : "accepted"} receipt deduplication ends at ${JSON.stringify(budget)} eviction`, async () => {
        const provider = new FakeProvider();
        provider.sessions = [fixtureSession("session")];
        provider.agent.capabilities.push("background-tasks", "background-blocking-work");
        let calls = 0;
        const dispatch = async () => { calls++; if (unknown) throw new OperationOutcomeUnknownError(); };
        Object.assign(provider, { backgroundBlockingWork: dispatch, stopTask: dispatch });
        const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", ...budget });
        const run = (id: string) => (operation === "background" ? adapter.backgroundBlockingWork("session", id) : adapter.stopTask("session", "worker", id))
          .catch(error => { expect(unknown).toBe(true); expect(error).toBeInstanceOf(OperationOutcomeUnknownError); });
        await run("first"); await run("first");
        expect(calls).toBe(1);
        await run("second"); await run("first");
        expect(calls).toBe(3);
        expect(provider.prompts).toEqual([]);
        await adapter.dispose();
      });
    }
    test(`${operation} ${unknown ? "unknown" : "accepted"} receipts expire after settlement and do not survive adapter recreation`, async () => {
      const provider = new FakeProvider();
      provider.sessions = [fixtureSession("session")];
      provider.agent.capabilities.push("background-tasks", "background-blocking-work");
      let clock = 0;
      let calls = 0;
      const dispatch = async () => { calls++; if (unknown) throw new OperationOutcomeUnknownError(); };
      Object.assign(provider, { backgroundBlockingWork: dispatch, stopTask: dispatch });
      const create = () => new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", now: () => clock });
      let adapter = create();
      const run = () => (operation === "background" ? adapter.backgroundBlockingWork("session", "request") : adapter.stopTask("session", "worker", "request")).catch(error => { expect(error).toBeInstanceOf(OperationOutcomeUnknownError); });
      await run();
      clock = 899_999;
      await run();
      expect(calls).toBe(1);
      clock = 900_000;
      await run();
      expect(calls).toBe(2);
      await adapter.dispose();
      adapter = create();
      await run();
      expect(calls).toBe(3);
      await adapter.dispose();
    });
  }

  test("a scheduled conversation accepts prompts, reopens scheduled with its live wakeups, and releases once per request", async () => {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, "scheduled-wakeups"] };
    provider.sessions = [fixtureSession("session")];
    const releases: string[] = [];
    let listed = [
      { conversationId: "session", wakeupId: "w1", prompt: "check the build", recurring: false, schedule: "3 20 * * *", nextFireAt: 9, createdAt: 5 },
      { conversationId: "other", wakeupId: "w2", prompt: "elsewhere", recurring: true, schedule: "* * * * *", createdAt: 6 },
    ];
    Object.assign(provider, {
      release: async (sessionId: string) => { releases.push(sessionId); },
      listScheduledWakeups: async () => listed,
    });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const projection = adapter.projectionForTests("session");
    projection.statusUpdate("running");
    projection.statusUpdate("completed");
    projection.statusUpdate("scheduled");
    // Not live: a prompt is delivered into the held session, not held back.
    expect((await adapter.prompt("session", "r1", "meanwhile")).pending).toBe(false);
    projection.statusUpdate("completed");
    // Reopened while the provider still holds the wakeup: its row (this
    // conversation's only) and the scheduled state.
    const snapshot = await adapter.history("session");
    expect(snapshot.items.filter(item => item.type === "scheduled_wakeup")).toEqual([
      expect.objectContaining({ id: "wakeup:w1", wakeupId: "w1", status: "pending", recurring: false, nextFireAt: 9, createdAt: 5 }),
    ]);
    expect(snapshot.conversation.status).toBe("scheduled");
    // Release is idempotent per request id and addressed to the owning session.
    expect(await adapter.release("session", "req-1")).toEqual({ released: true });
    expect(await adapter.release("session", "req-1")).toEqual({ released: true });
    expect(releases).toEqual(["session"]);
    listed = [];
    projection.statusUpdate("idle");
    const after = await adapter.history("session");
    expect(after.items.some(item => item.type === "scheduled_wakeup")).toBe(false);
    expect(after.conversation.status).not.toBe("scheduled");
    await adapter.dispose();
  });

  test("a conversation opened without a live session lists its paused crons, stays idle, and cancels one", async () => {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, "scheduled-wakeups"] };
    provider.sessions = [fixtureSession("session")];
    const cancels: Array<[string, string]> = [];
    const paused = { id: "wakeup:c1", type: "scheduled_wakeup" as const, createdAt: 5, wakeupId: "c1", prompt: "poll the queue", recurring: true, schedule: "*/5 * * * *", status: "paused" as const, message: "Paused." };
    Object.assign(provider, {
      listScheduledWakeups: async () => [],
      listPausedWakeups: async (id: string) => id === "session" ? [paused] : [],
      cancelWakeup: async (id: string, wakeupId: string) => { cancels.push([id, wakeupId]); },
    });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const snapshot = await adapter.history("session");
    expect(snapshot.items.filter(item => item.type === "scheduled_wakeup")).toEqual([paused]);
    expect(snapshot.conversation.status).not.toBe("scheduled");
    expect(await adapter.cancelWakeup("session", "c1", "req-1")).toEqual({ cancelled: true });
    expect(await adapter.cancelWakeup("session", "c1", "req-1")).toEqual({ cancelled: true });
    expect(cancels).toEqual([["session", "c1"]]);
    // A row this page already saw cancelled is not reopened by a stale list.
    adapter.projectionForTests("session").apply({ kind: "upsert", item: { ...paused, status: "cancelled" } });
    expect((await adapter.history("session")).items.find(item => item.id === "wakeup:c1")).toEqual(expect.objectContaining({ status: "cancelled" }));
    await adapter.dispose();
  });

  test("a wakeup that fires or is cancelled while the snapshot is read is not seeded back to pending", async () => {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, "scheduled-wakeups"] };
    provider.sessions = [fixtureSession("session")];
    const pending = (wakeupId: string) => ({ conversationId: "session", wakeupId, prompt: `check ${wakeupId}`, recurring: false, schedule: "3 20 * * *", nextFireAt: 9, createdAt: 5 });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const projection = adapter.projectionForTests("session");
    const settled = (wakeupId: string, status: "fired" | "cancelled") => ({ id: `wakeup:${wakeupId}`, type: "scheduled_wakeup" as const, createdAt: 5, wakeupId, prompt: `check ${wakeupId}`, recurring: false, schedule: "3 20 * * *", status, ...(status === "fired" ? { firedTurnId: "message:wakeup:f1" } : {}) });
    Object.assign(provider, {
      listScheduledWakeups: async () => [pending("w1"), pending("w2"), pending("w3")],
      // Read after the wakeup list: the provider's events land meanwhile.
      listPermissions: async () => {
        projection.apply({ kind: "upsert", item: settled("w1", "fired") });
        projection.apply({ kind: "upsert", item: settled("w2", "cancelled") });
        return [];
      },
    });
    const snapshot = await adapter.history("session");
    const rows = (items: ConversationItem[]) => items.filter(item => item.type === "scheduled_wakeup").map(item => [item.id, (item as { status: string }).status]);
    expect(rows(snapshot.items)).toEqual([["wakeup:w1", "fired"], ["wakeup:w2", "cancelled"], ["wakeup:w3", "pending"]]);
    expect(rows(projection.items())).toEqual([["wakeup:w1", "fired"], ["wakeup:w2", "cancelled"], ["wakeup:w3", "pending"]]);
    await adapter.dispose();
  });

  test("an agent without the scheduled-wakeups capability cannot release", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    Object.assign(provider, { release: async () => {} });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await expect(adapter.release("session", "req-1")).rejects.toBeInstanceOf(ScheduledWakeupsUnsupportedError);
    await adapter.dispose();
  });

  // Design D13: a typed command's run row is the turn's, not background work
  // the provider lists — the snapshot must neither stop it mid-command nor
  // lose it, nor read it as background work.
  test("a foreground run row rides a mid-command snapshot, running, and closes once no turn runs", async () => {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, "background-tasks"] };
    provider.sessions = [fixtureSession("session")];
    (provider as unknown as { listBackgroundTasks: () => Promise<unknown[]> }).listBackgroundTasks = async () => [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const projection = adapter.projectionForTests("session");
    projection.statusUpdate("running");
    projection.apply({ kind: "upsert", item: { id: "task:rv", type: "background_task", createdAt: 5, taskId: "rv", description: "/code-review", taskType: "local_agent", status: "running", childConversationId: "sub:session:rv", foreground: true } });
    const during = await adapter.history("session");
    expect(during.items.filter(item => item.type === "background_task")).toEqual([expect.objectContaining({ id: "task:rv", status: "running", foreground: true })]);
    expect(during.conversation.status).toBe("running");
    // The command ended without the run's notification: no turn is live, so
    // the row is over, and it never made the conversation background work.
    projection.statusUpdate("completed");
    const after = await adapter.history("session");
    expect(after.items.filter(item => item.type === "background_task")).toEqual([expect.objectContaining({ id: "task:rv", status: "stopped" })]);
    expect(after.conversation.status).toBe("completed");
    await adapter.dispose();
  });

  test("an agent without the background-tasks capability cannot stop tasks", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await expect(adapter.stopTask("session", "b1", "req-1")).rejects.toBeInstanceOf(BackgroundTasksUnsupportedError);
    await expect(adapter.taskOutput("session", "b1", { tailBytes: 512 })).rejects.toBeInstanceOf(BackgroundTasksUnsupportedError);
    await adapter.dispose();
  });

  test("a held message freezes the configuration it was submitted under", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const modelA = { providerId: "anthropic", modelId: "claude" };
    const modelB = { providerId: "openai", modelId: "gpt" };
    provider.configurations.set("session", { model: modelA });
    provider.models.push({ selection: modelB, provider: "OpenAI", name: "GPT" });
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });
    const until = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
      expect(predicate()).toBe(true);
    };

    expect((await adapter.prompt("session", "r1", "first")).pending).toBe(false);
    // Submitted with no explicit model — under the configuration the user
    // saw at the time (model A)...
    await adapter.prompt("session", "r2", "second");
    // ...before a later submission moves the conversation to model B.
    await adapter.prompt("session", "r3", "third", modelB);

    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => provider.prompts.length === 2);
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ text: "second", model: modelA }));
    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => provider.prompts.length === 3);
    expect(provider.prompts[2]).toEqual(expect.objectContaining({ text: "third", model: modelB }));
  });

  test("the held queue is bounded and a full queue refuses the submission without altering it", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r0", "start")).pending).toBe(false);
    for (let index = 1; index <= 20; index += 1) {
      expect((await adapter.prompt("session", `count-${index}`, `held ${index}`)).pending).toBe(true);
    }
    await expect(adapter.prompt("session", "count-21", "one too many")).rejects.toBeInstanceOf(ChatQueueFullError);
    expect((await adapter.history("session")).queued).toHaveLength(20);

    // The byte bound trips before the count bound for oversized prompts.
    const bytes = new ChatAdapter({ provider: (() => {
      const fresh = new FakeProvider();
      fresh.sessions = [fixtureSession("session")];
      return fresh;
    })(), workspacePath: process.cwd(), generation: "g2", id: () => `byte-${++message}` });
    expect((await bytes.prompt("session", "b0", "start")).pending).toBe(false);
    const large = "x".repeat(60 * 1024);
    for (let index = 1; index <= 4; index += 1) {
      expect((await bytes.prompt("session", `bytes-${index}`, large)).pending).toBe(true);
    }
    await expect(bytes.prompt("session", "bytes-5", large)).rejects.toBeInstanceOf(ChatQueueFullError);
  });

  test("a held message does not ride an idle event that outruns the interrupt acknowledgement", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).pending).toBe(false);
    const held = await adapter.prompt("session", "r2", "second");
    expect(held.pending).toBe(true);

    // The provider publishes the interrupt's idle transition before the
    // interrupt request itself resolves — the pump is faster than the HTTP
    // acknowledgement. The queue must already be paused when that happens.
    provider.interrupt = async sessionId => {
      provider.interrupts.push(sessionId);
      adapter.projectionForTests("session").statusUpdate("idle");
      await new Promise(resolve => setTimeout(resolve, 10));
    };
    await adapter.abort("session", "cancel-1");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(provider.prompts).toHaveLength(1);
    await expect(adapter.removeQueued("session", held.messageId, "remove-1")).resolves.toEqual({ removed: true });

    // Positive pre-application refusal rolls back only this Stop's pause;
    // an ordinary transport rejection cannot establish that fact.
    expect((await adapter.prompt("session", "r3", "third")).pending).toBe(false);
    const fourth = await adapter.prompt("session", "r4", "fourth");
    expect(fourth.pending).toBe(true);
    provider.interrupt = async () => { throw new InterruptNotAppliedError("interrupt refused"); };
    await expect(adapter.abort("session", "cancel-2")).rejects.toThrow("interrupt refused");
    adapter.projectionForTests("session").statusUpdate("completed");
    for (let attempt = 0; attempt < 200 && provider.prompts.length < 3; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    expect(provider.prompts[2]).toEqual(expect.objectContaining({ text: "fourth", id: fourth.messageId }));
  });

  test("a failed interrupt keeps the turn live so a following submission cannot release the queue", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });

    expect((await adapter.prompt("session", "r1", "first")).pending).toBe(false);
    const held = await adapter.prompt("session", "r2", "second");
    expect(held.pending).toBe(true);

    // The interrupt is refused while the provider turn keeps running. The
    // projection must keep reporting that turn live — a "failed" downgrade
    // would read as idle to the next submission, which would then release
    // the queue head into a turn the provider never stopped.
    provider.interrupt = async () => { throw new Error("interrupt refused"); };
    await expect(adapter.abort("session", "cancel-1")).rejects.toThrow("interrupt refused");
    expect(adapter.projectionForTests("session").status).toBe("running");

    expect((await adapter.prompt("session", "r3", "third")).pending).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.prompts).toHaveLength(1);
    expect((await adapter.history("session")).queued).toHaveLength(2);

    // The turn's own terminal event still ends the status and delivers.
    adapter.projectionForTests("session").statusUpdate("completed");
    for (let attempt = 0; attempt < 200 && provider.prompts.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ text: "second", id: held.messageId }));
  });

  test("a failed delivery pauses the queue instead of hammering a failing conversation", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let message = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++message}` });
    const until = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
      expect(predicate()).toBe(true);
    };

    expect((await adapter.prompt("session", "r1", "first")).pending).toBe(false);
    const held = await adapter.prompt("session", "r2", "second");
    expect(held.pending).toBe(true);

    let attempts = 0;
    const accept = provider.prompt.bind(provider);
    provider.prompt = async (sessionId, input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider refused");
      return accept(sessionId, input);
    };
    adapter.projectionForTests("session").statusUpdate("completed");
    await until(() => attempts === 1);
    expect(adapter.projectionForTests("session").status).toBe("failed");

    // A later idle transition does not retry on its own...
    adapter.projectionForTests("session").statusUpdate("idle");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(attempts).toBe(1);
    // ...the message is still held and removable, and a new submission
    // resumes delivery.
    expect((await adapter.history("session")).queued).toEqual([
      expect.objectContaining({ id: held.messageId, text: "second" }),
    ]);
    await adapter.prompt("session", "r3", "third");
    await until(() => attempts === 2);
  });

  test("joins duplicate prompts, holds busy submissions, and preserves content on abort", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let nextId = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `message-${++nextId}` });
    const projection = adapter.projectionForTests("session");
    projection.upsert({ id: "part:answer", type: "assistant_message", createdAt: 1, markdown: "Completed content" });

    const [first, duplicate] = await Promise.all([
      adapter.prompt("session", "request-1", "first"),
      adapter.prompt("session", "request-1", "first"),
    ]);
    expect(first).toEqual(duplicate);
    expect(provider.prompts).toHaveLength(1);
    expect(first.pending).toBe(false);
    expect(projection.status).toBe("running");

    // A busy submission is held by the workspace, not delivered mid-turn.
    const held = await adapter.prompt("session", "request-2", "follow-up");
    expect(held.pending).toBe(true);
    expect(provider.prompts).toHaveLength(1);

    await Promise.all([adapter.abort("session", "cancel-1"), adapter.abort("session", "cancel-1")]);
    expect(provider.interrupts).toEqual(["session"]);
    expect(projection.status).toBe("interrupted");
    expect(projection.items()).toContainEqual(expect.objectContaining({ id: "part:answer", markdown: "Completed content" }));

    // The cancellation left the held message queued and removable, and it
    // never rode the interrupt's idle transition to the provider.
    expect(provider.prompts).toHaveLength(1);
    await expect(adapter.removeQueued("session", held.messageId, "remove-1")).resolves.toEqual({ removed: true });
    await expect(adapter.removeQueued("session", held.messageId, "remove-2")).rejects.toBeInstanceOf(QueuedMessageNotHeldError);
  });

  test("maps completed and failed provider transitions", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ id: "idle", type: "session.idle", data: { sessionID: "session" } });
    provider.eventQueue.push({ id: "error", type: "session.error", data: { sessionID: "session", error: { type: "unknown", message: "failed" } } });
    for (let attempt = 0; attempt < 100 && adapter.projectionForTests("session").status !== "failed"; attempt += 1) {
      await Bun.sleep(1);
    }
    await adapter.stopEventPump();
    await pump;
    expect(adapter.projectionForTests("session").status).toBe("failed");
    expect(adapter.projectionForTests("session").items()).toContainEqual(expect.objectContaining({ type: "notice", level: "error", message: "failed" }));
  });

  test("supports permission outcomes exactly once and refuses stale duplicates", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    for (const [requestId, outcome] of [["once", "approved-once"], ["always", "approved-session"], ["reject", "rejected"]] as const) {
      applyEvent(adapter, "session", { id: requestId, type: "permission.v2.asked", data: { id: requestId, sessionID: "session", action: "shell", resources: ["bun test"], timestamp: Date.now() } });
      const first = adapter.respondPermission("session", requestId, `client-${requestId}`, outcome);
      const duplicate = adapter.respondPermission("session", requestId, `client-${requestId}`, outcome);
      expect(await duplicate).toEqual(await first);
      await expect(adapter.respondPermission("session", requestId, `other-${requestId}`, outcome)).rejects.toBeInstanceOf(InteractionConflictError);
    }
    expect(provider.permissionReplies.map(reply => reply.reply)).toEqual(["once", "always", "reject"]);
  });

  test("a late ask alias does not reopen a resolved interaction", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    applyEvent(adapter, "session", { id: "ask", type: "permission.v2.asked", data: { id: "perm_1", sessionID: "session", action: "shell", resources: ["ls"], timestamp: 10 } });
    await adapter.respondPermission("session", "perm_1", "c1", "approved-once");
    // The classic stream's alias of the same ask, delivered after the reply:
    // the merged streams only preserve order within themselves.
    applyEvent(adapter, "session", { id: "alias", type: "permission.asked", data: { id: "perm_1", sessionID: "session", permission: "shell", patterns: ["ls"], timestamp: 9 } });

    expect(adapter.projectionForTests("session").items()[0]).toEqual(expect.objectContaining({
      id: "permission:perm_1",
      status: "resolved",
      outcome: "approved-once",
    }));
    await expect(adapter.respondPermission("session", "perm_1", "c2", "rejected")).rejects.toBeInstanceOf(InteractionConflictError);

    applyEvent(adapter, "session", {
      id: "q-ask", type: "question.v2.asked",
      data: { id: "que_1", sessionID: "session", timestamp: 10, questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "A" }], multiple: false, custom: false }] },
    });
    await adapter.respondQuestion("session", "que_1", "c3", { kind: "answered", answers: [["A"]] });
    applyEvent(adapter, "session", {
      id: "q-alias", type: "question.v2.asked",
      data: { id: "que_1", sessionID: "session", timestamp: 9, questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "A" }], multiple: false, custom: false }] },
    });
    expect(adapter.projectionForTests("session").items().find(item => item.id === "question:que_1")).toEqual(
      expect.objectContaining({ status: "resolved", outcome: { kind: "answered", answers: [["A"]] } }),
    );
  });

  test("supports option, multi-option, free-form, and rejection answers and refuses invalid or stale responses", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const ask = (id: string, multiple: boolean, custom: boolean) => applyEvent(adapter, "session", {
      id,
      type: "question.v2.asked",
      data: { id, sessionID: "session", timestamp: Date.now(), questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "A" }, { label: "B", description: "B" }], multiple, custom }] },
    });

    ask("option", false, false);
    const option = adapter.respondQuestion("session", "option", "c1", { kind: "answered", answers: [["A"]] });
    const optionDuplicate = adapter.respondQuestion("session", "option", "c1", { kind: "answered", answers: [["A"]] });
    expect(await optionDuplicate).toEqual(await option);
    ask("multi", true, false);
    await adapter.respondQuestion("session", "multi", "c2", { kind: "answered", answers: [["A", "B"]] });
    ask("free", false, true);
    await adapter.respondQuestion("session", "free", "c3", { kind: "answered", answers: [["Other"]] });
    ask("reject", false, false);
    await adapter.respondQuestion("session", "reject", "c4", { kind: "rejected" });
    await expect(adapter.respondQuestion("session", "reject", "new-client", { kind: "rejected" })).rejects.toBeInstanceOf(InteractionConflictError);
    ask("invalid", false, false);
    await expect(adapter.respondQuestion("session", "invalid", "c5", { kind: "answered", answers: [["Other"]] })).rejects.toThrow(/free-form/);

    expect(provider.questionReplies).toEqual([
      expect.objectContaining({ requestId: "option", answers: [["A"]] }),
      expect.objectContaining({ requestId: "multi", answers: [["A", "B"]] }),
      expect.objectContaining({ requestId: "free", answers: [["Other"]] }),
      expect.objectContaining({ requestId: "reject", rejected: true }),
    ]);
  });

  test("invalid question answers neither reach the provider nor resolve the request", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const invalid = [
      { id: "empty", multiple: true, custom: true, answers: [] },
      { id: "whitespace", multiple: true, custom: true, answers: ["   "] },
      { id: "single-extra", multiple: false, custom: true, answers: ["A", "Other"] },
      { id: "unknown", multiple: false, custom: false, answers: ["Other"] },
    ];

    for (const testCase of invalid) {
      applyEvent(adapter, "session", {
        id: testCase.id,
        type: "question.v2.asked",
        data: {
          id: testCase.id,
          sessionID: "session",
          timestamp: Date.now(),
          questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "" }], multiple: testCase.multiple, custom: testCase.custom }],
        },
      });
      await expect(adapter.respondQuestion("session", testCase.id, `client-${testCase.id}`, {
        kind: "answered",
        answers: [testCase.answers],
      })).rejects.toBeInstanceOf(InteractionConflictError);
      expect(adapter.projectionForTests("session").items().find(item => item.id === `question:${testCase.id}`)).toEqual(
        expect.objectContaining({ status: "pending" }),
      );
    }

    expect(provider.questionReplies).toEqual([]);
  });
});

describe("discarded event accounting", () => {
  function counters() {
    const values: Record<string, number> = {};
    return { values, inc: (name: string, delta = 1) => { values[name] = (values[name] ?? 0) + delta; } };
  }

  test("an unrecognized event is counted by type and the stream keeps flowing", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    provider.eventQueue.push({ id: "u1", type: "totally.unknown.event", data: { sessionID: "local" } } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "after" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(metrics.values["chat.event.unrecognized.totally.unknown.event"]).toBe(1);
    // The event after the unrecognized one still landed.
    expect(JSON.stringify(adapter.projectionForTests("local").items())).toContain("after");
    await adapter.stopEventPump();
    await pump;
  });

  test("a malformed payload of a known type costs one event, not the pump", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    // `permission.v2.asked` requires an id; without one its accessor throws.
    provider.eventQueue.push({ id: "bad", type: "permission.v2.asked", data: { sessionID: "local" } } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "survived" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(metrics.values["chat.event.unparseable.permission.v2.asked"]).toBe(1);
    expect(JSON.stringify(adapter.projectionForTests("local").items())).toContain("survived");
    await adapter.stopEventPump();
    await pump;
  });

  test("an intentionally ignored type is not counted as a discard", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    provider.eventQueue.push({ id: "hb", type: "server.heartbeat", data: {} } as never);
    provider.eventQueue.push({ id: "cd", type: "session.next.compaction.delta", data: { sessionID: "local" } } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "ok" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(Object.keys(metrics.values).filter(key => key.startsWith("chat.event."))).toEqual([]);
    await adapter.stopEventPump();
    await pump;
  });

  test("the counted type space is bounded, folding overflow into `other`", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    for (let index = 0; index < 70; index += 1) {
      provider.eventQueue.push({ id: `u${index}`, type: `unknown.type.${index}`, data: { sessionID: "local" } } as never);
    }
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "last" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    const keys = Object.keys(metrics.values).filter(key => key.startsWith("chat.event.unrecognized."));
    expect(keys.length).toBe(65);
    expect(metrics.values["chat.event.unrecognized.other"]).toBe(6);
    await adapter.stopEventPump();
    await pump;
  });

  test("a skipped content block is counted by block type under the shared cap", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    provider.eventQueue.push({ id: "p1", type: "message.part.updated", data: { sessionID: "local", part: { id: "prt", messageID: "m", sessionID: "local", type: "patch" } } } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "after" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(metrics.values["chat.block.unrecognized.patch"]).toBe(1);
    expect(Object.keys(metrics.values).filter(key => key.startsWith("chat.event."))).toEqual([]);
    await adapter.stopEventPump();
    await pump;
  });

  test("a Claude system subtype nobody reads is counted under its subtype", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    const normalized = { ...normalizeClaudeMessage({ type: "system", subtype: "model_refusal_no_fallback", uuid: "s1" }, createClaudeEventMemory(), "live"), conversationId: "local" };
    provider.eventQueue.push({ normalized } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "after" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(metrics.values["chat.event.unrecognized.system.model_refusal_no_fallback"]).toBe(1);
    await adapter.stopEventPump();
    await pump;
  });

  test("discards land in the registry snapshot the workspace writes without --debug", async () => {
    // cli.ts writes `snapshot-<pid>.json` from MetricsRegistry.snapshot() on an
    // unconditional 1Hz tick; --debug only adds the NDJSON history. Driving the
    // real registry here guards the property that makes these counters readable
    // on the machine where chat broke, with no restart and no flag.
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const registry = new MetricsRegistry();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), metrics: registry, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    provider.eventQueue.push({ id: "u1", type: "question.asked.someday", data: { sessionID: "local" } } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "ok" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(registry.snapshot().counters["chat.event.unrecognized.question.asked.someday"]).toBe(1);
    await adapter.stopEventPump();
    await pump;
  });

  test("no counter key or value carries an event payload", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const metrics = counters();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), metrics, coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    provider.eventQueue.push({
      id: "secret",
      type: "unknown.secret.carrier",
      data: { sessionID: "local", contents: "PRIVATE-FILE-CONTENTS" },
    } as never);
    provider.eventQueue.push({ id: "d1", type: "session.next.text.delta", data: { sessionID: "local", partID: "p", delta: "ok" } });
    while (adapter.projectionForTests("local").items().length === 0) await Bun.sleep(1);

    expect(JSON.stringify(metrics.values)).not.toContain("PRIVATE-FILE-CONTENTS");
    await adapter.stopEventPump();
    await pump;
  });
});

describe("pending permission recovery", () => {
  test("a permission the event stream never delivered appears on load and is answerable", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    // The pump never saw this: OpenCode raised it while the stream was down.
    // The diff rides along — recovery exists for the reader who missed the
    // live announcement, who must not approve an edit without seeing it.
    // So does the rule an "always" reply would install: the recovered card
    // confirms with the same scope the live one would have shown.
    // And the tool row the request belongs to: a wildcard request shows
    // the call's arguments from that row, recovered or live.
    // And the MCP server and tool the provider resolved, so the recovered
    // card is titled as the live one would have been.
    provider.listPermissions = async () => [{ requestId: "perm_1", conversationId: "local", action: "skill", resources: ["review-code"], alwaysPatterns: ["review-*"], diff: "@@ -1 +1 @@\n-a\n+b", sourceToolId: "tool:call_1", mcp: { server: "tracker", tool: "review" } }];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const snapshot = await adapter.history("local");
    expect(snapshot.items).toEqual([expect.objectContaining({
      id: "permission:perm_1",
      type: "permission",
      action: "skill",
      resources: ["review-code"],
      alwaysPatterns: ["review-*"],
      status: "pending",
      diff: "@@ -1 +1 @@\n-a\n+b",
      sourceToolId: "tool:call_1",
      mcp: { server: "tracker", tool: "review" },
    })]);

    await adapter.respondPermission("local", "perm_1", "req-1", "approved-once");
    expect(provider.permissionReplies).toEqual([{ sessionId: "local", requestId: "perm_1", reply: "once" }]);
  });

  test("a recovered request that also arrives live stays one entry", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    provider.listPermissions = async () => [{ requestId: "perm_1", conversationId: "local", action: "skill", resources: ["review-code"] }];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    await adapter.history("local");
    applyEvent(adapter, "local", {
      id: "live",
      type: "permission.v2.asked",
      data: { id: "perm_1", sessionID: "local", action: "skill", resources: ["review-code"] },
    } as never);

    const items = adapter.projectionForTests("local").items().filter(item => item.type === "permission");
    expect(items).toHaveLength(1);
  });

  test("a permission answered elsewhere is revoked on load, not left answerable", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    // Answered through another client while its reply event was missed: the
    // successful pending list no longer carries it.
    provider.listPermissions = async () => [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    applyEvent(adapter, "local", {
      id: "live",
      type: "permission.v2.asked",
      data: { id: "perm_gone", sessionID: "local", action: "shell", resources: ["ls"] },
    } as never);

    const snapshot = await adapter.history("local");
    expect(snapshot.items).toEqual([]);
    expect(adapter.projectionForTests("local").has("permission:perm_gone")).toBe(false);
  });

  test("a failing permission list leaves already-known requests visible", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    provider.listPermissions = async () => { throw new Error("provider unreachable"); };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    applyEvent(adapter, "local", {
      id: "live",
      type: "permission.v2.asked",
      data: { id: "perm_known", sessionID: "local", action: "shell", resources: ["ls"] },
    } as never);

    // The snapshot degrades rather than erasing what the stream established.
    const snapshot = await adapter.history("local");
    expect(snapshot.items.some(item => item.id === "permission:perm_known")).toBe(true);
  });

  test("a failed permission list does not resurrect a question a successful read retired", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    // The question read succeeds and says the question is gone; the
    // permission read then fails and must not vouch for it anyway.
    provider.listQuestions = async () => [];
    provider.listPermissions = async () => { throw new Error("provider unreachable"); };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    applyEvent(adapter, "local", {
      id: "q", type: "question.v2.asked",
      data: { id: "que_stale", sessionID: "local", timestamp: 10, questions: [{ question: "Choose", header: "Choice", options: [{ label: "A", description: "A" }], multiple: false, custom: false }] },
    });
    applyEvent(adapter, "local", {
      id: "p", type: "permission.v2.asked",
      data: { id: "perm_live", sessionID: "local", action: "shell", resources: ["ls"], timestamp: 11 },
    });

    const snapshot = await adapter.history("local");
    // The permission survives its failed read; the retired question does not.
    expect(snapshot.items).toEqual([expect.objectContaining({ id: "permission:perm_live", status: "pending" })]);
    expect(adapter.projectionForTests("local").has("question:que_stale")).toBe(false);
  });

  test("the global question read vouches for mirrored child questions both ways", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const childQuestion = {
      requestId: "que_child",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    };
    let pending = [childQuestion];
    provider.listQuestions = async () => pending;
    provider.listPermissions = async () => { throw new Error("provider unreachable"); };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    // Present in the read: the child's question asked while the pump was down
    // surfaces on parent load, owned by the child.
    let snapshot = await adapter.history("parent");
    expect(snapshot.items).toEqual([expect.objectContaining({ id: "question:que_child", conversationId: "child", status: "pending" })]);

    // Absent from a later successful read: answered elsewhere, so the
    // parent's mirrored copy retires even while the permission read fails.
    pending = [];
    snapshot = await adapter.history("parent");
    expect(snapshot.items).toEqual([]);
    expect(adapter.projectionForTests("parent").has("question:que_child")).toBe(false);
  });

  test("a recovered child question answered elsewhere clears live, not just on reload", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    let pending = [{
      requestId: "que_gone",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    provider.listQuestions = async () => pending;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    // Recovered through the parent's snapshot — the child transcript is
    // never opened, so only this bookkeeping can seed the removal path.
    await adapter.history("parent");
    expect(adapter.projectionForTests("parent").has("question:que_gone")).toBe(true);

    // Answered from another client; the reply event was missed, and the next
    // question-tool update on the child is the only live signal.
    pending = [];
    const pump = adapter.startEventPump();
    provider.eventQueue.push({
      id: "t1", type: "session.next.tool.success",
      data: { sessionID: "child", callID: "c1", tool: "question" },
    } as never);
    while (adapter.projectionForTests("parent").has("question:que_gone")) await Bun.sleep(1);
    await adapter.stopEventPump();
    await pump;
  });

  // A subagent's request is announced under its own conversation. Its
  // resolution can reach the adapter only through the parent — an answer given
  // from the parent's transcript, or a parent reconciliation that no longer
  // lists it — and must still resolve the identity that was announced, or the
  // hub keeps a delivery alive for a request nobody is waiting on.
  test("a parent reconciliation that retires a child's question resolves the child's identity", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    let pending = [{
      requestId: "que_gone",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    provider.listQuestions = async () => pending;
    const events: AgentNotificationEvent[] = [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, onNotification: event => events.push(event) });
    const pump = adapter.startEventPump();
    // Discovered by the parent's sweep: the only signal for a question asked
    // while the pump was down, and it names the child.
    provider.eventQueue.push({ id: "t0", type: "session.next.tool.success", data: { sessionID: "parent", callID: "c0", tool: "question" } } as never);
    await waitUntil(() => events.some(event => event.type === "notification"));
    const announced = events.find(event => event.type === "notification");
    expect(announced).toEqual({ type: "notification", notification: expect.objectContaining({
      conversationId: "parent", kind: "question-pending", sourceId: JSON.stringify(["child", "que_gone"]),
    }) });
    // Answered elsewhere with the reply event lost; the parent's next
    // reconciliation carries only the removal.
    pending = [];
    provider.eventQueue.push({ id: "t1", type: "session.next.tool.success", data: { sessionID: "parent", callID: "c1", tool: "question" } } as never);
    await waitUntil(() => events.some(event => event.type === "resolved"));
    await adapter.stopEventPump();
    await pump;
    expect(events.filter(event => event.type === "resolved")).toEqual([
      { type: "resolved", id: (announced as Extract<AgentNotificationEvent, { type: "notification" }>).notification.id, conversationId: "parent" },
    ]);
    await adapter.dispose();
  });

  test("a history read that retires a child's request resolves the child's identity", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    let questions = [{
      requestId: "que_child",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    let permissions = [{ requestId: "perm_child", conversationId: "child", action: "shell", resources: ["ls"] }];
    provider.listQuestions = async () => questions;
    provider.listPermissions = async () => permissions;
    const events: AgentNotificationEvent[] = [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, onNotification: event => events.push(event) });
    const pump = adapter.startEventPump();
    // Announced live: the question through the parent's sweep, the permission on the child's own stream.
    provider.eventQueue.push({ id: "t0", type: "session.next.tool.success", data: { sessionID: "parent", callID: "c0", tool: "question" } } as never);
    provider.eventQueue.push({ type: "permission.v2.asked", data: { id: "perm_child", sessionID: "child", action: "shell", resources: ["ls"], timestamp: Date.now() } } as never);
    await waitUntil(() => events.filter(event => event.type === "notification").length === 2);
    await adapter.stopEventPump();
    await pump;
    const announced = events.flatMap(event => event.type === "notification" ? [event.notification] : []);
    expect(announced.map(notification => notification.sourceId).sort()).toEqual([JSON.stringify(["child", "perm_child"]), JSON.stringify(["child", "que_child"])]);
    // Both answered elsewhere with the reply events lost; opening the
    // transcripts is the next authoritative read.
    questions = []; permissions = [];
    await adapter.history("parent");
    await adapter.history("child");
    expect(events.flatMap(event => event.type === "resolved" ? [event.id] : []).sort()).toEqual(announced.map(notification => notification.id).sort());
    await adapter.dispose();
  });

  test("a request announced while the authoritative read is in flight is neither retired nor resolved", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    let releaseQuestions = () => {}; let releasePermissions = () => {};
    let questionsRead = false; let permissionsRead = false;
    // Each read takes its snapshot (empty) and then stalls; the request that
    // arrives meanwhile is newer than what the read will report.
    provider.listQuestions = async () => { questionsRead = true; await new Promise<void>(resolve => { releaseQuestions = resolve; }); return []; };
    provider.listPermissions = async () => { permissionsRead = true; await new Promise<void>(resolve => { releasePermissions = resolve; }); return []; };
    const events: AgentNotificationEvent[] = [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, onNotification: event => events.push(event) });
    const pump = adapter.startEventPump();
    const load = adapter.history("local");
    await waitUntil(() => questionsRead);
    provider.eventQueue.push({ type: "question.asked", data: { sessionID: "local", id: "que_live", timestamp: Date.now(), questions: [{ question: "Pick", options: [{ label: "A" }] }] } });
    await waitUntil(() => events.filter(event => event.type === "notification").length === 1);
    releaseQuestions();
    await waitUntil(() => permissionsRead);
    provider.eventQueue.push({ type: "permission.v2.asked", data: { id: "perm_live", sessionID: "local", action: "shell", resources: ["ls"], timestamp: Date.now() } } as never);
    await waitUntil(() => events.filter(event => event.type === "notification").length === 2);
    releasePermissions();
    const snapshot = await load;
    await adapter.stopEventPump();
    await pump;
    expect(events.filter(event => event.type === "resolved")).toEqual([]);
    expect(snapshot.items.map(item => item.id).sort()).toEqual(["permission:perm_live", "question:que_live"]);
    expect(adapter.projectionForTests("local").has("question:que_live")).toBe(true);
    expect(adapter.projectionForTests("local").has("permission:perm_live")).toBe(true);
    await adapter.dispose();
  });

  test("a rewrite of the child's timeline keeps the announcement, so a later answer from the parent still resolves it", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.listQuestions = async () => [{
      requestId: "que_child",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    const events: AgentNotificationEvent[] = [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, onNotification: event => events.push(event) });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ id: "t0", type: "session.next.tool.success", data: { sessionID: "parent", callID: "c0", tool: "question" } } as never);
    await waitUntil(() => events.some(event => event.type === "notification"));
    await adapter.stopEventPump();
    await pump;
    const announced = events.find(event => event.type === "notification");
    // An undo/redo/revert/restore replaces the child's timeline wholesale.
    adapter.projectionForTests("child").replace([]);
    await adapter.respondQuestion("parent", "que_child", "c1", { kind: "answered", answers: [["A"]] });
    expect(events.filter(event => event.type === "resolved")).toEqual([
      { type: "resolved", id: (announced as Extract<AgentNotificationEvent, { type: "notification" }>).notification.id, conversationId: "parent" },
    ]);
    await adapter.dispose();
  });

  test("deleting the parent settles a child's request announced under it", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.listQuestions = async () => [{
      requestId: "que_child",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    const events: AgentNotificationEvent[] = [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, onNotification: event => events.push(event) });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ id: "t0", type: "session.next.tool.success", data: { sessionID: "parent", callID: "c0", tool: "question" } } as never);
    await waitUntil(() => events.some(event => event.type === "notification"));
    const announced = events.find(event => event.type === "notification") as Extract<AgentNotificationEvent, { type: "notification" }>;
    expect(announced.notification).toEqual(expect.objectContaining({ conversationId: "parent", sourceId: JSON.stringify(["child", "que_child"]) }));
    // The parent goes away; no event for the child is guaranteed to follow.
    provider.eventQueue.push({ type: "session.deleted", data: { info: fixtureSession("parent") } });
    await waitUntil(() => events.some(event => event.type === "resolved"));
    await adapter.stopEventPump();
    await pump;
    expect(events.filter(event => event.type === "resolved")).toEqual([{ type: "resolved", id: announced.notification.id, conversationId: "parent" }]);
    await adapter.dispose();
  });

  test("answering a child's question or permission from the parent resolves the child's identity", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    // The parent's projection is seeded from these when the answer arrives;
    // the child transcript is never opened.
    provider.listQuestions = async () => [{
      requestId: "que_child",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    provider.listPermissions = async () => [{ requestId: "perm_child", conversationId: "child", action: "shell", resources: ["ls"] }];
    const events: AgentNotificationEvent[] = [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, onNotification: event => events.push(event) });
    const pump = adapter.startEventPump();
    const timestamp = Date.now();
    provider.eventQueue.push({ type: "question.asked", data: { sessionID: "child", id: "que_child", timestamp, questions: [{ question: "Pick", options: [{ label: "A" }] }] } });
    provider.eventQueue.push({ type: "permission.v2.asked", data: { id: "perm_child", sessionID: "child", action: "shell", resources: ["ls"], timestamp } } as never);
    await waitUntil(() => events.filter(event => event.type === "notification").length === 2);
    const announced = events.flatMap(event => event.type === "notification" ? [event.notification] : []);
    expect(announced.map(notification => [notification.conversationId, notification.sourceId]).sort()).toEqual([
      ["parent", JSON.stringify(["child", "perm_child"])], ["parent", JSON.stringify(["child", "que_child"])],
    ]);
    await adapter.respondQuestion("parent", "que_child", "c1", { kind: "answered", answers: [["A"]] });
    await adapter.respondPermission("parent", "perm_child", "c2", "approved-once");
    await adapter.stopEventPump();
    await pump;
    expect(events.flatMap(event => event.type === "resolved" ? [event.id] : []).sort()).toEqual(announced.map(notification => notification.id).sort());
    await adapter.dispose();
  });

  // A subagent's model and cost live in its own session, which the parent's
  // client never sees. The adapter is the only place both are in scope, so it
  // sums the child's messages and materializes the total onto the row that
  // launched it.
  test("a subagent's usage aggregates across its messages and lands on the parent's row", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Review renderer", subagent_type: "explore" }, metadata: { sessionId: "child" },
      } }],
    }] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    expect(row()).toEqual(expect.objectContaining({ id: "tool:prt_task", childConversationId: "child" }));
    expect(row()).not.toHaveProperty("usage");

    const pump = adapter.startEventPump();
    // The child's own stream: a text part first (usage decorates the part it
    // belongs to), then the message's tokens.
    const part = (id: string) => ({
      id: `e-part-${id}`, type: "message.part.updated",
      data: { part: { id: `prt_${id}`, messageID: id, sessionID: "child", type: "text", text: "findings" } },
    });
    // The price restates with the tokens, and follows the same rule: the
    // message's latest figure, counted once.
    const message = (id: string, input: number, output: number, cost: number) => ({
      id: `e-${id}-${input}`, type: "message.updated",
      data: { info: { id, sessionID: "child", role: "assistant", modelID: "claude-sonnet-4-5", time: { created: 2 }, tokens: { input, output, cache: { read: 100, write: 0 } }, cost } },
    });
    // Two messages, and one of them restated: `message.updated` reports a
    // message's growing tokens rather than a delta, so the restatement must
    // replace that message's figure and not add to it.
    provider.eventQueue.push(part("msg_a") as never);
    provider.eventQueue.push(message("msg_a", 1_000, 10, 0.5) as never);
    provider.eventQueue.push(message("msg_a", 1_200, 20, 0.75) as never);
    provider.eventQueue.push(part("msg_b") as never);
    provider.eventQueue.push(message("msg_b", 800, 5, 0.25) as never);
    while (sumInput(row()) !== 2_000) await Bun.sleep(1);
    expect(row()).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 2_000, output: 25, cacheRead: 200, cacheWrite: 0, costUsd: 1 },
      workerSession: { model: "claude-sonnet-4-5", effort: null, costUsd: null }, // message totals are not a session authority
    }));

    // A message that emits a second text part reports the SAME cumulative
    // tokens again, against the new part. Keyed by part, that message's spend
    // would be banked twice; keyed by message, the restatement replaces it.
    provider.eventQueue.push({
      id: "e-part-msg_b-2", type: "message.part.updated",
      data: { part: { id: "prt_msg_b_2", messageID: "msg_b", sessionID: "child", type: "text", text: "and more" } },
    } as never);
    provider.eventQueue.push(message("msg_b", 900, 7, 0.375) as never);
    while (sumInput(row()) === 2_000) await Bun.sleep(1);
    expect(sumInput(row())).toBe(2_100);

    // Reopening the parent reapplies the tally rather than losing it: the
    // store has no memory of an attribution that only ever arrived live, so a
    // refresh would otherwise show costs that simply vanished.
    const reopened = await adapter.history("parent");
    expect(reopened.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 2_100, output: 27, cacheRead: 200, cacheWrite: 0, costUsd: 1.125 },
    }));

    // The tool part's own later update knows nothing about attribution; it
    // must not wipe what the child reported.
    applyEvent(adapter, "parent", {
      id: "e-done", type: "message.part.updated",
      data: { part: { id: "prt_task", messageID: "m1", sessionID: "parent", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer", subagent_type: "explore" }, metadata: { sessionId: "child" }, output: "done",
      } } },
    } as never);
    expect(row()).toEqual(expect.objectContaining({ status: "completed", model: "claude-sonnet-4-5", usage: { input: 2_100, output: 27, cacheRead: 200, cacheWrite: 0, costUsd: 1.125 } }));

    await adapter.stopEventPump();
    await pump;
  });

  test("a nested subagent is listed beneath the row that launched its branch, from the store and live", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, { ...fixtureSession("grandchild"), parentId: "child" }];
    const launcher = (id: string, target: string) => ({
      id, type: "assistant", time: { created: 1 },
      content: [{ id: `prt_${id}`, type: "tool", tool: "task", callID: id, state: { status: "completed", input: { description: `Run ${target}`, subagent_type: "explore" }, metadata: { sessionId: target }, output: "done" } }],
    });
    const priced = (id: string, cost: number) => ({ id, type: "assistant", modelID: "gpt-5.6-sol", providerID: "openai", time: { created: 2 }, tokens: { input: 100, output: 10 }, cost });
    provider.pages.set("first", { items: [launcher("launch_child", "child")] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId === "child") return { items: [launcher("launch_grandchild", "grandchild"), priced("child_msg", 0.5)] as never[] };
      if (sessionId === "grandchild") return { items: [priced("grandchild_msg", 0.25)] as never[] };
      return listMessages(sessionId, options);
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });

    // From the store: the child's row states the child's OWN spend, and the
    // subagent it launched is a line beneath it with its own — nothing is
    // added into the row, so row and line sum to what the branch cost.
    const snapshot = await adapter.history("parent");
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool") as ToolItem | undefined;
    expect(snapshot.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      childConversationId: "child", model: "gpt-5.6-sol", usage: { input: 100, output: 10, costUsd: 0.5 },
      descendants: [{ id: "tool:prt_launch_grandchild", parentId: "tool:prt_launch_child", description: "Run grandchild", subagent: "explore", conversationId: "grandchild", model: "gpt-5.6-sol", usage: { input: 100, output: 10, costUsd: 0.25 } }],
    }));

    // Live: a grandchild message restates its price; its line moves, and the
    // row above it does not.
    const pump = adapter.startEventPump();
    provider.eventQueue.push({
      id: "e-part", type: "message.part.updated",
      data: { part: { id: "prt_g", messageID: "grandchild_msg", sessionID: "grandchild", type: "text", text: "more" } },
    } as never);
    provider.eventQueue.push({
      id: "e-msg", type: "message.updated",
      data: { info: { id: "grandchild_msg", sessionID: "grandchild", role: "assistant", modelID: "gpt-5.6-sol", time: { created: 2 }, tokens: { input: 300, output: 30 }, cost: 0.5 } },
    } as never);
    await waitUntil(() => row()?.descendants?.[0]?.usage?.costUsd === 0.5);
    expect(row()).toEqual(expect.objectContaining({
      usage: { input: 100, output: 10, costUsd: 0.5 },
      descendants: [expect.objectContaining({ conversationId: "grandchild", usage: { input: 300, output: 30, costUsd: 0.5 } })],
    }));
    await adapter.stopEventPump();
    await pump;
  });

  test("a grandchild whose store read failed is read again on the next open", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, { ...fixtureSession("grandchild"), parentId: "child" }];
    const launcher = (id: string, target: string) => ({
      id, type: "assistant", time: { created: 1 },
      content: [{ id: `prt_${id}`, type: "tool", tool: "task", callID: id, state: { status: "completed", input: { description: `Run ${target}`, subagent_type: "explore" }, metadata: { sessionId: target }, output: "done" } }],
    });
    const priced = (id: string, cost: number) => ({ id, type: "assistant", modelID: "gpt-5.6-sol", providerID: "openai", time: { created: 2 }, tokens: { input: 100, output: 10 }, cost });
    provider.pages.set("first", { items: [launcher("launch_child", "child")] });
    let grandchildReads = 0;
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId === "child") return { items: [launcher("launch_grandchild", "grandchild"), priced("child_msg", 0.5)] as never[] };
      if (sessionId === "grandchild") {
        grandchildReads += 1;
        if (grandchildReads === 1) throw new Error("transient");
        return { items: [priced("grandchild_msg", 0.25)] as never[] };
      }
      return listMessages(sessionId, options);
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const row = (snapshot: { items: ConversationItem[] }) => snapshot.items.find(item => item.type === "tool");
    // First open: the child's own spend is banked; the grandchild is listed,
    // since the child's transcript names it, but with no figure — its spend is
    // not yet known — and the tally is not marked squared.
    const first = row(await adapter.history("parent")) as ToolItem;
    expect(first.usage).toEqual({ input: 100, output: 10, costUsd: 0.5 });
    expect(first.descendants).toEqual([{ id: "tool:prt_launch_grandchild", parentId: "tool:prt_launch_child", description: "Run grandchild", subagent: "explore", conversationId: "grandchild" }]);
    // Next open reads the grandchild again and the nest is whole.
    expect(row(await adapter.history("parent"))).toEqual(expect.objectContaining({
      usage: { input: 100, output: 10, costUsd: 0.5 },
      descendants: [expect.objectContaining({ conversationId: "grandchild", usage: { input: 100, output: 10, costUsd: 0.25 } })],
    }));
    expect(grandchildReads).toBe(2);
    // Squared now: a third open reads nothing more.
    await adapter.history("parent");
    expect(grandchildReads).toBe(2);
  });

  test("a grandchild already being read for its own transcript is awaited by the top-level open", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, { ...fixtureSession("grandchild"), parentId: "child" }];
    const launcher = (id: string, target: string) => ({
      id, type: "assistant", time: { created: 1 },
      content: [{ id: `prt_${id}`, type: "tool", tool: "task", callID: id, state: { status: "completed", input: { description: `Run ${target}`, subagent_type: "explore" }, metadata: { sessionId: target }, output: "done" } }],
    });
    const priced = (id: string, cost: number) => ({ id, type: "assistant", modelID: "gpt-5.6-sol", providerID: "openai", time: { created: 2 }, tokens: { input: 100, output: 10 }, cost });
    provider.pages.set("first", { items: [launcher("launch_child", "child")] });
    let releaseGrandchild = () => {};
    const gate = new Promise<void>(resolve => { releaseGrandchild = resolve; });
    let grandchildReads = 0;
    let childReads = 0;
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId === "child") {
        childReads += 1;
        return { items: [launcher("launch_grandchild", "grandchild"), priced("child_msg", 0.5)] as never[] };
      }
      if (sessionId === "grandchild") {
        grandchildReads += 1;
        await gate;
        return { items: [priced("grandchild_msg", 0.25)] as never[] };
      }
      return listMessages(sessionId, options);
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    // The child's transcript is opened first and is mid-read of its
    // grandchild when the top-level conversation opens.
    const childOpen = adapter.history("child");
    while (grandchildReads === 0) await Bun.sleep(1);
    const parentOpen = adapter.history("parent");
    // The top-level open has read its way down to the child's transcript (the
    // second read of it) before the grandchild is released; waiting on that,
    // rather than on a fixed delay, keeps a loaded machine from releasing first.
    while (childReads < 2) await Bun.sleep(1);
    await Bun.sleep(5);
    releaseGrandchild();
    await childOpen;
    const snapshot = await parentOpen;
    expect(snapshot.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      usage: { input: 100, output: 10, costUsd: 0.5 },
      descendants: [expect.objectContaining({ conversationId: "grandchild", usage: { input: 100, output: 10, costUsd: 0.25 } })],
    }));
    // One read served both; the nest is squared, so a reopen reads nothing more.
    expect(grandchildReads).toBe(1);
    await adapter.history("parent");
    expect(grandchildReads).toBe(1);
  });

  // A subagent handed a further task (OpenCode's `task_id`) is ONE session and
  // TWO rows. These fixtures are that shape: a prompt per task, a row per task.
  const taskRow = (part: string, created: number, description: string, target = "child", resumed = false, gave?: string) => ({
    id: `launch_${part}`, type: "assistant", time: { created },
    content: [{ id: part, type: "tool", tool: "task", callID: part, state: {
      status: "completed", input: { description, subagent_type: "general", ...(gave === undefined ? {} : { prompt: gave }), ...(resumed ? { task_id: target } : {}) }, metadata: { sessionId: target }, output: "done",
    } }],
  });
  // Classic-store records, the shape a compacting subagent's session has: a
  // user message per task, plus the two OpenCode adds when the subagent
  // summarises itself — a compaction request and a synthetic "continue".
  const asked = (id: string, created: number, text: string) => ({ info: { id, role: "user", time: { created } }, parts: [{ type: "text", text }] });
  const compactionRequest = (id: string, created: number) => ({ info: { id, role: "user", time: { created } }, parts: [{ type: "compaction" }] });
  const continued = (id: string, created: number) => ({ info: { id, role: "user", time: { created } }, parts: [{ type: "text", text: "Continue if you have next steps, or stop and ask for clarification.", synthetic: true }] });
  const answered = (id: string, created: number, promptId: string, input: number, cost: number) => ({ info: { id, role: "assistant", parentID: promptId, modelID: "gpt-5.6-sol", providerID: "openai", time: { created }, tokens: { input, output: 0 }, cost }, parts: [] });
  const prompt = (id: string, created: number) => ({ id, type: "user", time: { created }, text: "do it" });
  const reply = (id: string, created: number, input: number, cost: number) => ({ id, type: "assistant", modelID: "gpt-5.6-sol", providerID: "openai", time: { created }, tokens: { input, output: input / 100 }, cost });
  const rowsOf = (items: ConversationItem[]) => items.filter((item): item is ToolItem => item.type === "tool").sort((left, right) => left.createdAt - right.createdAt);

  test("a subagent given a second task is billed once: each row states its own task, live and from the store", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [taskRow("prt_t1", 1, "First task")] });
    let childStore: unknown[] = [];
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => (sessionId === "child" ? { items: childStore as never[] } : listMessages(sessionId, options));
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const rows = () => rowsOf(adapter.projectionForTests("parent").items());
    const live = (id: string, promptId: string, input: number, cost: number) => ({
      id: `e-${id}-${input}`, type: "message.updated",
      data: { info: { id, sessionID: "child", role: "assistant", parentID: promptId, modelID: "gpt-5.6-sol", time: { created: 3 }, tokens: { input, output: input / 100 }, cost } },
    });
    const pump = adapter.startEventPump();
    provider.eventQueue.push(live("m1", "p1", 1_000, 0.5) as never);
    await waitUntil(() => rows()[0]?.usage?.input === 1_000);

    // The main agent hands the SAME subagent a further task: a second row for
    // the same child session, then that task's reply.
    provider.eventQueue.push({
      id: "e-row-2", type: "message.part.updated",
      data: { part: { id: "prt_t2", messageID: "launch_prt_t2", sessionID: "parent", type: "tool", tool: "task", callID: "prt_t2", state: {
        status: "running", input: { description: "Second task", subagent_type: "general", task_id: "child" }, metadata: { sessionId: "child" },
      } } },
    } as never);
    provider.eventQueue.push(live("m2", "p2", 400, 0.2) as never);
    await waitUntil(() => rows()[1]?.usage?.input === 400);
    // The second row states the second task alone, and the first is untouched:
    // keyed by session, the second row opened at the first one's total.
    expect(rows().map(row => row.usage)).toEqual([{ input: 1_000, output: 10, costUsd: 0.5 }, { input: 400, output: 4, costUsd: 0.2 }]);
    // The second task's figure restates as it streams; only its row moves.
    provider.eventQueue.push(live("m2", "p2", 600, 0.3) as never);
    await waitUntil(() => rows()[1]?.usage?.input === 600);
    expect(rows().map(row => row.usage?.costUsd)).toEqual([0.5, 0.3]);
    expect(rows().map(row => row.workerSession?.costUsd)).toEqual([null, null]); // no authoritative session aggregate
    await adapter.stopEventPump();
    await pump;

    // From the store, in a process that saw none of it live. The v2 records
    // name no prompt: each reply answers the newest prompt before it.
    provider.pages.set("first", { items: [taskRow("prt_t1", 1, "First task"), taskRow("prt_t2", 5, "Second task", "child", true)] });
    childStore = [prompt("p1", 2), reply("m1", 3, 1_000, 0.5), prompt("p2", 6), reply("m2", 7, 600, 0.3)];
    const reopened = rowsOf((await new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g2" }).history("parent")).items);
    expect(reopened.map(row => row.usage)).toEqual([{ input: 1_000, output: 10, costUsd: 0.5 }, { input: 600, output: 6, costUsd: 0.3 }]);
    // Together the rows are what the session spent — no more.
    expect(reopened.reduce((sum, row) => sum + (row.usage?.costUsd ?? 0), 0)).toBeCloseTo(0.8);
    expect(reopened.map(row => row.workerSession)).toEqual([
      { model: "gpt-5.6-sol", effort: null, costUsd: null },
      { model: "gpt-5.6-sol", effort: null, costUsd: null },
    ]);
  });

  test("existing parent refresh ages session accounting; a child inspection refreshes it without a second child read", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [taskRow("launch", 1, "Review")] });
    let childStore = [reply("m1", 2, 100, 0)];
    let sessionCostUsd: number | undefined = 0;
    let reads = 0;
    const readMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (id, options) => id === "child" ? (reads++, { items: childStore as never[] }) : readMessages(id, options);
    const listMessages = provider.listMessages.bind(provider);
    provider.listMessages = async (id, options) => ({ ...await listMessages(id, options), ...(id === "child" ? { sessionCostUsd } : {}) });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const cost = async () => rowsOf((await adapter.history("parent")).items)[0]?.workerSession?.costUsd;
    expect(await cost()).toBe(0);
    expect(reads).toBe(1);
    childStore = [...childStore, reply("m2", 3, 200, 0.5)];
    sessionCostUsd = 0.5;
    expect(await cost()).toBe(0);
    expect(reads).toBe(1); // no all-history polling on each repaint/reselection
    await adapter.history("child");
    expect(await cost()).toBe(0.5);
    expect(reads).toBe(2); // the inspection's own existing read was reused
    childStore = [...childStore, reply("m3", 4, 300, 0.25)];
    sessionCostUsd = 0.75;
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 31_000);
    try { expect(await cost()).toBe(0.75); } finally { clock.mockRestore(); }
    expect(reads).toBe(3);
    sessionCostUsd = undefined;
    await adapter.history("child");
    expect(await cost()).toBeNull(); // missing aggregate never falls back to a partial transcript sum
    // A different parent never inherits a cached child's report.
    provider.sessions.push(fixtureSession("other"));
    provider.pages.set("first", { items: [] });
    expect((await adapter.history("other")).items).toEqual([]);
    await adapter.dispose();
  });

  test("native session snapshots replace rather than sum, include hidden compaction/reverted costs and stay child-scoped", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [taskRow("a", 1, "First"), taskRow("b", 2, "Second", "child", true)] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const rows = () => rowsOf(adapter.projectionForTests("parent").items());
    const pump = adapter.startEventPump();
    const report = (conversationId: string, cost: number) => provider.eventQueue.push({ normalized: { conversationId, updates: [], eventType: "session.usage.updated", outcome: "handled", sessionCostUsd: cost } } as never);
    report("parent", 999); // parent's receipt is never the child's cost
    report("child", 0);
    await waitUntil(() => rows().every(row => row.workerSession?.costUsd === 0));
    report("child", 0.3);
    report("child", 0.8); // includes cost not recoverable from visible message history
    report("child", 0.8); // replay is replacement, not +0.8
    report("child", 0.3); // out-of-order older cumulative snapshot
    await waitUntil(() => rows().every(row => row.workerSession?.costUsd === 0.8));
    await adapter.stopEventPump();
    await pump;
    expect(rows().map(row => row.workerSession?.costUsd)).toEqual([0.8, 0.8]);
    expect(rows().map(row => row.usage)).toEqual([undefined, undefined]); // display snapshots never enter task receipts
    await adapter.dispose();
  });

  for (const mode of ["periodic refresh", "inspection"] as const) test(`a removal racing ${mode} cannot resurrect child model, effort or tokens`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [taskRow("a", 1, "Review")] });
    const snapshot: ProviderHistoryPage = { items: [], accounting: [
      { messageId: "m1", model: "Old", effort: "high", createdAt: 1, usage: { input: 100 } },
      { messageId: "m2", model: "Removed", effort: "medium", createdAt: 2, usage: { input: 200 } },
    ], sessionCostUsd: 9 };
    const list = provider.listMessages.bind(provider);
    let hold = false;
    let release: ((page: ProviderHistoryPage) => void) | undefined;
    provider.listMessages = async (id, options) => id !== "child" ? list(id, options) : hold
      ? new Promise<ProviderHistoryPage>(resolve => { release = resolve; }) : structuredClone(snapshot);
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const row = () => rowsOf(adapter.projectionForTests("parent").items())[0];
    expect(row()?.workerSession).toEqual({ model: "Removed", effort: "medium", costUsd: 9 });
    const pump = adapter.startEventPump();
    const now = Date.now();
    const clock = mode === "periodic refresh" ? spyOn(Date, "now").mockReturnValue(now + 31_000) : undefined;
    try {
      hold = true;
      const pending = adapter.history(mode === "inspection" ? "child" : "parent");
      await waitUntil(() => Boolean(release));
      provider.eventQueue.push({ type: "message.removed", properties: { sessionID: "child", messageID: "m2" } } as never);
      await waitUntil(() => row()?.workerSession?.model === "Old");
      expect(row()?.workerSession).toEqual({ model: "Old", effort: "high", costUsd: 9 });
      expect(row()?.usage?.input).toBe(100);
      hold = false;
      release!(structuredClone(snapshot)); // old provider read still contains removed m2
      await pending;
      const refreshed = rowsOf((await adapter.history("parent")).items)[0];
      expect(refreshed?.workerSession).toEqual({ model: "Old", effort: "high", costUsd: 9 });
      expect(refreshed?.usage?.input).toBe(100);
      // A later actual event may legitimately recreate this provider message id.
      provider.eventQueue.push({ normalized: { conversationId: "child", eventType: "message.updated", outcome: "handled", updates: [],
        assistantModel: { messageId: "m2", model: "Restored", effort: "low", createdAt: 3 },
        assistantUsage: { messageId: "m2", usage: { input: 50 } }, sessionCostUsd: 9,
      } } as never);
      await waitUntil(() => row()?.workerSession?.model === "Restored");
      expect(row()?.workerSession).toEqual({ model: "Restored", effort: "low", costUsd: 9 });
      expect(row()?.usage?.input).toBe(150);
    } finally {
      clock?.mockRestore();
      await adapter.stopEventPump();
      await pump;
      await adapter.dispose();
    }
  });

  for (const mode of ["periodic refresh", "inspection"] as const) test(`bounded removal fences reject older ${mode}, allow future source recovery and clear on conversation eviction`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, fixtureSession("other")];
    provider.pages.set("first", { items: [taskRow("a", 1, "Review")] });
    let source: ProviderHistoryPage = { items: [], accounting: [
      { messageId: "m1", model: "Old", effort: "high", createdAt: 1, usage: { input: 100 } },
      { messageId: "m2", model: "Removed", effort: "medium", createdAt: 2, usage: { input: 200 } },
    ], sessionCostUsd: 9 };
    const list = provider.listMessages.bind(provider);
    let hold = false;
    let release: ((page: ProviderHistoryPage) => void) | undefined;
    provider.listMessages = async (id, options) => id === "other" ? { items: [], accounting: [] } : id !== "child" ? list(id, options) : hold
      ? new Promise<ProviderHistoryPage>(resolve => { release = resolve; }) : structuredClone(source);
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, maxProjections: 2 });
    await adapter.history("parent");
    const key = [...adapter["childModels"].keys()][0]!;
    const row = () => rowsOf(adapter.projectionForTests("parent").items())[0];
    const pump = adapter.startEventPump();
    const now = Date.now();
    const clock = mode === "periodic refresh" ? spyOn(Date, "now").mockReturnValue(now + 31_000) : undefined;
    try {
      hold = true;
      const pending = adapter.history(mode === "inspection" ? "child" : "parent");
      await waitUntil(() => Boolean(release));
      const epoch = adapter["attributionEpochs"].get(key);
      provider.eventQueue.push({ type: "message.removed", properties: { sessionID: "child", messageID: "m2" } } as never);
      for (let i = 0; i < 600; i++) provider.eventQueue.push({ type: "message.removed", properties: { sessionID: "child", messageID: `removed-${i}` } } as never);
      await waitUntil(() => adapter["removedChildAttribution"].get(key)?.has("removed-599") === true);
      expect(adapter["removedChildAttribution"].get(key)?.size).toBeLessThanOrEqual(512);
      expect(adapter["attributionArrivals"].get(key)?.size).toBeLessThanOrEqual(512);
      expect(adapter["attributionEpochs"].get(key)).not.toBe(epoch);
      await waitUntil(() => row()?.workerSession?.model === "Old");
      hold = false;
      release!({ ...structuredClone(source), sessionCostUsd: 99 }); // old read must not restore retired m2 or its cost snapshot
      await pending;
      expect(row()?.workerSession).toEqual({ model: "Old", effort: "high", costUsd: 9 });
      expect(row()?.usage?.input).toBe(100);
      source = { items: [], accounting: [{ messageId: "m2", model: "Fresh", effort: "low", createdAt: 3, usage: { input: 50 } }], sessionCostUsd: 9 };
      expect(rowsOf((await adapter.history("parent")).items)[0]?.workerSession).toEqual({ model: "Fresh", effort: "low", costUsd: 9 });
      await adapter.history("child"); // keep the child most recent so the next selection retires its parent
      expect((await adapter.history("other")).items).toEqual([]); // evicts the original parent, not a cross-conversation tombstone
      expect(adapter["removedChildAttribution"].has(key)).toBe(false);
      expect(adapter["attributionArrivals"].has(key)).toBe(false);
      expect(adapter["attributionEpochs"].has(key)).toBe(false);
      expect(rowsOf((await adapter.history("parent")).items)[0]?.workerSession).toEqual({ model: "Fresh", effort: "low", costUsd: 9 });
    } finally {
      clock?.mockRestore();
      await adapter.stopEventPump();
      await pump;
      await adapter.dispose();
    }
  });

  test("a late child inspection cannot repopulate an evicted parent's session-cost cache", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, fixtureSession("other")];
    provider.readMessages = async id => ({ items: id === "parent" ? [taskRow("a", 1, "Review")] as never[] : [] });
    const list = provider.listMessages.bind(provider);
    let hold = false;
    let release: ((page: ProviderHistoryPage) => void) | undefined;
    let sourceCost = 1;
    provider.listMessages = async (id, options) => {
      const page = await list(id, options);
      if (id !== "child") return page;
      if (hold) return new Promise<ProviderHistoryPage>(resolve => { release = resolve; });
      return { ...page, sessionCostUsd: sourceCost };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", maxProjections: 2 });
    await adapter.history("parent");
    hold = true;
    const inspection = adapter.history("child");
    await waitUntil(() => Boolean(release));
    await adapter.history("other"); // evicts parent while its child's read is pending
    hold = false;
    sourceCost = 2;
    release!({ items: [], accounting: [], sessionCostUsd: 8 });
    await inspection;
    expect(rowsOf((await adapter.history("parent")).items)[0]?.workerSession?.costUsd).toBe(2);
    await adapter.dispose();
  });

  test("a subagent that compacted during its first task bills the compaction to that task, not the next", async () => {
    // A real session's shape and figures: one `general`, two tasks, one
    // compaction partway through the first. Four user messages, two rows:
    // paired by position, the compaction request and the "continue" — and the
    // 258k tokens answering them — were handed to the SECOND task.
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [
      taskRow("prt_t1", 1, "Audit", "child", false, "Read-only audit, do not edit."),
      taskRow("prt_t2", 9, "Re-audit", "child", true, "Re-audit the current files after fixes."),
    ] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => (sessionId === "child" ? { items: [
      asked("p1", 2, "Read-only audit, do not edit."), answered("m1", 3, "p1", 270_923, 0.27),
      compactionRequest("pc", 4), answered("mc", 5, "pc", 38_970, 0.04),
      continued("ps", 6), answered("ms", 7, "ps", 218_840, 0.22),
      asked("p2", 10, "Re-audit the current files after fixes."), answered("m2", 11, "p2", 23_000, 0.02),
    ] as never[] } : listMessages(sessionId, options));
    const rows = rowsOf((await new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" }).history("parent")).items);
    expect(rows.map(row => row.usage?.input)).toEqual([528_733, 23_000]);
    expect(rows.map(row => row.usage?.costUsd)).toEqual([expect.closeTo(0.53, 10), 0.02]);
  });

  // OpenCode 2.x names the launcher `subagent` and the agent `agent`, and
  // delivers a new child's first prompt behind its own preamble — so that
  // prompt never equals the row's. Pairing must still see it as the task's.
  test("a 2.x subagent that compacted during its first task bills the compaction to that task, not the next", async () => {
    const subagentRow = (part: string, created: number, description: string, gave: string, resumed: boolean) => ({
      id: `launch_${part}`, type: "assistant", time: { created },
      content: [{ id: part, type: "tool", tool: "subagent", callID: part, state: {
        status: "completed", input: { agent: "general", description, prompt: gave, ...(resumed ? { sessionID: "child" } : {}) },
        metadata: { sessionID: "child", status: "completed" }, output: '<subagent sessionID="child" state="completed">\ndone\n</subagent>',
      } }],
    });
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [
      subagentRow("prt_t1", 1, "Audit", "Read-only audit, do not edit.", false),
      subagentRow("prt_t2", 9, "Re-audit", "Re-audit the current files after fixes.", true),
    ] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => (sessionId === "child" ? { items: [
      asked("p1", 2, "You are a subagent spawned by another session.\nRead-only audit, do not edit."), answered("m1", 3, "p1", 270_923, 0.27),
      compactionRequest("pc", 4), answered("mc", 5, "pc", 38_970, 0.04),
      continued("ps", 6), answered("ms", 7, "ps", 218_840, 0.22),
      asked("p2", 10, "Re-audit the current files after fixes."), answered("m2", 11, "p2", 23_000, 0.02),
    ] as never[] } : listMessages(sessionId, options));
    const rows = rowsOf((await new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" }).history("parent")).items);
    expect(rows.map(row => row.childConversationId)).toEqual(["child", "child"]);
    expect(rows.map(row => row.usage?.input)).toEqual([528_733, 23_000]);
    expect(rows.map(row => row.usage?.costUsd)).toEqual([expect.closeTo(0.53, 10), 0.02]);
  });

  // Only the prompt that creates the child carries the preamble. A message
  // typed into the child during the first task that happens to end with the
  // next task's prompt is still the first task's.
  test("a 2.x child message that ends with a later task's prompt does not open that task early", async () => {
    const subagentRow = (part: string, created: number, gave: string, resumed: boolean) => ({
      id: `launch_${part}`, type: "assistant", time: { created },
      content: [{ id: part, type: "tool", tool: "subagent", callID: part, state: {
        status: "completed", input: { agent: "general", description: part, prompt: gave, ...(resumed ? { sessionID: "child" } : {}) },
        metadata: { sessionID: "child", status: "completed" }, output: "done",
      } }],
    });
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [subagentRow("prt_t1", 1, "Audit the renderer.", false), subagentRow("prt_t2", 9, "Run tests", true)] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => (sessionId === "child" ? { items: [
      asked("p1", 2, "You are a subagent spawned by another session.\nAudit the renderer."), answered("m1", 3, "p1", 1_000, 0.1),
      asked("pu", 4, "Before you finish:\nRun tests"), answered("mu", 5, "pu", 2_000, 0.2),
      asked("p2", 10, "Run tests"), answered("m2", 11, "p2", 300, 0.03),
    ] as never[] } : listMessages(sessionId, options));
    const rows = rowsOf((await new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" }).history("parent")).items);
    expect(rows.map(row => row.usage?.input)).toEqual([3_000, 300]);
  });

  test("live, a compaction between two tasks stays with the first as the second task's row and prompt arrive", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [taskRow("prt_t1", 1, "Audit", "child", false, "Read-only audit, do not edit.")] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const rows = () => rowsOf(adapter.projectionForTests("parent").items());
    const user = (id: string) => ({ id: `e-u-${id}`, type: "message.updated", data: { info: { id, sessionID: "child", role: "user", time: { created: 2 } } } });
    const typed = (id: string, text: string, synthetic = false) => ({ id: `e-t-${id}`, type: "message.part.updated", data: { part: { id: `prt_${id}`, messageID: id, sessionID: "child", type: "text", text, ...(synthetic ? { synthetic: true } : {}) } } });
    const spent = (id: string, promptId: string, input: number) => ({ id: `e-a-${id}`, type: "message.updated", data: { info: { id, sessionID: "child", role: "assistant", parentID: promptId, modelID: "gpt-5.6-sol", time: { created: 3 }, tokens: { input, output: 0 }, cost: input / 1_000_000 } } });
    const pump = adapter.startEventPump();
    for (const event of [
      user("p1"), typed("p1", "Read-only audit, do not edit."), spent("m1", "p1", 270_923),
      // The subagent summarises itself: a request with no text, then OpenCode's own "continue".
      user("pc"), spent("mc", "pc", 38_970),
      user("ps"), typed("ps", "Continue if you have next steps, or stop and ask for clarification.", true), spent("ms", "ps", 218_840),
    ]) provider.eventQueue.push(event as never);
    await waitUntil(() => rows()[0]?.usage?.input === 528_733);

    // The second task: its row in the parent, then its prompt and reply in the child.
    provider.eventQueue.push({
      id: "e-row-2", type: "message.part.updated",
      data: { part: { id: "prt_t2", messageID: "launch_prt_t2", sessionID: "parent", type: "tool", tool: "task", callID: "prt_t2", state: {
        status: "running", input: { description: "Re-audit", subagent_type: "general", prompt: "Re-audit the current files after fixes.", task_id: "child" }, metadata: { sessionId: "child" },
      } } },
    } as never);
    for (const event of [user("p2"), typed("p2", "Re-audit the current files after fixes."), spent("m2", "p2", 23_000)]) provider.eventQueue.push(event as never);
    await waitUntil(() => rows()[1]?.usage?.input === 23_000);
    expect(rows().map(row => row.usage?.input)).toEqual([528_733, 23_000]);
    await adapter.stopEventPump();
    await pump;
  });

  test("a nested subagent launched after a compaction still hangs off the task it was launched during", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, { ...fixtureSession("grandchild"), parentId: "child" }];
    provider.pages.set("first", { items: [taskRow("prt_t1", 1, "Audit", "child", false, "Audit."), taskRow("prt_t2", 9, "Re-audit", "child", true, "Re-audit.")] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      // Still the FIRST task when the helper is launched: two of the child's
      // user messages so far are OpenCode's own, not tasks.
      if (sessionId === "child") return { items: [asked("p1", 2, "Audit."), compactionRequest("pc", 3), continued("ps", 4), taskRow("prt_g", 5, "Help", "grandchild"), answered("m1", 6, "ps", 1_000, 0.5), asked("p2", 10, "Re-audit."), answered("m2", 11, "p2", 400, 0.2)] as never[] };
      if (sessionId === "grandchild") return { items: [prompt("pg", 5), reply("mg", 6, 100, 0.1)] as never[] };
      return listMessages(sessionId, options);
    };
    const rows = rowsOf((await new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" }).history("parent")).items);
    expect(rows[0]?.descendants).toEqual([expect.objectContaining({ id: "tool:prt_g", parentId: "tool:prt_t1", usage: { input: 100, output: 1, costUsd: 0.1 } })]);
    expect(rows[1]).not.toHaveProperty("descendants");
    expect(rows.map(row => row.usage?.costUsd)).toEqual([0.5, 0.2]);
  });

  test("when no prompt matches any task's, pairing falls back to position rather than piling everything on one row", async () => {
    // Texts that cannot be compared usefully (a provider that rewrites the
    // prompt it stores) must not make the second task vanish into the first.
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [taskRow("prt_t1", 1, "First", "child", false, "Do the first thing."), taskRow("prt_t2", 5, "Second", "child", true, "Do the second thing.")] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => (sessionId === "child"
      ? { items: [asked("p1", 2, "[rewritten] first"), answered("m1", 3, "p1", 1_000, 0.5), asked("p2", 6, "[rewritten] second"), answered("m2", 7, "p2", 400, 0.2)] as never[] }
      : listMessages(sessionId, options));
    const rows = rowsOf((await new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" }).history("parent")).items);
    expect(rows.map(row => row.usage?.costUsd)).toEqual([0.5, 0.2]);
  });

  test("after a restart mid-task, a reply that names no prompt answers the newest prompt the store knows", async () => {
    // The workspace comes up while a reused subagent is on its SECOND task:
    // the store already holds that task's prompt, the event stream's own
    // memory of prompts starts empty, and the live record names no `parentID`.
    // Unpaired, the second task's spend would fall to the first task's row.
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [taskRow("prt_t1", 1, "First task"), taskRow("prt_t2", 5, "Second task", "child", true)] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => (sessionId === "child"
      ? { items: [prompt("p1", 2), reply("m1", 3, 1_000, 0.5), prompt("p2", 6)] as never[] }
      : listMessages(sessionId, options));
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const rows = () => rowsOf(adapter.projectionForTests("parent").items());
    await adapter.history("parent");
    expect(rows().map(row => row.usage?.costUsd)).toEqual([0.5, undefined]);

    const unnamed = (id: string, input: number, cost: number) => ({
      id: `e-${id}-${input}`, type: "message.updated",
      data: { info: { id, sessionID: "child", role: "assistant", modelID: "gpt-5.6-sol", time: { created: 7 }, tokens: { input, output: input / 100 }, cost } },
    });
    const pump = adapter.startEventPump();
    provider.eventQueue.push(unnamed("m2", 400, 0.2) as never);
    await waitUntil(() => rows()[1]?.usage?.input === 400);
    expect(rows().map(row => row.usage)).toEqual([{ input: 1_000, output: 10, costUsd: 0.5 }, { input: 400, output: 4, costUsd: 0.2 }]);
    // A restatement of the FIRST task's message, equally unnamed, stays where
    // the store paired it rather than moving to the task running now.
    provider.eventQueue.push(unnamed("m1", 1_200, 0.6) as never);
    await waitUntil(() => rows()[0]?.usage?.input === 1_200);
    expect(rows().map(row => row.usage?.costUsd)).toEqual([0.6, 0.2]);
    await adapter.stopEventPump();
    await pump;
  });

  test("an older page's row keeps its place among all the rows that launched the child", async () => {
    // Paged history returns some of a child's rows at a time. Placed among
    // only the rows on its page, the first task's row would be the only row
    // and claim the whole session.
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const all = [taskRow("prt_t1", 1, "First task"), taskRow("prt_t2", 5, "Second task", "child", true)];
    provider.pages.set("first", { items: [all[1]!], configurationItems: all, nextCursor: "older" });
    provider.pages.set("older", { items: [all[0]!], configurationItems: all });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => (sessionId === "child"
      ? { items: [prompt("p1", 2), reply("m1", 3, 1_000, 0.5), prompt("p2", 6), reply("m2", 7, 400, 0.2)] as never[] }
      : listMessages(sessionId, options));
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const first = await adapter.history("parent");
    expect(rowsOf(first.items).map(row => row.usage?.costUsd)).toEqual([0.5, 0.2]);
    expect(first.olderCursor).toBeDefined();
    const older = await adapter.history("parent", { cursor: first.olderCursor });
    expect(rowsOf(older.items).map(row => [row.id, row.usage?.costUsd])).toEqual([["tool:prt_t1", 0.5]]);
  });

  test("subagents nest to any depth as lines, each under what launched it, and a change at the bottom reaches the top", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" },
      { ...fixtureSession("grandchild"), parentId: "child" }, { ...fixtureSession("great"), parentId: "grandchild" }];
    provider.pages.set("first", { items: [taskRow("prt_c", 1, "Audit docs")] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId === "child") return { items: [prompt("pc", 2), taskRow("prt_g", 3, "Find files", "grandchild"), reply("mc", 4, 100, 0.0116)] as never[] };
      if (sessionId === "grandchild") return { items: [prompt("pg", 4), taskRow("prt_gg", 5, "Count lines", "great"), reply("mg", 6, 200, 0.0119)] as never[] };
      if (sessionId === "great") return { items: [prompt("pgg", 6), reply("mgg", 7, 300, 0.0136)] as never[] };
      return listMessages(sessionId, options);
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const row = () => rowsOf(adapter.projectionForTests("parent").items())[0];
    await adapter.history("parent");
    // Three layers below the conversation: the row is the child's own spend,
    // and the two below are lines — the second hanging off the first.
    expect(row()?.usage?.costUsd).toBe(0.0116);
    expect(row()?.descendants).toEqual([
      { id: "tool:prt_g", parentId: "tool:prt_c", description: "Find files", subagent: "general", conversationId: "grandchild", model: "gpt-5.6-sol", usage: { input: 200, output: 2, costUsd: 0.0119 } },
      { id: "tool:prt_gg", parentId: "tool:prt_g", description: "Count lines", subagent: "general", conversationId: "great", model: "gpt-5.6-sol", usage: { input: 300, output: 3, costUsd: 0.0136 } },
    ]);
    // Row and lines are what the whole branch cost, each message once.
    const branch = (row()?.usage?.costUsd ?? 0) + (row()?.descendants ?? []).reduce((sum, line) => sum + (line.usage?.costUsd ?? 0), 0);
    expect(branch).toBeCloseTo(0.0371);

    const pump = adapter.startEventPump();
    provider.eventQueue.push({
      id: "e-deep", type: "message.updated",
      data: { info: { id: "mgg", sessionID: "great", role: "assistant", parentID: "pgg", modelID: "gpt-5.6-sol", time: { created: 7 }, tokens: { input: 900, output: 9 }, cost: 0.04 } },
    } as never);
    await waitUntil(() => row()?.descendants?.[1]?.usage?.costUsd === 0.04);
    expect(row()?.usage?.costUsd).toBe(0.0116);
    expect(row()?.descendants?.[0]?.usage?.costUsd).toBe(0.0119);
    await adapter.stopEventPump();
    await pump;
  });

  test("a nested subagent is listed under the task during which it was launched", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, { ...fixtureSession("grandchild"), parentId: "child" }];
    provider.pages.set("first", { items: [taskRow("prt_t1", 1, "First task"), taskRow("prt_t2", 5, "Second task", "child", true)] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      // The child launched its helper while answering its SECOND task.
      if (sessionId === "child") return { items: [prompt("p1", 2), reply("m1", 3, 1_000, 0.5), prompt("p2", 6), taskRow("prt_g", 7, "Help", "grandchild"), reply("m2", 8, 400, 0.2)] as never[] };
      if (sessionId === "grandchild") return { items: [prompt("pg", 7), reply("mg", 8, 100, 0.1)] as never[] };
      return listMessages(sessionId, options);
    };
    const rows = rowsOf((await new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" }).history("parent")).items);
    expect(rows[0]).not.toHaveProperty("descendants");
    expect(rows[1]?.descendants).toEqual([expect.objectContaining({ id: "tool:prt_g", parentId: "tool:prt_t2", usage: { input: 100, output: 1, costUsd: 0.1 } })]);
  });

  test("a subagent that launches its own subagent live is listed once its row appears", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, { ...fixtureSession("grandchild"), parentId: "child" }];
    provider.pages.set("first", { items: [taskRow("prt_c", 1, "Audit docs")] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const row = () => rowsOf(adapter.projectionForTests("parent").items())[0];
    const pump = adapter.startEventPump();
    const spend = (id: string, sessionID: string, promptId: string, cost: number) => ({
      id: `e-${id}`, type: "message.updated",
      data: { info: { id, sessionID, role: "assistant", parentID: promptId, modelID: "gpt-5.6-sol", time: { created: 3 }, tokens: { input: 100, output: 1 }, cost } },
    });
    provider.eventQueue.push(spend("mc", "child", "pc", 0.5) as never);
    // The child's own timeline gains a launcher row; the conversation above
    // it has no such row, only the line.
    provider.eventQueue.push({
      id: "e-launch", type: "message.part.updated",
      data: { part: { id: "prt_g", messageID: "mc", sessionID: "child", type: "tool", tool: "task", callID: "prt_g", state: {
        status: "running", input: { description: "Find files", subagent_type: "explore" }, metadata: { sessionId: "grandchild" },
      } } },
    } as never);
    provider.eventQueue.push(spend("mg", "grandchild", "pg", 0.25) as never);
    await waitUntil(() => row()?.descendants?.[0]?.usage?.costUsd === 0.25);
    expect(row()?.usage?.costUsd).toBe(0.5);
    expect(row()?.descendants).toEqual([{ id: "tool:prt_g", parentId: "tool:prt_c", description: "Find files", subagent: "explore", conversationId: "grandchild", model: "gpt-5.6-sol", usage: { input: 100, output: 1, costUsd: 0.25 } }]);

    // The nested task's tool part is removed (outside any revert): its line
    // and its cost leave the row above, and — the tally being squared — a
    // reopen must not bring them back from the launcher record.
    provider.eventQueue.push({ id: "e-unlaunch", type: "message.part.removed", properties: { sessionID: "child", messageID: "mc", partID: "prt_g" } } as never);
    await waitUntil(() => row()?.descendants === undefined);
    expect(row()).not.toHaveProperty("descendants");
    expect(row()?.usage?.costUsd).toBe(0.5);
    expect(rowsOf((await adapter.history("parent")).items)[0]).not.toHaveProperty("descendants");
    await adapter.stopEventPump();
    await pump;
  });

  test("a nested launcher removed while its ancestor's stored read is in flight is not banked from that read", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, { ...fixtureSession("grandchild"), parentId: "child" }];
    provider.pages.set("first", { items: [taskRow("prt_c", 1, "Audit docs")] });
    let releaseChild = () => {};
    const gate = new Promise<void>(resolve => { releaseChild = resolve; });
    let childReads = 0;
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId === "child") {
        childReads += 1;
        // The store as it was when the read began: the nested launcher is still in it.
        const stale = { items: [prompt("pc", 2), taskRow("prt_g", 3, "Find files", "grandchild"), reply("mc", 4, 100, 0.5)] as never[] };
        await gate;
        return stale;
      }
      if (sessionId === "grandchild") return { items: [prompt("pg", 4), reply("mg", 5, 100, 0.25)] as never[] };
      return listMessages(sessionId, options);
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    const opening = adapter.history("parent");
    await waitUntil(() => childReads === 1);
    // The removal lands mid-read, when no launcher record exists to edit yet.
    provider.eventQueue.push({ id: "e-unlaunch", type: "message.part.removed", properties: { sessionID: "child", messageID: "mc", partID: "prt_g" } } as never);
    // Release the read only once the pump has handled the removal; a fixed
    // 20 ms sleep lost that race under `bun test --parallel`.
    await liveEventsApplied(adapter, provider);
    releaseChild();
    const opened = rowsOf((await opening).items)[0];
    expect(opened?.usage?.costUsd).toBe(0.5);
    expect(opened).not.toHaveProperty("descendants");
    // Squared without it: a reopen reads nothing more and lists nothing more.
    expect(rowsOf((await adapter.history("parent")).items)[0]).not.toHaveProperty("descendants");
    expect(childReads).toBe(1);
    await adapter.stopEventPump();
    await pump;
  });

  test("a figure seen live before a read does not overwrite what the store says now", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "launch", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: { status: "completed", input: { description: "Review", subagent_type: "explore" }, metadata: { sessionId: "child" }, output: "done" } }],
    }] });
    // The store already holds the child's final figure.
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId === "child") return { items: [{ id: "child_msg", type: "assistant", modelID: "gpt-5.6-sol", providerID: "openai", time: { created: 2 }, tokens: { input: 300, output: 30 }, cost: 0.75 }] as never[] };
      return listMessages(sessionId, options);
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    // A partial figure for that message was seen live earlier — before the
    // stream dropped and the child finished — and banked with no parent open.
    provider.eventQueue.push({
      id: "e-part", type: "message.part.updated",
      data: { part: { id: "prt_c", messageID: "child_msg", sessionID: "child", type: "text", text: "partial" } },
    } as never);
    provider.eventQueue.push({
      id: "e-msg", type: "message.updated",
      data: { info: { id: "child_msg", sessionID: "child", role: "assistant", modelID: "gpt-5.6-sol", time: { created: 2 }, tokens: { input: 100, output: 10 }, cost: 0.25 } },
    } as never);
    await liveEventsApplied(adapter, provider);
    // Opening the parent reads the store: its final figure stands, the
    // older live one does not overwrite it — and the tally is squared.
    const snapshot = await adapter.history("parent");
    expect(snapshot.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({ usage: { input: 300, output: 30, costUsd: 0.75 } }));
    await adapter.stopEventPump();
    await pump;
  });

  test("removing a grandchild's message takes its spend off its line", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }, { ...fixtureSession("grandchild"), parentId: "child" }];
    const launcher = (id: string, target: string) => ({
      id, type: "assistant", time: { created: 1 },
      content: [{ id: `prt_${id}`, type: "tool", tool: "task", callID: id, state: { status: "completed", input: { description: `Run ${target}`, subagent_type: "explore" }, metadata: { sessionId: target }, output: "done" } }],
    });
    provider.pages.set("first", { items: [launcher("launch_child", "child")] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId === "child") return { items: [launcher("launch_grandchild", "grandchild")] as never[] };
      if (sessionId === "grandchild") return { items: [{ id: "grandchild_msg", type: "assistant", modelID: "gpt-5.6-sol", providerID: "openai", time: { created: 2 }, tokens: { input: 100, output: 10 }, cost: 0.25 }] as never[] };
      return listMessages(sessionId, options);
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool") as ToolItem | undefined;
    await adapter.history("parent");
    // The child spent nothing itself: the row asserts no figure, the line does.
    expect(row()).not.toHaveProperty("usage");
    expect(row()?.descendants?.[0]?.usage).toEqual({ input: 100, output: 10, costUsd: 0.25 });
    // The grandchild's only priced message is removed (a revert below): its
    // line stays — the subagent did run — but states no spend any more.
    const pump = adapter.startEventPump();
    provider.eventQueue.push({ id: "remove", type: "message.removed", properties: { sessionID: "grandchild", messageID: "grandchild_msg" } } as never);
    await waitUntil(() => row()?.descendants?.[0]?.usage === undefined);
    // Its model went with it: the message that named it is gone.
    expect(row()?.descendants).toEqual([{ id: "tool:prt_launch_grandchild", parentId: "tool:prt_launch_child", description: "Run grandchild", subagent: "explore", conversationId: "grandchild" }]);
    await adapter.stopEventPump();
    await pump;
  });

  test("a revert inside a subagent takes the reverted spend off the parent's row", async () => {
    const provider = new FakeProvider();
    provider.agent.capabilities.push("reversible-history");
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const historyState = { staged: true, canUndo: false, canRedo: true, revertedMessages: [] };
    provider.getReversibleHistoryState = async () => historyState;
    provider.undo = async () => ({ outcome: "changed", state: historyState });
    provider.redo = async () => ({ outcome: "changed", state: historyState });
    provider.revert = async () => ({ outcome: "changed", state: historyState });
    provider.restore = async () => ({ outcome: "changed", state: historyState });
    const priced = (id: string, cost: number) => ({ id, type: "assistant", modelID: "gpt-5.6-sol", providerID: "openai", time: { created: 2 }, tokens: { input: 100, output: 10 }, cost, content: [{ id: `prt_${id}`, type: "text", text: id }] });
    let childVisible = [priced("child_a", 0.5), priced("child_b", 0.25)];
    provider.pages.set("first", { items: [{
      id: "launch", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: { status: "completed", input: { description: "Review", subagent_type: "explore" }, metadata: { sessionId: "child" }, output: "done" } }],
    }] });
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => (sessionId === "child" ? { items: childVisible as never[] } : listMessages(sessionId, options));
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool") as { usage?: { input?: number; output?: number; costUsd?: number } } | undefined;
    await adapter.history("parent");
    expect(row()?.usage?.costUsd).toBe(0.75);

    // The child's second message is reverted: its store now holds one
    // message, and the lifecycle event is all the parent hears about it.
    const pump = adapter.startEventPump();
    childVisible = [priced("child_a", 0.5)];
    provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "child" } } as never);
    while (row()?.usage?.costUsd !== 0.5) await Bun.sleep(1);
    expect(row()?.usage).toEqual({ input: 100, output: 10, costUsd: 0.5 });
    // Squared against the rewritten store: a reopen reads the same figure.
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).toEqual(expect.objectContaining({ usage: { input: 100, output: 10, costUsd: 0.5 } }));
    await adapter.stopEventPump();
    await pump;
  });

  test("a revert inside a subagent given two tasks withdraws only the reverted task's spend", async () => {
    const provider = new FakeProvider();
    provider.agent.capabilities.push("reversible-history");
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const historyState = { staged: true, canUndo: false, canRedo: true, revertedMessages: [] };
    provider.getReversibleHistoryState = async () => historyState;
    provider.undo = async () => ({ outcome: "changed", state: historyState });
    provider.redo = async () => ({ outcome: "changed", state: historyState });
    provider.revert = async () => ({ outcome: "changed", state: historyState });
    provider.restore = async () => ({ outcome: "changed", state: historyState });
    provider.pages.set("first", { items: [taskRow("prt_t1", 1, "First task"), taskRow("prt_t2", 5, "Second task", "child", true)] });
    let childVisible: unknown[] = [prompt("p1", 2), reply("m1", 3, 1_000, 0.5), prompt("p2", 6), reply("m2", 7, 400, 0.2)];
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => (sessionId === "child" ? { items: childVisible as never[] } : listMessages(sessionId, options));
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const rows = () => rowsOf(adapter.projectionForTests("parent").items());
    await adapter.history("parent");
    expect(rows().map(row => row.usage?.costUsd)).toEqual([0.5, 0.2]);

    // The second task is reverted out of the child's store. Its row stays —
    // the parent still launched it — but states no spend; the first is whole.
    const pump = adapter.startEventPump();
    childVisible = [prompt("p1", 2), reply("m1", 3, 1_000, 0.5)];
    provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "child" } } as never);
    await waitUntil(() => rows()[1]?.usage === undefined);
    expect(rows()[0]?.usage).toEqual({ input: 1_000, output: 10, costUsd: 0.5 });
    expect(rows()[1]).not.toHaveProperty("usage");
    expect(rowsOf((await adapter.history("parent")).items).map(row => row.usage?.costUsd)).toEqual([0.5, undefined]);
    await adapter.stopEventPump();
    await pump;
  });

  test("a reversible-history replacement of the parent keeps its subagents' spend on their rows", async () => {
    const provider = new FakeProvider();
    provider.agent.capabilities.push("reversible-history");
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const historyState = { staged: true, canUndo: false, canRedo: true, revertedMessages: [] };
    provider.getReversibleHistoryState = async () => historyState;
    provider.undo = async () => ({ outcome: "changed", state: historyState });
    provider.redo = async () => ({ outcome: "changed", state: historyState });
    provider.revert = async () => ({ outcome: "changed", state: historyState });
    provider.restore = async () => ({ outcome: "changed", state: historyState });
    const launcher = {
      id: "launch", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: { status: "completed", input: { description: "Review", subagent_type: "explore" }, metadata: { sessionId: "child" }, output: "done" } }],
    };
    let parentVisible = [launcher, { id: "later", type: "user", time: { created: 5 }, text: "discard me" }];
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId === "child") return { items: [{ id: "child_msg", type: "assistant", modelID: "gpt-5.6-sol", providerID: "openai", time: { created: 2 }, tokens: { input: 100, output: 10 }, cost: 0.5 }] as never[] };
      if (sessionId === "parent") return { items: parentVisible as never[] };
      return listMessages(sessionId, options);
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool") as { usage?: { costUsd?: number } } | undefined;
    await adapter.history("parent");
    expect(row()?.usage?.costUsd).toBe(0.5);

    // The parent's own later prompt is reverted: its history is replaced
    // with the provider's raw rows, and the launcher keeps its child's spend.
    const pump = adapter.startEventPump();
    parentVisible = [launcher];
    provider.eventQueue.push({ type: "session.next.revert.staged", data: { sessionID: "parent" } } as never);
    while (adapter.projectionForTests("parent").items().some(item => item.id === "message:later")) await Bun.sleep(1);
    expect(row()?.usage?.costUsd).toBe(0.5);
    await adapter.stopEventPump();
    await pump;
  });

  test("removing a subagent message withdraws its usage now and after reopening", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    const pump = adapter.startEventPump();
    const report = (messageId: string, input: number) => provider.eventQueue.push({
      id: `e-${messageId}`, type: "message.updated",
      properties: { sessionID: "child", info: { id: messageId, sessionID: "child", role: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input } } },
    } as never);

    report("msg_a", 700);
    report("msg_b", 300);
    while (sumInput(row()) !== 1_000) await Bun.sleep(1);
    provider.eventQueue.push({ id: "remove-a", type: "message.removed", properties: { sessionID: "child", messageID: "msg_a" } } as never);
    while (sumInput(row()) !== 300) await Bun.sleep(1);
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).toEqual(expect.objectContaining({ usage: { input: 300 } }));

    provider.eventQueue.push({ id: "remove-b", type: "message.removed", properties: { sessionID: "child", messageID: "msg_b" } } as never);
    while ((row() as { usage?: unknown } | undefined)?.usage !== undefined) await Bun.sleep(1);
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    await adapter.stopEventPump();
    await pump;
  });

  test("removing the newest subagent message restores the remaining message's model", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const parentMessages = [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }];
    let childMessages = [
      { id: "msg_old", type: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input: 100 } },
      { id: "msg_new", type: "assistant", modelID: "gpt-5", time: { created: 3 }, tokens: { reasoning: 50 } },
    ];
    provider.readMessages = async (sessionId) => ({ items: (sessionId === "child" ? childMessages : parentMessages) as never[] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");

    await adapter.history("parent");
    expect(row()).toEqual(expect.objectContaining({ model: "gpt-5", usage: { input: 100, reasoning: 50 } }));
    const pump = adapter.startEventPump();
    childMessages = [childMessages[0]!];
    provider.eventQueue.push({ id: "remove-new", type: "message.removed", properties: { sessionID: "child", messageID: "msg_new" } } as never);
    while ((row() as { model?: string } | undefined)?.model !== "claude-haiku") await Bun.sleep(1);
    expect(row()).toEqual(expect.objectContaining({ model: "claude-haiku", usage: { input: 100 } }));
    expect((row() as { usage?: Record<string, number> }).usage).not.toHaveProperty("reasoning");
    expect((await adapter.history("parent")).items.find(item => item.type === "tool"))
      .toEqual(expect.objectContaining({ model: "claude-haiku", usage: { input: 100 } }));
    await adapter.stopEventPump();
    await pump;
  });

  test("a subagent that reports nothing leaves its row readable and unattributed", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Audit styles" }, metadata: { sessionId: "child" },
      } }],
    }] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const pump = adapter.startEventPump();
    // An assistant message with no tokens at all: nothing to attribute, and a
    // zero would be a figure the agent never gave.
    provider.eventQueue.push({
      id: "e1", type: "message.updated",
      data: { info: { id: "msg", sessionID: "child", role: "assistant", time: { created: 2 } } },
    } as never);
    provider.eventQueue.push({
      id: "e2", type: "message.part.updated",
      data: { part: { id: "prt_c", messageID: "msg", sessionID: "child", type: "text", text: "working" } },
    } as never);
    await liveEventsApplied(adapter, provider);
    const row = adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    // Still named, still carrying a status; simply nothing claimed about cost.
    expect(row).toEqual(expect.objectContaining({ id: "tool:prt_task", name: "task", input: JSON.stringify({ description: "Audit styles" }) }));
    expect(typeof (row as { status?: unknown }).status).toBe("string");
    expect(row).not.toHaveProperty("usage");
    expect(row).not.toHaveProperty("model");
    await adapter.stopEventPump();
    await pump;
  });

  test("a subagent seen only in the store is attributed from its own messages", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    // The child's own history, as a fresh adapter would find it: the turn
    // finished before this process existed, so nothing was ever seen live.
    const childMessages = [
      { id: "msg_a", type: "assistant", modelID: "claude-sonnet-4-5", time: { created: 2 }, tokens: { input: 900, output: 30, cache: { read: 40, write: 0 } } },
      { id: "msg_b", type: "assistant", modelID: "claude-sonnet-4-5", time: { created: 3 }, tokens: { input: 600, output: 10, cache: { read: 0, write: 0 } } },
    ];
    let childReads = 0;
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      childReads += 1;
      return { items: childMessages as never[] };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const snapshot = await adapter.history("parent");
    expect(snapshot.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 1_500, output: 40, cacheRead: 40, cacheWrite: 0 },
    }));
    expect(childReads).toBe(1);

    // Banked, so reopening does not pay for it again.
    await adapter.history("parent");
    expect(childReads).toBe(1);
  });

  test("a child message with only tool parts still counts toward the parent's total", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    await adapter.history("parent");
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    const pump = adapter.startEventPump();
    // The child's whole turn is agentic: tool calls, no text part ever, so
    // nothing ever lands in the child's own timeline. The message's tokens
    // must still reach the parent's tally.
    provider.eventQueue.push({
      id: "e1", type: "message.updated",
      data: { info: { id: "msg_agentic", sessionID: "child", role: "assistant", modelID: "claude-sonnet-4-5", time: { created: 2 }, tokens: { input: 700, output: 15, cache: { read: 30, write: 0 } } } },
    } as never);
    while (!(row() as { usage?: unknown }).usage) await Bun.sleep(1);
    expect(row()).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 700, output: 15, cacheRead: 30, cacheWrite: 0 },
    }));
    await adapter.stopEventPump();
    await pump;
  });

  test("usage arriving during a reconstruction wins over the stored snapshot", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    // The stored read is held open so live events can land mid-flight. The
    // snapshot it eventually returns is older than what the child reports
    // live while it is pending.
    let release: () => void = () => {};
    let reconstructionReads = 0;
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      reconstructionReads += 1;
      await new Promise<void>(resolve => { release = resolve; });
      return { items: [
        { id: "msg_a", type: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input: 500, output: 5, cache: { read: 0, write: 0 } } },
      ] as never[] };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    const opening = adapter.history("parent");
    await waitUntil(() => reconstructionReads === 1); // the reconstruction is now blocked inside the read
    provider.eventQueue.push({
      id: "e-live", type: "message.updated",
      data: { info: { id: "msg_a", sessionID: "child", role: "assistant", modelID: "gpt-5", time: { created: 3 }, tokens: { input: 900, output: 20, cache: { read: 0, write: 0 } } } },
    } as never);
    await liveEventsApplied(adapter, provider); // the live attribution lands before the read returns
    release();

    // Both the returned snapshot and later opens carry the live figure — the
    // stale stored read must not overwrite what arrived while it was in
    // flight, or the stale number would be banked permanently.
    expect((await opening).items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "gpt-5",
      usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0 },
    }));
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "gpt-5",
      usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0 },
    }));
    await adapter.stopEventPump();
    await pump;
  });

  test("concurrent snapshots share reconstruction and preserve a racing removal", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    let childReads = 0;
    let release: () => void = () => {};
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      childReads += 1;
      const items = childReads === 1
        ? [{ id: "msg_removed", type: "assistant", time: { created: 2 }, tokens: { input: 500 } }]
        : [];
      if (childReads === 1) await new Promise<void>(resolve => { release = resolve; });
      return { items: items as never[] };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();

    const first = adapter.history("parent");
    const second = adapter.history("parent");
    while (childReads === 0) await Bun.sleep(1);
    provider.eventQueue.push({ id: "remove", type: "message.removed", properties: { sessionID: "child", messageID: "msg_removed" } } as never);
    await liveEventsApplied(adapter, provider);
    release();

    for (const snapshot of await Promise.all([first, second])) {
      expect(snapshot.items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    }
    // Both snapshots share one read, and the racing tombstone removes the
    // deleted message's usage and model from its result.
    expect(childReads).toBe(1);
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    await adapter.stopEventPump();
    await pump;
  });

  test("eviction invalidates a stored attribution read already in flight", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const parentMessages = [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }];
    let childStore = [{ id: "msg_old", type: "assistant", time: { created: 2 }, tokens: { input: 500 } }];
    let childReads = 0;
    let release: () => void = () => {};
    provider.readMessages = async (sessionId) => {
      if (sessionId !== "child") return { items: parentMessages as never[] };
      childReads += 1;
      const snapshot = childStore;
      if (childReads === 1) await new Promise<void>(resolve => { release = resolve; });
      return { items: snapshot as never[] };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, maxProjections: 2 });
    const pump = adapter.startEventPump();

    const opening = adapter.history("parent");
    while (childReads === 0) await Bun.sleep(1);
    provider.eventQueue.push({
      id: "live", type: "message.updated",
      properties: { info: { id: "msg_live", sessionID: "child", role: "assistant", time: { created: 3 }, tokens: { input: 900 } } },
    } as never);
    await liveEventsApplied(adapter, provider);
    adapter.projectionForTests("other-1");
    adapter.projectionForTests("other-2");
    childStore = [...childStore, { id: "msg_live", type: "assistant", time: { created: 3 }, tokens: { input: 900 } }];
    release();

    expect((await opening).items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    const reopened = await adapter.history("parent");
    expect(reopened.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({ usage: { input: 1_400 } }));
    expect(childReads).toBe(2);
    await adapter.stopEventPump();
    await pump;
  });

  test("a subagent longer than a page is tallied across all its pages", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    // The provider pages newest-first: the first read returns the tail of the
    // transcript with a cursor pointing at what came before it.
    const childPages = new Map<string, { items: never[]; nextCursor?: string }>([
      ["latest", { items: [
        { id: "msg_new", type: "assistant", modelID: "claude-sonnet-4-5", time: { created: 3 }, tokens: { input: 600, output: 10, cache: { read: 0, write: 0 } } },
      ] as never[], nextCursor: "older" }],
      ["older", { items: [
        { id: "msg_old", type: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input: 900, output: 30, cache: { read: 40, write: 0 } } },
      ] as never[] }],
    ]);
    let childReads = 0;
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      childReads += 1;
      return childPages.get(options.cursor ?? "latest") ?? { items: [] };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const snapshot = await adapter.history("parent");
    // The tally covers the whole transcript, and the model is the child's
    // newest, not whichever page happened to be read last.
    expect(snapshot.items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-5",
      usage: { input: 1_500, output: 40, cacheRead: 40, cacheWrite: 0 },
    }));
    expect(childReads).toBe(2);

    // Banked as one answer: reopening re-reads nothing.
    await adapter.history("parent");
    expect(childReads).toBe(2);
  });

  test("a subagent that reported nothing is read once and not asked again", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Audit styles" }, metadata: { sessionId: "child" },
      } }],
    }] });
    let childReads = 0;
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      childReads += 1;
      return { items: [] };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    const snapshot = await adapter.history("parent");
    // Still a readable row asserting no figure — and an empty answer is an
    // answer, so it is not re-asked.
    expect(snapshot.items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    await adapter.history("parent");
    expect(childReads).toBe(1);
  });

  test("a failed child read is unknown, not empty, and is retried", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "completed", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    let fail = true;
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      if (fail) throw new Error("provider unreachable");
      return { items: [{ id: "msg_a", type: "assistant", modelID: "gpt-5", time: { created: 2 }, tokens: { input: 500 } }] as never[] };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });

    // The error degrades the row rather than the snapshot, and banks nothing —
    // caching it as "no usage" would hide the cost permanently.
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).not.toHaveProperty("usage");
    fail = false;
    expect((await adapter.history("parent")).items.find(item => item.type === "tool")).toEqual(expect.objectContaining({
      model: "gpt-5",
      usage: { input: 500 },
    }));
  });

  test("a subagent that starts and reports inside one coalescer window still lands on its row", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 25 });
    await adapter.history("parent");
    const pump = adapter.startEventPump();
    // The task row and the child's whole report enter one buffer window: when
    // the usage arrives, the parent's row is not in the projection yet, so
    // the live decoration path finds nothing. The flush must settle the
    // banked figures onto the row it just materialized — a fast child that
    // never speaks again gives no later event to retry on.
    provider.eventQueue.push({
      id: "e-task", type: "message.part.updated",
      data: { part: { id: "prt_task", messageID: "m1", sessionID: "parent", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Quick check" }, metadata: { sessionId: "child" },
      } } },
    } as never);
    provider.eventQueue.push({
      id: "e-msg", type: "message.updated",
      data: { info: { id: "msg_fast", sessionID: "child", role: "assistant", modelID: "claude-haiku", time: { created: 2 }, tokens: { input: 120 } } },
    } as never);
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");
    while (!(row() as { usage?: unknown } | undefined)?.usage) await Bun.sleep(5);
    expect(row()).toEqual(expect.objectContaining({ model: "claude-haiku", usage: { input: 120 } }));
    await adapter.stopEventPump();
    await pump;
  });

  test("a tally rebuilt by live events after an eviction is not mistaken for complete", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.pages.set("first", { items: [{
      id: "prt_task", type: "assistant", time: { created: 1 },
      content: [{ id: "prt_task", type: "tool", tool: "task", callID: "c1", state: {
        status: "running", input: { description: "Review renderer" }, metadata: { sessionId: "child" },
      } }],
    }] });
    // The child's store holds what was reported before the eviction; the
    // stored figure for msg_a is deliberately staler than what arrived live.
    let childStore: never[] = [];
    const listMessages = provider.readMessages.bind(provider);
    provider.readMessages = async (sessionId, options) => {
      if (sessionId !== "child") return listMessages(sessionId, options);
      return { items: childStore };
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1, maxProjections: 2 });
    await adapter.history("parent");
    const pump = adapter.startEventPump();
    const report = (suffix: string, input: number) => {
      provider.eventQueue.push({
        id: `e-part-${suffix}`, type: "message.part.updated",
        data: { part: { id: `prt_${suffix}`, messageID: `msg_${suffix}`, sessionID: "child", type: "text", text: "findings" } },
      } as never);
      provider.eventQueue.push({
        id: `e-msg-${suffix}`, type: "message.updated",
        data: { info: { id: `msg_${suffix}`, sessionID: "child", role: "assistant", time: { created: 2 }, tokens: { input } } },
      } as never);
    };
    const row = () => adapter.projectionForTests("parent").items().find(item => item.type === "tool");

    report("a", 500);
    while (sumInput(row()) !== 500) await Bun.sleep(1);
    childStore = [{ id: "msg_a", type: "assistant", time: { created: 2 }, tokens: { input: 500 } }] as never[];

    // Two other conversations push the parent out of the LRU, and the tally
    // kept for its subagent goes with it. The child keeps running: its next
    // report recreates a map holding only the post-eviction message.
    adapter.projectionForTests("other-1");
    adapter.projectionForTests("other-2");

    report("b", 700);
    await liveEventsApplied(adapter, provider);

    // Reopened, the partial rebuild must not pass for the whole answer: the
    // pre-eviction 500 is recovered from the child's store and merged with
    // the 700 that arrived live after the eviction.
    await adapter.history("parent");
    expect(sumInput(row())).toBe(1_200);
    report("c", 300);
    while (sumInput(row()) !== 1_500) await Bun.sleep(1);
    expect(sumInput(row())).toBe(1_500);

    await adapter.stopEventPump();
    await pump;
  });

  test("a child question answered from the parent seeds an empty owning projection", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.listQuestions = async () => [{
      requestId: "que_child",
      conversationId: "child",
      questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    // The parent shows the card; the child's transcript was never opened, so
    // its projection is empty when the answer arrives.
    await adapter.history("parent");
    await adapter.respondQuestion("child", "que_child", "client-1", { kind: "answered", answers: [["A"]] });
    expect(provider.questionReplies).toEqual([{ sessionId: "child", requestId: "que_child", answers: [["A"]] }]);
  });

  for (const kind of ["permission", "question"] as const) test(`a positively linked worker ${kind} keeps one canonical parent card and one native answer`, async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("parent"), { ...fixtureSession("child"), parentId: "parent" }];
    provider.listPermissions = async () => kind === "permission"
      ? [{ conversationId: "child", requestId: "canonical", action: "read", resources: ["safe-fixture"] }] : [];
    provider.listQuestions = async () => kind === "question"
      ? [{ conversationId: "child", requestId: "canonical", questions: [{ prompt: "Pick", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }] }] : [];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    try {
      await adapter.history("parent");
      // Provider occurrence proof is verified separately through the native V2
      // seam. This adapter test consumes its DTO without inventing a second ask.
      adapter.projectionForTests("parent").upsert({ id: "task:worker", type: "background_task", taskId: "worker", createdAt: 1,
        description: "Worker", childConversationId: "child", status: "running", stateUncertain: true,
        activity: { kind: "needs-answer", executionId: "execution:worker", request: { id: "canonical", kind } }, control: { available: false } });
      const cards = adapter.projectionForTests("parent").items().filter(item => item.type === kind);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ id: `${kind}:canonical`, requestId: "canonical", conversationId: "child", status: "pending" });
      expect(adapter.projectionForTests("parent").find(item => item.id === "task:worker")).toMatchObject({ activity: { request: { id: "canonical", kind } } });
      if (kind === "permission") {
        await adapter.respondPermission("child", "canonical", "client-1", "approved-once");
        expect(provider.permissionReplies).toEqual([{ sessionId: "child", requestId: "canonical", reply: "once" }]);
        expect(provider.questionReplies).toEqual([]);
      } else {
        await adapter.respondQuestion("child", "canonical", "client-1", { kind: "answered", answers: [["A"]] });
        expect(provider.questionReplies).toEqual([{ sessionId: "child", requestId: "canonical", answers: [["A"]] }]);
        expect(provider.permissionReplies).toEqual([]);
      }
      expect(provider.prompts).toEqual([]);
      expect(provider.interrupts).toEqual([]);
    } finally { await adapter.dispose(); }
  });

  test("a provider without the list simply never recovers, and does not throw", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    expect((await adapter.history("local")).items).toEqual([]);
  });

  test("a reply keeps the tool row the ask named", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    // The ask names the call (2.x `source`); the reply names nothing but
    // the request. The resolved card must still know which row it was about.
    applyEvent(adapter, "local", {
      id: "ask",
      type: "permission.asked",
      data: { id: "perm_mcp", sessionID: "local", action: "tracker_create_issue", resources: ["*"], save: ["*"], metadata: {}, source: { type: "tool", messageID: "msg_1", id: "call_1" }, timestamp: 10 },
    } as never);
    applyEvent(adapter, "local", {
      id: "reply",
      type: "permission.replied",
      data: { sessionID: "local", requestID: "perm_mcp", reply: "once", timestamp: 11 },
    } as never);
    expect(adapter.projectionForTests("local").items()).toEqual([expect.objectContaining({
      id: "permission:perm_mcp",
      status: "resolved",
      outcome: "approved-once",
      action: "tracker_create_issue",
      resources: ["*"],
      sourceToolId: "tool:call_1",
    })]);
  });

  test("a resolution whose ask was never projected is suppressed, not published invalid", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    // The classic replied event carries no action or resources; without the
    // ask to merge into, publishing it would fail client validation and force
    // a resync on every snapshot that repeats the item.
    applyEvent(adapter, "local", {
      id: "orphan",
      type: "permission.replied",
      data: { sessionID: "local", requestID: "perm_ghost", reply: "once", timestamp: 10 },
    } as never);
    expect(adapter.projectionForTests("local").items()).toEqual([]);
  });

  test("a plan approval's resource-less card is published, not suppressed", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("local")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    // A plan approval legitimately names no resources — the plan is the
    // content — and must reach the timeline with its intent choices.
    adapter.projectionForTests("local").apply({ kind: "upsert", item: {
      id: "permission:plan-1",
      type: "permission",
      createdAt: 20,
      requestId: "plan-1",
      action: "Review the plan",
      resources: [],
      status: "pending",
      plan: "## Plan\n1. Do the thing",
      choices: [{ id: "implement", label: "Approve and implement" }],
    } });
    const items = adapter.projectionForTests("local").items();
    expect(items.map(item => item.id)).toContain("permission:plan-1");
    const card = items.find(item => item.id === "permission:plan-1") as { plan?: string; choices?: unknown[] };
    expect(card.plan).toContain("Do the thing");
    expect(card.choices).toHaveLength(1);
  });
});

describe("a subagent's request reaches the conversation that launched it", () => {
  function withChild() {
    const provider = new FakeProvider();
    provider.sessions = [
      fixtureSession("parent"),
      { ...fixtureSession("child"), parentId: "parent" },
    ];
    return provider;
  }
  const asked = (id: string) => ({
    id, type: "permission.v2.asked",
    data: { id, sessionID: "child", action: "bash", resources: ["rm -rf build"], timestamp: 10 },
  });

  test("appears in the parent, owned by the child, and is answerable there", async () => {
    const provider = withChild();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push(asked("perm-1") as never);
    while (adapter.projectionForTests("parent").items().length === 0) await Bun.sleep(1);

    const mirrored = adapter.projectionForTests("parent").items()[0]!;
    expect(mirrored).toEqual(expect.objectContaining({
      id: "permission:perm-1",
      type: "permission",
      // The child owns it — that is what routes the answer correctly.
      conversationId: "child",
      status: "pending",
    }));
    // It is in the child's own transcript too.
    expect(adapter.projectionForTests("child").items()).toHaveLength(1);

    // Answering addresses the child, and replies exactly once.
    await adapter.respondPermission("child", "perm-1", "client-1", "approved-once");
    expect(provider.permissionReplies).toEqual([{ sessionId: "child", requestId: "perm-1", reply: "once" }]);

    await adapter.stopEventPump();
    await pump;
  });

  test("resolving in the child clears the parent's copy", async () => {
    const provider = withChild();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push(asked("perm-2") as never);
    while (adapter.projectionForTests("parent").items().length === 0) await Bun.sleep(1);

    provider.eventQueue.push({
      id: "replied", type: "permission.v2.replied",
      data: { sessionID: "child", requestID: "perm-2", reply: "once", timestamp: 11 },
    } as never);
    const permissionStatus = (conversation: string) => {
      const item = adapter.projectionForTests(conversation).items()[0];
      return item?.type === "permission" ? item.status : undefined;
    };
    while (permissionStatus("parent") !== "resolved") await Bun.sleep(1);

    for (const conversation of ["parent", "child"]) {
      const item = adapter.projectionForTests(conversation).items()[0]!;
      expect(item).toEqual(expect.objectContaining({ status: "resolved" }));
    }
    await adapter.stopEventPump();
    await pump;
  });

  test("a reconciled subagent question reaches the parent and clears when withdrawn", async () => {
    const provider = withChild();
    let pending = [{
      requestId: "que-1",
      conversationId: "child",
      questions: [{ prompt: "Pick one", header: "Choice", options: [{ label: "A", description: "" }], multiple: false, allowFreeForm: false }],
    }];
    provider.listQuestions = async () => pending;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    // The question tool part is the only live signal a question exists; the
    // asked event never fires, so this fallback is the parent's only chance.
    provider.eventQueue.push({
      id: "t1", type: "session.next.tool.called",
      data: { sessionID: "child", callID: "c1", tool: "question" },
    } as never);
    const parentQuestion = () => adapter.projectionForTests("parent").items().find(item => item.type === "question");
    while (!parentQuestion()) await Bun.sleep(1);
    expect(parentQuestion()).toEqual(expect.objectContaining({
      id: "question:que-1",
      conversationId: "child",
      status: "pending",
    }));

    // Withdrawn (answered from the CLI): the parent's copy must clear too.
    pending = [];
    provider.eventQueue.push({
      id: "t2", type: "session.next.tool.success",
      data: { sessionID: "child", callID: "c1", tool: "question" },
    } as never);
    while (parentQuestion()) await Bun.sleep(1);
    await adapter.stopEventPump();
    await pump;
  });

  test("a newer subagent request does not block answering the parent's own", async () => {
    const provider = withChild();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({
      id: "own", type: "permission.v2.asked",
      data: { id: "perm-own", sessionID: "parent", action: "bash", resources: ["bun test"], timestamp: 10 },
    } as never);
    provider.eventQueue.push({
      id: "mirrored", type: "permission.v2.asked",
      data: { id: "perm-late", sessionID: "child", action: "bash", resources: ["rm -rf build"], timestamp: 20 },
    } as never);
    while (adapter.projectionForTests("parent").items().length < 2) await Bun.sleep(1);

    // The renderer enables one request per owning conversation; the guard
    // must admit the same set, not just the globally newest.
    await adapter.respondPermission("parent", "perm-own", "client-own", "approved-once");
    await adapter.respondPermission("child", "perm-late", "client-late", "rejected");
    expect(provider.permissionReplies).toEqual([
      { sessionId: "parent", requestId: "perm-own", reply: "once" },
      { sessionId: "child", requestId: "perm-late", reply: "reject" },
    ]);
    await adapter.stopEventPump();
    await pump;
  });

  test("a request from a parentless conversation is not mirrored anywhere", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("solo")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", coalesceWindowMs: 1 });
    const pump = adapter.startEventPump();
    provider.eventQueue.push({
      id: "perm-3", type: "permission.v2.asked",
      data: { id: "perm-3", sessionID: "solo", action: "bash", resources: ["ls"], timestamp: 10 },
    } as never);
    while (adapter.projectionForTests("solo").items().length === 0) await Bun.sleep(1);
    expect(adapter.projectionForTests("solo").items()[0]).toEqual(expect.objectContaining({ conversationId: "solo" }));
    await adapter.stopEventPump();
    await pump;
  });
});

describe("a subagent's pending request is reconciled into its parent", () => {
  // The live-event path is not enough: OpenCode does not deliver a subagent's
  // permission on the main stream, so the parent must find it by asking.
  function withPendingChildRequest() {
    const provider = new FakeProvider();
    provider.sessions = [
      fixtureSession("parent"),
      { ...fixtureSession("child"), parentId: "parent" },
    ];
    provider.listPermissions = async () => [
      { requestId: "perm-child", conversationId: "child", action: "bash", resources: ["echo from-subagent"] },
    ];
    return provider;
  }

  test("appears in the parent on load, owned by the child", async () => {
    const provider = withPendingChildRequest();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const snapshot = await adapter.history("parent");
    expect(snapshot.items).toEqual([expect.objectContaining({
      id: "permission:perm-child",
      type: "permission",
      conversationId: "child",
      action: "bash",
      status: "pending",
    })]);
  });

  test("answering it from the parent replies once, for the child", async () => {
    const provider = withPendingChildRequest();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.history("parent");
    // The client addresses the owner, which is what the item carries.
    await adapter.respondPermission("child", "perm-child", "client-1", "approved-once");
    expect(provider.permissionReplies).toEqual([{ sessionId: "child", requestId: "perm-child", reply: "once" }]);
  });

  test("answering also resolves the parent's mirrored copy, not just the child's", async () => {
    const provider = withPendingChildRequest();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await adapter.history("parent");
    await adapter.respondPermission("child", "perm-child", "client-1", "approved-once");
    // A recovered request may never produce a replied event for the pump to
    // mirror, so the answer itself must clear the parent's copy — otherwise
    // the parent counts an already-answered request forever.
    expect(adapter.projectionForTests("parent").items()).toEqual([
      expect.objectContaining({ id: "permission:perm-child", status: "resolved", outcome: "approved-once" }),
    ]);
  });

  test("a transient parent-lookup failure does not permanently hide the child's request", async () => {
    const provider = withPendingChildRequest();
    const lookup = provider.getSession.bind(provider);
    let failing = true;
    provider.getSession = async (id: string) => {
      if (failing && id === "child") throw new Error("provider unreachable");
      return lookup(id);
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    // Degraded while the provider errors — unknown, not empty…
    expect((await adapter.history("parent")).items).toEqual([]);
    failing = false;
    // …and recovered on the next load, rather than cached as "no parent".
    expect((await adapter.history("parent")).items).toEqual([
      expect.objectContaining({ id: "permission:perm-child", conversationId: "child", status: "pending" }),
    ]);
  });

  test("an unrelated conversation's request is not pulled in", async () => {
    const provider = withPendingChildRequest();
    provider.sessions.push({ ...fixtureSession("stranger") });
    provider.listPermissions = async () => [
      { requestId: "perm-other", conversationId: "stranger", action: "bash", resources: ["ls"] },
    ];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    expect((await adapter.history("parent")).items).toEqual([]);
  });
});

describe("prompt attachments", () => {
  const STORED = new Map([
    ["11111111-2222-4333-8444-555555555555", { id: "11111111-2222-4333-8444-555555555555", mimeType: "image/png", absolutePath: "/state/attachments/ws/11111111-2222-4333-8444-555555555555.png" }],
    ["22222222-2222-4333-8444-555555555555", { id: "22222222-2222-4333-8444-555555555555", mimeType: "image/webp", absolutePath: "/state/attachments/ws/22222222-2222-4333-8444-555555555555.webp" }],
  ]);
  const resolveAttachment = async (id: string) => STORED.get(id) ?? null;
  const ref = (id: string, name = "shot.png") => ({ id, name, mimeType: "image/png" });

  test("locates stored bytes at dispatch and hands the provider neutral refs with the sniffed type", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", resolveAttachment });
    // The client claims image/png; the store sniffed webp. The store wins on
    // both the provider hand-off and the projected reference.
    const accepted = await adapter.prompt("session", "r1", "look at this", undefined, undefined, undefined, [ref("22222222-2222-4333-8444-555555555555", "actually.webp")]);
    expect(accepted.pending).toBe(false);
    expect(provider.prompts[0]!.attachments).toEqual([{
      id: "22222222-2222-4333-8444-555555555555",
      name: "actually.webp",
      mimeType: "image/webp",
      absolutePath: "/state/attachments/ws/22222222-2222-4333-8444-555555555555.webp",
    }]);
    expect(adapter.projectionForTests("session").items()).toContainEqual(expect.objectContaining({
      type: "user_message",
      text: "look at this",
      attachments: [{ id: "22222222-2222-4333-8444-555555555555", name: "actually.webp", mimeType: "image/webp" }],
    }));
  });

  test("refuses unknown references at admission, before anything reaches the provider", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", resolveAttachment });
    await expect(adapter.prompt("session", "r1", "go", undefined, undefined, undefined, [ref("99999999-0000-4000-8000-000000000000")]))
      .rejects.toBeInstanceOf(UnknownAttachmentError);
    expect(provider.prompts).toHaveLength(0);
    // A harness without a store refuses every reference the same way.
    const bare = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    await expect(bare.prompt("session", "r2", "go", undefined, undefined, undefined, [ref("11111111-2222-4333-8444-555555555555")]))
      .rejects.toBeInstanceOf(UnknownAttachmentError);
  });

  test("refuses attachments on a slash command at admission", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", resolveAttachment });
    await expect(adapter.prompt("session", "r1", "/review focus", undefined, undefined, undefined, [ref("11111111-2222-4333-8444-555555555555")]))
      .rejects.toBeInstanceOf(CommandAttachmentsError);
    expect(provider.prompts).toHaveLength(0);
    expect(provider.commandCalls).toHaveLength(0);
  });

  test("admits slash-leading prose with attachments when no listed command matches", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", resolveAttachment });
    // "/unknown" is not in the command list, so dispatch would send it as an
    // ordinary prompt — admission must classify the same way and keep the
    // images rather than refusing on shape alone.
    const accepted = await adapter.prompt("session", "r1", "/unknown focus", undefined, undefined, undefined, [ref("11111111-2222-4333-8444-555555555555")]);
    expect(accepted.messageId).toBeTruthy();
    expect(provider.commandCalls).toHaveLength(0);
    expect(provider.prompts).toHaveLength(1);
    expect(provider.prompts[0]!.text).toBe("/unknown focus");
    expect(provider.prompts[0]!.attachments).toHaveLength(1);
  });

  test("a slow command listing does not let a later prompt overtake the slash-prose one", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let releaseListing: () => void = () => {};
    const listing = new Promise<void>(resolve => { releaseListing = resolve; });
    provider.listCommands = async () => {
      await listing;
      return provider.commands;
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", resolveAttachment });
    // Classification happens inside the per-conversation admission lane, so an
    // ordinary prompt submitted afterwards cannot be admitted — and dispatched,
    // committing its configuration — while the attachment-bearing one is still
    // waiting on the listing.
    const first = adapter.prompt("session", "r1", "/unknown focus", undefined, undefined, undefined, [ref("11111111-2222-4333-8444-555555555555")]);
    const second = adapter.prompt("session", "r2", "second");
    await Bun.sleep(5);
    expect(provider.prompts).toHaveLength(0);
    releaseListing();
    expect((await first).pending).toBe(false);
    expect((await second).pending).toBe(true);
    expect(provider.prompts).toHaveLength(1);
    expect(provider.prompts[0]!.text).toBe("/unknown focus");
  });

  test("a retry of an accepted slash-prose prompt replays the receipt after the command list changes", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", resolveAttachment });
    const accepted = await adapter.prompt("session", "r1", "/unknown focus", undefined, undefined, undefined, [ref("11111111-2222-4333-8444-555555555555")]);
    // The list gains the name after acceptance. A lost-response retry must
    // replay the receipt, never reclassify: refusing now would restore a
    // draft the provider already received.
    provider.commands = [...provider.commands, { name: "unknown", description: "New", argumentHint: "", kind: "command" as const }];
    const retried = await adapter.prompt("session", "r1", "/unknown focus", undefined, undefined, undefined, [ref("11111111-2222-4333-8444-555555555555")]);
    expect(retried.messageId).toBe(accepted.messageId);
    expect(provider.prompts).toHaveLength(1);
    expect(provider.commandCalls).toHaveLength(0);
  });

  test("held messages keep their references, expose them on the wire, and deliver them", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    let nextId = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `message-${++nextId}`, resolveAttachment });
    const pump = adapter.startEventPump();

    await adapter.prompt("session", "r1", "first");
    const held = await adapter.prompt("session", "r2", "with image", undefined, undefined, undefined, [ref("11111111-2222-4333-8444-555555555555")]);
    expect(held.pending).toBe(true);
    expect(provider.prompts).toHaveLength(1);
    expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({
      id: held.messageId,
      text: "with image",
      attachments: [{ id: "11111111-2222-4333-8444-555555555555", name: "shot.png", mimeType: "image/png" }],
    })]);

    provider.eventQueue.push({ id: "idle", type: "session.idle", data: { sessionID: "session" } });
    for (let attempt = 0; attempt < 200 && provider.prompts.length < 2; attempt += 1) await Bun.sleep(1);
    await adapter.stopEventPump();
    await pump;
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]!.attachments).toEqual([expect.objectContaining({
      id: "11111111-2222-4333-8444-555555555555",
      absolutePath: "/state/attachments/ws/11111111-2222-4333-8444-555555555555.png",
    })]);
    expect((await adapter.history("session")).queued ?? []).toEqual([]);
  });

  test("removing a held message discards its references", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", resolveAttachment });
    await adapter.prompt("session", "r1", "first");
    const held = await adapter.prompt("session", "r2", "queued", undefined, undefined, undefined, [ref("11111111-2222-4333-8444-555555555555")]);
    await expect(adapter.removeQueued("session", held.messageId, "rm-1")).resolves.toEqual({ removed: true });
    expect((await adapter.history("session")).queued ?? []).toEqual([]);
    expect(provider.prompts).toHaveLength(1);
  });
});

describe("sparse user-message updates preserve attachments", () => {
  test("an attachment-less upsert for the same message keeps the thumbnails", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g" });
    const projection = adapter.projectionForTests("session");
    const attachments = [{ id: "11111111-2222-4333-8444-555555555555", name: "shot.png", mimeType: "image/png" }];
    projection.upsert({ id: "message:m1", type: "user_message", createdAt: 1, text: "look", requestId: "r1", attachments });

    // A classic event alias knows nothing of attachments: text-only restate.
    projection.upsert({ id: "message:m1", type: "user_message", createdAt: 1, text: "look" });
    expect(projection.items()[0]).toEqual(expect.objectContaining({ text: "look", requestId: "r1", attachments }));

    // An empty-parts message.updated frame: empty text AND no attachments.
    projection.upsert({ id: "message:m1", type: "user_message", createdAt: 1, text: "" });
    expect(projection.items()[0]).toEqual(expect.objectContaining({ text: "look", attachments }));

    // An update that does carry attachments is authoritative, not sparse.
    const replaced = [{ id: "22222222-2222-4333-8444-555555555555", name: "other.png", mimeType: "image/webp" }];
    projection.upsert({ id: "message:m1", type: "user_message", createdAt: 1, text: "look", attachments: replaced });
    expect(projection.items()[0]).toEqual(expect.objectContaining({ attachments: replaced }));
  });
});

describe("image-only prompts reach the provider", () => {
  test("empty text with attachments dispatches; without them it is refused", async () => {
    const provider = new FakeProvider();
    provider.sessions = [fixtureSession("session")];
    const resolveAttachment = async (id: string) => id === "11111111-2222-4333-8444-555555555555"
      ? { id, mimeType: "image/png", absolutePath: "/state/a.png" }
      : null;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", resolveAttachment });
    const accepted = await adapter.prompt("session", "r1", "", undefined, undefined, undefined, [{ id: "11111111-2222-4333-8444-555555555555", name: "shot.png", mimeType: "image/png" }]);
    expect(accepted.pending).toBe(false);
    expect(provider.prompts[0]).toEqual(expect.objectContaining({ text: "", attachments: [expect.objectContaining({ id: "11111111-2222-4333-8444-555555555555" })] }));
    await expect(adapter.prompt("session2", "r2", "")).rejects.toThrow("prompt must not be empty");
  });
});

describe("workspace activity summary", () => {
  function activityAdapter(options: { maxProjections?: number } = {}) {
    let changes = 0;
    const provider = new FakeProvider();
    const adapter = new ChatAdapter({
      provider,
      workspacePath: process.cwd(),
      generation: "activity",
      onActivityChange: () => { changes += 1; },
      ...options,
    });
    return { adapter, provider, changes: () => changes };
  }

  function permission(requestId: string, status: "pending" | "resolved" = "pending"): ConversationItem {
    return {
      id: `permission:${requestId}`,
      type: "permission",
      createdAt: 1,
      requestId,
      action: "edit",
      resources: ["README.md"],
      status,
      ...(status === "resolved" ? { outcome: "approved-once" as const } : {}),
    };
  }

  function question(requestId: string): ConversationItem {
    return {
      id: `question:${requestId}`,
      type: "question",
      createdAt: 1,
      requestId,
      questions: [{ prompt: "Proceed?", header: "Proceed", options: [], multiple: false, allowFreeForm: true }],
      status: "pending",
    };
  }

  test("a turn in flight in any conversation is working, and only a change of the summary is reported", () => {
    const { adapter, changes } = activityAdapter();
    expect(adapter.activity()).toEqual({ working: false, awaiting: false });
    adapter.projectionForTests("a").apply({ kind: "status", status: "running" });
    expect(adapter.activity()).toEqual({ working: true, awaiting: false });
    expect(changes()).toBe(1);
    // A second live turn, and the first ending while the second runs, leave
    // the summary where it was.
    adapter.projectionForTests("b").apply({ kind: "status", status: "compacting" });
    adapter.projectionForTests("a").apply({ kind: "status", status: "completed" });
    expect(adapter.activity()).toEqual({ working: true, awaiting: false });
    expect(changes()).toBe(1);
    adapter.projectionForTests("b").apply({ kind: "status", status: "idle" });
    expect(adapter.activity()).toEqual({ working: false, awaiting: false });
    expect(changes()).toBe(2);
  });

  test("a turn that ends into live background work keeps the workspace working without a change", () => {
    const { adapter, changes } = activityAdapter();
    adapter.projectionForTests("a").apply({ kind: "status", status: "running" });
    expect(adapter.activity()).toEqual({ working: true, awaiting: false });
    expect(changes()).toBe(1);
    // The turn ended but the agent still holds a backgrounded task: the
    // summary reads the same, so nothing is reported.
    adapter.projectionForTests("a").apply({ kind: "status", status: "background" });
    expect(adapter.activity()).toEqual({ working: true, awaiting: false });
    expect(changes()).toBe(1);
  });

  test("background work going quiet stops working with exactly one change", () => {
    const { adapter, changes } = activityAdapter();
    adapter.projectionForTests("a").apply({ kind: "status", status: "running" });
    adapter.projectionForTests("a").apply({ kind: "status", status: "background" });
    expect(changes()).toBe(1);
    adapter.projectionForTests("a").apply({ kind: "status", status: "idle" });
    expect(adapter.activity()).toEqual({ working: false, awaiting: false });
    expect(changes()).toBe(2);
  });

  test("a conversation deleted while in background stops counting as working", async () => {
    const { adapter, provider, changes } = activityAdapter();
    const local = fixtureSession("a");
    provider.sessions = [local];
    const pump = adapter.startEventPump();
    adapter.projectionForTests("a").apply({ kind: "status", status: "running" });
    adapter.projectionForTests("a").apply({ kind: "status", status: "background" });
    expect(adapter.activity()).toEqual({ working: true, awaiting: false });
    const before = changes();
    provider.sessions = [];
    provider.eventQueue.push({ type: "session.deleted", data: { info: local } });
    await waitUntil(() => changes() > before);
    await Bun.sleep(20);
    expect(adapter.activity()).toEqual({ working: false, awaiting: false });
    expect(changes() - before).toBe(1);
    await adapter.dispose();
    await pump;
  });

  test("a pending permission or question awaits the user until it settles or is withdrawn", () => {
    const { adapter, changes } = activityAdapter();
    adapter.projectionForTests("a").apply({ kind: "upsert", item: permission("p1") });
    expect(adapter.activity()).toEqual({ working: false, awaiting: true });
    expect(changes()).toBe(1);
    adapter.projectionForTests("b").apply({ kind: "upsert", item: question("q1") });
    adapter.projectionForTests("a").apply({ kind: "upsert", item: permission("p1", "resolved") });
    expect(adapter.activity().awaiting).toBe(true);
    expect(changes()).toBe(1);
    adapter.projectionForTests("b").apply({ kind: "remove", itemId: "question:q1" });
    expect(adapter.activity()).toEqual({ working: false, awaiting: false });
    expect(changes()).toBe(2);
    // A resync rewrite rebuilds the timeline from history, which carries no
    // requests: what it drops no longer counts.
    adapter.projectionForTests("a").apply({ kind: "upsert", item: permission("p2") });
    expect(adapter.activity().awaiting).toBe(true);
    adapter.projectionForTests("a").replace([]);
    expect(adapter.activity().awaiting).toBe(false);
  });

  test("a waiting request outlives its conversation's eviction and clears on a content-less resolution", () => {
    const { adapter } = activityAdapter({ maxProjections: 1 });
    adapter.projectionForTests("a").apply({ kind: "upsert", item: permission("p1") });
    // Opening another conversation evicts the quiet one — and a conversation
    // blocked on the user is exactly the quiet one.
    adapter.projectionForTests("b");
    const recreated = adapter.projectionForTests("a");
    expect(recreated.has("permission:p1")).toBe(false);
    expect(adapter.activity().awaiting).toBe(true);
    // The classic reply event carries no action or resources, so the fresh
    // projection drops it for lack of content — but it still settles the
    // request.
    recreated.apply({ kind: "upsert", item: { ...permission("p1", "resolved"), resources: [] } as ConversationItem });
    expect(recreated.has("permission:p1")).toBe(false);
    expect(adapter.activity().awaiting).toBe(false);
  });

  // Once a conversation leaves the workspace, requireSession rejects its later
  // events, so nothing else would ever settle its turn or its request.
  for (const leave of ["moved out of the workspace", "deleted"] as const) {
    for (const [kind, request] of [["permission", permission("p1")], ["question", question("q1")]] as const) {
      test(`a running conversation with a pending ${kind} stops counting once ${leave}`, async () => {
        const { adapter, provider, changes } = activityAdapter();
        const local = fixtureSession("a");
        provider.sessions = [local];
        const pump = adapter.startEventPump();
        adapter.projectionForTests("a").apply({ kind: "status", status: "running" });
        adapter.projectionForTests("a").apply({ kind: "upsert", item: request });
        expect(adapter.activity()).toEqual({ working: true, awaiting: true });
        const before = changes();

        if (leave === "deleted") {
          provider.sessions = [];
          provider.eventQueue.push({ type: "session.deleted", data: { info: local } });
        } else {
          const moved = fixtureSession("a", `${process.cwd()}-moved`);
          provider.sessions = [moved];
          provider.eventQueue.push({ type: "session.updated", data: { info: moved } });
        }
        await waitUntil(() => changes() > before);
        await Bun.sleep(20);
        expect(adapter.activity()).toEqual({ working: false, awaiting: false });
        expect(changes() - before).toBe(1);

        if (leave === "moved out of the workspace") {
          // Moving back re-derives activity from new events; the request the
          // move-out forgot is not resurrected from the retained timeline.
          provider.sessions = [local];
          provider.eventQueue.push({ type: "session.updated", data: { info: local } });
          provider.eventQueue.push({ type: "session.status", data: { sessionID: "a", status: { type: "busy" } } });
          await waitUntil(() => adapter.activity().working);
          expect(adapter.activity()).toEqual({ working: true, awaiting: false });
          expect(changes() - before).toBe(2);
        }

        await adapter.dispose();
        await pump;
      });
    }
  }

  test("any lookup that finds a conversation outside the workspace forgets its activity", async () => {
    for (const lookup of [
      (adapter: ChatAdapter) => adapter.listConversations(),
      (adapter: ChatAdapter) => adapter.getConversation("a").catch(() => undefined),
    ]) {
      const { adapter, provider, changes } = activityAdapter();
      adapter.projectionForTests("a").apply({ kind: "status", status: "running" });
      adapter.projectionForTests("a").apply({ kind: "upsert", item: permission("p1") });
      const before = changes();
      provider.sessions = [fixtureSession("a", `${process.cwd()}-moved`)];
      await lookup(adapter);
      expect(adapter.activity()).toEqual({ working: false, awaiting: false });
      expect(changes() - before).toBe(1);
    }
  });

  test("a conversation that stays in the workspace keeps its activity through lifecycle updates", async () => {
    const { adapter, provider, changes } = activityAdapter();
    const local = fixtureSession("a");
    provider.sessions = [local];
    const pump = adapter.startEventPump();
    adapter.projectionForTests("a").apply({ kind: "status", status: "running" });
    adapter.projectionForTests("a").apply({ kind: "upsert", item: permission("p1") });
    const before = changes();
    const inventory = adapter.subscribeInventory();
    await expectInventorySignal(inventory);
    provider.eventQueue.push({ type: "session.updated", data: { info: { ...local, title: "Renamed" } } });
    await expectInventorySignal(inventory);
    await adapter.listConversations();
    await adapter.getConversation("a");
    expect(adapter.activity()).toEqual({ working: true, awaiting: true });
    expect(changes()).toBe(before);
    inventory.cancel();
    await adapter.dispose();
    await pump;
  });
});

describe("plan usage on demand", () => {
  test("a read is gated on the capability, idempotent per request, and joined across concurrent requests", async () => {
    const provider = new FakeProvider();
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });
    await expect(adapter.usage()).rejects.toThrow(UsageUnsupportedError);
    await expect(adapter.readUsage("req-1", "start")).rejects.toThrow(UsageUnsupportedError);
    provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, "usage"] };
    let reads = 0;
    let release!: () => void;
    const report = { plan: { fiveHour: { utilization: 9 } }, readAt: 5 };
    (provider as unknown as { usageReport: () => Promise<unknown> }).usageReport = async () => undefined;
    (provider as unknown as { readUsage: (mode: string) => Promise<unknown> }).readUsage = mode => {
      reads += 1;
      expect(mode).toBe("start");
      return new Promise(resolve => { release = () => resolve({ report }); });
    };
    expect(await adapter.usage()).toBeNull();
    const first = adapter.readUsage("req-1", "start");
    const second = adapter.readUsage("req-2", "start");
    await Bun.sleep(1);
    release();
    expect(await first).toEqual({ report });
    expect(await second).toEqual({ report });
    expect(reads).toBe(1);
    // The same request id replays its receipt without a new read.
    expect(await adapter.readUsage("req-1", "start")).toEqual({ report });
    expect(reads).toBe(1);
    // A later request reads again.
    const third = adapter.readUsage("req-3", "start");
    await Bun.sleep(1);
    release();
    await third;
    expect(reads).toBe(2);
  });

  test("a start asked during a live-only read runs after it instead of inheriting no-live-session", async () => {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, "usage"] };
    const modes: string[] = [];
    const settle: Array<(value: unknown) => void> = [];
    (provider as unknown as { readUsage: (mode: string) => Promise<unknown> }).readUsage = mode => {
      modes.push(mode);
      return new Promise(resolve => { settle.push(resolve); });
    };
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd() });
    const quiet = adapter.readUsage("req-1", "live-only");
    const click = adapter.readUsage("req-2", "start");
    // A live-only asked while the start is queued joins the start: it answers at least as much.
    const another = adapter.readUsage("req-3", "live-only");
    await Bun.sleep(1);
    expect(modes).toEqual(["live-only"]);
    settle[0]!({ report: null, reason: "no-live-session" });
    expect(await quiet).toEqual({ report: null, reason: "no-live-session" });
    await Bun.sleep(1);
    expect(modes).toEqual(["live-only", "start"]);
    const report = { plan: {}, readAt: 9 };
    settle[1]!({ report });
    expect(await click).toEqual({ report });
    expect(await another).toEqual({ report });
  });
});

describe("steering (opencode-v2-steering)", () => {
  // A fake shaped like the OpenCode 2.x agent: it declares steering and
  // send-now, keeps an inbox the adapter can list and cancel, and announces
  // inbox changes as the 2.x normalizer would — as `inbox` deltas.
  function steering(options: { capabilities?: Array<"steering" | "send-now" | "background-blocking-work">; steerWithdrawTimeoutMs?: number; automaticBackgroundTimeoutMs?: number; steerAdmissionTimeoutMs?: number; receiptEntries?: number; receiptBytes?: number; receiptTtlMs?: number; now?: () => number; resolveAttachment?: ConstructorParameters<typeof ChatAdapter>[0]["resolveAttachment"] } = {}) {
    const provider = new FakeProvider();
    provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, ...(options.capabilities ?? ["steering", "send-now"])] };
    provider.sessions = [fixtureSession("session")];
    // The agent's inbox lists what it was handed until it settles, as the
    // real server does: a steer the adapter admits is listed at once.
    provider.listPendingInbox = async () => provider.pendingInbox;
    provider.cancelInbox = async (_sessionId, inboxId) => { provider.cancelledInbox.push(inboxId); };
    const accept = provider.prompt.bind(provider);
    provider.prompt = async (sessionId, input) => {
      const accepted = await accept(sessionId, input);
      if (input.delivery === "steer") provider.pendingInbox = [...provider.pendingInbox, { id: accepted.messageId, text: input.text, delivery: "steer", at: Date.now() }];
      return accepted;
    };
    let n = 0;
    const adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "g", id: () => `id-${++n}`, coalesceWindowMs: 1, steerWithdrawTimeoutMs: options.steerWithdrawTimeoutMs ?? 60, automaticBackgroundTimeoutMs: options.automaticBackgroundTimeoutMs, steerAdmissionTimeoutMs: options.steerAdmissionTimeoutMs, receiptEntries: options.receiptEntries, receiptBytes: options.receiptBytes, receiptTtlMs: options.receiptTtlMs, now: options.now, resolveAttachment: options.resolveAttachment });
    const inbox = (delta: InboxDelta, eventType = `session.inbox.${delta.kind === "pending" ? "enqueued" : delta.kind === "delivery" ? "delivery.changed" : delta.outcome}`) => {
      if (delta.kind === "settled") provider.pendingInbox = provider.pendingInbox.filter(entry => entry.id !== delta.id);
      if (delta.kind === "pending" && delta.delivery === "steer" && !provider.pendingInbox.some(entry => entry.id === delta.id)) provider.pendingInbox = [...provider.pendingInbox, { id: delta.id, text: delta.text, delivery: "steer", at: delta.at }];
      provider.eventQueue.push({ normalized: { conversationId: "session", updates: [{ kind: "inbox", delta }], outcome: "handled", eventType } });
    };
    const steer = (requestId: string, text: string) => adapter.prompt("session", requestId, text, undefined, undefined, undefined, undefined, "steer");
    const queue = (requestId: string, text: string) => adapter.prompt("session", requestId, text, undefined, undefined, undefined, undefined, "queue");
    const queued = async () => (await adapter.history("session")).queued ?? [];
    return { provider, adapter, inbox, steer, queue, queued };
  }
  test("settlement retention is bounded without erasing dormant dock ownership on projection eviction", async () => {
    const { adapter, provider, queue, steer } = steering();
    try {
      const original = adapter.projectionForTests("session");
      original.statusUpdate("running");
      const head = await queue("head", "hold head");
      await queue("behind", "hold behind");
      await steer("paused-steer", "already admitted steer");
      await adapter.abort("session", "stop");
      // More settled conversations than the historical inventory budget, and
      // far more than the projection LRU. The dormant dock still owns its fence.
      for (let index = 0; index < 2_100; index++) adapter.projectionForTests(`finished-${index}`).statusUpdate("completed");
      expect(adapter.retainedSettlementsForTests()).toBeLessThanOrEqual(2_048);
      expect(adapter.projectionForTests("session")).not.toBe(original);
      expect((await adapter.history("session")).queued?.[0]).toMatchObject({ text: "already admitted steer", paused: true });
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => {
        const accepted = await admit(...args);
        adapter.projectionForTests("session").statusUpdate("interrupted");
        return accepted;
      };
      await adapter.sendNow("session", head.messageId, "manual-send");
      expect((await adapter.history("session")).queued).toEqual([
        expect.objectContaining({ text: "already admitted steer", delivery: "steer", paused: true }),
        expect.objectContaining({ text: "hold head", delivery: "steer", paused: true }),
        expect.objectContaining({ text: "hold behind", delivery: "queue", paused: true }),
      ]);
      expect(provider.prompts.map(entry => entry.text)).toEqual(["already admitted steer", "hold head"]);
    } finally { await adapter.dispose(); }
  });

  // The queue events a subscriber saw, as `kind:messageId`.
  for (const outcome of ["delivered", "cancelled"] as const) test(`a delayed inbox read cannot resurrect a ${outcome} steer or discard new pending entries`, async () => {
    const { adapter, provider, inbox } = steering();
    const pump = adapter.startEventPump();
    try {
      const accepted = { messageId: "old-steer" };
      provider.pendingInbox = [{ id: accepted.messageId, text: "follow up", delivery: "steer", at: 1 }];
      await adapter.history("session");
      await liveEventsApplied(adapter, provider);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      provider.listPendingInbox = async () => {
        const captured = [...provider.pendingInbox, { id: "another-client", text: "new valid input", delivery: "steer" as const, at: 2 }];
        entered();
        await gate;
        return captured;
      };
      const read = adapter.history("session");
      await started;
      inbox({ kind: "settled", id: accepted.messageId, outcome });
      // Outlive the small delivered-id cache as well: the in-flight read's
      // fence, not retained receipts/tombstones, must protect this snapshot.
      for (let index = 0; index < 70; index++) inbox({ kind: "settled", id: `other-${index}`, outcome: "delivered" });
      await liveEventsApplied(adapter, provider);
      release();
      expect((await read).queued?.map(entry => entry.id)).toEqual(["another-client"]);
      expect((adapter as unknown as { inboxReads: Map<string, unknown> }).inboxReads.size).toBe(0);
    } finally {
      await adapter.dispose();
      await pump;
    }
  });

  test("confirmed read-side withdrawal fences an older inbox read even without a settlement event", async () => {
    const { adapter, provider, steer } = steering({ steerWithdrawTimeoutMs: 1 });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "withdraw me");
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      let reads = 0;
      provider.listPendingInbox = async () => {
        if (++reads > 1) return [];
        const captured = [...provider.pendingInbox];
        entered(); await gate; return captured;
      };
      const snapshot = adapter.history("session");
      await started;
      await adapter.removeQueued("session", accepted.messageId, "remove");
      release();
      expect((await snapshot).queued).toEqual([]);
      expect(provider.cancelledInbox).toEqual([accepted.messageId]);
    } finally { await adapter.dispose(); }
  });

  for (const source of ["visible", "complete", "projection"] as const) test(`delivered evidence in ${source} history wins over a stale inbox listing`, async () => {
    const { adapter, provider, steer } = steering();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "already delivered");
      const row = { id: `message:${accepted.messageId}`, type: "user_message" as const, createdAt: 2, text: "already delivered" };
      if (source === "projection") adapter.projectionForTests("session").apply({ kind: "upsert", item: row });
      provider.listMessages = async () => ({ items: source === "visible" ? [row] : [], completeItems: source === "complete" ? [row] : source === "visible" ? [row] : [], accounting: [] });
      const { events } = await adapter.subscribe("session");
      const changes: string[] = [];
      const consumed = (async () => { for await (const event of events) if (event.type === "conversation.queue") changes.push(event.change.kind); })();
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toEqual([]);
      events.cancel(); await consumed;
      expect(changes).toContain("delivered");
      expect(changes).not.toContain("removed");
      expect(provider.prompts).toHaveLength(1);
    } finally { await adapter.dispose(); }
  });

  for (const failure of ["response-lost", "cancel-hangs", "inbox-hangs", "history-hangs", "history-fails", "cancel-unavailable"] as const) test(`withdrawal ${failure} retains the draft and releases Stop within the total deadline`, async () => {
    const { adapter, provider, steer, inbox } = steering({ steerWithdrawTimeoutMs: 10 });
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "retain original input");
      const never = new Promise<never>(() => {});
      provider.cancelInbox = async (_session, id) => {
        provider.cancelledInbox.push(id);
        provider.pendingInbox = [];
        if (failure === "response-lost") throw new Error("response lost after apply");
        if (failure === "cancel-hangs") await never;
      };
      if (failure === "cancel-unavailable") provider.cancelInbox = undefined;
      if (failure === "inbox-hangs") provider.listPendingInbox = () => never;
      if (failure === "history-hangs") provider.listMessages = () => never;
      if (failure === "history-fails") provider.listMessages = async () => { throw new Error("history unavailable"); };
      const removal = adapter.removeQueued("session", accepted.messageId, "remove").catch(error => error);
      const stop = adapter.abort("session", "stop");
      expect(await Promise.race([removal, Bun.sleep(100).then(() => "deadline missed")])).toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      await Promise.race([stop, Bun.sleep(100)]);
      expect(provider.interrupts).toEqual(["session"]);
      // Snapshot recovery must not erase a cancellation whose HTTP response
      // was lost, even when the agent now lists an empty inbox.
      provider.listPendingInbox = async () => [];
      provider.listMessages = async () => ({ items: [], accounting: [] });
      expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: accepted.messageId, text: "retain original input", unconfirmed: true })]);
      provider.cancelInbox = async (_session, id) => { provider.cancelledInbox.push(id); inbox({ kind: "settled", id, outcome: "cancelled" }); };
      await expect(adapter.removeQueued("session", accepted.messageId, "explicit-retry")).resolves.toEqual({ removed: true });
      expect(adapter.pendingSteersForTests("session")).toEqual([]);
      expect(provider.prompts).toHaveLength(1);
      expect(provider.cancelledInbox.every(id => id === accepted.messageId)).toBe(true);
    } finally { await adapter.dispose(); await pump; }
  });

  for (const outcome of ["delivered", "cancelled"] as const) test(`terminal ${outcome} wins over a hung cancellation transport`, async () => {
    const { adapter, provider, steer, inbox } = steering({ steerWithdrawTimeoutMs: 10 });
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "settle once");
      provider.cancelInbox = async (_session, id) => { inbox({ kind: "settled", id, outcome }); await new Promise(() => {}); };
      const result = await adapter.removeQueued("session", accepted.messageId, "remove").catch(error => error);
      if (outcome === "delivered") expect(result).toBeInstanceOf(SteerAlreadyDeliveredError);
      else expect(result).toEqual({ removed: true });
      expect(adapter.pendingSteersForTests("session")).toEqual([]);
    } finally { await adapter.dispose(); await pump; }
  });

  for (const late of ["resolve", "reject"] as const) test(`a cancellation transport that ${late}s after the deadline cannot start fallback reads`, async () => {
    const { adapter, provider, steer } = steering({ steerWithdrawTimeoutMs: 5 });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "no delayed side effects");
      let resolve!: () => void, reject!: (error: Error) => void;
      const transport = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      provider.cancelInbox = () => transport;
      let reads = 0;
      provider.listPendingInbox = async () => { reads++; return []; };
      provider.listMessages = async () => { reads++; return { items: [], accounting: [] }; };
      await expect(adapter.removeQueued("session", accepted.messageId, "remove")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      if (late === "resolve") resolve(); else reject(new Error("late transport rejection"));
      await Promise.allSettled([transport]);
      expect(reads).toBe(0);
      expect(adapter.pendingSteersForTests("session")).toEqual([expect.objectContaining({ id: accepted.messageId, withdrawalUnconfirmed: true })]);
      expect((adapter as unknown as { steerSettlements: Map<string, unknown> }).steerSettlements.size).toBe(0);
    } finally { await adapter.dispose(); }
  });

  test("paged withdrawal recovery shares the cancellation deadline and stops requesting pages after expiry", async () => {
    const { adapter, provider, steer } = steering({ steerWithdrawTimeoutMs: 10 });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "bound every recovery page");
      provider.pendingInbox = [];
      let reads = 0, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let historyRead!: Promise<ProviderHistoryPage>;
      provider.listMessages = () => historyRead = (async () => {
        reads++;
        await gate;
        return { items: [{ id: `message:page-${reads}`, type: "user_message", text: "other input", createdAt: 1 }], nextCursor: `next-${reads}`, accounting: [] };
      })();
      await expect(adapter.removeQueued("session", accepted.messageId, "remove")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      expect(reads).toBe(1);
      release(); await historyRead;
      expect(reads).toBe(1);
      expect(adapter.pendingSteersForTests("session")[0]?.withdrawalUnconfirmed).toBe(true);
    } finally { await adapter.dispose(); }
  });

  test("unconfirmed withdrawal stays inspectable and permits only an explicit withdrawal retry", async () => {
    const { adapter, provider, steer, queued } = steering({ steerWithdrawTimeoutMs: 1 });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "retain this input");
      await expect(adapter.removeQueued("session", accepted.messageId, "first")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      expect(await queued()).toEqual([expect.objectContaining({ text: "retain this input", unconfirmed: true })]);
      await expect(adapter.removeQueued("session", accepted.messageId, "second")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      await expect(adapter.changeDelivery("session", accepted.messageId, "convert", "queue")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      await expect(adapter.sendNow("session", accepted.messageId, "wake")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      expect(provider.cancelledInbox).toEqual([accepted.messageId, accepted.messageId]);
      expect(provider.prompts).toHaveLength(1);
      provider.pendingInbox = [];
      expect(await queued()).toEqual([expect.objectContaining({ id: accepted.messageId, unconfirmed: true })]);
      await expect(adapter.removeQueued("session", accepted.messageId, "confirmed-retry")).resolves.toEqual({ removed: true });
      expect(await queued()).toEqual([]);
    } finally { await adapter.dispose(); }
  });

  for (const outcome of ["cancelled", "delivered"] as const) test(`explicit withdrawal retry settles as ${outcome} without another prompt or inbox identity`, async () => {
    const { adapter, provider, steer, inbox } = steering({ steerWithdrawTimeoutMs: 1 });
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "retained original");
      await expect(adapter.removeQueued("session", accepted.messageId, "first")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      provider.cancelInbox = async (_id, nativeId) => {
        provider.cancelledInbox.push(nativeId);
        inbox({ kind: "settled", id: nativeId, outcome });
        if (outcome === "delivered") provider.listMessages = async () => ({ items: [{ id: `message:${nativeId}`, type: "user_message", text: "retained original", createdAt: 2 }], accounting: [] });
      };
      const retry = adapter.removeQueued("session", accepted.messageId, "explicit-retry");
      if (outcome === "delivered") await expect(retry).rejects.toBeInstanceOf(SteerAlreadyDeliveredError);
      else await expect(retry).resolves.toEqual({ removed: true });
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toEqual([]);
      if (outcome === "delivered") expect(snapshot.items).toContainEqual(expect.objectContaining({ id: `message:${accepted.messageId}`, text: "retained original" }));
      expect(provider.cancelledInbox).toEqual([accepted.messageId, accepted.messageId]);
      expect(provider.prompts).toHaveLength(1);
    } finally { await adapter.dispose(); await pump; }
  });

  for (const outcome of ["accepted", "primary-unknown", "follow-up-unknown"] as const) {
    for (const boundary of ["ttl", "entries", "bytes", "recreation"] as const) test(`composite ${outcome} receipt protection ends at ${boundary}, never by read-side replay`, async () => {
      let clock = 0, backgrounds = 0;
      const { provider, adapter: initial } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"], now: () => clock,
        ...(boundary === "entries" ? { receiptEntries: 1 } : boundary === "bytes" ? { receiptBytes: 360 } : {}),
      });
      let adapter = initial;
      const prepare = () => {
        adapter.projectionForTests("session").statusUpdate("running");
        adapter.projectionForTests("session").apply({ kind: "upsert", item: { id: "tool:shell", type: "tool", name: "shell", status: "running", createdAt: 1 } });
      };
      prepare();
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => { const result = await admit(...args); if (outcome === "primary-unknown") throw new OperationOutcomeUnknownError(); return result; };
      Object.assign(provider, { backgroundBlockingWork: async () => { backgrounds++; if (outcome === "follow-up-unknown") throw new OperationOutcomeUnknownError(); } });
      const context: ChatActionContext = { receiptScope: "alice", automaticBackground: "on" };
      const send = async (id = "original") => {
        try { return await adapter.prompt("session", id, "Retain input", undefined, undefined, undefined, undefined, "steer", context); }
        catch (error) { expect(outcome).toBe("primary-unknown"); expect(error).toBeInstanceOf(OperationOutcomeUnknownError); return "unknown"; }
      };
      const first = await send();
      expect(await send()).toEqual(first);
      expect(provider.prompts).toHaveLength(1);
      if (boundary === "ttl") {
        clock = 899_999; expect(await send()).toEqual(first); expect(provider.prompts).toHaveLength(1);
        clock = 900_000;
      } else if (boundary === "recreation") {
        await adapter.dispose();
        let id = 100;
        adapter = new ChatAdapter({ provider, workspacePath: process.cwd(), generation: "restart-equivalent", id: () => `recreated-${++id}`, now: () => clock });
        prepare();
      } else await send(boundary === "bytes" ? "evict-original-".padEnd(220, "x") : "evict-original");
      const beforeReads = provider.prompts.length;
      await adapter.history("session");
      const { events } = await adapter.subscribe("session"); events.cancel();
      expect(provider.prompts).toHaveLength(beforeReads);
      prepare();
      await send(); // explicit repeat after protection ended; not an automatic retry
      expect(provider.prompts).toHaveLength(boundary === "entries" || boundary === "bytes" ? 3 : 2);
      expect(backgrounds).toBe(outcome === "primary-unknown" ? 0 : provider.prompts.length);
      if (outcome !== "primary-unknown") {
        const prompts = provider.prompts.length;
        await adapter.backgroundBlockingWork("session", "fresh-explicit-continue").catch(error => { expect(error).toBeInstanceOf(OperationOutcomeUnknownError); });
        expect(provider.prompts).toHaveLength(prompts);
        expect(backgrounds).toBe(prompts + 1);
      }
      await adapter.dispose();
    });
  }
  test("fresh parent history supplies a running shell before its streamed tool frame arrives", async () => {
    const { adapter, provider } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
    adapter.projectionForTests("session").statusUpdate("running");
    provider.readMessages = async () => ({ items: [{ info: { id: "shell-message", role: "assistant", time: { created: 1 } }, parts: [{ id: "shell", type: "tool", tool: "shell", state: { status: "running", input: { command: "fixture only" } } }] } as never] });
    let backgrounds = 0;
    Object.assign(provider, { reconcileBackgroundTasks: async () => [], backgroundBlockingWork: async () => { backgrounds++; } });
    const result = await adapter.prompt("session", "fresh-shell", "steer", undefined, undefined, undefined, undefined, "steer", { receiptScope: "alice", automaticBackground: "on" });
    expect(result.automaticBackground).toBe("accepted");
    expect(backgrounds).toBe(1);
    await adapter.dispose();
  });

  test("standalone native steer ambiguity is retained without any automatic-policy context", async () => {
    const { adapter, provider } = steering({ capabilities: ["steering", "background-blocking-work"] });
    adapter.projectionForTests("session").statusUpdate("running");
    let admissions = 0, backgrounds = 0;
    provider.prompt = async () => { admissions++; throw new OperationOutcomeUnknownError(); };
    Object.assign(provider, { backgroundBlockingWork: async () => { backgrounds++; } });
    const send = () => adapter.prompt("session", "standalone-id", "Preserve unknown input", undefined, undefined, undefined, undefined, "steer");
    await expect(send()).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    await expect(send()).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    expect(admissions).toBe(1); expect(backgrounds).toBe(0);
    await adapter.dispose();
  });

  test("automatic eligibility excludes pending, generating, detached, settled and uncertain work; failed evidence preserves admission", async () => {
    for (const kind of ["pending", "generating", "detached", "settled", "uncertain", "unavailable", "empty-race"] as const) {
      const { adapter, provider } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
      const projection = adapter.projectionForTests("session"); projection.statusUpdate("running");
      if (kind !== "generating") projection.apply({ kind: "upsert", item: { id: "tool:call", type: "tool", name: "task", status: kind === "pending" ? "pending" : "running", createdAt: 1 } });
      let backgrounds = 0;
      Object.assign(provider, {
        reconcileBackgroundTasks: async () => {
          if (kind === "unavailable") throw new Error("read failed");
          if (!["detached", "settled", "uncertain"].includes(kind)) return [];
          return [{ id: "worker", type: "background_task", taskId: "worker", toolUseId: "call", description: kind, status: kind === "settled" ? "completed" : "running", foreground: kind !== "detached", stateUncertain: kind === "uncertain", createdAt: 1 }];
        },
        // The evidence can qualify even when the native inventory has raced
        // to empty. Its successful no-op acknowledgement is still accepted.
        backgroundBlockingWork: async () => { backgrounds++; },
      });
      const result = await adapter.prompt("session", kind, "Keep accepted input", undefined, undefined, undefined, undefined, "steer", { receiptScope: "alice", automaticBackground: "on" });
      expect(result).toMatchObject({ pending: true, delivery: "steer", automaticBackground: kind === "unavailable" ? "unavailable" : kind === "empty-race" ? "accepted" : "not-needed" });
      expect(backgrounds).toBe(kind === "empty-race" ? 1 : 0);
      expect(provider.prompts).toHaveLength(1);
      await adapter.dispose();
    }
  });

  test("automatic policy cannot background idle sends, queue/command admissions, no-op conversions, standalone or unsupported agents", async () => {
    for (const kind of ["idle", "queue", "command", "no-op", "standalone", "no-steering", "no-background"] as const) {
      const capabilities = kind === "no-steering" ? ["background-blocking-work"] as const : kind === "no-background" ? ["steering"] as const : ["steering", "background-blocking-work"] as const;
      const { adapter, provider } = steering({ capabilities: [...capabilities] });
      let backgrounds = 0;
      Object.assign(provider, { backgroundBlockingWork: async () => { backgrounds++; } });
      const projection = adapter.projectionForTests("session");
      if (kind !== "idle") projection.statusUpdate("running");
      projection.apply({ kind: "upsert", item: { id: "tool:shell", type: "tool", name: "shell", status: "running", createdAt: 1 } });
      const context = kind === "standalone" ? undefined : { receiptScope: "alice", automaticBackground: "on" as const };
      const result = await adapter.prompt("session", "primary", kind === "command" ? "/review fixture" : "Fixture input", undefined, undefined, undefined, undefined, kind === "queue" ? "queue" : "steer", context);
      if (kind === "no-op") {
        expect(backgrounds).toBe(1);
        const noOp = await adapter.changeDelivery("session", result.messageId, "already-steer", "steer", context);
        expect(noOp).not.toHaveProperty("automaticBackground");
      } else expect(result).not.toHaveProperty("automaticBackground");
      expect(backgrounds).toBe(kind === "no-op" ? 1 : 0);
      await adapter.dispose();
    }
  });

  test("automatic held conversion retains attachment and message identity before follow-up and serializes parent Stop afterward", async () => {
    const { adapter, provider } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
    const stored = { id: "11111111-2222-4333-8444-555555555555", mimeType: "image/png", absolutePath: "/fixture/attachment.png" };
    (adapter as unknown as { resolveAttachment: () => Promise<typeof stored> }).resolveAttachment = async () => stored;
    const projection = adapter.projectionForTests("session"); projection.statusUpdate("running");
    const held = await adapter.prompt("session", "held", "Image input", undefined, undefined, undefined, [{ id: stored.id, name: "fixture.png", mimeType: stored.mimeType }], "queue");
    projection.apply({ kind: "upsert", item: { id: "tool:shell", type: "tool", name: "shell", status: "running", createdAt: 1 } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    let nativeId: string | undefined;
    const admit = provider.prompt.bind(provider);
    provider.prompt = async (...args) => { const accepted = await admit(...args); nativeId = accepted.messageId; calls.push("admitted"); return accepted; };
    Object.assign(provider, { backgroundBlockingWork: async () => {
      expect(provider.prompts[0]).toMatchObject({ id: nativeId, attachments: [expect.objectContaining({ id: stored.id })] });
      calls.push("background"); await gate;
    } });
    provider.interrupt = async (_id, options) => { expect(options).toEqual({ resume: false }); calls.push("stop"); };
    const conversion = adapter.changeDelivery("session", held.messageId, "convert", "steer", { receiptScope: "alice", automaticBackground: "on" });
    await waitUntil(() => calls.includes("background"));
    const stop = adapter.abort("session", "stop-after-convert");
    expect(calls).toEqual(["admitted", "background"]);
    release();
    expect(await conversion).toMatchObject({ messageId: nativeId, automaticBackground: "accepted" });
    await stop;
    expect(calls).toEqual(["admitted", "background", "stop"]);
    expect(provider.prompts).toHaveLength(1);
    await adapter.dispose();
  });

  test("unknown batch resume remains unconfirmed despite inbox presence and cannot be resent under a fresh ID", async () => {
    const { adapter, provider, steer } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
    const projection = adapter.projectionForTests("session");
    projection.statusUpdate("running");
    const first = await steer("first", "first paused");
    await steer("second", "second paused");
    projection.statusUpdate("completed");
    let resumes = 0, backgrounds = 0;
    provider.interrupt = async () => { resumes++; throw new OperationOutcomeUnknownError(); };
    Object.assign(provider, { backgroundBlockingWork: async () => { backgrounds++; } });
    const context: ChatActionContext = { receiptScope: "alice", automaticBackground: "on" };
    await expect(adapter.sendNow("session", first.messageId, "resume", context)).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    const uncertain = await adapter.history("session");
    expect(uncertain.queued).toHaveLength(2);
    expect(uncertain.queued?.every(entry => entry.unconfirmed)).toBe(true);
    const listed = provider.pendingInbox;
    provider.pendingInbox = [];
    const absent = await adapter.history("session");
    expect(absent.queued).toHaveLength(2);
    expect(absent.queued?.every(entry => entry.unconfirmed)).toBe(true);
    await expect(adapter.removeQueued("session", first.messageId, "not-a-withdrawal-retry")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    expect(provider.cancelledInbox).toEqual([]);
    provider.pendingInbox = listed;
    await expect(adapter.sendNow("session", first.messageId, "fresh-resume", context)).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    expect(resumes).toBe(1);
    projection.statusUpdate("running");
    expect((await adapter.history("session")).queued?.some(entry => entry.unconfirmed)).toBe(false);
    expect(provider.prompts).toHaveLength(2);
    expect(backgrounds).toBe(0);
    await adapter.dispose();
  });

  test("unknown composer admission retains a bounded unconfirmed handle and original request identity for reload recovery", async () => {
    const { adapter, provider } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
    adapter.projectionForTests("session").statusUpdate("running");
    provider.prompt = async () => { throw new OperationOutcomeUnknownError(); };
    provider.listPendingInbox = async () => { throw new Error("read unavailable"); };
    const context: ChatActionContext = { receiptScope: "alice", automaticBackground: "on" };
    await expect(adapter.prompt("session", "original-request", "Keep this input", undefined, undefined, undefined, undefined, "steer", context)).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    const snapshot = await adapter.history("session");
    expect(snapshot.queued).toEqual([expect.objectContaining({ requestId: "original-request", text: "Keep this input", delivery: "steer", unconfirmed: true })]);
    const id = snapshot.queued![0]!.id;
    await expect(adapter.sendNow("session", id, "fresh-id", context)).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    await expect(adapter.removeQueued("session", id, "remove-id")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    await adapter.dispose();
  });

  for (const evidence of ["pending-event", "inbox-list"] as const) test(`composer ${evidence} before lost acknowledgement preserves correlation without merging account request-ID collisions`, async () => {
    const { adapter, provider, inbox } = steering();
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => {
        const accepted = await admit(...args);
        if (evidence === "pending-event") {
          inbox({ kind: "pending", id: accepted.messageId, text: args[1].text, delivery: "steer", at: 1 });
          await liveEventsApplied(adapter, provider);
        } else await adapter.history("session");
        throw new OperationOutcomeUnknownError();
      };
      for (const account of ["alice", "bob"]) {
        const context: ChatActionContext = { receiptScope: account, automaticBackground: "on" };
        const send = () => adapter.prompt("session", "same-request", "same text", undefined, undefined, undefined, undefined, "steer", context);
        await expect(send()).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
        await expect(send()).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      }
      provider.pendingInbox.push({ id: "unrelated-native", text: "same text", delivery: "steer", at: 1 });
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toHaveLength(3);
      expect(new Set(snapshot.queued!.map(entry => entry.submissionId)).size).toBe(3);
      expect(snapshot.queued!.filter(entry => entry.requestId === "same-request")).toHaveLength(2);
      expect(snapshot.queued!.find(entry => entry.id === "unrelated-native")).not.toHaveProperty("requestId");
      expect(snapshot.queued!.some(entry => entry.unconfirmed)).toBe(false);
      expect(provider.prompts).toHaveLength(2);
    } finally { await adapter.dispose(); await pump; }
  });

  test("positive native enqueue before a timed-out composer response fences a later different-ID acknowledgement", async () => {
    const { adapter, provider, inbox, steer } = steering({ steerAdmissionTimeoutMs: 10 });
    const pump = adapter.startEventPump();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let settled!: () => void;
    const acknowledged = new Promise<void>(resolve => { settled = resolve; });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => {
        const accepted = await admit(...args);
        inbox({ kind: "pending", id: accepted.messageId, text: args[1].text, delivery: "steer", at: 1 });
        await liveEventsApplied(adapter, provider);
        await gate;
        settled();
        return { messageId: "different-native-key" };
      };
      await expect(steer("original-request", "original input")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      release(); await acknowledged;
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toEqual([expect.objectContaining({ id: provider.prompts[0]!.id, requestId: "original-request", text: "original input" })]);
      expect(snapshot.queued![0]).not.toHaveProperty("unconfirmed");
      expect(provider.prompts).toHaveLength(1);
    } finally { release(); await adapter.dispose(); await pump; }
  });

  test("delivered composer correlation survives bounded terminal-cache eviction in later snapshots", async () => {
    const { adapter, provider, inbox, steer } = steering();
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original-request", "delivered input");
      const row: ConversationItem = { id: `message:${accepted.messageId}`, type: "user_message", text: "delivered input", requestId: accepted.messageId, createdAt: 1 };
      inbox({ kind: "settled", id: accepted.messageId, outcome: "delivered" });
      provider.eventQueue.push({ normalized: { conversationId: "session", updates: [{ kind: "upsert", item: row }], outcome: "handled", eventType: "session.inbox.delivered" } });
      await liveEventsApplied(adapter, provider);
      for (let index = 0; index < 65; index++) inbox({ kind: "settled", id: `external-${index}`, outcome: "delivered" });
      await liveEventsApplied(adapter, provider);
      const { requestId: _request, ...stored } = row;
      provider.listMessages = async () => ({ items: [stored], completeItems: [stored], accounting: [] });
      const snapshot = await adapter.history("session");
      expect(snapshot.items).toEqual([expect.objectContaining({ requestId: "original-request", text: "delivered input" })]);
      expect(projectionFromSnapshot(snapshot, [{ requestId: "original-request", messageId: "pending:original-request", text: "delivered input", unconfirmed: true }]).acceptedDrafts).toEqual([]);
    } finally { await adapter.dispose(); await pump; }
  });

  test("read-only delivery evidence during withdrawal retains the original composer correlation", async () => {
    const { adapter, provider, steer } = steering({ steerWithdrawTimeoutMs: 30 });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original-request", "deliver once");
      provider.pendingInbox = [];
      const row: ConversationItem = { id: `message:${accepted.messageId}`, type: "user_message", text: "deliver once", createdAt: 1 };
      provider.listMessages = async () => ({ items: [row], completeItems: [row], accounting: [] });
      await expect(adapter.changeDelivery("session", accepted.messageId, "too-late", "queue")).rejects.toBeInstanceOf(SteerAlreadyDeliveredError);
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toEqual([]);
      expect(projectionFromSnapshot(snapshot, [{ requestId: "original-request", messageId: "pending:original-request", text: "deliver once", unconfirmed: true }]).acceptedDrafts).toEqual([]);
      expect(provider.prompts).toHaveLength(1);
    } finally { await adapter.dispose(); }
  });

  test("native pending before a lost held conversion acknowledgement leaves one logical submission", async () => {
    const { adapter, provider, inbox, queue } = steering();
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const held = await queue("held", "preserve text");
      const admit = provider.prompt.bind(provider);
      provider.listPendingInbox = async () => { throw new Error("read unavailable"); };
      provider.prompt = async (...args) => {
        const accepted = await admit(...args);
        inbox({ kind: "pending", id: accepted.messageId, text: args[1].text, delivery: "steer", at: Date.now() });
        await liveEventsApplied(adapter, provider);
        throw new OperationOutcomeUnknownError();
      };
      await expect(adapter.changeDelivery("session", held.messageId, "switch", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toEqual([expect.objectContaining({ submissionId: held.messageId, requestId: "held", text: "preserve text", delivery: "steer" })]);
      expect(snapshot.queued![0]).not.toHaveProperty("unconfirmed");
      expect(provider.prompts).toHaveLength(1);
    } finally { await adapter.dispose(); await pump; }
  });

  for (const outcome of ["delivered", "cancelled"] as const) test(`native ${outcome} after rejected held admission retires its original owner without a transport fence`, async () => {
    const { adapter, provider, inbox, queue } = steering();
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const held = await queue("held", "original input");
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => { await admit(...args); throw new OperationOutcomeUnknownError(); };
      provider.listPendingInbox = async () => { throw new Error("read unavailable"); };
      await expect(adapter.changeDelivery("session", held.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      await queue("other", "other held input");
      inbox({ kind: "settled", id: provider.prompts[0]!.id, outcome });
      await liveEventsApplied(adapter, provider);
      expect((await adapter.history("session")).queued?.map(entry => entry.text)).toEqual(["other held input"]);
      expect(provider.prompts).toHaveLength(1);
      provider.prompt = admit;
      provider.listPendingInbox = async () => provider.pendingInbox;
      adapter.projectionForTests("session").statusUpdate("completed");
      await queue("wake", "new idle input");
      await waitUntil(() => provider.prompts.length === 2);
      expect(provider.prompts.map(entry => entry.text)).toEqual(["original input", "other held input"]);
    } finally { await adapter.dispose(); await pump; }
  });

  test("native listing during held conversion merges ownership before the acknowledgement is lost", async () => {
    const { adapter, provider, queue } = steering();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const held = await queue("held", "original input");
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => {
        await admit(...args);
        const listed = await adapter.history("session");
        expect(listed.queued).toEqual([expect.objectContaining({ delivery: "steer", submissionId: held.messageId, requestId: "held" })]);
        throw new OperationOutcomeUnknownError();
      };
      await expect(adapter.changeDelivery("session", held.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      provider.listPendingInbox = async () => { throw new Error("read unavailable"); };
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toHaveLength(1);
      expect(snapshot.queued![0]).not.toHaveProperty("unconfirmed");
    } finally { await adapter.dispose(); }
  });

  test("positive delivered history during a held admission cannot be resurrected by its lost acknowledgement", async () => {
    const { adapter, provider, queue } = steering();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const held = await queue("held", "already delivered");
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => {
        const accepted = await admit(...args);
        const row: ConversationItem = { id: `message:${accepted.messageId}`, type: "user_message", text: args[1].text, createdAt: 1 };
        provider.listMessages = async () => ({ items: [row], completeItems: [row], accounting: [] });
        expect((await adapter.history("session")).queued).toEqual([]);
        throw new OperationOutcomeUnknownError();
      };
      await expect(adapter.changeDelivery("session", held.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      provider.listPendingInbox = async () => { throw new Error("read unavailable"); };
      expect((await adapter.history("session")).queued).toEqual([]);
      expect(provider.prompts).toHaveLength(1);
    } finally { await adapter.dispose(); }
  });

  for (const timing of ["event-before-deadline", "event-after-deadline", "event-after-rejection"] as const) for (const outcome of ["delivered", "cancelled"] as const) test(`${timing} held conversion keeps one owner through native ${outcome} and releases later held input`, async () => {
    const attachment = { id: "11111111-2222-4333-8444-555555555555", name: "fixture.png", mimeType: "image/png" };
    const { adapter, provider, inbox, queue } = steering({ steerAdmissionTimeoutMs: 30, resolveAttachment: async () => ({ ...attachment, absolutePath: "/fixture/attachment.png" }) });
    const pump = adapter.startEventPump();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      provider.configurations.set("session", { model: provider.models[0]!.selection, mode: "build", variant: "high" });
      const held = await adapter.prompt("session", "held", "original input", undefined, undefined, undefined, [attachment], "queue");
      await queue("other", "other held input");
      const admit = provider.prompt.bind(provider);
      provider.listPendingInbox = async () => { throw new Error("read unavailable"); };
      const pendingEvent = () => inbox({ kind: "pending", id: provider.prompts[0]!.id, text: "original input", delivery: "steer", attachments: [attachment], at: Date.now() });
      provider.prompt = async (...args) => {
        await admit(...args);
        if (timing === "event-before-deadline") { pendingEvent(); await liveEventsApplied(adapter, provider); }
        if (timing !== "event-after-rejection") await gate;
        throw new OperationOutcomeUnknownError();
      };
      const convert = () => adapter.changeDelivery("session", held.messageId, "convert", "steer");
      await expect(convert()).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      await expect(convert()).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      if (timing !== "event-before-deadline") { pendingEvent(); await liveEventsApplied(adapter, provider); }
      const nativeId = provider.prompts[0]!.id;
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toEqual([
        expect.objectContaining({ id: nativeId, submissionId: held.messageId, text: "original input", requestId: "held", attachments: [attachment], delivery: "steer" }),
        expect.objectContaining({ text: "other held input", delivery: "queue" }),
      ]);
      expect(snapshot.queued![0]).not.toHaveProperty("unconfirmed");
      expect(provider.prompts[0]).not.toHaveProperty("model");
      expect(provider.prompts[0]).not.toHaveProperty("mode");
      expect(provider.prompts[0]).not.toHaveProperty("variant");
      if (outcome === "cancelled") {
        provider.cancelInbox = async (_sessionId, id) => { provider.cancelledInbox.push(id); inbox({ kind: "settled", id, outcome }); };
        await adapter.removeQueued("session", nativeId, "cancel");
        expect(provider.cancelledInbox).toEqual([nativeId]);
      } else { inbox({ kind: "settled", id: nativeId, outcome }); await liveEventsApplied(adapter, provider); }
      release();
      await liveEventsApplied(adapter, provider);
      expect((await adapter.history("session")).queued?.map(entry => entry.text)).toEqual(["other held input"]);
      expect(provider.prompts).toHaveLength(1);
      provider.prompt = admit;
      provider.listPendingInbox = async () => provider.pendingInbox;
      adapter.projectionForTests("session").statusUpdate("completed");
      await queue("wake", "new idle input");
      await waitUntil(() => provider.prompts.length === 2);
      expect(provider.prompts.map(entry => entry.text)).toEqual(["original input", "other held input"]);
    } finally { release(); await adapter.dispose(); await pump; }
  });

  test("native pending confirmation of unknown admission wins over an older empty inbox read", async () => {
    const { adapter, provider, inbox, steer } = steering();
    const pump = adapter.startEventPump();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => { await admit(...args); throw new OperationOutcomeUnknownError(); };
      await expect(steer("original", "uncertain input")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      provider.listPendingInbox = async () => { entered(); await gate; return []; };
      const read = adapter.history("session");
      await started;
      inbox({ kind: "pending", id: provider.prompts[0]!.id, text: "uncertain input", delivery: "steer", at: Date.now() });
      await liveEventsApplied(adapter, provider);
      release();
      const snapshot = await read;
      expect(snapshot.queued).toEqual([expect.objectContaining({ text: "uncertain input", delivery: "steer", requestId: "original" })]);
      expect(snapshot.queued![0]).not.toHaveProperty("unconfirmed");
      expect(provider.prompts).toHaveLength(1);
    } finally { release(); await adapter.dispose(); await pump; }
  });

  test("native admission evidence settles a dormant held conversion without proving resume or releasing other input", async () => {
    const { adapter, provider, inbox, queue } = steering();
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const held = await queue("held", "original input");
      await queue("other", "other held input");
      await adapter.abort("session", "stop");
      const admit = provider.prompt.bind(provider);
      provider.listPendingInbox = async () => { throw new Error("read unavailable"); };
      provider.prompt = async (...args) => {
        const accepted = await admit(...args);
        inbox({ kind: "pending", id: accepted.messageId, text: args[1].text, delivery: "steer", at: Date.now() });
        await liveEventsApplied(adapter, provider);
        throw new OperationOutcomeUnknownError();
      };
      await expect(adapter.changeDelivery("session", held.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toEqual([
        expect.objectContaining({ text: "original input", delivery: "steer", paused: true }),
        expect.objectContaining({ text: "other held input", delivery: "queue", paused: true }),
      ]);
      expect(snapshot.queued![0]).not.toHaveProperty("unconfirmed");
      expect(provider.interruptOptions).toEqual([{ resume: false }]);
      expect(provider.prompts).toHaveLength(1);
    } finally { await adapter.dispose(); await pump; }
  });

  for (const evidence of ["snapshot", "event"] as const) test(`held unknown admission pauses followers until positive ${evidence} evidence without additional writes`, async () => {
    const { adapter, provider, queue, inbox } = steering();
    const pump = adapter.startEventPump();
    const seen: ChatEvent[] = [];
    const client = await adapter.subscribe("session");
    const collecting = (async () => { for await (const event of client.events) seen.push(event); })();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const head = await queue("head", "head");
      const behind = await queue("behind", "behind");
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      await expect(adapter.changeDelivery("session", head.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      adapter.projectionForTests("session").statusUpdate("idle");
      await admissionsApplied(adapter);
      expect(provider.prompts.map(item => item.text)).toEqual(["head"]);
      expect((await adapter.history("session")).queued?.find(item => item.id === behind.messageId)).toMatchObject({ paused: true });
      const nativeId = provider.prompts[0]!.id;
      if (evidence === "snapshot") provider.pendingInbox = [{ id: nativeId, text: "head", delivery: "steer", at: 1 }];
      else { inbox({ kind: "pending", id: nativeId, text: "head", delivery: "steer", at: 1 }); await liveEventsApplied(adapter, provider); }
      expect((await adapter.history("session")).queued?.find(item => item.id === behind.messageId)).not.toHaveProperty("paused");
      await flushRecoveryIo();
      expect(seen.filter(event => event.type === "conversation.queue" && event.change.messageId === behind.messageId)
        .flatMap(event => event.type === "conversation.queue" && ["paused", "resumed"].includes(event.change.kind) ? [event.change.kind] : [])).toEqual(["paused", "resumed"]);
      expect(provider.prompts.map(item => item.text)).toEqual(["head"]);
      expect(provider.cancelledInbox).toEqual([]);
      expect(provider.interrupts).toEqual([]);
    } finally { client.events.cancel(); await collecting; await adapter.dispose(); await pump; }
  });

  test("an uncertain held entry pauses only its held suffix, not earlier messages", async () => {
    const { adapter, provider, queue } = steering();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const before = await queue("before", "before");
      const head = await queue("head", "head");
      const behind = await queue("behind", "behind");
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      await expect(adapter.changeDelivery("session", head.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const pending = (await adapter.history("session")).queued!;
      expect(pending.find(item => item.id === before.messageId)).not.toHaveProperty("paused");
      expect(pending.find(item => item.id === head.messageId)).toMatchObject({ paused: true, unconfirmed: true });
      expect(pending.find(item => item.id === behind.messageId)).toMatchObject({ paused: true });
    } finally { await adapter.dispose(); }
  });

  test("pending-map unknown admission does not pause or block an otherwise deliverable held follower", async () => {
    const { adapter, provider, queue, steer } = steering();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accept = provider.prompt.bind(provider);
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      await expect(steer("original", "original")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const behind = await queue("behind", "behind");
      expect((await adapter.history("session")).queued?.find(item => item.id === behind.messageId)).not.toHaveProperty("paused");
      provider.prompt = accept;
      adapter.projectionForTests("session").statusUpdate("idle");
      await admissionsApplied(adapter);
      expect(provider.prompts.map(item => item.text)).toEqual(["original", "behind"]);
    } finally { await adapter.dispose(); }
  });

  test("accepted explicit Queue after Stop and local discard resumes FIFO while rejected Queue preserves the barrier", async () => {
    const { adapter, provider, queue } = steering();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const head = await queue("head", "head");
      const behind = await queue("behind", "behind");
      await adapter.abort("session", "stop");
      const accept = provider.prompt.bind(provider);
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      await expect(adapter.changeDelivery("session", head.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const unknown = (await adapter.history("session")).queued!.find(item => item.id === head.messageId)!;
      const discarding = adapter.discardUnconfirmedSteer("session", head.messageId, "discard", unknown.admissionUncertaintyId!);
      // This idle drain predates the discard's fresh-idle fence.
      adapter.projectionForTests("session").statusUpdate("idle");
      await discarding;
      await admissionsApplied(adapter);
      expect(provider.prompts.map(item => item.text)).toEqual(["head"]);
      provider.prompt = accept;
      expect(await queue("behind", "behind")).toMatchObject({ messageId: behind.messageId, pending: true, delivery: "queue" });
      await admissionsApplied(adapter);
      expect(provider.prompts.map(item => item.text)).toEqual(["head"]);
      await expect(adapter.prompt("session", "invalid", "invalid", { providerId: "missing", modelId: "missing" }, undefined, undefined, undefined, "queue")).rejects.toBeInstanceOf(InvalidModelSelectionError);
      await admissionsApplied(adapter);
      expect(provider.prompts.map(item => item.text)).toEqual(["head"]);
      expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ text: "behind", paused: true })]);
      expect(await queue("new", "new")).toMatchObject({ pending: true, delivery: "queue" });
      await admissionsApplied(adapter);
      expect(provider.prompts.map(item => item.text)).toEqual(["head", "behind"]);
      adapter.projectionForTests("session").statusUpdate("idle");
      await admissionsApplied(adapter);
      expect(provider.prompts.map(item => item.text)).toEqual(["head", "behind", "new"]);
      expect(provider.cancelledInbox).toEqual([]);
      expect(provider.interruptOptions).toEqual([{ resume: false }]);
    } finally { await adapter.dispose(); }
  });

  for (const origin of ["held", "composer"] as const) test(`local discard of unknown ${origin} admission sends nothing, fences an old idle drain and permits explicit Send now`, async () => {
    const { adapter, provider, queue, steer } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
    let backgrounds = 0;
    Object.assign(provider, { backgroundBlockingWork: async () => { backgrounds++; } });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accept = provider.prompt.bind(provider);
      let headId: string;
      if (origin === "held") headId = (await queue("head", "head")).messageId;
      else headId = "";
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      if (origin === "held") await expect(adapter.changeDelivery("session", headId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      else {
        await expect(steer("head", "head")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
        headId = provider.prompts[0]!.id;
      }
      const behind = await queue("behind", "behind");
      const entry = (await adapter.history("session")).queued!.find(item => item.id === headId)!;
      expect(entry.admissionUncertaintyId).toEqual(expect.any(String));
      const lookup = spyOn(provider, "getSession");
      const discarding = adapter.discardUnconfirmedSteer("session", headId, "discard", entry.admissionUncertaintyId!);
      // This drain is queued behind the discard but belongs to its old queue.
      adapter.projectionForTests("session").statusUpdate("idle");
      expect(await discarding).toEqual({ discarded: true, outcomeUnconfirmed: true });
      await admissionsApplied(adapter);
      expect(lookup).not.toHaveBeenCalled();
      lookup.mockRestore();
      expect(await adapter.discardUnconfirmedSteer("session", headId, "discard", entry.admissionUncertaintyId!)).toEqual({ discarded: true, outcomeUnconfirmed: true });
      expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: behind.messageId, text: "behind", delivery: "queue" })]);
      expect(provider.prompts.map(item => item.text)).toEqual(["head"]);
      expect(provider.cancelledInbox).toEqual([]);
      expect(provider.interrupts).toEqual([]);
      expect(backgrounds).toBe(0);
      provider.prompt = accept;
      await adapter.sendNow("session", behind.messageId, "explicit-send");
      expect(provider.prompts.map(item => item.text)).toEqual(["head", "behind"]);
    } finally { await adapter.dispose(); }
  });

  test("discard rejects wrong and confirmed tokens, and cannot replay the original unknown request", async () => {
    const { adapter, provider, steer } = steering();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      await expect(steer("original", "original")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const first = (await adapter.history("session")).queued![0]!;
      await expect(adapter.discardUnconfirmedSteer("session", first.id, "wrong", "wrong-token")).rejects.toBeInstanceOf(InteractionConflictError);
      expect((await adapter.history("session")).queued![0]!.admissionUncertaintyId).toBe(first.admissionUncertaintyId);
      provider.pendingInbox = [{ id: first.id, text: first.text, delivery: "steer", at: 1 }];
      expect((await adapter.history("session")).queued![0]).not.toHaveProperty("admissionUncertaintyId");
      await expect(adapter.discardUnconfirmedSteer("session", first.id, "stale", first.admissionUncertaintyId!)).rejects.toBeInstanceOf(InteractionConflictError);
      await expect(steer("original", "original")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      await expect(steer("second", "second")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const second = (await adapter.history("session")).queued!.find(entry => entry.text === "second")!;
      expect(second.admissionUncertaintyId).not.toBe(first.admissionUncertaintyId);
      await adapter.discardUnconfirmedSteer("session", second.id, "discard", second.admissionUncertaintyId!);
      // Reusing a client nonce for a different target must not return another
      // entry's cached success or bypass this entry's changed-token check.
      await expect(adapter.discardUnconfirmedSteer("session", first.id, "discard", first.admissionUncertaintyId!)).rejects.toBeInstanceOf(InteractionConflictError);
      await expect(steer("second", "second")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      expect(provider.prompts.map(entry => entry.text)).toEqual(["original", "second"]);
      expect(provider.cancelledInbox).toEqual([]);
    } finally { await adapter.dispose(); }
  });

  test("a timed-out but still-pending admission offers no discard token until the transport settles unknown", async () => {
    const { adapter, provider, steer } = steering({ steerAdmissionTimeoutMs: 10 });
    let reject!: (error: Error) => void;
    const pending = new Promise<{ messageId: string }>((_resolve, fail) => { reject = fail; });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); return pending; };
      jest.useFakeTimers();
      const sending = steer("original", "original");
      await flushRecoveryIo();
      const during = (await adapter.history("session")).queued ?? [];
      expect(during.every(entry => !entry.admissionUncertaintyId)).toBe(true);
      jest.advanceTimersByTime(10);
      await expect(sending).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const timedOut = (await adapter.history("session")).queued![0]!;
      expect(timedOut).toMatchObject({ unconfirmed: true });
      expect(timedOut).not.toHaveProperty("admissionUncertaintyId");
      await expect(adapter.discardUnconfirmedSteer("session", timedOut.id, "pending-discard", "invented-token")).rejects.toBeInstanceOf(InteractionConflictError);
      reject(new OperationOutcomeUnknownError());
      await flushRecoveryIo();
      const settled = (await adapter.history("session")).queued![0]!;
      expect(settled.admissionUncertaintyId).toEqual(expect.any(String));
      await adapter.discardUnconfirmedSteer("session", settled.id, "settled-discard", settled.admissionUncertaintyId!);
      expect(provider.prompts).toHaveLength(1);
    } finally { reject(new OperationOutcomeUnknownError()); await adapter.dispose(); jest.useRealTimers(); }
  });

  for (const uncertainty of ["resume", "withdrawal"] as const) test(`local discard never applies to ${uncertainty} uncertainty`, async () => {
    const { adapter, provider, steer } = steering({ steerWithdrawTimeoutMs: 10 });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("steer", "native input");
      if (uncertainty === "resume") {
        adapter.projectionForTests("session").statusUpdate("interrupted");
        provider.interrupt = async () => { throw new OperationOutcomeUnknownError(); };
        await expect(adapter.sendNow("session", accepted.messageId, "resume")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      } else await expect(adapter.removeQueued("session", accepted.messageId, "withdraw")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      const entry = (await adapter.history("session")).queued![0]!;
      expect(entry).toMatchObject({ unconfirmed: true });
      expect(entry).not.toHaveProperty("admissionUncertaintyId");
      const before = provider.cancelledInbox.length;
      await expect(adapter.discardUnconfirmedSteer("session", entry.id, "discard", "invented-token")).rejects.toBeInstanceOf(InteractionConflictError);
      expect(provider.cancelledInbox).toHaveLength(before);
      expect(provider.prompts).toHaveLength(1);
      expect((await adapter.history("session")).queued).toHaveLength(1);
    } finally { await adapter.dispose(); }
  });

  test("discard fences a stale inbox read but preserves later positive native pending and delivered history", async () => {
    const { adapter, provider, queue, inbox } = steering();
    const pump = adapter.startEventPump();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reading: ReturnType<ChatAdapter["history"]> | undefined;
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const head = await queue("head", "head");
      await queue("behind", "behind");
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      await expect(adapter.changeDelivery("session", head.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const uncertain = (await adapter.history("session")).queued![0]!;
      const nativeId = provider.prompts[0]!.id;
      let entered = false;
      provider.listPendingInbox = async () => { entered = true; await gate; return [{ id: nativeId, text: "head", delivery: "steer", at: 1 }]; };
      reading = adapter.history("session");
      await waitUntil(() => entered);
      await adapter.discardUnconfirmedSteer("session", head.messageId, "discard", uncertain.admissionUncertaintyId!);
      release();
      expect((await reading).queued?.map(entry => entry.text)).toEqual(["behind"]);
      provider.listPendingInbox = async () => provider.pendingInbox;
      inbox({ kind: "pending", id: nativeId, text: "head", delivery: "steer", at: 2 });
      await liveEventsApplied(adapter, provider);
      const native = (await adapter.history("session")).queued!;
      expect(native.map(entry => entry.id)).not.toContain(head.messageId);
      expect(native.filter(entry => entry.text === "head")).toEqual([expect.objectContaining({ id: nativeId, delivery: "steer" })]);
      expect(native[0]).not.toHaveProperty("admissionUncertaintyId");
      inbox({ kind: "settled", id: nativeId, outcome: "delivered" });
      await liveEventsApplied(adapter, provider);
      provider.pages.set("first", { items: [{ id: nativeId, type: "user", time: { created: 3 }, text: "head" }] });
      const delivered = await adapter.history("session");
      expect(delivered.items).toContainEqual(expect.objectContaining({ id: `message:${nativeId}`, type: "user_message", text: "head" }));
      expect(delivered.queued?.map(entry => entry.text)).toEqual(["behind"]);
      expect(provider.prompts).toHaveLength(1);
      expect(provider.cancelledInbox).toEqual([]);
    } finally { release(); await reading; await adapter.dispose(); await pump; }
  });

  test("discard Keep queued survives derived completion and drains only on a later normal idle transition", async () => {
    const { adapter, provider, queue } = steering();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const head = await queue("head", "head");
      await queue("behind", "behind");
      const accept = provider.prompt.bind(provider);
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      await expect(adapter.changeDelivery("session", head.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const entry = (await adapter.history("session")).queued![0]!;
      await adapter.discardUnconfirmedSteer("session", head.messageId, "discard", entry.admissionUncertaintyId!);
      const finished = { id: "task:finished", type: "background_task" as const, taskId: "finished", description: "Finished", createdAt: 1, status: "completed" as const };
      adapter.projectionForTests("session").apply({ kind: "upsert", item: finished });
      adapter.projectionForTests("session").statusUpdate("background");
      Object.assign(provider, { reconcileBackgroundTasks: async () => [finished] });
      expect((await adapter.history("session")).conversation.status).toBe("completed");
      await admissionsApplied(adapter);
      expect(provider.prompts.map(item => item.text)).toEqual(["head"]);
      provider.prompt = accept;
      adapter.projectionForTests("session").statusUpdate("idle");
      await admissionsApplied(adapter);
      expect(provider.prompts.map(item => item.text)).toEqual(["head", "behind"]);
      expect((await adapter.history("session")).queued).toEqual([]);
    } finally { await adapter.dispose(); }
  });

  for (const failure of ["unknown", "definite", "timeout"] as const) for (const release of ["idle", "explicit"] as const) test(`failed Send now (${failure}) preserves unrelated Keep queued input until ${release} evidence`, async () => {
    const { adapter, provider, queue } = steering({ steerAdmissionTimeoutMs: 10 });
    let rejectTransport!: (error: Error) => void;
    const transport = new Promise<{ messageId: string }>((_resolve, reject) => { rejectTransport = reject; });
    // Only the timeout case consumes this promise.
    void transport.catch(() => undefined);
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const head = await queue("head", "head");
      const behind = await queue("behind", "behind");
      const selected = await queue("selected", "selected");
      const accept = provider.prompt.bind(provider);
      provider.prompt = async (sessionId, input) => {
        if (input.text === "behind") return accept(sessionId, input);
        provider.prompts.push({ sessionId, ...input });
        if (input.text === "selected" && failure === "timeout") return transport;
        if (input.text === "selected" && failure === "definite") throw new Error("definite admission refusal");
        throw new OperationOutcomeUnknownError();
      };
      await expect(adapter.changeDelivery("session", head.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      adapter.projectionForTests("session").statusUpdate("idle");
      await admissionsApplied(adapter);
      const unknown = (await adapter.history("session")).queued!.find(entry => entry.id === head.messageId)!;
      await adapter.discardUnconfirmedSteer("session", head.messageId, "discard", unknown.admissionUncertaintyId!);
      if (failure === "timeout") jest.useFakeTimers();
      const sending = adapter.sendNow("session", selected.messageId, "send-selected").catch(error => error);
      if (failure === "timeout") { await flushRecoveryIo(); jest.advanceTimersByTime(10); }
      expect(await sending).toBeInstanceOf(failure === "definite" ? Error : OperationOutcomeUnknownError);
      await admissionsApplied(adapter);
      expect(provider.prompts.map(entry => [entry.text, entry.delivery])).toEqual([["head", "steer"], ["selected", "steer"]]);
      expect((await adapter.history("session")).queued?.filter(entry => entry.delivery === "queue")).toEqual([
        expect.objectContaining({ id: behind.messageId, paused: true }),
        expect.objectContaining({ id: selected.messageId, paused: true }),
      ]);
      if (release === "idle") {
        adapter.projectionForTests("session").statusUpdate("idle");
        await admissionsApplied(adapter);
      } else await adapter.sendNow("session", behind.messageId, "explicit-behind");
      expect(provider.prompts.map(entry => entry.text)).toEqual(["head", "selected", "behind"]);
      expect(provider.prompts.at(-1)!.delivery).toBe(release === "idle" ? "queue" : "steer");
      expect(provider.cancelledInbox).toEqual([]);
    } finally { rejectTransport(new OperationOutcomeUnknownError()); await adapter.dispose(); jest.useRealTimers(); }
  });

  for (const failure of ["configuration", "attachment"] as const) test(`${failure} preflight failure preserves Keep queued input across projection recreation`, async () => {
    let attachmentAvailable = true;
    const { adapter, provider, queue } = steering({ resolveAttachment: async id => attachmentAvailable && id === "asset" ? { id, mimeType: "image/png", absolutePath: `${process.cwd()}/fake-asset.png` } : null });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const head = await queue("head", "head");
      const behind = await queue("behind", "behind");
      const selected = await adapter.prompt("session", "selected", "selected", undefined, undefined, undefined,
        failure === "attachment" ? [{ id: "asset", name: "asset.png", mimeType: "image/png" }] : undefined, "queue");
      const accept = provider.prompt.bind(provider);
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      await expect(adapter.changeDelivery("session", head.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      adapter.projectionForTests("session").statusUpdate("idle");
      await admissionsApplied(adapter);
      const unknown = (await adapter.history("session")).queued!.find(entry => entry.id === head.messageId)!;
      await adapter.discardUnconfirmedSteer("session", head.messageId, "discard", unknown.admissionUncertaintyId!);
      for (let index = 0; index < 70; index++) adapter.projectionForTests(`preflight-evict-${index}`);
      if (failure === "configuration") {
        provider.getConversationConfiguration = async () => { throw new Error("configuration unavailable"); };
        await expect(adapter.prompt("session", "new-draft", "preserve this draft", undefined, undefined, undefined, undefined, "steer")).rejects.toThrow("configuration unavailable");
        provider.getConversationConfiguration = async () => ({});
      } else {
        attachmentAvailable = false;
        await expect(adapter.sendNow("session", selected.messageId, "failed-preflight")).rejects.toBeInstanceOf(UnknownAttachmentError);
        attachmentAvailable = true;
      }
      await admissionsApplied(adapter);
      expect(provider.prompts.map(entry => entry.text)).toEqual(["head"]);
      expect((await adapter.history("session")).queued).toEqual([
        expect.objectContaining({ id: behind.messageId, paused: true }),
        expect.objectContaining({ id: selected.messageId, paused: true }),
      ]);
      provider.prompt = accept;
      await adapter.sendNow("session", selected.messageId, "explicit-selected");
      expect(provider.prompts.map(entry => entry.text)).toEqual(["head", "selected"]);
      adapter.projectionForTests("session").statusUpdate("idle");
      await admissionsApplied(adapter);
      expect(provider.prompts.map(entry => entry.text)).toEqual(["head", "selected", "behind"]);
    } finally { await adapter.dispose(); }
  });

  test("discard rechecks exact ownership after a native confirmation overtakes its admission lane", async () => {
    const { adapter, provider, queue, inbox } = steering();
    const pump = adapter.startEventPump();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const head = await queue("head", "head");
      const behind = await queue("behind", "behind");
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); throw new OperationOutcomeUnknownError(); };
      await expect(adapter.changeDelivery("session", head.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const entry = (await adapter.history("session")).queued![0]!;
      const nativeId = provider.prompts[0]!.id;
      provider.prompt = async (sessionId, input) => { provider.prompts.push({ sessionId, ...input }); await gate; return { messageId: input.id }; };
      const sending = adapter.sendNow("session", behind.messageId, "send-other");
      await waitUntil(() => provider.prompts.length === 2);
      const discarding = adapter.discardUnconfirmedSteer("session", head.messageId, "discard", entry.admissionUncertaintyId!);
      inbox({ kind: "pending", id: nativeId, text: "head", delivery: "steer", at: 1 });
      await liveEventsApplied(adapter, provider);
      release(); await sending;
      await expect(discarding).rejects.toBeInstanceOf(InteractionConflictError);
      expect((await adapter.history("session")).queued).toContainEqual(expect.objectContaining({ id: nativeId, text: "head", delivery: "steer" }));
      expect(provider.cancelledInbox).toEqual([]);
    } finally { release(); await adapter.dispose(); await pump; }
  });

  test("a genuinely unknown held head remains a no-replay barrier after idle and two empty history reads", async () => {
    const { adapter, provider, queue } = steering();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const head = await queue("head", "head");
      const behind = await queue("behind", "behind");
      provider.prompt = async (sessionId, input) => {
        provider.prompts.push({ sessionId, ...input });
        throw new OperationOutcomeUnknownError(); // Nothing landed, but Uatu cannot know that.
      };
      await expect(adapter.changeDelivery("session", head.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      adapter.projectionForTests("session").statusUpdate("idle");
      await admissionsApplied(adapter);
      for (let read = 0; read < 2; read++) {
        expect((await adapter.history("session")).queued).toEqual([
          expect.objectContaining({ id: head.messageId, unconfirmed: true, paused: true }),
          expect.objectContaining({ id: behind.messageId }),
        ]);
      }
      await expect(adapter.removeQueued("session", head.messageId, "remove")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      await expect(adapter.sendNow("session", head.messageId, "send-now")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      await expect(adapter.changeDelivery("session", head.messageId, "convert-again", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      expect(provider.pendingInbox).toEqual([]);
      expect(provider.prompts.map(entry => entry.text)).toEqual(["head"]);
    } finally { await adapter.dispose(); }
  });

  test("inbox reconciliation during held dispatch cannot leave the accepted head queued for replay", async () => {
    const { adapter, provider, queue } = steering();
    let release!: () => void;
    const dispatchGate = new Promise<void>(resolve => { release = resolve; });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const head = await queue("head", "head");
      const second = await queue("second", "second");
      provider.prompt = async (sessionId, input) => {
        provider.prompts.push({ sessionId, ...input });
        throw new OperationOutcomeUnknownError();
      };
      await expect(adapter.changeDelivery("session", second.messageId, "convert", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const nativeId = provider.prompts[0]!.id;
      provider.prompt = async (sessionId, input) => {
        provider.prompts.push({ sessionId, ...input });
        await dispatchGate;
        return { messageId: input.id };
      };
      adapter.projectionForTests("session").statusUpdate("idle");
      await waitUntil(() => provider.prompts.length === 2);
      provider.pendingInbox = [{ id: nativeId, text: "second", delivery: "steer", at: 1 }];
      expect((await adapter.history("session")).queued?.map(entry => entry.text)).toEqual(["second", "head"]);
      release();
      await admissionsApplied(adapter);
      adapter.projectionForTests("session").statusUpdate("idle");
      await admissionsApplied(adapter);
      expect(provider.prompts.map(entry => entry.text)).toEqual(["second", "head"]);
      expect((await adapter.history("session")).queued?.map(entry => entry.id)).not.toContain(head.messageId);
    } finally { release(); await adapter.dispose(); }
  });

  test("unknown held-to-steer admission blocks fresh-ID resend and queue release until read-only confirmation", async () => {
    const { adapter, provider, queue } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
    adapter.projectionForTests("session").statusUpdate("running");
    const held = await queue("held", "preserve text");
    const admit = provider.prompt.bind(provider);
    provider.prompt = async (...args) => { await admit(...args); throw new OperationOutcomeUnknownError(); };
    provider.listPendingInbox = async () => { throw new Error("read unavailable"); };
    let backgrounds = 0;
    Object.assign(provider, { backgroundBlockingWork: async () => { backgrounds++; } });
    const context: ChatActionContext = { receiptScope: "alice", automaticBackground: "on" };
    await expect(adapter.changeDelivery("session", held.messageId, "switch", "steer", context)).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    await expect(adapter.sendNow("session", held.messageId, "new-id", context)).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    await expect(adapter.removeQueued("session", held.messageId, "remove")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    expect(provider.prompts).toHaveLength(1);
    const unconfirmed = await adapter.history("session");
    expect(unconfirmed.queued).toEqual([expect.objectContaining({ id: held.messageId, text: "preserve text", unconfirmed: true })]);
    provider.listPendingInbox = async () => provider.pendingInbox;
    const recovered = await adapter.history("session");
    expect(recovered.queued).toEqual([expect.objectContaining({ text: "preserve text", delivery: "steer" })]);
    expect(recovered.queued?.[0]).not.toHaveProperty("unconfirmed");
    expect(backgrounds).toBe(0);
    expect(provider.prompts).toHaveLength(1);
    await adapter.dispose();
  });

  test("primary admission unknown is retained without a second prompt or a late follow-up", async () => {
    for (const unknown of ["transport", "timeout"] as const) {
      const { adapter, provider } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"], steerAdmissionTimeoutMs: 10 });
      const projection = adapter.projectionForTests("session");
      projection.statusUpdate("running");
      projection.apply({ kind: "upsert", item: { id: "tool:shell", type: "tool", name: "shell", status: "running", createdAt: 1 } });
      const admit = provider.prompt.bind(provider);
      let release!: () => void, backgrounds = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      provider.prompt = async (...args) => {
        const accepted = await admit(...args);
        if (unknown === "transport") throw new OperationOutcomeUnknownError();
        await gate;
        return accepted;
      };
      Object.assign(provider, { backgroundBlockingWork: async () => { backgrounds++; } });
      const context: ChatActionContext = { receiptScope: "alice", automaticBackground: "on" };
      const send = () => adapter.prompt("session", "uncertain", "keep this text", undefined, undefined, undefined, undefined, "steer", context);
      await expect(send()).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      await expect(send()).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      expect(provider.prompts).toHaveLength(1);
      release();
      await gate;
      await Promise.resolve();
      expect(backgrounds).toBe(0);
      const snapshot = await adapter.history("session");
      expect(snapshot.queued?.map(message => message.text)).toEqual(["keep this text"]);
      await adapter.dispose();
    }
  });

  test("every accepted steer transition follows once under ON and never under OFF, including one follow-up per batch resume", async () => {
    for (const action of ["composer", "convert", "held-now", "paused-now", "replacement"] as const) for (const enabled of [true, false]) {
      const { adapter, provider, queue, steer } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
      const context: ChatActionContext = { receiptScope: "alice", automaticBackground: enabled ? "on" : "off" };
      const projection = adapter.projectionForTests("session");
      projection.statusUpdate("running");
      projection.apply({ kind: "upsert", item: { id: "tool:shell", type: "tool", name: "shell", status: "running", createdAt: 1 } });
      const calls: string[] = [];
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => { const accepted = await admit(...args); calls.push("admit"); return accepted; };
      Object.assign(provider, {
        backgroundBlockingWork: async () => { calls.push("background"); },
        // Replacement reconciliation correctly discards the old transcript.
        // Fresh provider evidence, not that discarded tool row, qualifies.
        reconcileBackgroundTasks: async () => [{ id: "worker:live", type: "background_task", taskId: "live", description: "Still blocking", status: "running", foreground: true, createdAt: 1 }],
      });
      let result: { automaticBackground?: string };
      if (action === "composer" || action === "replacement") {
        if (action === "replacement") {
          provider.agent.capabilities.push("reversible-history");
          provider.getReversibleHistoryState = async () => ({ staged: true, canUndo: false, canRedo: true, revertedMessages: [] });
          const unchanged = async (): Promise<ReversibleHistoryResult> => ({ outcome: "nothing-to-undo", state: { staged: true, canUndo: false, canRedo: true, revertedMessages: [] } });
          provider.undo = unchanged;
          provider.redo = unchanged;
          provider.revert = unchanged;
          provider.restore = unchanged;
        }
        result = await adapter.prompt("session", "primary", "steer", undefined, undefined, undefined, undefined, action === "replacement" ? "queue" : "steer", context);
      } else if (action === "paused-now") {
        const first = await steer("first", "first paused");
        await steer("second", "second paused");
        projection.statusUpdate("completed");
        calls.length = 0;
        provider.interrupt = async (_id, options) => {
          expect(options).toEqual({ resume: true }); calls.push("resume"); projection.statusUpdate("running");
        };
        result = await adapter.sendNow("session", first.messageId, "resume", context);
        expect(provider.prompts).toHaveLength(2);
      } else {
        const held = await queue("held", "held input");
        expect(calls).toEqual([]);
        result = action === "convert" ? await adapter.changeDelivery("session", held.messageId, "convert", "steer", context)
          : await adapter.sendNow("session", held.messageId, "send-now", context);
      }
      expect(calls, `${action}, policy ${enabled ? "ON" : "OFF"}`).toEqual([action === "paused-now" ? "resume" : "admit", ...(enabled ? ["background"] : [])]);
      expect(result.automaticBackground).toBe(enabled ? "accepted" : undefined);
      await adapter.dispose();
    }
  });

  test("late eligibility never backgrounds after its bound, and dispatched unknown follows remain receipt-protected", async () => {
    for (const stage of ["evidence", "background"] as const) {
      const { adapter, provider } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"], automaticBackgroundTimeoutMs: 10 });
      adapter.projectionForTests("session").statusUpdate("running");
      adapter.projectionForTests("session").apply({ kind: "upsert", item: { id: "tool:shell", type: "tool", name: "shell", status: "running", createdAt: 1 } });
      let release!: () => void, backgrounds = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      if (stage === "evidence") Object.assign(provider, { reconcileBackgroundTasks: async () => { await gate; return []; } });
      Object.assign(provider, { backgroundBlockingWork: async () => { backgrounds++; if (stage === "background") await gate; } });
      const context = { receiptScope: "alice", automaticBackground: "on" as const };
      const send = () => adapter.prompt("session", "bounded", "steer", undefined, undefined, undefined, undefined, "steer", context);
      const result = await send();
      expect(result).toMatchObject({ pending: true, delivery: "steer", automaticBackground: stage === "evidence" ? "unavailable" : "unknown" });
      release();
      await gate;
      await Promise.resolve();
      expect(await send()).toEqual(result);
      expect(provider.prompts).toHaveLength(1);
      expect(backgrounds).toBe(stage === "evidence" ? 0 : 1);
      const { snapshot, events } = await adapter.subscribe("session");
      expect(snapshot.queued?.map(message => message.text)).toEqual(["steer"]);
      events.cancel();
      await adapter.dispose();
    }
  });

  test("verified personal ON follows confirmed steer acceptance once and scopes receipts to the account", async () => {
    const { adapter, provider } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
    adapter.projectionForTests("session").statusUpdate("running");
    adapter.projectionForTests("session").apply({ kind: "upsert", item: { id: "tool:shell", type: "tool", name: "shell", status: "running", createdAt: 1 } });
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admit = provider.prompt.bind(provider);
    provider.prompt = async (...args) => { const result = await admit(...args); calls.push("admitted"); await gate; calls.push("acknowledged"); return result; };
    Object.assign(provider, { backgroundBlockingWork: async () => { calls.push("background"); } });
    const policy: ChatActionContext = { receiptScope: "alice", automaticBackground: "on" };
    const send = (context = policy) => adapter.prompt("session", "same-id", "steer", undefined, undefined, undefined, undefined, "steer", context);
    const pending = send();
    await waitUntil(() => calls.includes("admitted"));
    expect(calls).toEqual(["admitted"]);
    release();
    const result = await pending;
    expect(result).toMatchObject({ pending: true, delivery: "steer", automaticBackground: "accepted" });
    expect(calls).toEqual(["admitted", "acknowledged", "background"]);
    expect(await send({ ...policy, automaticBackground: "off" })).toEqual(result);
    expect(calls).toHaveLength(3);
    const other = await send({ ...policy, receiptScope: "bob", automaticBackground: "off" });
    expect(other).not.toHaveProperty("automaticBackground");
    expect(provider.prompts).toHaveLength(2);
    expect(calls.filter(call => call === "background")).toHaveLength(1);
    await adapter.dispose();
  });

  test("accepted steer survives automatic background refusal and missing evidence without becoming a failed prompt", async () => {
    const { adapter, provider } = steering({ capabilities: ["steering", "send-now", "background-blocking-work"] });
    const policy = { receiptScope: "alice", automaticBackground: "on" as const };
    adapter.projectionForTests("session").statusUpdate("running");
    Object.assign(provider, { backgroundBlockingWork: async () => {} });
    const send = (id: string) => adapter.prompt("session", id, "steer", undefined, undefined, undefined, undefined, "steer", policy);
    expect(await send("none")).toMatchObject({ pending: true, automaticBackground: "not-needed" });
    adapter.projectionForTests("session").apply({ kind: "upsert", item: { id: "tool:shell", type: "tool", name: "shell", status: "running", createdAt: 1 } });
    let calls = 0;
    Object.assign(provider, { backgroundBlockingWork: async () => { calls++; throw new Error("private provider refusal details"); } });
    const refused = await send("refused");
    expect(refused).toMatchObject({ pending: true, delivery: "steer", automaticBackground: "failed" });
    expect(JSON.stringify(refused)).not.toContain("private provider refusal");
    expect(await send("refused")).toEqual(refused);
    expect(calls).toBe(1);
    expect(provider.prompts).toHaveLength(2);
    await adapter.dispose();
  });

  async function watchQueue(adapter: ChatAdapter): Promise<{ changes: string[]; stop: () => void }> {
    const { events } = await adapter.subscribe("session");
    const changes: string[] = [];
    void (async () => { for await (const event of events) if (event.type === "conversation.queue") changes.push(`${event.change.kind}:${event.change.messageId}`); })();
    return { changes, stop: () => events.cancel() };
  }

  test("a busy steer reaches the provider as a steer, counts as pending, and lists before held messages", async () => {
    const { adapter, provider, steer, queue, queued } = steering();
    const watch = await watchQueue(adapter);
    adapter.projectionForTests("session").statusUpdate("running");
    const held = await queue("r-q", "later");
    const steered = await steer("r-s", "now");
    expect(held).toEqual(expect.objectContaining({ pending: true, delivery: "queue" }));
    expect(steered).toEqual(expect.objectContaining({ pending: true, delivery: "steer", messageId: "id-2" }));
    expect(provider.prompts).toEqual([expect.objectContaining({ id: "id-2", text: "now", delivery: "steer" })]);
    // No model or mode travels with a steer (D6): the session keeps its own.
    expect(provider.prompts[0]!.model).toBeUndefined();
    expect(provider.prompts[0]!.mode).toBeUndefined();
    expect(await queued()).toEqual([
      expect.objectContaining({ id: "id-2", text: "now", delivery: "steer", requestId: "r-s" }),
      expect.objectContaining({ id: "id-1", text: "later", delivery: "queue", requestId: "r-q" }),
    ]);
    await waitUntil(() => watch.changes.length === 2);
    expect(watch.changes).toEqual(["held:id-1", "steered:id-2"]);
    watch.stop();
    await adapter.dispose();
  });

  test("commands, skills, and reload are held whatever the delivery; so is a steer to an agent without steering, and an omitted delivery", async () => {
    const { adapter, provider, steer } = steering();
    provider.commands = [...provider.commands, { name: "reload", description: "Reload", argumentHint: "", kind: "command" as const }, { name: "pdf", description: "PDF", argumentHint: "", kind: "skill" as const }];
    adapter.projectionForTests("session").statusUpdate("running");
    for (const text of ["/review focus", "/pdf read it", "/reload"]) {
      expect(await steer(`r-${text}`, text)).toEqual(expect.objectContaining({ pending: true, delivery: "queue" }));
    }
    expect(await adapter.prompt("session", "r-omitted", "no delivery named")).toEqual(expect.objectContaining({ pending: true, delivery: "queue" }));
    expect(provider.prompts).toEqual([]);
    expect(((await adapter.history("session")).queued ?? []).map(entry => entry.delivery)).toEqual(["queue", "queue", "queue", "queue"]);

    const plain = steering({ capabilities: [] });
    plain.adapter.projectionForTests("session").statusUpdate("running");
    expect(await plain.steer("r-plain", "steer please")).toEqual(expect.objectContaining({ pending: true, delivery: "queue" }));
    expect(plain.provider.prompts).toEqual([]);
    await adapter.dispose();
    await plain.adapter.dispose();
  });

  test("submitting while idle with nothing pending dispatches at once whatever the delivery", async () => {
    const { adapter, provider, steer } = steering();
    expect(await steer("r-idle", "go")).toEqual(expect.objectContaining({ pending: false, delivery: "queue" }));
    expect(provider.prompts).toEqual([expect.objectContaining({ text: "go", delivery: "queue" })]);
    await adapter.dispose();
  });

  test("inbox deltas keep the dock: another client's steer joins it, a delivery leaves it, and the snapshot lists steers first", async () => {
    const { adapter, provider, inbox, queue, queued } = steering();
    const pump = adapter.startEventPump();
    const watch = await watchQueue(adapter);
    adapter.projectionForTests("session").statusUpdate("running");
    await queue("r-q", "held one");
    inbox({ kind: "pending", id: "msg_other", text: "from the TUI", delivery: "steer", at: 5 });
    await liveEventsApplied(adapter, provider);
    expect(await queued()).toEqual([
      expect.objectContaining({ id: "msg_other", text: "from the TUI", delivery: "steer" }),
      expect.objectContaining({ id: "id-1", delivery: "queue" }),
    ]);
    // A natively queued entry or an internal one is not the dock's.
    inbox({ kind: "pending", id: "msg_native", text: "native queue", delivery: "queue", at: 6 });
    await liveEventsApplied(adapter, provider);
    expect((await queued()).map(entry => entry.id)).toEqual(["msg_other", "id-1"]);
    inbox({ kind: "settled", id: "msg_other", outcome: "delivered" });
    await liveEventsApplied(adapter, provider);
    expect((await queued()).map(entry => entry.id)).toEqual(["id-1"]);
    await waitUntil(() => watch.changes.length === 3);
    expect(watch.changes).toEqual(["held:id-1", "steered:msg_other", "delivered:msg_other"]);
    watch.stop();
    await adapter.stopEventPump();
    await pump;
    await adapter.dispose();
  });

  test("attach and reconnect replace the pending steers from the agent's own list", async () => {
    const { adapter, provider, queued } = steering();
    provider.pendingInbox = [{ id: "msg_listed", text: "raised while away", delivery: "steer", at: 7 }];
    expect(await queued()).toEqual([expect.objectContaining({ id: "msg_listed", text: "raised while away", delivery: "steer" })]);
    // The stream reconnecting re-reads the list: a steer delivered meanwhile
    // leaves, one raised meanwhile joins.
    provider.pendingInbox = [{ id: "msg_newer", text: "raised during the gap", delivery: "steer", at: 8 }];
    const pump = adapter.startEventPump();
    await waitUntil(() => provider.eventQueue.waiting);
    await waitUntil(() => adapter.pendingSteersForTests("session").map(entry => entry.id).join() === "msg_newer");
    // A failed list is unknown, not empty: the map stands.
    provider.listPendingInbox = async () => { throw new Error("inbox unavailable"); };
    expect((await queued()).map(entry => entry.id)).toEqual(["msg_newer"]);
    await adapter.stopEventPump();
    await pump;
    await adapter.dispose();
  });

  test("the bound counts steers and held messages together, including steers raised elsewhere", async () => {
    const { adapter, provider, inbox, steer, queue, queued } = steering();
    const pump = adapter.startEventPump();
    adapter.projectionForTests("session").statusUpdate("running");
    for (let index = 1; index <= 9; index += 1) await steer(`s-${index}`, `steer ${index}`);
    for (let index = 1; index <= 9; index += 1) await queue(`q-${index}`, `held ${index}`);
    inbox({ kind: "pending", id: "msg_tui1", text: "tui 1", delivery: "steer", at: 1 });
    inbox({ kind: "pending", id: "msg_tui2", text: "tui 2", delivery: "steer", at: 2 });
    await liveEventsApplied(adapter, provider);
    expect((await queued()).length).toBe(20);
    await expect(steer("s-21", "one too many")).rejects.toBeInstanceOf(ChatQueueFullError);
    await expect(queue("q-21", "one too many")).rejects.toBeInstanceOf(ChatQueueFullError);
    expect((await queued()).length).toBe(20);
    expect(provider.prompts).toHaveLength(9);
    // Bytes count across both as well.
    const bytes = steering();
    bytes.adapter.projectionForTests("session").statusUpdate("running");
    const large = "x".repeat(100 * 1024);
    await bytes.steer("b-1", large);
    await bytes.queue("b-2", large);
    await expect(bytes.steer("b-3", large)).rejects.toBeInstanceOf(ChatQueueFullError);
    await expect(bytes.queue("b-4", large)).rejects.toBeInstanceOf(ChatQueueFullError);
    await adapter.stopEventPump();
    await pump;
    await adapter.dispose();
    await bytes.adapter.dispose();
  });

  for (const clock of ["same", "backward"] as const) test(`a timed-out resume's late receipt preserves a newer settlement (${clock} clock)`, async () => {
    const { adapter, provider, steer, queued } = steering({ steerAdmissionTimeoutMs: 100 });
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispatched = new Promise<void>(resolve => { arrived = resolve; });
    const now = Date.now();
    const time = spyOn(Date, "now").mockReturnValue(now);
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const pending = await steer("pending", "paused instruction");
      adapter.projectionForTests("session").statusUpdate("interrupted");
      provider.interrupt = async () => { arrived(); await gate; };
      jest.useFakeTimers();
      const resuming = adapter.sendNow("session", pending.messageId, "resume").catch(error => error);
      await dispatched;
      jest.advanceTimersByTime(100);
      expect(await resuming).toBeInstanceOf(OperationOutcomeUnknownError);
      jest.useRealTimers();
      time.mockReturnValue(now - (clock === "backward" ? 10 : 0));
      adapter.projectionForTests("session").statusUpdate("interrupted");
      release();
      const after = await queued();
      expect(after).toEqual([expect.objectContaining({ id: pending.messageId, paused: true })]);
      expect(after[0]).not.toHaveProperty("unconfirmed");
      expect((await adapter.history("session")).conversation.status).toBe("interrupted");
    } finally { release(); jest.useRealTimers(); time.mockRestore(); await adapter.dispose(); }
  });

  for (const path of ["composer", "switch", "send-now", "staged", "staged-queue", "resume"] as const) for (const clock of ["forward", "same", "backward"] as const) test(`a late ${path} wake receipt cannot erase a newer interruption (${clock} clock)`, async () => {
    const { adapter, provider, steer, queue, queued, inbox } = steering(path === "staged-queue" ? { capabilities: [] } : {});
    const pump = adapter.startEventPump();
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const accepted = new Promise<void>(resolve => { arrived = resolve; });
    const now = Date.now();
    const time = spyOn(Date, "now").mockReturnValue(now);
    try {
      await adapter.prompt("session", "start", "initial work");
      const anchor = await queue("anchor", "held behind wake");
      const pending = path === "staged-queue" ? undefined : await steer("original", "pending before wake");
      const held = path === "switch" || path === "send-now" ? await queue("wake", "wake") : undefined;
      await adapter.abort("session", "stop");
      if (path === "staged" || path === "staged-queue") {
        provider.agent.capabilities.push("reversible-history");
        let state: ReversibleHistoryState = { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:old", text: "old" }] };
        provider.getReversibleHistoryState = async () => state;
        provider.undo = provider.redo = provider.revert = provider.restore = async () => ({ outcome: "changed", state });
        const accept = provider.prompt.bind(provider);
        provider.prompt = async (id, input) => {
          const result = await accept(id, input);
          state = { staged: false, canUndo: true, canRedo: false, revertedMessages: [] };
          if (path === "staged") inbox({ kind: "pending", id: result.messageId, text: input.text, delivery: "steer", at: Date.now() });
          adapter.projectionForTests("session").statusUpdate("running");
          arrived(); await gate;
          return result;
        };
      } else if (path === "resume") {
        provider.interrupt = async (_id, options) => {
          expect(options).toEqual({ resume: true });
          adapter.projectionForTests("session").statusUpdate("running");
          arrived(); await gate;
        };
      } else {
        const accept = provider.prompt.bind(provider);
        provider.prompt = async (id, input) => {
          const result = await accept(id, input);
          inbox({ kind: "pending", id: result.messageId, text: input.text, delivery: "steer", at: Date.now() });
          adapter.projectionForTests("session").statusUpdate("running");
          arrived(); await gate;
          return result;
        };
      }
      const waking = path === "switch" ? adapter.changeDelivery("session", held!.messageId, "wake", "steer")
        : path === "send-now" ? adapter.sendNow("session", held!.messageId, "wake")
        : path === "resume" ? adapter.sendNow("session", pending!.messageId, "wake")
        : path === "staged-queue" ? queue("wake", "wake") : steer("wake", "wake");
      await accepted;
      await liveEventsApplied(adapter, provider);
      time.mockReturnValue(now + (clock === "forward" ? 10 : clock === "backward" ? -10 : 0));
      provider.eventQueue.push({ normalized: { conversationId: "session", updates: [{ kind: "status", status: "interrupted" }], outcome: "handled", eventType: "session.execution.interrupted" } });
      await liveEventsApplied(adapter, provider);
      expect((await queued()).filter(entry => entry.delivery === "steer").every(entry => entry.paused)).toBe(true);
      release(); await waking;
      await admissionsApplied(adapter);
      const after = await queued();
      expect(after.filter(entry => entry.delivery === "steer").map(entry => entry.paused)).toEqual(path === "resume" ? [true] : path === "staged-queue" ? [] : [true, true]);
      expect(after.find(entry => entry.id === anchor.messageId)).toEqual(expect.objectContaining({ paused: true }));
      expect((await adapter.history("session")).conversation.status).toBe("interrupted");
    } finally { release(); time.mockRestore(); await adapter.dispose(); await pump; }
  });

  test("a steer enqueued before the conversation last went idle reads paused; a new steer or a wake resumes it", async () => {
    const { adapter, provider, inbox, steer, queued } = steering();
    const pump = adapter.startEventPump();
    const watch = await watchQueue(adapter);
    adapter.projectionForTests("session").statusUpdate("running");
    const first = await steer("s-1", "steer one");
    expect((await queued())[0]).not.toHaveProperty("paused");
    // The turn ends without delivering it: stranded, and said so.
    adapter.projectionForTests("session").statusUpdate("completed");
    expect(await queued()).toEqual([expect.objectContaining({ id: first.messageId, paused: true })]);
    await waitUntil(() => watch.changes.includes(`paused:${first.messageId}`));
    // A new steer wakes the agent, which delivers every pending steer:
    // nothing reads paused any more, and the wake is announced.
    const second = await steer("s-2", "steer two");
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ id: second.messageId, delivery: "steer" }));
    expect((await queued()).map(entry => entry.paused ?? false)).toEqual([false, false]);
    await waitUntil(() => watch.changes.includes(`resumed:${first.messageId}`));
    // Delivered together, oldest first.
    inbox({ kind: "settled", id: first.messageId, outcome: "delivered" });
    inbox({ kind: "settled", id: second.messageId, outcome: "delivered" });
    await liveEventsApplied(adapter, provider);
    expect(await queued()).toEqual([]);
    watch.stop();
    await adapter.stopEventPump();
    await pump;
    await adapter.dispose();
  });

  test("held messages read paused while delivery is paused: after a cancel, and behind a staged revert", async () => {
    const fixture = steering();
    const { adapter, queue, queued } = fixture;
    const watch = await watchQueue(adapter);
    expect((await adapter.prompt("session", "r-1", "start")).pending).toBe(false);
    const held = await queue("r-2", "held");
    expect((await queued())[0]).not.toHaveProperty("paused");
    await adapter.abort("session", "cancel-1");
    expect(await queued()).toEqual([expect.objectContaining({ id: held.messageId, paused: true })]);
    await waitUntil(() => watch.changes.includes(`paused:${held.messageId}`));
    // A new submission resumes the queue: the entry stops reading paused,
    // and as the conversation is idle the head is delivered at once.
    const { provider } = fixture;
    await queue("r-3", "resume");
    await waitUntil(() => watch.changes.includes(`resumed:${held.messageId}`));
    await waitUntil(() => provider.prompts.length === 2);
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ id: held.messageId, delivery: "queue" }));
    expect((await queued()).map(entry => entry.paused ?? false)).toEqual([false]);
    watch.stop();
    await adapter.dispose();
  });

  test("a new composer steer resumes a stopped held queue only after acceptance", async () => {
    const { adapter, provider, steer, queue, queued, inbox } = steering();
    const pump = adapter.startEventPump();
    const watch = await watchQueue(adapter);
    try {
      await adapter.prompt("session", "start", "start");
      const held = await queue("held", "held before Stop");
      await adapter.abort("session", "stop");
      const before = await queued();
      const accept = provider.prompt.bind(provider);
      provider.prompt = async () => { throw new Error("refused"); };
      await expect(steer("refused", "refused steer")).rejects.toThrow("refused");
      expect(await queued()).toEqual(before);
      expect(provider.prompts).toHaveLength(1);
      provider.prompt = accept;
      const accepted = await steer("resume", "new composer steer");
      expect(await queued()).toEqual([
        expect.objectContaining({ id: accepted.messageId, delivery: "steer" }),
        expect.objectContaining({ id: held.messageId, delivery: "queue" }),
      ]);
      expect((await queued()).find(entry => entry.id === held.messageId)).not.toHaveProperty("paused");
      await waitUntil(() => watch.changes.includes(`resumed:${held.messageId}`));
      // Acceptance wakes the turn; held delivery still waits for its end.
      expect(provider.prompts).toHaveLength(2);
      inbox({ kind: "settled", id: accepted.messageId, outcome: "delivered" });
      await liveEventsApplied(adapter, provider);
      adapter.projectionForTests("session").statusUpdate("completed");
      await admissionsApplied(adapter);
      expect(provider.prompts.map(input => input.text)).toEqual(["start", "new composer steer", "held before Stop"]);
      expect(await queued()).toEqual([]);
    } finally { watch.stop(); await adapter.dispose(); await pump; }
  });

  test("a new idle prompt after empty Stop clears dormancy only after acceptance", async () => {
    const { adapter, provider, queue, queued, inbox } = steering();
    const pump = adapter.startEventPump();
    try {
      await adapter.prompt("session", "start", "start");
      await adapter.abort("session", "empty-stop");
      const accept = provider.prompt.bind(provider);
      provider.prompt = async () => { throw new Error("refused"); };
      await expect(queue("refused", "refused prompt")).rejects.toThrow("refused");
      provider.prompt = accept;
      await queue("new", "new idle prompt");
      inbox({ kind: "pending", id: "external-steer", text: "held in the new turn", delivery: "steer", at: Date.now() });
      await liveEventsApplied(adapter, provider);
      provider.cancelInbox = async (_id, id) => { inbox({ kind: "settled", id, outcome: "cancelled" }); };
      const held = await adapter.changeDelivery("session", "external-steer", "hold", "queue");
      expect(await queued()).toEqual([expect.objectContaining({ id: held.messageId, delivery: "queue" })]);
      expect((await queued())[0]).not.toHaveProperty("paused");
      adapter.projectionForTests("session").statusUpdate("completed");
      await admissionsApplied(adapter);
      expect(provider.prompts.map(input => input.text)).toEqual(["start", "new idle prompt", "held in the new turn"]);
    } finally { await adapter.dispose(); await pump; }
  });

  test("cancel interrupts without resuming: held messages go dormant, pending steers stay pending and paused, nothing delivers", async () => {
    const { adapter, provider, steer, queue, queued } = steering();
    expect((await adapter.prompt("session", "r-1", "start")).pending).toBe(false);
    const held = await queue("r-2", "held");
    const steered = await steer("r-3", "steered");
    await adapter.abort("session", "cancel-1");
    expect(provider.interruptOptions).toEqual([{ resume: false }]);
    adapter.projectionForTests("session").statusUpdate("idle");
    await admissionsApplied(adapter);
    expect(provider.prompts).toHaveLength(2);
    expect(await queued()).toEqual([
      expect.objectContaining({ id: steered.messageId, delivery: "steer", paused: true }),
      expect.objectContaining({ id: held.messageId, delivery: "queue", paused: true }),
    ]);
    await adapter.dispose();
  });

  for (const application of ["confirmed", "unknown"] as const) for (const inventory of ["empty", "queued", "native", "mixed"] as const) for (const resume of ["prompt", "switch", "send-now"] as const) test(`lost ${application} Stop with ${inventory} dock stays dormant until explicit ${resume}`, async () => {
    const { adapter, provider, steer, queue, queued, inbox } = steering();
    const pump = adapter.startEventPump();
    try {
      await adapter.prompt("session", "initial", "initial work");
      const original = inventory === "native" || inventory === "mixed" ? await steer("native", "native pending") : undefined;
      if (inventory === "queued" || inventory === "mixed") await queue("held", "held pending");
      let interrupts = 0;
      provider.interrupt = async () => {
        interrupts++;
        if (application === "confirmed") adapter.projectionForTests("session").statusUpdate("interrupted");
        throw new Error("Stop response lost");
      };
      await expect(adapter.abort("session", "stop")).rejects.toThrow("Stop response lost");
      expect((await adapter.history("session")).conversation.status).toBe(application === "confirmed" ? "interrupted" : "running");
      const before = provider.prompts.length;
      // Later native settlement or inbox recovery is not restart authority,
      // even when Stop had no queued entries at all when it was requested.
      adapter.projectionForTests("session").statusUpdate("completed");
      const native = original?.messageId ?? "recovered-native";
      if (!original) inbox({ kind: "pending", id: native, text: "native pending", delivery: "steer", at: Date.now() });
      await liveEventsApplied(adapter, provider);
      provider.cancelInbox = async (_id, id) => { inbox({ kind: "settled", id, outcome: "cancelled" }); };
      const converted = await adapter.changeDelivery("session", native, "hold-only", "queue");
      await admissionsApplied(adapter);
      expect((await queued()).every(entry => entry.paused)).toBe(true);
      expect((await queued()).find(entry => entry.id === converted.messageId)).toEqual(expect.objectContaining({ delivery: "queue", paused: true }));
      expect(provider.prompts).toHaveLength(before);
      expect(interrupts).toBe(1);
      const explicitResume = () => resume === "prompt" ? steer("explicit-resume", "new user instruction")
        : resume === "switch" ? adapter.changeDelivery("session", converted.messageId, "explicit-resume", "steer")
        : adapter.sendNow("session", converted.messageId, "explicit-resume");
      const resumed = await explicitResume();
      expect(await explicitResume()).toEqual(resumed);
      expect(provider.prompts).toHaveLength(before + 1);
      expect((await queued()).find(entry => entry.id === resumed.messageId)).toEqual(expect.objectContaining({ delivery: "steer" }));
      expect((await queued()).find(entry => entry.id === resumed.messageId)).not.toHaveProperty("paused");
    } finally { await adapter.dispose(); await pump; }
  });

  for (const inventory of ["empty", "native", "mixed"] as const) for (const resume of ["switch", "send-now"] as const) test(`Stop with ${inventory} dock survives disconnect, late settlement and Queue conversion until explicit ${resume}`, async () => {
    const { adapter, provider, steer, queue, queued, inbox } = steering();
    let pump = adapter.startEventPump();
    try {
      await adapter.prompt("session", "start", "initial work");
      const native = inventory === "empty" ? "late-native" : (await steer("original", "later input")).messageId;
      if (inventory === "mixed") await queue("held", "other held input");
      await adapter.abort("session", "stop");
      await adapter.stopEventPump(); await pump;
      provider.listPendingInbox = async () => { throw new Error("disconnected"); };
      expect((await queued()).every(entry => entry.paused)).toBe(true);
      // An enqueue raised elsewhere was not seen before Stop. Recovery is
      // evidence of input, not a fresh submission or permission to resume.
      if (inventory === "empty") provider.pendingInbox.push({ id: native, text: "later input", delivery: "steer", at: 1 });
      provider.listPendingInbox = async () => provider.pendingInbox;
      provider.eventQueue = new EventQueue();
      pump = adapter.startEventPump();
      expect((await queued()).every(entry => entry.paused)).toBe(true);
      provider.cancelInbox = async (_session, id) => { inbox({ kind: "settled", id, outcome: "cancelled" }); };
      const before = provider.prompts.length;
      const converted = await adapter.changeDelivery("session", native, "hold", "queue");
      provider.eventQueue.push({ type: "session.idle", data: { sessionID: "session" } });
      await liveEventsApplied(adapter, provider);
      await admissionsApplied(adapter);
      expect((await queued()).find(entry => entry.id === converted.messageId)).toEqual(expect.objectContaining({ text: "later input", delivery: "queue", paused: true }));
      expect(provider.prompts).toHaveLength(before);
      const resumed = resume === "switch"
        ? await adapter.changeDelivery("session", converted.messageId, "explicit-resume", "steer")
        : await adapter.sendNow("session", converted.messageId, "explicit-resume");
      expect(provider.prompts).toHaveLength(before + 1);
      expect((await queued()).find(entry => entry.id === resumed.messageId)).toEqual(expect.objectContaining({ delivery: "steer", text: "later input" }));
      if (inventory === "mixed") expect((await queued()).find(entry => entry.text === "other held input")).toEqual(expect.objectContaining({ paused: true }));
    } finally { await adapter.dispose(); await pump; }
  });

  test("a replacement under a staged revert goes out as a steer on a steering agent, and dispatches as before on one without", async () => {
    for (const declares of [true, false]) {
      const { adapter, provider, steer, queue, queued, inbox } = steering({ capabilities: declares ? ["steering", "send-now"] : [] });
      const pump = adapter.startEventPump();
      provider.agent = { ...provider.agent, capabilities: [...provider.agent.capabilities, "reversible-history"] };
      let state: ReversibleHistoryState = { staged: false, canUndo: true, canRedo: false, revertedMessages: [] };
      provider.getReversibleHistoryState = async () => state;
      provider.undo = async () => { state = { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:old", text: "old" }] }; return { outcome: "changed", state }; };
      provider.redo = async () => ({ outcome: "nothing-to-redo", state });
      provider.revert = async () => ({ outcome: "changed", state });
      provider.restore = async () => ({ outcome: "changed", state });
      const accept = provider.prompt.bind(provider);
      provider.prompt = async (sessionId, input) => {
        const accepted = await accept(sessionId, input);
        // Real OpenCode commits the revert on replacement acceptance. Its
        // running event can arrive later than this HTTP response.
        if (input.text === "replacement") state = { staged: false, canUndo: true, canRedo: false, revertedMessages: [] };
        return accepted;
      };
      adapter.projectionForTests("session").statusUpdate("running");
      const held = await queue("r-held", "held one");
      const paused = declares ? await steer("r-steer", "steer one") : undefined;
      await adapter.undo("session", "undo-1");
      // Undo interrupted the turn: the held message waits, and so does the steer.
      expect((await queued()).every(entry => entry.paused)).toBe(true);
      const replacement = await adapter.prompt("session", "r-replace", "replacement");
      if (declares) {
        expect(replacement).toEqual(expect.objectContaining({ pending: true, delivery: "steer" }));
        expect(provider.prompts.at(-1)).toEqual(expect.objectContaining({ text: "replacement", delivery: "steer" }));
        // Held stays held; the paused steer stays, to be delivered with the
        // replacement oldest first (the agent batches them on resume).
        expect((await queued()).map(entry => entry.id)).toEqual([paused!.messageId, replacement.messageId, held.messageId]);
        inbox({ kind: "settled", id: paused!.messageId, outcome: "delivered" });
        inbox({ kind: "settled", id: replacement.messageId, outcome: "delivered" });
        await liveEventsApplied(adapter, provider);
        expect((await queued()).map(entry => entry.id)).toEqual([held.messageId]);
      } else {
        expect(replacement).toEqual(expect.objectContaining({ pending: false, delivery: "queue" }));
        expect(provider.prompts.at(-1)).toEqual(expect.objectContaining({ text: "replacement", delivery: "queue" }));
        expect((await queued()).map(entry => entry.id)).toEqual([held.messageId]);
      }
      await adapter.stopEventPump();
      await pump;
      await adapter.dispose();
    }
  });

  for (const bound of ["count", "UTF-8 bytes"] as const) test(`a staged replacement respects the shared ${bound} bound without double counting acceptance`, async () => {
    const { adapter, provider, steer, queue, queued } = steering();
    provider.agent.capabilities.push("reversible-history");
    let state: ReversibleHistoryState = { staged: false, canUndo: true, canRedo: false, revertedMessages: [] };
    provider.getReversibleHistoryState = async () => state;
    provider.undo = async () => {
      state = { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:old", text: "old" }] };
      return { outcome: "changed", state };
    };
    provider.redo = provider.revert = provider.restore = async () => ({ outcome: "changed", state });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      await steer("existing-steer", bound === "count" ? "existing steer" : "é".repeat(32 * 1024));
      const held = await queue("existing-held", bound === "count" ? "held" : "🙂".repeat(48 * 1024 - 1));
      if (bound === "count") for (let index = 0; index < 18; index++) await queue(`held-${index}`, "held");
      await adapter.undo("session", "undo");
      const before = await queued();
      const staged = structuredClone(state);
      const calls = provider.prompts.length;
      // Four bytes remain in the byte case: three UTF-8 characters are six,
      // not three bytes. Rejection must precede provider or staged mutation.
      await expect(adapter.prompt("session", "overflow", bound === "count" ? "replacement" : "ééé")).rejects.toBeInstanceOf(ChatQueueFullError);
      expect(await queued()).toEqual(before);
      expect(state).toEqual(staged);
      expect(provider.prompts).toHaveLength(calls);
      if (bound === "count") await adapter.removeQueued("session", held.messageId, "make-room");
      const accept = provider.prompt.bind(provider);
      provider.prompt = async (id, input) => {
        const result = await accept(id, input);
        state = { staged: false, canUndo: true, canRedo: false, revertedMessages: [] };
        return result;
      };
      const text = bound === "count" ? "replacement" : "🙂";
      const accepted = await adapter.prompt("session", "at-bound", text);
      expect(accepted).toEqual(expect.objectContaining({ pending: true, delivery: "steer" }));
      // Retrying an already-counted replacement replays its receipt even at
      // capacity; held messages must still wait for this resumed turn's end.
      expect(await adapter.prompt("session", "at-bound", text)).toEqual(accepted);
      await admissionsApplied(adapter);
      expect(provider.prompts).toHaveLength(calls + 1);
      const pending = await queued();
      expect(pending.filter(entry => entry.id === accepted.messageId)).toHaveLength(1);
      expect(state.staged).toBe(false);
      expect(pending.length).toBe(bound === "count" ? 20 : 3);
      if (bound === "UTF-8 bytes") expect(pending.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0)).toBe(256 * 1024);
      await expect(steer("over-bound", "x")).rejects.toBeInstanceOf(ChatQueueFullError);
      expect(await queued()).toEqual(pending);
    } finally { await adapter.dispose(); }
  });

  test("withdrawing a steer waits for the agent's confirmation: cancelled removes it or holds it in submission order with the current configuration", async () => {
    const { adapter, provider, inbox, steer, queue, queued } = steering();
    const pump = adapter.startEventPump();
    const watch = await watchQueue(adapter);
    provider.configurations.set("session", { model: { providerId: "anthropic", modelId: "claude" }, mode: "build" });
    adapter.projectionForTests("session").statusUpdate("running");
    // Distinct timestamps cover the ordinary case; actual V2 regressions also
    // cover same-tick submissions and wall-clock rollback.
    const older = await queue("q-1", "held first");
    await Bun.sleep(2);
    const steered = await steer("s-1", "steer me");
    await Bun.sleep(2);
    const newer = await queue("q-2", "held later");
    // The agent confirms the withdrawal on its stream, not in the response.
    const answerCancel = (id: string) => { provider.cancelInbox = async (_s, inboxId) => { provider.cancelledInbox.push(inboxId); setTimeout(() => inbox({ kind: "settled", id, outcome: "cancelled" }), 5); }; };
    answerCancel(steered.messageId);
    // Held again under a fresh id: the agent's inbox id named an entry it
    // has now cancelled, and a later dispatch must not reuse it.
    const switched = await adapter.changeDelivery("session", steered.messageId, "switch-1", "queue");
    expect(switched).toEqual({ messageId: expect.not.stringMatching(steered.messageId), delivery: "queue" });
    expect(provider.cancelledInbox).toEqual([steered.messageId]);
    // Back in the held queue at its submission-order position, frozen to the
    // session's configuration as it stands now.
    expect((await queued()).map(entry => `${entry.id}:${entry.delivery}`)).toEqual([`${older.messageId}:queue`, `${switched.messageId}:queue`, `${newer.messageId}:queue`]);
    adapter.projectionForTests("session").statusUpdate("completed");
    await waitUntil(() => provider.prompts.length === 2);
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ id: older.messageId, delivery: "queue" }));
    // Removing a steer goes the same way.
    adapter.projectionForTests("session").statusUpdate("running");
    const removable = await steer("s-2", "remove me");
    answerCancel(removable.messageId);
    await expect(adapter.removeQueued("session", removable.messageId, "remove-1")).resolves.toEqual({ removed: true });
    expect((await queued()).map(entry => entry.id)).toEqual([switched.messageId, newer.messageId]);
    await waitUntil(() => watch.changes.includes(`switched:${switched.messageId}`) && watch.changes.includes(`removed:${removable.messageId}`));
    watch.stop();
    await adapter.stopEventPump();
    await pump;
    await adapter.dispose();
  });

  for (const bound of ["count", "UTF-8 bytes"] as const) test(`Queue conversion at the dock ${bound} bound transfers existing ownership without consuming another slot`, async () => {
    const { adapter, provider, inbox, steer, queue, queued } = steering();
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const text = bound === "count" ? "later" : "é".repeat(32 * 1024);
      const accepted = await steer("native", text);
      for (let index = 0; index < (bound === "count" ? 19 : 3); index++) await queue(`held-${index}`, text);
      provider.cancelInbox = async () => { inbox({ kind: "settled", id: accepted.messageId, outcome: "cancelled" }); };
      const converted = await adapter.changeDelivery("session", accepted.messageId, "convert", "queue");
      const pending = await queued();
      expect(pending).toHaveLength(bound === "count" ? 20 : 4);
      expect(pending.filter(entry => entry.id === converted.messageId)).toHaveLength(1);
      expect(pending.every(entry => entry.delivery === "queue")).toBe(true);
      if (bound === "UTF-8 bytes") expect(pending.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0)).toBe(256 * 1024);
      await expect(queue("over-bound", "x")).rejects.toBeInstanceOf(ChatQueueFullError);
      expect(await queued()).toEqual(pending);
    } finally { await adapter.stopEventPump(); await pump; await adapter.dispose(); }
  });

  test("Queue conversion freezes configuration when preparing withdrawal but retains pending attachment updates until cancellation", async () => {
    const stored = { id: "11111111-2222-4333-8444-555555555555", mimeType: "image/png", absolutePath: "/fixture/11111111-2222-4333-8444-555555555555.png" };
    const attachment = { id: stored.id, name: "updated.png", mimeType: stored.mimeType };
    const { adapter, provider, inbox, steer, queued } = steering({ resolveAttachment: async id => id === stored.id ? stored : null });
    const pump = adapter.startEventPump();
    try {
      const frozen = { model: { providerId: "anthropic", modelId: "claude" }, mode: "plan", variant: "high" };
      provider.configurations.set("session", frozen);
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "original instruction");
      provider.cancelInbox = async () => {
        provider.eventQueue.push({ normalized: { conversationId: "session", updates: [], outcome: "handled", eventType: "session.next.model.switched", configuration: { model: { providerId: "openai", modelId: "gpt" }, mode: "build", variant: "low" }, replaceModel: true } });
        inbox({ kind: "pending", id: accepted.messageId, text: "updated instruction", attachments: [attachment], delivery: "steer", at: Date.now() });
        await liveEventsApplied(adapter, provider);
        inbox({ kind: "settled", id: accepted.messageId, outcome: "cancelled" });
      };
      const converted = await adapter.changeDelivery("session", accepted.messageId, "convert", "queue");
      expect(await queued()).toEqual([expect.objectContaining({ id: converted.messageId, text: "updated instruction", attachments: [attachment] })]);
      expect((await adapter.history("session")).configuration).toEqual({ model: { providerId: "openai", modelId: "gpt" }, mode: "build", variant: "low" });
      adapter.projectionForTests("session").statusUpdate("completed");
      await waitUntil(() => provider.prompts.length === 2);
      expect(provider.prompts[1]).toMatchObject({ id: converted.messageId, text: "updated instruction", ...frozen, attachments: [expect.objectContaining({ id: stored.id })] });
    } finally { await adapter.stopEventPump(); await pump; await adapter.dispose(); }
  });

  test("a steer the agent delivers first cannot be withdrawn: already delivered, nothing held, nothing sent twice; retries apply once", async () => {
    const { adapter, provider, inbox, steer, queued } = steering();
    const pump = adapter.startEventPump();
    adapter.projectionForTests("session").statusUpdate("running");
    const steered = await steer("s-1", "too late");
    provider.cancelInbox = async (_s, inboxId) => { provider.cancelledInbox.push(inboxId); setTimeout(() => inbox({ kind: "settled", id: steered.messageId, outcome: "delivered" }), 5); };
    await expect(adapter.changeDelivery("session", steered.messageId, "switch-1", "queue")).rejects.toBeInstanceOf(SteerAlreadyDeliveredError);
    expect(await queued()).toEqual([]);
    expect(provider.prompts).toHaveLength(1);
    // Delivered before the withdrawal was even asked for: still "already
    // delivered", not merely "not held".
    await expect(adapter.removeQueued("session", steered.messageId, "remove-1")).rejects.toBeInstanceOf(SteerAlreadyDeliveredError);
    expect(provider.cancelledInbox).toEqual([steered.messageId]);
    // A retry with the same request id replays, asking the agent nothing more.
    const again = await steer("s-2", "again");
    provider.cancelInbox = async (_s, inboxId) => { provider.cancelledInbox.push(inboxId); setTimeout(() => inbox({ kind: "settled", id: again.messageId, outcome: "cancelled" }), 5); };
    await Promise.all([adapter.removeQueued("session", again.messageId, "remove-2"), adapter.removeQueued("session", again.messageId, "remove-2")]);
    expect(provider.cancelledInbox).toEqual([steered.messageId, again.messageId]);
    await adapter.stopEventPump();
    await pump;
    await adapter.dispose();
  });

  function revertedV2History(deliveredId: string, visibleId?: string) {
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(new Request(input, init).url).pathname;
      if (pathname === "/api/session/session/message") return Response.json({ data: [
        ...(visibleId ? [{ id: visibleId, type: "user", text: "visible delivered input", time: { created: 0 } }] : []),
        { id: deliveredId, type: "user", text: "delivered then reverted elsewhere", time: { created: 1 } },
      ], cursor: {} });
      if (pathname === "/api/session/session") return Response.json({ data: { id: "session", location: { directory: process.cwd() }, time: { created: 1, updated: 2 }, revert: { messageID: deliveredId } } });
      throw new Error(`Unexpected V2 history read: ${pathname}`);
    }) as typeof globalThis.fetch;
    return createOpenCodeV2Provider({ endpoint: "http://opencode.test", password: "test", directory: process.cwd(), fetch });
  }

  for (const action of ["remove", "edit", "convert"] as const) test(`real V2 reverted delivery cannot be ${action === "convert" ? "converted" : action === "edit" ? "returned to the draft" : "removed"} based on visible history absence`, async () => {
    const { adapter, provider, steer } = steering({ steerWithdrawTimeoutMs: 1 });
    adapter.projectionForTests("session").statusUpdate("running");
    const accepted = await steer("original", "delivered then reverted elsewhere");
    provider.pendingInbox = [];
    const native = revertedV2History(accepted.messageId);
    provider.listMessages = native.listMessages.bind(native);
    try {
      // Real provider filtering hides the delivered record, even from its
      // complete visible transcript. The stream's delivery event was missed.
      expect((await provider.listMessages("session", { limit: 50 })).completeItems).toEqual([]);
      const withdrawal = action === "convert"
        ? adapter.changeDelivery("session", accepted.messageId, "convert", "queue")
        : adapter.removeQueued("session", accepted.messageId, action);
      await expect(withdrawal).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      await expect(withdrawal).rejects.toThrow("delivery is unconfirmed");
      expect(adapter.pendingSteersForTests("session").map(entry => entry.id)).toEqual([accepted.messageId]);
      expect(provider.prompts).toHaveLength(1);
      const snapshot = await adapter.history("session");
      expect(snapshot.queued).toEqual([expect.objectContaining({ id: accepted.messageId, unconfirmed: true })]);
      await expect(adapter.removeQueued("session", accepted.messageId, "explicit-withdrawal-retry")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
      expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: accepted.messageId, unconfirmed: true })]);
      expect(provider.cancelledInbox).toEqual([accepted.messageId, accepted.messageId]);
      expect(snapshot.queued?.filter(entry => entry.delivery === "queue") ?? []).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain("deliveryHistoryIncomplete");
      for (let index = 0; index < 70; index++) adapter.projectionForTests(`eviction-${index}`);
      expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: accepted.messageId, unconfirmed: true })]);
      const pump = adapter.startEventPump();
      try {
        await liveEventsApplied(adapter, provider);
        expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: accepted.messageId, unconfirmed: true })]);
      } finally { await adapter.stopEventPump(); await pump; }
    } finally { await native.dispose?.(); await adapter.dispose(); }
  });

  test("real V2 visible delivery remains proven before a revert boundary", async () => {
    const { adapter, provider, steer } = steering({ steerWithdrawTimeoutMs: 1 });
    adapter.projectionForTests("session").statusUpdate("running");
    const accepted = await steer("original", "visible delivered input");
    provider.pendingInbox = [];
    const native = revertedV2History("later-reverted-input", accepted.messageId);
    provider.listMessages = native.listMessages.bind(native);
    try {
      await expect(adapter.removeQueued("session", accepted.messageId, "remove")).rejects.toBeInstanceOf(SteerAlreadyDeliveredError);
      expect(provider.prompts).toHaveLength(1);
      expect(adapter.pendingSteersForTests("session")).toEqual([]);
    } finally { await native.dispose?.(); await adapter.dispose(); }
  });

  test("explicit cancellation still withdraws a steer while real V2 history has a revert boundary", async () => {
    const { adapter, provider, steer, inbox } = steering();
    const pump = adapter.startEventPump();
    adapter.projectionForTests("session").statusUpdate("running");
    const accepted = await steer("original", "not delivered");
    const native = revertedV2History("earlier-delivered-input");
    provider.listMessages = native.listMessages.bind(native);
    provider.cancelInbox = async () => { inbox({ kind: "settled", id: accepted.messageId, outcome: "cancelled" }); };
    try {
      expect((await provider.listMessages("session", { limit: 50 })).completeItems).toEqual([]);
      await expect(adapter.removeQueued("session", accepted.messageId, "remove")).resolves.toEqual({ removed: true });
      expect(provider.prompts).toHaveLength(1);
      expect(adapter.pendingSteersForTests("session")).toEqual([]);
    } finally { await adapter.stopEventPump(); await pump; await native.dispose?.(); await adapter.dispose(); }
  });

  for (const history of ["complete", "paged"] as const) for (const action of ["remove", "edit", "convert"] as const) test(`missed delivery older than the latest ${history} page refuses ${action}, without resubmission`, async () => {
    const { adapter, provider, steer } = steering({ steerWithdrawTimeoutMs: 1 });
    adapter.projectionForTests("session").statusUpdate("running");
    const accepted = await steer("original", "already delivered");
    provider.pendingInbox = [];
    const older: ConversationItem = { id: `message:${accepted.messageId}`, type: "user_message", text: "already delivered", createdAt: 1 };
    const recent: ConversationItem[] = Array.from({ length: 50 }, (_, index) => ({ id: `message:recent-${index}`, type: "user_message", text: "newer", createdAt: index + 2 }));
    provider.listMessages = async (_id, { cursor }) => history === "complete"
      ? { items: recent, completeItems: [older, ...recent], accounting: [] }
      : cursor ? { items: [older], accounting: [] } : { items: recent, nextCursor: "older", accounting: [] };
    const withdrawal = action === "convert"
      ? adapter.changeDelivery("session", accepted.messageId, "convert", "queue")
      : adapter.removeQueued("session", accepted.messageId, action);
    await expect(withdrawal).rejects.toBeInstanceOf(SteerAlreadyDeliveredError);
    expect(provider.prompts).toHaveLength(1);
    expect((await adapter.history("session")).queued ?? []).toEqual([]);
    await adapter.dispose();
  });

  for (const announced of [true, false]) for (const outcome of ["delivered", "cancelled"] as const) test(`terminal ${outcome} before admission acknowledgement (${announced ? "announced" : "no pending event"}) never resurrects the steer`, async () => {
    const { adapter, provider, steer, inbox } = steering();
    const pump = adapter.startEventPump();
    const watch = await watchQueue(adapter);
    adapter.projectionForTests("session").statusUpdate("running");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admit = provider.prompt.bind(provider);
    provider.prompt = async (...args) => { const result = await admit(...args); await gate; return result; };
    const pending = steer("receipt", "fast settlement");
    await waitUntil(() => provider.prompts.length === 1);
    const id = provider.prompts[0]!.id;
    if (announced) {
      inbox({ kind: "pending", id, text: "fast settlement", delivery: "steer", at: 1 });
      await waitUntil(() => provider.eventQueue.waiting);
    }
    inbox({ kind: "settled", id, outcome });
    await waitUntil(() => provider.eventQueue.waiting);
    const terminal = `${outcome === "delivered" ? "delivered" : "removed"}:${id}`;
    await waitUntil(() => watch.changes.includes(terminal));
    // Outlive the bounded delivered-id cache while the acknowledgement is
    // still blocked: the admission's own terminal fence must keep winning.
    for (let index = 0; index < 70; index++) inbox({ kind: "settled", id: `other-${index}`, outcome: "delivered" });
    await waitUntil(() => provider.eventQueue.waiting);
    release();
    const accepted = await pending;
    expect(await steer("receipt", "fast settlement")).toEqual(accepted);
    expect(provider.prompts).toHaveLength(1);
    expect(watch.changes.at(-1)).toBe(terminal);
    expect(adapter.pendingSteersForTests("session")).toEqual([]);
    expect((await adapter.history("session")).queued ?? []).toEqual([]);
    watch.stop();
    await adapter.stopEventPump(); await pump; await adapter.dispose();
  });

  for (const evidence of ["capped", "repeated-cursor", "repeated-page", "read-bound", "no-inbox-list"] as const) test(`withdrawal with ${evidence} evidence stays unconfirmed, never held or resubmitted`, async () => {
    const { adapter, provider, steer } = steering({ steerWithdrawTimeoutMs: 1 });
    adapter.projectionForTests("session").statusUpdate("running");
    const accepted = await steer("original", "unknown delivery");
    provider.pendingInbox = [];
    let reads = 0;
    provider.listMessages = async () => {
      reads++;
      const recent: ConversationItem[] = Array.from({ length: 50 }, (_, index) => ({ id: `message:${evidence === "read-bound" ? reads : "same"}-${index}`, type: "user_message", text: "newer", createdAt: index }));
      return { items: recent, accounting: [], ...(evidence === "capped" ? {} : { nextCursor: evidence === "repeated-cursor" ? "same" : `older-${reads}` }) };
    };
    if (evidence === "no-inbox-list") provider.listPendingInbox = undefined;
    await expect(adapter.changeDelivery("session", accepted.messageId, "convert", "queue")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
    expect(provider.prompts).toHaveLength(1);
    expect(adapter.pendingSteersForTests("session").map(entry => entry.id)).toEqual([accepted.messageId]);
    expect(reads).toBeLessThanOrEqual(20);
    if (evidence === "read-bound") expect(reads).toBe(20);
    if (evidence === "no-inbox-list") expect(reads).toBe(0);
    await adapter.dispose();
  });

  for (const source of ["held", "composer"] as const) for (const outcome of ["delivered", "cancelled"] as const) test(`${source} timeout then ${outcome} fences late acknowledgement beyond cache eviction and another admission`, async () => {
    const { adapter, provider, queue, steer, inbox } = steering({ steerAdmissionTimeoutMs: 5 });
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const held = source === "held" ? await queue("original", "deliver once") : undefined;
      const admit = provider.prompt.bind(provider);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      provider.prompt = async (...args) => { const result = await admit(...args); await gate; return result; };
      await expect(held ? adapter.changeDelivery("session", held.messageId, "convert", "steer") : steer("original", "deliver once")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const id = provider.prompts[0]!.id;
      // A subsequent admission must not overwrite the original request fence.
      provider.prompt = admit;
      const second = await steer("second", "another input");
      await adapter.abort("session", "stop");
      await adapter.sendNow("session", second.messageId, "resume");
      expect(provider.interruptOptions).toEqual([{ resume: false }, { resume: true }]);
      inbox({ kind: "settled", id, outcome });
      for (let index = 0; index < 70; index++) inbox({ kind: "settled", id: `other-${index}`, outcome: "delivered" });
      await liveEventsApplied(adapter, provider);
      release();
      const admissions = (adapter as unknown as { admittingSteers: Map<string, unknown> }).admittingSteers;
      await waitUntil(() => admissions.size === 0);
      expect(adapter.pendingSteersForTests("session").map(entry => entry.text)).toEqual(["another input"]);
      const pending = (await adapter.history("session")).queued ?? [];
      expect(pending.map(entry => entry.text)).toEqual(["another input"]);
      expect(provider.prompts).toHaveLength(2);
      expect(admissions.size).toBe(0);
    } finally { await adapter.dispose(); await pump; }
  });

  test("unanswered admission fences are bounded and evicted requests cannot apply late acknowledgement", async () => {
    const { adapter, provider, steer, inbox } = steering({ steerAdmissionTimeoutMs: 1 });
    const pump = adapter.startEventPump();
    const releases: Array<() => void> = [];
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => {
        const accepted = await admit(...args);
        await new Promise<void>(resolve => { releases.push(resolve); });
        return accepted;
      };
      for (let index = 0; index < 66; index++) {
        await expect(steer(`request-${index}`, `input-${index}`)).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
        inbox({ kind: "settled", id: provider.prompts.at(-1)!.id, outcome: "cancelled" });
        await liveEventsApplied(adapter, provider);
      }
      const fences = (adapter as unknown as { admittingSteers: Map<string, unknown> }).admittingSteers;
      expect(fences.size).toBe(64);
      for (const release of releases) release();
      await waitUntil(() => fences.size === 0);
      expect(adapter.pendingSteersForTests("session")).toEqual([]);
      expect(provider.prompts).toHaveLength(66);
    } finally { for (const release of releases) release(); await adapter.dispose(); await pump; }
  });

  test("delivery during a held-to-steer admission timeout cannot leave the original held for resubmission", async () => {
    const { adapter, provider, queue, inbox } = steering({ steerAdmissionTimeoutMs: 100 });
    const pump = adapter.startEventPump();
    const watch = await watchQueue(adapter);
    await waitUntil(() => provider.eventQueue.waiting);
    adapter.projectionForTests("session").statusUpdate("running");
    const held = await queue("original", "deliver once");
    expect(held.pending).toBe(true);
    expect(provider.prompts).toHaveLength(0);
    const admit = provider.prompt.bind(provider);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    provider.prompt = async (...args) => { const result = await admit(...args); await gate; return result; };
    const converting = adapter.changeDelivery("session", held.messageId, "convert", "steer");
    const refused = converting.catch(error => error);
    await waitUntil(() => provider.prompts.length === 1);
    const id = provider.prompts[0]!.id;
    inbox({ kind: "settled", id, outcome: "delivered" });
    await waitUntil(() => watch.changes.includes(`delivered:${id}`));
    expect(await refused).toBeInstanceOf(OperationOutcomeUnknownError);
    release();
    await gate;
    expect((await adapter.history("session")).queued ?? []).toEqual([]);
    expect(provider.prompts).toHaveLength(1);
    expect(watch.changes.at(-1)).toBe(`delivered:${id}`);
    watch.stop(); await adapter.stopEventPump(); await pump; await adapter.dispose();
  });

  test("a delivered event overtaking fallback history wins over apparent absence", async () => {
    const { adapter, provider, steer, inbox } = steering({ steerWithdrawTimeoutMs: 1 });
    const pump = adapter.startEventPump();
    const watch = await watchQueue(adapter);
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
    let startedHistory!: () => void;
    const historyStarted = new Promise<void>(resolve => { startedHistory = resolve; });
    let releaseDeadline!: () => void;
    const deadlineGate = new Promise<void>(resolve => { releaseDeadline = resolve; });
    const schedule = globalThis.setTimeout;
    let timerSpy: ReturnType<typeof spyOn> | undefined;
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const accepted = await steer("original", "racing delivery");
      provider.pendingInbox = [];
      provider.listMessages = async () => {
        startedHistory();
        await historyGate;
        return { items: [], completeItems: [], accounting: [] };
      };
      // Gate the deadline callback, not its duration: explicitly schedule the
      // delivery event before expiry, even when the test process is descheduled.
      timerSpy = spyOn(globalThis, "setTimeout").mockImplementationOnce(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        expect(ms).toBe(1);
        return schedule(() => { void deadlineGate.then(() => callback(...args)); }, ms);
      }) as typeof setTimeout);
      const withdrawal = adapter.changeDelivery("session", accepted.messageId, "convert", "queue");
      const outcome = withdrawal.catch(error => error);
      await historyStarted;
      inbox({ kind: "settled", id: accepted.messageId, outcome: "delivered" });
      for (let index = 0; index < 70; index++) inbox({ kind: "settled", id: `other-${index}`, outcome: "delivered" });
      await waitUntil(() => provider.eventQueue.waiting && watch.changes.includes(`delivered:${accepted.messageId}`));
      releaseHistory();
      expect(await outcome).toBeInstanceOf(SteerAlreadyDeliveredError);
      expect(provider.prompts).toHaveLength(1);
    } finally {
      releaseHistory();
      timerSpy?.mockRestore();
      releaseDeadline();
      watch.stop(); await adapter.dispose(); await pump;
    }
  });

  test("with no confirmation before the bounded wait, the outcome comes from the agent's list and history", async () => {
    const { adapter, provider, steer, queued } = steering({ steerWithdrawTimeoutMs: 30 });
    const pump = adapter.startEventPump();
    adapter.projectionForTests("session").statusUpdate("running");
    const silent = await steer("s-1", "no event");
    // Absent from the list and present in history: delivered.
    provider.pendingInbox = [];
    provider.readMessages = async () => ({ items: [{ info: { id: silent.messageId, role: "user", sessionID: "session", time: { created: 1 } }, parts: [{ id: "p1", type: "text", text: "no event" }] }] });
    await expect(adapter.removeQueued("session", silent.messageId, "remove-1")).rejects.toBeInstanceOf(SteerAlreadyDeliveredError);
    expect(await queued()).toEqual([]);
    // Absent from both: cancelled.
    const gone = await steer("s-2", "vanished");
    provider.pendingInbox = [];
    provider.readMessages = async () => ({ items: [] });
    await expect(adapter.removeQueued("session", gone.messageId, "remove-2")).resolves.toEqual({ removed: true });
    // Still listed: the withdrawal did not take; the steer stays and the
    // mutation says so rather than guessing.
    const stuck = await steer("s-3", "stuck");
    provider.pendingInbox = [{ id: stuck.messageId, text: "stuck", delivery: "steer", at: 1 }];
    await expect(adapter.removeQueued("session", stuck.messageId, "remove-3")).rejects.toBeInstanceOf(SteerWithdrawalUnconfirmedError);
    expect((await queued()).map(entry => entry.id)).toEqual([stuck.messageId]);
    await adapter.stopEventPump();
    await pump;
    await adapter.dispose();
  });

  for (const imageOnly of [false, true]) test(`actual adapter queue DTOs preserve rendered pending numbers through conversion and withdrawal gaps for ${imageOnly ? "image-only" : "duplicate-text"} submissions`, async () => {
    const { parseHTML } = await import("linkedom");
    const { QueueDockRenderer } = await import("./timeline-renderer");
    const { parseChatEvent, parseQueuedMessages } = await import("./validation");
    const previousDocument = Reflect.get(globalThis, "document");
    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    Reflect.set(globalThis, "document", document);
    const stored = { id: "11111111-2222-4333-8444-555555555555", mimeType: "image/png", absolutePath: "/synthetic/pending.png" };
    const { adapter, provider, inbox } = steering({ resolveAttachment: async id => id === stored.id ? stored : null });
    const pump = adapter.startEventPump();
    const dock = new QueueDockRenderer();
    const host = document.createElement("div") as unknown as HTMLElement;
    const context = { conversationId: "session", steering: true, sendNow: true, running: true, isCommand: () => false };
    const { events, snapshot: emptySnapshot } = await adapter.subscribe("session");
    const consumed = (async () => {
      for await (const frame of events) if (frame.type === "conversation.queue") {
        const parsed = parseChatEvent(JSON.parse(JSON.stringify(frame)));
        if (parsed.type !== "conversation.queue") throw new Error("Expected queue frame");
        dock.render(host, parsed.queued, context);
      }
    })();
    const label = (id: string) => host.querySelector(`[data-queue-remove="${id}"]`)?.getAttribute("aria-label");
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const text = imageOnly ? "" : "Same prompt";
      const attachments = imageOnly ? [{ id: stored.id, name: "pending.png", mimeType: stored.mimeType }] : undefined;
      const first = await adapter.prompt("session", "one", text, undefined, undefined, undefined, attachments, "queue");
      const second = await adapter.prompt("session", "two", text, undefined, undefined, undefined, attachments, "queue");
      await waitUntil(() => label(second.messageId)?.includes("pending message 2") === true);
      const originalLabel = label(first.messageId);
      const steered = await adapter.changeDelivery("session", first.messageId, "steer", "steer");
      await waitUntil(() => label(steered.messageId) === originalLabel);
      await adapter.removeQueued("session", second.messageId, "remove-sibling");
      provider.cancelInbox = async (_session, id) => { inbox({ kind: "settled", id, outcome: "cancelled" }); };
      const held = await adapter.changeDelivery("session", steered.messageId, "hold", "queue");
      await waitUntil(() => label(held.messageId) === originalLabel);
      expect(host.querySelectorAll(".chat-queued-message")).toHaveLength(1);
      expect(host.querySelector(`[data-queue-remove="${steered.messageId}"]`) === null).toBe(true);
      // Feed an actual empty DTO before reattaching, representing the
      // withdrawal/reconnect gap independently of stream coalescing order.
      dock.render(host, parseQueuedMessages(JSON.parse(JSON.stringify(emptySnapshot.queued))), context);
      expect(host.querySelectorAll(".chat-queued-message")).toHaveLength(0);
      // Reattach/snapshot over the existing public seam and strict parser.
      const reconnect = await adapter.subscribe("session");
      dock.render(host, parseQueuedMessages(JSON.parse(JSON.stringify(reconnect.snapshot.queued))), context);
      reconnect.events.cancel();
      expect(label(held.messageId)).toBe(originalLabel);
      expect(reconnect.snapshot.queued?.[0]?.submissionId).toBe(first.messageId);
      expect(reconnect.snapshot.queued?.[0]?.attachments ?? []).toEqual(attachments ?? []);
    } finally {
      events.cancel(); await consumed; await adapter.dispose(); await pump;
      Reflect.set(globalThis, "document", previousDocument);
    }
  });

  test("server submission identity survives both switches despite colliding client request IDs and timestamps", async () => {
    const { adapter, provider, queued, inbox } = steering();
    const pump = adapter.startEventPump();
    const clock = spyOn(Date, "now").mockReturnValue(1234);
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      // Two accounts may use the same unscoped request ID. Distinct receipt
      // scopes admit both; neither that ID nor the millisecond is identity.
      const first = await adapter.prompt("session", "shared-request", "same text", undefined, undefined, undefined, undefined, "queue", { receiptScope: "account-one", automaticBackground: "off" });
      const second = await adapter.prompt("session", "shared-request", "same text", undefined, undefined, undefined, undefined, "queue", { receiptScope: "account-two", automaticBackground: "off" });
      const original = await queued();
      expect(original.map(entry => entry.submissionId)).toEqual([first.messageId, second.messageId]);
      expect(original.map(entry => entry.requestId)).toEqual(["shared-request", "shared-request"]);
      expect(original.map(entry => entry.queuedAt)).toEqual([1234, 1234]);
      const steered = await adapter.changeDelivery("session", second.messageId, "to-steer", "steer");
      expect((await queued()).find(entry => entry.id === steered.messageId)?.submissionId).toBe(second.messageId);
      provider.cancelInbox = async (_session, id) => { inbox({ kind: "settled", id, outcome: "cancelled" }); };
      const held = await adapter.changeDelivery("session", steered.messageId, "to-queue", "queue");
      expect((await queued()).find(entry => entry.id === held.messageId)?.submissionId).toBe(second.messageId);
      const again = await adapter.changeDelivery("session", held.messageId, "again", "steer");
      expect((await queued()).find(entry => entry.id === again.messageId)?.submissionId).toBe(second.messageId);
      expect((await queued()).find(entry => entry.id === first.messageId)?.submissionId).toBe(first.messageId);
    } finally { clock.mockRestore(); await adapter.dispose(); await pump; }
  });

  test("recovered native steers use native submission identity and preserve known identity on later reads", async () => {
    const { adapter, provider, queued, inbox } = steering();
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      provider.pendingInbox = [{ id: "external-native", text: "same", delivery: "steer", at: 1 }];
      expect(await queued()).toEqual([expect.objectContaining({ id: "external-native", submissionId: "external-native" })]);
      expect((await queued())[0]?.requestId).toBeUndefined();
      provider.cancelInbox = async (_session, id) => { inbox({ kind: "settled", id, outcome: "cancelled" }); };
      const held = await adapter.changeDelivery("session", "external-native", "hold", "queue");
      const steered = await adapter.changeDelivery("session", held.messageId, "steer", "steer");
      // The new native handle is listed on attach/reconnect. Known identity
      // comes from server state, not the native enqueue time or client echo.
      provider.pendingInbox = [{ id: steered.messageId, text: "same", delivery: "steer", at: 1 }, { id: "unknown-native", text: "same", delivery: "steer", at: 1 }];
      const recovered = await queued();
      expect(recovered.find(entry => entry.id === steered.messageId)?.submissionId).toBe("external-native");
      expect(recovered.find(entry => entry.id === "unknown-native")).toEqual(expect.objectContaining({ submissionId: "unknown-native", text: "same", queuedAt: 1 }));
      expect(recovered.find(entry => entry.id === "unknown-native")?.requestId).toBeUndefined();
    } finally { await adapter.dispose(); await pump; }
  });

  test("a late acknowledgement with a canonical native ID retains the held submission identity", async () => {
    const { adapter, provider, queue } = steering({ steerAdmissionTimeoutMs: 5 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const held = await queue("original", "one submission");
      const admit = provider.prompt.bind(provider);
      provider.prompt = async (...args) => {
        await admit(...args); await gate;
        provider.pendingInbox = [{ id: "canonical-native", text: "one submission", delivery: "steer", at: 1 }];
        return { messageId: "canonical-native" };
      };
      await expect(adapter.changeDelivery("session", held.messageId, "switch", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      release();
      await waitUntil(() => adapter.pendingSteersForTests("session").some(entry => entry.id === "canonical-native"));
      expect((await adapter.history("session")).queued).toEqual([expect.objectContaining({ id: "canonical-native", submissionId: held.messageId, requestId: "original" })]);
      expect(provider.prompts).toHaveLength(1);
    } finally { release(); await adapter.dispose(); }
  });

  for (const recovery of ["late-ack", "inbox-list", "pending-event"] as const) test(`held submission identity survives admission timeout and ${recovery} recovery`, async () => {
    const { adapter, provider, queue, inbox } = steering({ steerAdmissionTimeoutMs: 5 });
    const pump = adapter.startEventPump();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const subscriptions: Array<{ cancel(): void }> = [];
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const held = await queue("original", "one submission");
      const admit = provider.prompt.bind(provider);
      let completed!: () => void;
      const acknowledged = new Promise<void>(resolve => { completed = resolve; });
      provider.prompt = async (...args) => { const result = await admit(...args); await gate; completed(); return result; };
      await expect(adapter.changeDelivery("session", held.messageId, "switch", "steer")).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      const unknown = await adapter.subscribe("session"); subscriptions.push(unknown.events);
      expect(unknown.snapshot.queued).toEqual([expect.objectContaining({ id: held.messageId, submissionId: held.messageId, unconfirmed: true })]);
      const nativeId = provider.prompts[0]!.id;
      if (recovery === "pending-event") {
        inbox({ kind: "pending", id: nativeId, text: "one submission", delivery: "steer", at: 1 });
        await liveEventsApplied(adapter, provider);
      }
      if (recovery !== "late-ack") {
        const read = await adapter.history("session");
        expect(read.queued).toEqual([expect.objectContaining({ id: nativeId, submissionId: held.messageId })]);
      }
      release(); await acknowledged;
      await waitUntil(() => adapter.pendingSteersForTests("session").some(entry => entry.id === nativeId));
      const confirmed = await adapter.history("session");
      expect(confirmed.queued).toEqual([expect.objectContaining({ id: nativeId, submissionId: held.messageId })]);
      expect(provider.prompts).toHaveLength(1);
    } finally {
      release(); for (const subscription of subscriptions) subscription.cancel();
      await adapter.dispose(); await pump;
    }
  });

  test("duplicate submissions retain their distinct original request IDs through both delivery switches", async () => {
    const { adapter, provider, queue, queued, inbox } = steering();
    const pump = adapter.startEventPump();
    try {
      adapter.projectionForTests("session").statusUpdate("running");
      const first = await queue("submission-one", "same text");
      const second = await queue("submission-two", "same text");
      const steered = await adapter.changeDelivery("session", second.messageId, "switch-to-steer", "steer");
      expect(steered.messageId).not.toBe(second.messageId);
      expect(await queued()).toEqual([
        expect.objectContaining({ id: steered.messageId, requestId: "submission-two", text: "same text", delivery: "steer" }),
        expect.objectContaining({ id: first.messageId, requestId: "submission-one", text: "same text", delivery: "queue" }),
      ]);
      provider.cancelInbox = async (_session, id) => { inbox({ kind: "settled", id, outcome: "cancelled" }); };
      const held = await adapter.changeDelivery("session", steered.messageId, "switch-to-queue", "queue");
      expect(held.messageId).not.toBe(steered.messageId);
      expect((await queued()).find(entry => entry.id === held.messageId)).toEqual(expect.objectContaining({ requestId: "submission-two", delivery: "queue" }));
      const steeredAgain = await adapter.changeDelivery("session", held.messageId, "switch-again", "steer");
      expect((await queued()).find(entry => entry.id === steeredAgain.messageId)).toEqual(expect.objectContaining({ requestId: "submission-two", delivery: "steer" }));
      expect((await queued()).find(entry => entry.id === first.messageId)?.requestId).toBe("submission-one");
      expect(provider.prompts).toHaveLength(2);
    } finally { await adapter.dispose(); await pump; }
  });

  test("switching a held message to steer hands it to the agent with its attachments; a dormant queue stays dormant for the rest", async () => {
    const { adapter, provider, queue, queued } = steering();
    const watch = await watchQueue(adapter);
    const stored = { id: "11111111-2222-4333-8444-555555555555", mimeType: "image/png", absolutePath: "/tmp/uatu/att.png" };
    (adapter as unknown as { resolveAttachment: (id: string) => Promise<typeof stored | null> }).resolveAttachment = async id => id === stored.id ? stored : null;
    expect((await adapter.prompt("session", "r-1", "start")).pending).toBe(false);
    const first = await queue("q-1", "held first");
    const second = await adapter.prompt("session", "q-2", "with image", undefined, undefined, undefined, [{ id: stored.id, name: "shot.png", mimeType: "image/png" }], "queue");
    await adapter.abort("session", "cancel-1");
    // Dormant. Switching the second to steer sends it now, with its image,
    // under no frozen configuration; the first stays held and dormant.
    const switched = await adapter.changeDelivery("session", second.messageId, "switch-1", "steer");
    expect(switched).toEqual({ messageId: switched.messageId, delivery: "steer" });
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ text: "with image", delivery: "steer", attachments: [expect.objectContaining({ id: stored.id, absolutePath: "/tmp/uatu/att.png" })] }));
    expect(provider.prompts[1]!.model).toBeUndefined();
    expect((await queued()).map(entry => `${entry.id}:${entry.delivery}`)).toEqual([`${switched.messageId}:steer`, `${first.messageId}:queue`]);
    expect((await queued())[1]).toEqual(expect.objectContaining({ paused: true }));
    adapter.projectionForTests("session").statusUpdate("completed");
    await admissionsApplied(adapter);
    expect(provider.prompts).toHaveLength(2);
    await waitUntil(() => watch.changes.includes(`switched:${switched.messageId}`));
    // Send now on a steering agent is the same operation.
    const third = await queue("q-3", "send me now");
    const sent = await adapter.sendNow("session", third.messageId, "send-1");
    expect(sent).toEqual({ messageId: sent.messageId, delivery: "steer" });
    expect(provider.prompts.at(-1)).toEqual(expect.objectContaining({ text: "send me now", delivery: "steer" }));
    // A command is refused a switch to steer.
    adapter.projectionForTests("session").statusUpdate("running");
    const command = await queue("q-4", "/review all");
    await expect(adapter.changeDelivery("session", command.messageId, "switch-2", "steer")).rejects.toBeInstanceOf(CommandSteeringError);
    await expect(adapter.sendNow("session", command.messageId, "send-2")).rejects.toBeInstanceOf(CommandSteeringError);
    watch.stop();
    await adapter.dispose();
  });

  test("send now on a paused steer wakes the agent with resume; on a running one it is refused", async () => {
    const { adapter, provider, steer, queued } = steering();
    expect((await adapter.prompt("session", "r-1", "start")).pending).toBe(false);
    const steered = await steer("s-1", "steer me");
    await expect(adapter.sendNow("session", steered.messageId, "send-0")).rejects.toBeInstanceOf(SendNowUnavailableError);
    await adapter.abort("session", "cancel-1");
    expect((await queued())[0]).toEqual(expect.objectContaining({ id: steered.messageId, paused: true }));
    await expect(adapter.sendNow("session", steered.messageId, "send-1")).resolves.toEqual({ messageId: steered.messageId, delivery: "steer" });
    expect(provider.interruptOptions).toEqual([{ resume: false }, { resume: true }]);
    expect((await queued())[0]).not.toHaveProperty("paused");
    await adapter.dispose();
  });

  test("send now without steering (Claude-shaped) is refused while a turn runs, and otherwise dispatches that message under its frozen configuration", async () => {
    const { adapter, provider, queue, queued } = steering({ capabilities: ["send-now"] });
    const watch = await watchQueue(adapter);
    provider.models = [...provider.models, { selection: { providerId: "anthropic", modelId: "haiku" }, provider: "Anthropic", name: "Haiku" }];
    expect((await adapter.prompt("session", "r-1", "start")).pending).toBe(false);
    const first = await queue("q-1", "held first");
    const second = await adapter.prompt("session", "q-2", "send me", { providerId: "anthropic", modelId: "haiku" }, undefined, undefined, undefined, "queue");
    await expect(adapter.sendNow("session", second.messageId, "send-0")).rejects.toBeInstanceOf(SendNowUnavailableError);
    await adapter.abort("session", "cancel-1");
    await expect(adapter.sendNow("session", second.messageId, "send-1")).resolves.toEqual({ messageId: second.messageId, delivery: "queue" });
    expect(provider.prompts[1]).toEqual(expect.objectContaining({ id: second.messageId, text: "send me", delivery: "queue", model: { providerId: "anthropic", modelId: "haiku" } }));
    expect((await queued()).map(entry => entry.id)).toEqual([first.messageId]);
    await waitUntil(() => watch.changes.includes(`delivered:${second.messageId}`));
    // The rest stay dormant: the turn ending delivers nothing by itself.
    adapter.projectionForTests("session").statusUpdate("completed");
    await admissionsApplied(adapter);
    expect(provider.prompts).toHaveLength(2);
    // Without send-now, or steering, the operations are refused outright.
    const plain = steering({ capabilities: [] });
    plain.adapter.projectionForTests("session").statusUpdate("running");
    const held = await plain.queue("q-1", "held");
    await expect(plain.adapter.sendNow("session", held.messageId, "send-1")).rejects.toBeInstanceOf(SendNowUnsupportedError);
    await expect(plain.adapter.changeDelivery("session", held.messageId, "switch-1", "steer")).rejects.toBeInstanceOf(SteeringUnsupportedError);
    watch.stop();
    await adapter.dispose();
    await plain.adapter.dispose();
  });
});
