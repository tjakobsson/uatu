import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MultiAgentChatService, parseQualifiedConversationId, qualifyConversationId, UnknownAgentError, type RegisteredChatAgent } from "./agents";
import { ConversationProjection } from "./adapter";
import { createClaudeEventMemory, normalizeClaudeMessage, normalizeTranscriptEntries } from "./claude/normalization";
import { readSessionTranscript } from "./claude/transcript";
import { createProviderEventMemory, normalizeProviderEvent as normalizeOpenCodeV1, normalizeProviderMessage } from "./opencode/v1/normalization";
import { createOpenCodeV2Memory, createOpenCodeV2Normalizer, normalizeStoredMessage as normalizeOpenCodeV2History } from "./opencode/v2/normalization";
import { ConversationInventoryBroadcaster } from "./inventory-broadcaster";
import { ConversationReplay, ReplaySubscription } from "./replay";
import { applyChatEvent, projectionFromSnapshot } from "./projection";
import { createWatchedVisualReader, VisualReadError, VisualStore } from "./visual-store";
import type { WorkspaceChatService } from "./service";
import { ConversationNotFoundError } from "./workspace";
import type { AssistantMessageItem, ChatActivity, ChatAvailability, ChatEvent, ConversationItem, ConversationSnapshot, ConversationSummary, MessageDelivery, UsageReadMode } from "./types";

test.each([
  { entry: "history", completion: "message" }, { entry: "history", completion: "conversation" },
  { entry: "subscribe", completion: "message" }, { entry: "subscribe", completion: "conversation" },
] as const)("steered visuals stay pending through $entry reload and finish on $completion completion", async ({ entry, completion }) => {
  const root = path.join(os.tmpdir(), "opencode");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "lifecycle-"));
  const replay = new ConversationReplay("g", "c", 100_000);
  const projection = new ConversationProjection(replay);
  projection.status = "running";
  const assistant: AssistantMessageItem = { id: "part:answer", type: "assistant_message", createdAt: 2, markdown: '![Generated](later.png)\n\n```svg\n<svg><rect width="10"' };
  for (const item of [
    { id: "message:prompt", type: "user_message", createdAt: 1, text: "Draw it" },
    assistant,
    { id: "message:steer", type: "user_message", createdAt: 3, text: "Use a smaller rectangle" },
  ] satisfies ConversationItem[]) projection.upsert(item);
  const current = (): ConversationSnapshot => ({ ...snapshot("c"), generation: "g", cursor: replay.latestCursor(), conversation: { ...summary("c"), status: projection.status }, items: projection.items() });
  const provider = {
    history: async () => current(),
    subscribe: async () => { const handoff = replay.handoff(cursor => ({ ...current(), cursor })); return { snapshot: handoff.snapshot, events: handoff.subscription }; },
    dispose: async () => {},
  } as unknown as WorkspaceChatService;
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  let available = false;
  let reads = 0;
  const services: MultiAgentChatService[] = [];
  const subscriptions: Array<{ cancel(): void }> = [];
  const makeService = () => {
    const store = new VisualStore("/workspace", directory);
    store.setReader(async source => { expect(source).toBe("later.png"); reads++; if (!available) throw new VisualReadError(true); return png; });
    const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "opencode", name: "OpenCode" }, service: provider }] });
    services.push(service);
    return service;
  };
  const answer = (value: ConversationSnapshot) => value.items.find(item => item.id === assistant.id) as AssistantMessageItem;
  const attach = async (service: MultiAgentChatService) => {
    const subscription = await service.subscribe("opencode:c");
    subscriptions.push(subscription.events);
    return subscription;
  };
  try {
    const service = makeService();
    const first = entry === "history" ? await service.history("opencode:c") : (await attach(service)).snapshot;
    expect(first.items.map(item => item.id)).toEqual(["message:prompt", assistant.id, "message:steer"]);
    expect(answer(first).visuals?.map(visual => visual.status)).toEqual(["pending", "pending"]);
    // A new store simulates reload/server restart; a second subscription also
    // exercises attachment to an answer that started before its latest steer.
    const restarted = makeService();
    expect(answer(await restarted.history("opencode:c")).visuals).toEqual(answer(first).visuals);
    const second = await attach(restarted);
    expect(answer(second.snapshot).visuals).toEqual(answer(first).visuals);
    expect(reads).toBe(1);
    const iterator = second.events[Symbol.asyncIterator]();
    const delta = '/></svg>\n```';
    projection.apply({ kind: "text", itemId: assistant.id, identity: "answer", mode: "incremental", text: delta });
    const fenceEvents = await deliveredBatch(replay, iterator);
    expect(fenceEvents).toHaveLength(1);
    const finishedFence = fenceEvents.at(-1)!;
    if (finishedFence.type !== "item.upsert" || finishedFence.item.type !== "assistant_message") throw new Error("expected completed SVG capture");
    expect(finishedFence.item.markdown).toBe(assistant.markdown + delta);
    expect(finishedFence.item.visuals?.map(visual => visual.status)).toEqual(["pending", "ready"]);
    const appliedFence = applyChatEvent(projectionFromSnapshot(second.snapshot), finishedFence);
    expect(appliedFence.outcome).toBe("applied");
    expect((appliedFence.projection.items.find(item => item.id === assistant.id) as AssistantMessageItem).visuals).toEqual(finishedFence.item.visuals);
    expect(reads).toBe(1);
    available = true;
    if (completion === "message") projection.upsert({ ...assistant, markdown: assistant.markdown + delta, completedAt: 4 });
    else projection.statusUpdate("completed");
    const terminalEvents = await deliveredBatch(replay, iterator);
    expect(terminalEvents[0]!.type).toBe(completion === "message" ? "item.upsert" : "conversation.status");
    expect(terminalEvents.at(-1)!.type).toBe(completion === "message" ? "item.upsert" : "resync");
    const completed = answer(await restarted.history("opencode:c"));
    expect(completed.visuals?.map(visual => visual.status)).toEqual(["ready", "ready"]);
    expect(reads).toBe(2);
    expect((await restarted.resolveVisual(completed.visuals![0]!.id!))?.bytes).toEqual(png);
    expect(new TextDecoder().decode((await restarted.resolveVisual(completed.visuals![1]!.id!))?.sourceBytes)).toBe('<svg><rect width="10"/></svg>\n');
    const reloaded = makeService();
    expect(answer(await reloaded.history("opencode:c")).visuals).toEqual(completed.visuals);
    expect(reads).toBe(2);
  } finally {
    for (const subscription of subscriptions) subscription.cancel();
    for (const service of services) await service.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test.each(["completedAt", "turn_status"] as const)("historical visuals stay terminal during a later running turn via %s", async completion => {
  const root = path.join(os.tmpdir(), "opencode");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "historical-"));
  const old: AssistantMessageItem = { id: "old", type: "assistant_message", createdAt: 1, markdown: '![Old](old.png)\n\n```svg\n<svg>', ...(completion === "completedAt" ? { completedAt: 2 } : {}) };
  const items: ConversationItem[] = [old, ...(completion === "turn_status" ? [{ id: "turn:old", type: "turn_status" as const, createdAt: 2, status: "completed" as const }] : []), { id: "new", type: "user_message", createdAt: 3, text: "Next turn" }];
  const provider = { history: async () => ({ ...snapshot("c"), conversation: { ...summary("c"), status: "running" }, items }), dispose: async () => {} } as unknown as WorkspaceChatService;
  let reads = 0;
  let available = false;
  const store = new VisualStore("/workspace", directory);
  store.setReader(async () => { reads++; if (!available) throw new VisualReadError(true); return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]); });
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "test", name: "Test" }, service: provider }] });
  try {
    const first = (await service.history("test:c")).items[0] as AssistantMessageItem;
    expect(first.visuals?.map(visual => visual.status)).toEqual(["unavailable", "unavailable"]);
    available = true;
    expect(((await service.history("test:c")).items[0] as AssistantMessageItem).visuals).toEqual(first.visuals);
    expect(reads).toBe(1);
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test.each([
  { generation: "v1", field: "completed", pending: false },
  { generation: "v1", field: "completed", pending: true },
  { generation: "v1", field: "end", pending: false },
  { generation: "v1", field: "end", pending: true },
  { generation: "v2", field: "completed", pending: false },
  { generation: "v2", field: "completed", pending: true },
] as const)("native $generation time.$field seals historical visuals before a newer turn (pending=$pending)", async ({ generation, field, pending }) => {
  const root = path.join(os.homedir(), ".cache/opencode/scratch/uatu-544-review-resume-20261030/admission");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "historical-native-"));
  const content = [
    { id: "old-image", type: "text", text: "![Old](old.png)", time: { start: 1, end: 2, created: 1, completed: 2 } },
    { id: "old-svg", type: "text", text: "```svg\n<svg>", time: { start: 1, end: 2, created: 1, completed: 2 } },
  ];
  const normalize = (completed: boolean): ConversationItem[] => {
    const time = { created: 1, ...(completed ? { [field]: 2 } : {}) };
    return generation === "v1"
      ? normalizeProviderMessage({ info: { id: "old", role: "assistant", time }, parts: content })
      : normalizeOpenCodeV2History({ id: "old", type: "assistant", time, content });
  };
  let items = normalize(false);
  let status: ConversationSummary["status"] = "running";
  const provider = { history: async () => ({ ...snapshot("c"), conversation: { ...summary("c"), status }, items }), dispose: async () => {} } as unknown as WorkspaceChatService;
  const services: MultiAgentChatService[] = [];
  let available = false;
  let reads = 0;
  const makeService = () => {
    const store = new VisualStore("/workspace", directory);
    store.setReader(async source => {
      expect(source).toBe("old.png");
      reads++;
      if (!available) throw new VisualReadError(true);
      return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    });
    const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "opencode", name: "OpenCode" }, service: provider }] });
    services.push(service);
    return service;
  };
  const visuals = (value: ConversationSnapshot) => value.items.filter((item): item is AssistantMessageItem => item.type === "assistant_message").flatMap(item => item.visuals ?? []);
  try {
    if (pending) {
      expect(items.every(item => item.type !== "assistant_message" || item.completedAt === undefined)).toBe(true);
      expect(visuals(await makeService().history("opencode:c")).map(visual => visual.status)).toEqual(["pending", "pending"]);
    }
    const old = normalize(true);
    expect(old.every(item => item.type !== "assistant_message" || item.completedAt === 2)).toBe(true);
    items = [...old, { id: "new-prompt", type: "user_message", createdAt: 3, text: "Next turn" }];
    const service = makeService();
    const terminal = visuals(await service.history("opencode:c"));
    expect(terminal.map(visual => visual.status)).toEqual(["unavailable", "unavailable"]);
    expect(reads).toBe(pending ? 2 : 1);
    available = true;
    status = "completed";
    expect(visuals(await service.history("opencode:c"))).toEqual(terminal);
    expect(visuals(await makeService().history("opencode:c"))).toEqual(terminal);
    expect(reads).toBe(pending ? 2 : 1);
  } finally {
    for (const service of services) await service.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// These regressions use the real replay/projection and provider normalizer;
// the file reader is the only fake at the visual-capture boundary.
async function visualSubscriptionHarness(agentId: string, initial: ConversationItem[] = []) {
  const root = path.join(os.tmpdir(), "opencode");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "agent-enrichment-"));
  const replay = new ConversationReplay("g", "c", 1_000_000);
  const projection = new ConversationProjection(replay);
  projection.status = "running";
  for (const item of initial) projection.upsert(item);
  const current = (): ConversationSnapshot => ({ ...snapshot("c"), generation: "g", cursor: replay.latestCursor(), conversation: { ...summary("c"), status: projection.status }, items: projection.items() });
  const provider = {
    history: async (_id?: string, _options?: { cursor?: string }) => current(),
    subscribe: async (_id: string, options?: { cursor?: string; signal?: AbortSignal }) => {
      const handoff = replay.handoff(cursor => ({ ...current(), cursor }), options?.cursor, options?.signal);
      return { snapshot: handoff.snapshot, events: handoff.subscription };
    },
    dispose: async () => {},
  };
  const store = new VisualStore("/workspace", directory);
  const files = { available: false, reads: 0 };
  store.setReader(async () => {
    files.reads++;
    if (!files.available) throw new VisualReadError(true);
    return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  });
  const service = new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: agentId, name: agentId }, service: provider as unknown as WorkspaceChatService }] });
  const subscription = await service.subscribe(`${agentId}:c`);
  return {
    replay, projection, current, provider, store, files, service, subscription,
    iterator: subscription.events[Symbol.asyncIterator](),
    cleanup: async () => { subscription.events.cancel(); await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test.each(["footer", "result"] as const)("Claude text stop stays pending through tool file creation until %s", async completion => {
  const h = await visualSubscriptionHarness("claude");
  const memory = createClaudeEventMemory();
  let uuid = 0;
  const emit = (frame: Record<string, unknown>) => {
    const normalized = normalizeClaudeMessage({ uuid: `frame-${++uuid}`, timestamp: uuid, ...frame }, memory, "live");
    for (const update of normalized.updates) h.projection.apply(update);
  };
  const stream = (event: Record<string, unknown>) => emit({ type: "stream_event", event });
  const markdown = "![Generated](later.png)";
  try {
    stream({ type: "message_start", message: { id: "native-claude" } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: markdown } });
    await deliveredBatch(h.replay, h.iterator);
    stream({ type: "content_block_stop", index: 0 });
    emit({ type: "assistant", uuid: "stopped-text", message: { id: "native-claude", content: [{ type: "text", text: markdown }] } });
    const stopped = await deliveredBatch(h.replay, h.iterator);
    const text = stopped.findLast(event => event.type === "item.upsert" && event.item.type === "assistant_message");
    if (text?.type !== "item.upsert" || text.item.type !== "assistant_message") throw new Error("expected normalized stopped text");
    expect(text.item.completedAt).toBeDefined();
    expect(text.item.visuals?.[0]?.status).toBe("pending");
    expect(h.files.reads).toBe(1);
    emit({ type: "assistant", message: { id: "native-tool", content: [{ type: "tool_use", id: "write-image", name: "Write", input: { file_path: "later.png" } }] } });
    h.files.available = true;
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "write-image", content: "Created later.png" }] } });
    await deliveredBatch(h.replay, h.iterator);
    const duringTool = (await h.service.history("claude:c")).items.find(item => item.id === "message:stopped-text") as AssistantMessageItem;
    expect(duringTool.visuals?.[0]?.status).toBe("pending");
    expect(h.files.reads).toBe(1);
    if (completion === "footer") h.projection.upsert({ id: "turn:done", type: "turn_status", createdAt: 20, status: "completed" });
    else emit({ type: "result", subtype: "success", is_error: false });
    const terminal = await deliveredBatch(h.replay, h.iterator);
    expect(terminal[0]!.type).toBe(completion === "footer" ? "item.upsert" : "conversation.status");
    expect(terminal.at(-1)).toMatchObject({ type: "resync", sequence: terminal[0]!.sequence });
    const finished = (await h.service.history("claude:c")).items.find(item => item.id === "message:stopped-text") as AssistantMessageItem;
    expect(finished.visuals?.[0]?.status).toBe("ready");
    expect(h.files.reads).toBe(2);
  } finally { await h.cleanup(); }
});

test.each(["status-error", "updated"] as const)("visual terminal refresh preserves the original %s before its additional resync", async kind => {
  const h = await visualSubscriptionHarness("test", [{ id: "answer", type: "assistant_message", createdAt: 1, markdown: "![Missing](later.png)" }]);
  try {
    const original = kind === "status-error"
      ? h.projection.statusUpdate("failed", "Provider rejected the model; /reload required")
      : h.projection.conversationUpdate({ ...summary("c"), status: "completed", title: "Renamed by provider", updatedAt: 99 });
    const delivered = await deliveredBatch(h.replay, h.iterator);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toEqual({ ...original, conversationId: "test:c", ...(original.type === "conversation.updated" ? { conversation: { ...original.conversation, id: "test:c", agent: { id: "test", name: "test" } } } : {}) });
    expect(delivered[1]).toEqual({ generation: original.generation, sequence: original.sequence, conversationId: "test:c", type: "resync", reason: "conversation-rewritten" });
    const first = applyChatEvent(projectionFromSnapshot(h.subscription.snapshot), delivered[0]!);
    expect(first.outcome).toBe("applied");
    expect(first.projection.status).toBe(kind === "status-error" ? "failed" : "completed");
    if (kind === "updated") expect(first.projection.conversation?.title).toBe("Renamed by provider");
    expect(applyChatEvent(first.projection, delivered[1]!).outcome).toBe("resync");
  } finally { await h.cleanup(); }
});

test.each([false, true])("provider resync reseeds rewritten assistant text before deltas (covered delta=%s)", async covered => {
  const h = await visualSubscriptionHarness("test", [
    { id: "answer", type: "assistant_message", createdAt: 1, markdown: "stale answer ![Old](old.png)" },
    { id: "removed", type: "assistant_message", createdAt: 2, markdown: "removed text" },
    { id: "tool", type: "tool", createdAt: 3, name: "Read", status: "running", output: "large tool output" },
  ]);
  try {
    h.projection.seed([{ id: "answer", type: "assistant_message", createdAt: 1, markdown: "rewritten answer " }]);
    h.replay.publish({ type: "resync", reason: "conversation-rewritten" });
    if (covered) h.projection.apply({ kind: "text", itemId: "answer", identity: "answer", mode: "incremental", text: "already covered " });
    const reset = await deliveredBatch(h.replay, h.iterator);
    expect(reset[0]).toMatchObject({ type: "resync", reason: "conversation-rewritten" });
    const delta = "![New](new.png)";
    const original = h.projection.apply({ kind: "text", itemId: "answer", identity: "answer", mode: "incremental", text: delta });
    const delivered = await deliveredBatch(h.replay, h.iterator);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ generation: original!.generation, sequence: original!.sequence, conversationId: "test:c", type: "item.upsert" });
    const enriched = delivered.at(-1)!;
    if (enriched.type !== "item.upsert" || enriched.item.type !== "assistant_message") throw new Error("expected enriched rewritten reply");
    expect(enriched.item.markdown).toBe(`rewritten answer ${covered ? "already covered " : ""}${delta}`);
    for (const itemId of ["removed", "tool"]) h.replay.publish({ type: "item.text_delta", itemId, delta });
    const stale = await deliveredBatch(h.replay, h.iterator);
    expect(stale.map(event => event.type)).toEqual(["item.text_delta", "item.text_delta"]);
  } finally { await h.cleanup(); }
});

test("a visual-bearing replay boundary retains its original updated event before the additional resync", async () => {
  const h = await visualSubscriptionHarness("test", [{ id: "answer", type: "assistant_message", createdAt: 1, markdown: "![Missing](later.png)" }]);
  const cursor = h.replay.latestCursor();
  const original = h.projection.conversationUpdate({ ...summary("c"), status: "running", title: "Replay this title" });
  const reconnect = await h.service.subscribe("test:c", { cursor });
  try {
    const delivered = await deliveredBatch(h.replay, reconnect.events[Symbol.asyncIterator]());
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({ type: "conversation.updated", sequence: original.sequence, conversation: { id: "test:c", title: "Replay this title" } });
    expect(delivered[1]).toMatchObject({ type: "resync", sequence: original.sequence, reason: "conversation-rewritten" });
  } finally { reconnect.events.cancel(); await h.cleanup(); }
});

test("cancelling between a status and its additional resync stops both the wrapper and source", async () => {
  const h = await visualSubscriptionHarness("test", [{ id: "answer", type: "assistant_message", createdAt: 1, markdown: "![Missing](later.png)" }]);
  try {
    const original = h.projection.statusUpdate("completed");
    expect((await h.iterator.next()).value).toEqual({ ...original, conversationId: "test:c" });
    h.subscription.events.cancel();
    expect(await h.iterator.next()).toEqual({ value: undefined, done: true });
  } finally { await h.cleanup(); }
});

test("only the newest history request treats trailing rows as live, regardless of an older page's footer", async () => {
  const h = await visualSubscriptionHarness("test");
  h.provider.history = async (_id, options) => ({ ...h.current(), items: [
    { id: "prior-footer", type: "turn_status", createdAt: 1, status: "completed" },
    { id: options?.cursor ? "old-page" : "newest-page", type: "assistant_message", createdAt: 2, markdown: "![Missing](later.png)\n\n```svg\n<svg>" },
  ], olderCursor: "there-is-still-an-older-page" });
  try {
    const old = await h.service.history("test:c", { cursor: "actual-older-history-request" });
    expect((old.items[1] as AssistantMessageItem).visuals?.map(visual => visual.status)).toEqual(["unavailable", "unavailable"]);
    const newest = await h.service.history("test:c", { limit: 2 });
    expect((newest.items[1] as AssistantMessageItem).visuals?.map(visual => visual.status)).toEqual(["pending", "pending"]);
  } finally { await h.cleanup(); }
});

test.each([
  { fence: "```", chunks: ["```"] },
  { fence: "```", chunks: ["`", "`", "`"] },
  { fence: "~~~", chunks: ["~~~"] },
  { fence: "~~~", chunks: ["~", "~", "~"] },
])("a $fence SVG close flushes immediately inside the cadence, including split delimiters ($chunks)", async ({ fence, chunks }) => {
  const h = await visualSubscriptionHarness("test");
  const clock = spyOn(Date, "now").mockReturnValue(1_000);
  let client = projectionFromSnapshot(h.subscription.snapshot);
  const outcomes: string[] = [];
  const project = (event: ChatEvent) => {
    const result = applyChatEvent(client, event);
    outcomes.push(result.outcome);
    expect(result.outcome).toBe("applied");
    client = result.projection;
  };
  try {
    const open: AssistantMessageItem = { id: "answer", type: "assistant_message", createdAt: 1, markdown: `${fence}svg\n<svg><rect width="10"/></svg>\n`, contextKey: "original-context", model: { providerId: "test", modelId: "original-model" } };
    const original = h.projection.upsert(open)!;
    const opening = await deliveredBatch(h.replay, h.iterator, project);
    expect(opening).toHaveLength(1);
    expect(opening[0]).toMatchObject({ type: "item.upsert", sequence: original.sequence, item: open });
    expect((client.items[0] as AssistantMessageItem).visuals?.[0]?.status).toBe("pending");
    let last: ChatEvent[] = [];
    for (const text of chunks) {
      h.projection.apply({ kind: "text", itemId: "answer", identity: "answer", mode: "incremental", text });
      last = await deliveredBatch(h.replay, h.iterator, project);
      expect(last).toHaveLength(1);
    }
    expect(last[0]).toMatchObject({ type: "item.upsert", item: { markdown: open.markdown + fence, contextKey: open.contextKey, model: open.model } });
    const displayed = client.items[0] as AssistantMessageItem;
    expect(displayed.markdown).toBe(open.markdown + fence);
    expect(displayed.visuals?.[0]?.status).toBe("ready");
    expect(outcomes).not.toContain("duplicate");
    expect(h.projection.status).toBe("running"); // No tool, footer, status or elapsed cadence needed.
    expect(new TextDecoder().decode((await h.service.resolveVisual(displayed.visuals![0]!.id!))?.sourceBytes)).toBe('<svg><rect width="10"/></svg>\n');
  } finally { clock.mockRestore(); await h.cleanup(); }
});

test("ordinary streamed code tokens have bounded enrichment/store work and an explicit final flush without losing deltas", async () => {
  const prefix = "![First](first.png)\n\n```ts\n";
  const h = await visualSubscriptionHarness("test", [{ id: "answer", type: "assistant_message", createdAt: 1, markdown: prefix }]);
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const captures = spyOn(h.store, "captureMany");
  const enrichments = spyOn(h.service as unknown as { enrichItem(id: string, item: ConversationItem, streaming: boolean): Promise<ConversationItem> }, "enrichItem");
  const originals: ChatEvent[] = [];
  const received: ChatEvent[] = [];
  let client = projectionFromSnapshot(h.subscription.snapshot);
  const project = (event: ChatEvent) => {
    const result = applyChatEvent(client, event);
    expect(result.outcome).toBe(event.type === "resync" ? "resync" : "applied");
    client = result.projection;
  };
  try {
    for (let index = 0; index < 1_000; index++) {
      now++;
      const original = h.projection.apply({ kind: "text", itemId: "answer", identity: "answer", mode: "incremental", text: `${index}();\n` });
      if (!original) throw new Error("expected native delta");
      originals.push(original);
      received.push(...await deliveredBatch(h.replay, h.iterator, project));
    }
    const tail = "```\n![Final](final.png)";
    h.projection.apply({ kind: "text", itemId: "answer", identity: "answer", mode: "incremental", text: tail });
    received.push(...await deliveredBatch(h.replay, h.iterator, project));
    expect((client.items[0] as AssistantMessageItem).visuals?.map(visual => visual.status)).toEqual(["pending", "pending"]);
    h.files.available = true;
    const terminal = h.projection.statusUpdate("completed");
    const final = await deliveredBatch(h.replay, h.iterator, project);
    expect(final[0]).toEqual({ ...terminal, conversationId: "test:c" });
    expect(final.at(-1)).toMatchObject({ type: "resync", sequence: terminal.sequence });
    expect(received.filter(event => event.type === "item.text_delta").slice(0, 1_000)).toEqual(originals.map(event => ({ ...event, conversationId: "test:c" })));
    expect(enrichments.mock.calls.length).toBeLessThanOrEqual(12);
    expect(captures.mock.calls.length).toBeLessThanOrEqual(12);
    expect(h.files.reads).toBe(4); // Each missing image once, then both files at completion.
    const completed = (await h.service.history("test:c")).items[0] as AssistantMessageItem;
    expect(completed.markdown).toBe(`${prefix}${Array.from({ length: 1_000 }, (_, index) => `${index}();\n`).join("")}${tail}`);
    expect(completed.visuals?.map(visual => visual.status)).toEqual(["ready", "ready"]);
  } finally { enrichments.mockRestore(); captures.mockRestore(); clock.mockRestore(); await h.cleanup(); }
});

test("raw HTML image aliases pass the visual-capture precheck", async () => {
  const scratch = path.join(os.tmpdir(), "opencode");
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, "chat-visual-alias-"));
  const workspace = path.join(directory, "workspace");
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const provider = {
    history: async () => ({ ...snapshot("c"), items: [{ id: "m", type: "assistant_message", createdAt: 1, markdown: '<IMAGE src="result.png" alt="Result">' }] }),
    dispose: async () => {},
  } as unknown as WorkspaceChatService;
  const service = new MultiAgentChatService({ workspacePath: workspace, visualStore: new VisualStore(workspace, path.join(directory, "state")), agents: [{ descriptor: { id: "test", name: "Test" }, service: provider }] });
  let reads = 0;
  service.configureVisualReader(async source => { expect(source).toBe("result.png"); reads++; return png; });
  try {
    const history = await service.history("test:c");
    const item = history.items[0] as AssistantMessageItem;
    expect(item.visuals).toHaveLength(1);
    expect(item.visuals![0]!.status).toBe("ready");
    expect((await service.resolveVisual(item.visuals![0]!.id!))?.bytes).toEqual(png);
    expect(reads).toBe(1);
  } finally {
    await service.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Claude native message admissions span text blocks, joined completion and fresh transcript normalization", async () => {
  const root = path.join(os.homedir(), ".cache/opencode/scratch/uatu-544-review-resume-20261030/admission");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "claude-budget-"));
  const memory = createClaudeEventMemory();
  const replay = new ConversationReplay("g", "c", 100_000);
  const projection = new ConversationProjection(replay);
  const emit = (frame: unknown) => {
    for (const update of normalizeClaudeMessage(frame, memory, "live").updates) projection.apply(update);
  };
  let sequence = 0;
  const stream = (event: Record<string, unknown>) => emit({ type: "stream_event", uuid: `s${++sequence}`, timestamp: 1, event });
  let items = () => projection.items();
  const provider = { history: async () => ({ ...snapshot("c"), items: items() }), dispose: async () => {} } as unknown as WorkspaceChatService;
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const reads: string[] = [];
  const makeService = () => {
    const store = new VisualStore("/workspace", directory);
    store.setReader(async source => { reads.push(source); return png; });
    return new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "claude", name: "Claude Code" }, service: provider }] });
  };
  const service = makeService();
  const firstText = Array.from({ length: 8 }, (_, i) => `![${i}](old-${i}.png)`).join("\n");
  const lastText = "![ninth](new.png)";
  try {
    stream({ type: "message_start", message: { id: "native:api:id" } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: firstText } });
    const first = (await service.history("claude:c")).items.find(item => item.type === "assistant_message") as AssistantMessageItem;
    expect(first.visuals).toHaveLength(8);
    stream({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: lastText } });
    const streamed = await service.history("claude:c");
    expect(reads).toHaveLength(8);
    expect((streamed.items.find(item => item.id === "message:stream:native:api:id:2") as AssistantMessageItem).visuals).toEqual([]);
    const frame = { type: "assistant", uuid: "joined", timestamp: 1, message: { id: "native:api:id", content: [{ type: "text", text: firstText }, { type: "text", text: lastText }] } };
    emit(frame);
    const completed = (await service.history("claude:c")).items.find(item => item.id === "message:joined") as AssistantMessageItem;
    expect(completed.visuals).toEqual(first.visuals);
    items = () => normalizeTranscriptEntries([{ kind: "assistant", uuid: frame.uuid, timestamp: 1, message: frame.message, parentUuid: null, isSidechain: false, parentToolUseId: null }]).items;
    const restarted = makeService();
    try {
      const reloaded = (await restarted.history("claude:c")).items.find(item => item.id === "message:joined") as AssistantMessageItem;
      expect(reloaded.visuals).toEqual(first.visuals);
      expect(reads).toHaveLength(8);
    } finally { await restarted.dispose(); }
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test.each([
  { generation: "v1", arrival: "started" }, { generation: "v2", arrival: "started" },
  { generation: "v1", arrival: "delta" }, { generation: "v2", arrival: "delta" },
  { generation: "v1", arrival: "restatement" }, { generation: "v2", arrival: "restatement" },
] as const)("OpenCode $generation $arrival arrivals share native-message admissions through restatement and reload", async ({ generation, arrival }) => {
  const root = path.join(os.homedir(), ".cache/opencode/scratch/uatu-544-review-resume-20261030/admission");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, `opencode-${generation}-budget-`));
  const replay = new ConversationReplay("g", "c", 100_000);
  const projection = new ConversationProjection(replay);
  projection.status = "running";
  const v1Memory = createProviderEventMemory();
  const v2Memory = createOpenCodeV2Memory();
  const normalizeV2 = createOpenCodeV2Normalizer("/workspace");
  let eventSequence = 0;
  const emit = (type: string, data: Record<string, unknown>) => {
    const id = `e-${++eventSequence}`;
    const normalized = generation === "v1"
      ? normalizeOpenCodeV1({ id, type, properties: { sessionID: "c", timestamp: 1, ...data } }, v1Memory)
      : normalizeV2({ id, type, created: 1, location: { directory: "/workspace" }, data: { sessionID: "c", ...data } }, v2Memory);
    expect(normalized.outcome).not.toBe("unparseable");
    return normalized.updates.flatMap(update => { const event = projection.apply(update); return event ? [event] : []; });
  };
  const partId = (messageId: string, ordinal: number) => `${messageId}:text:${ordinal}`;
  const stream = (phase: "started" | "delta" | "ended", messageId: string, ordinal: number, text: string) => {
    const payload = phase === "delta" ? { delta: text } : { text };
    return emit(generation === "v1" ? `session.next.text.${phase}` : `session.text.${phase}`, generation === "v1"
      ? { assistantMessageID: messageId, textID: partId(messageId, ordinal), ...payload }
      : { assistantMessageID: messageId, ordinal, ...payload });
  };
  const restate = (messageId: string, texts: string[]) => {
    if (generation === "v1") {
      return texts.flatMap((text, ordinal) => emit("message.part.updated", { part: { id: partId(messageId, ordinal), messageID: messageId, type: "text", text } }));
    }
    return emit("session.message.content.updated", { messageID: messageId, content: texts.map(text => ({ type: "text", text })) });
  };
  const stored = (messageId: string, texts: string[]) => generation === "v1"
    ? { info: { id: messageId, role: "assistant", time: { created: 1 } }, parts: texts.map((text, ordinal) => ({ id: partId(messageId, ordinal), messageID: messageId, type: "text", text })) }
    : { id: messageId, type: "assistant", time: { created: 1 }, content: texts.map(text => ({ type: "text", text })) };
  let items = () => projection.items();
  const current = (): ConversationSnapshot => ({ ...snapshot("c"), generation: "g", conversation: { ...summary("c"), status: projection.status }, cursor: replay.latestCursor(), items: items() });
  const provider = {
    history: async () => current(),
    subscribe: async () => { const handoff = replay.handoff(cursor => ({ ...current(), cursor })); return { snapshot: handoff.snapshot, events: handoff.subscription }; },
    dispose: async () => {},
  } as unknown as WorkspaceChatService;
  const reads: string[] = [];
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const makeService = () => {
    const store = new VisualStore("/workspace", directory);
    store.setReader(async source => { reads.push(source); return png; });
    return new MultiAgentChatService({ workspacePath: "/workspace", visualStore: store, agents: [{ descriptor: { id: "opencode", name: "OpenCode" }, service: provider }] });
  };
  const service = makeService();
  const messageId = "native:api:same";
  const firstText = Array.from({ length: 8 }, (_, i) => `![${i}](old-${i}.png)`).join("\n");
  const ninthText = "![ninth](new.png)";
  try {
    if (arrival === "restatement") restate(messageId, [firstText]);
    else {
      if (arrival === "started") stream("started", messageId, 0, "");
      stream("delta", messageId, 0, firstText);
    }
    const first = (await service.history("opencode:c")).items.find(item => item.id === `part:${partId(messageId, 0)}`) as AssistantMessageItem;
    expect(first.visuals).toHaveLength(8);
    const subscription = await service.subscribe("opencode:c");
    try {
      const emitted = arrival === "restatement" ? restate(messageId, [firstText, ninthText]) : [
        ...(arrival === "started" ? stream("started", messageId, 1, "") : []),
        ...stream("delta", messageId, 1, ninthText),
      ];
      const iterator = subscription.events[Symbol.asyncIterator]();
      const delivered = await deliveredBatch(replay, iterator);
      expect(delivered.filter(event => emitted.some(original => original.sequence === event.sequence) && event.type !== "resync").length).toBeGreaterThanOrEqual(emitted.length);
      const ninth = delivered.findLast(event => event.type === "item.upsert" && event.item.id === `part:${partId(messageId, 1)}`);
      if (ninth?.type !== "item.upsert" || ninth.item.type !== "assistant_message") throw new Error("expected refused ninth occurrence on the live stream");
      expect(ninth.item.visuals).toEqual([]);
    } finally { subscription.events.cancel(); }
    const second = (await service.history("opencode:c")).items.find(item => item.id === `part:${partId(messageId, 1)}`) as AssistantMessageItem;
    expect(second.visuals).toEqual([]);
    expect(reads).toHaveLength(8);
    stream("ended", messageId, 0, firstText);
    stream("ended", messageId, 1, ninthText);
    restate(messageId, [firstText, ninthText]);
    const restated = (await service.history("opencode:c")).items.filter(item => item.type === "assistant_message") as AssistantMessageItem[];
    expect(restated.map(item => item.visuals)).toEqual([first.visuals, []]);
    expect(reads).toHaveLength(8);
    // A distinct native API message must have its own budget, not a session quota.
    restate("native:api:other", [ninthText]);
    const distinct = (await service.history("opencode:c")).items.find(item => item.id === `part:${partId("native:api:other", 0)}`) as AssistantMessageItem;
    expect(distinct.visuals?.[0]?.status).toBe("ready");
    expect(reads).toHaveLength(9);
    const historyRecords: unknown[] = JSON.parse(JSON.stringify([stored(messageId, [firstText, ninthText]), stored("native:api:other", [ninthText])]));
    items = () => historyRecords.flatMap(record => generation === "v1" ? normalizeProviderMessage(record) : normalizeOpenCodeV2History(record));
    const restarted = makeService();
    try {
      const reloaded = (await restarted.history("opencode:c")).items.filter(item => item.type === "assistant_message") as AssistantMessageItem[];
      expect(reloaded.map(item => item.visuals)).toEqual([first.visuals, [], distinct.visuals]);
      expect(reads).toHaveLength(9);
      expect((await restarted.resolveVisual(first.visuals![0]!.id!))?.bytes).toEqual(png);
    } finally { await restarted.dispose(); }
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("Claude visual captures survive native stream completion and transcript history reload without rereading files", async () => {
  const scratch = path.join(os.tmpdir(), "opencode");
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, "claude-visual-identity-"));
  const workspace = path.join(directory, "workspace");
  const state = path.join(directory, "state");
  await fs.mkdir(workspace);
  const originals = {
    "image.png": Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    "image.svg": new TextEncoder().encode('<svg><rect width="10"/></svg>'),
    "unsafe.svg": new TextEncoder().encode('<svg onload="alert(1)"/>'),
  };
  for (const [name, bytes] of Object.entries(originals)) await fs.writeFile(path.join(workspace, name), bytes);
  const replay = new ConversationReplay("g", "c", 100_000);
  const projection = new ConversationProjection(replay);
  projection.status = "running";
  const memory = createClaudeEventMemory();
  const at = "2026-10-01T10:00:00Z";
  const completedFrames: Array<Record<string, unknown>> = [];
  const emit = (frame: Record<string, unknown>): ChatEvent[] => {
    if (frame.type === "assistant") completedFrames.push(frame);
    const normalized = normalizeClaudeMessage({ timestamp: at, ...frame }, memory, "live");
    expect(normalized.outcome).not.toBe("unparseable");
    return normalized.updates.flatMap(update => { const event = projection.apply(update); return event ? [event] : []; });
  };
  let streamSequence = 0;
  const stream = (event: Record<string, unknown>) => emit({ type: "stream_event", uuid: `s${++streamSequence}`, event });
  const complete = (uuid: string, content: unknown[]) => emit({ type: "assistant", uuid, message: { id: "msg_api", role: "assistant", content } });
  let current = (): ConversationSnapshot => ({ ...snapshot("c"), conversation: { ...summary("c"), status: projection.status }, generation: "g", cursor: replay.latestCursor(), items: projection.items() });
  const provider = {
    history: async () => current(),
    subscribe: async () => { const handoff = replay.handoff(cursor => ({ ...current(), cursor })); return { snapshot: handoff.snapshot, events: handoff.subscription }; },
    dispose: async () => {},
  } as unknown as WorkspaceChatService;
  const agents: RegisteredChatAgent[] = [{ descriptor: { id: "claude", name: "Claude Code" }, service: provider }];
  let reads = 0;
  const reader = createWatchedVisualReader([{ kind: "dir", absolutePath: workspace } as never]);
  const makeService = () => {
    const service = new MultiAgentChatService({ workspacePath: workspace, visualStore: new VisualStore(workspace, state), agents });
    service.configureVisualReader(async (...args) => { reads++; return reader(...args); });
    return service;
  };
  const service = makeService();
  let restarted: MultiAgentChatService | undefined;
  let cancel: (() => void) | undefined;
  try {
    stream({ type: "message_start", message: { id: "msg_api" } });
    // Native frames complete per block. Non-text blocks and an earlier text
    // block make the final block's wire index differ from its text ordinal.
    complete("thinking", [{ type: "thinking", thinking: "Planning" }]);
    stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Context." } });
    complete("first", [{ type: "text", text: "Context." }]);
    complete("tool", [{ type: "tool_use", id: "tool1", name: "Bash", input: { command: "true" } }]);
    stream({ type: "content_block_start", index: 4, content_block: { type: "text", text: "" } });
    const subscription = await service.subscribe("claude:c");
    cancel = () => subscription.events.cancel();
    const iterator = subscription.events[Symbol.asyncIterator]();
    const markdown = Object.keys(originals).map(name => `![${name}](${name})`).join("\n");
    stream({ type: "content_block_delta", index: 4, delta: { type: "text_delta", text: markdown } });
    const firstEvents = await deliveredBatch(replay, iterator);
    const first = firstEvents.at(-1)!;
    if (first.type !== "item.upsert" || first.item.type !== "assistant_message") throw new Error("expected captured stream item");
    expect(first.item.id).toBe("message:stream:msg_api:4");
    const captures = first.item.visuals!;
    expect(captures.map(visual => visual.status)).toEqual(["ready", "ready", "unavailable"]);
    expect(reads).toBe(3);
    const stored = await Promise.all(captures.map(visual => service.resolveVisual(visual.id!)));
    expect(stored[0]?.bytes).toEqual(originals["image.png"]);
    expect(stored[1]?.sourceBytes).toEqual(originals["image.svg"]);
    expect(stored[2]?.sourceBytes).toEqual(originals["unsafe.svg"]);
    expect(stored[2]?.bytes).toBeUndefined();
    for (const name of Object.keys(originals)) await fs.writeFile(path.join(workspace, name), '<svg><circle r="99"/></svg>');
    await fs.unlink(path.join(workspace, "image.png"));
    const completionEvents = complete("visual", [{ type: "text", text: markdown }]);
    const delivered = await deliveredBatch(replay, iterator);
    expect(delivered.length).toBeGreaterThanOrEqual(completionEvents.length);
    expect(delivered[0]).toMatchObject({ type: "item.remove", itemId: "message:stream:msg_api:4" });
    const final = delivered.findLast(event => event.type === "item.upsert" && event.item.id === "message:visual");
    if (final?.type !== "item.upsert" || final.item.type !== "assistant_message") throw new Error("expected durable message");
    expect(final.item.visuals).toEqual(captures);
    expect(reads).toBe(3);
    expect(await Promise.all(captures.map(visual => service.resolveVisual(visual.id!)))).toEqual(stored);
    // Reload only native JSONL, never our live objects/metadata or an ID alias.
    for (const name of ["image.svg", "unsafe.svg"]) await fs.unlink(path.join(workspace, name));
    const transcriptPath = path.join(directory, "transcript.jsonl");
    await fs.writeFile(transcriptPath, completedFrames.map(frame => JSON.stringify({ timestamp: at, ...frame })).join("\n"));
    const transcript = await readSessionTranscript(transcriptPath);
    expect(transcript.entries).toHaveLength(4);
    current = () => ({ ...snapshot("c"), conversation: { ...summary("c"), status: "completed" }, items: normalizeTranscriptEntries(transcript.entries).items });
    restarted = makeService();
    const history = await restarted.history("claude:c");
    expect((history.items.find(item => item.id === "message:visual") as AssistantMessageItem).visuals).toEqual(captures);
    expect(await Promise.all(captures.map(visual => restarted!.resolveVisual(visual.id!)))).toEqual(stored);
    expect(reads).toBe(3);
  } finally {
    cancel?.();
    await service.dispose();
    await restarted?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// A real provider-sequenced marker drains every additional visual event from
// the preceding batch without sleeps or assuming a unary event mapper.
async function deliveredBatch(replay: ConversationReplay, iterator: AsyncIterator<ChatEvent>, project?: (event: ChatEvent) => void): Promise<ChatEvent[]> {
  const marker = replay.publish({ type: "conversation.configuration", configuration: {} });
  const delivered: ChatEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error("subscription ended before batch marker");
    project?.(next.value);
    if (next.value.sequence === marker.sequence && next.value.type === marker.type) return delivered;
    delivered.push(next.value);
  }
}

function summary(id: string, updatedAt = 1): ConversationSummary {
  return { id, title: `Conversation ${id}`, createdAt: updatedAt, updatedAt, status: "idle" };
}

function snapshot(id: string): ConversationSnapshot {
  return {
    conversation: summary(id),
    configuration: {},
    generation: "g1",
    cursor: "c0",
    items: [],
  };
}

class StubAgentService implements WorkspaceChatService {
  calls: Array<{ method: string; args: unknown[] }> = [];
  availability: ChatAvailability = { state: "ready", version: "1.0.0" };
  conversations: ConversationSummary[] = [];
  inventory = new ConversationInventoryBroadcaster();
  replay: ReplaySubscription | null = null;

  private record<T>(method: string, args: unknown[], value: T): Promise<T> {
    this.calls.push({ method, args });
    return Promise.resolve(value);
  }

  async status() { return this.availability; }
  async retry() { this.calls.push({ method: "retry", args: [] }); return this.availability; }
  async accountsChanged(change: unknown) { this.calls.push({ method: "accountsChanged", args: [change] }); }
  async models() { return this.record("models", [], []); }
  async modes() { return this.record("modes", [], []); }
  async commands() { return this.record("commands", [], []); }
  async listConversations() { return this.conversations; }
  async subscribeInventory(options: { signal?: AbortSignal } = {}) { return this.inventory.subscribe(options.signal); }
  async createConversation() { return this.record("createConversation", [], snapshot("created")); }
  async history(id: string, options?: unknown) { return this.record("history", [id, options], snapshot(id)); }
  async subscribe(id: string) {
    this.calls.push({ method: "subscribe", args: [id] });
    this.replay = new ReplaySubscription(() => undefined);
    return { snapshot: snapshot(id), events: this.replay };
  }
  async prompt(id: string, requestId: string, text: string) {
    return this.record("prompt", [id, requestId, text], {
      messageId: "msg-1",
      pending: false,
      delivery: "queue" as const,
      configuration: {},
      conversation: summary(id),
    });
  }
  async removeQueued(id: string, messageId: string) { return this.record("removeQueued", [id, messageId], { removed: true as const }); }
  async discardUnconfirmedSteer(id: string, messageId: string, requestId: string, uncertaintyId: string) { return this.record("discardUnconfirmedSteer", [id, messageId, requestId, uncertaintyId], { discarded: true as const, outcomeUnconfirmed: true as const }); }
  async changeDelivery(id: string, messageId: string, _requestId: string, delivery: MessageDelivery) { return this.record("changeDelivery", [id, messageId, delivery], { messageId, delivery }); }
  async sendNow(id: string, messageId: string) { return this.record("sendNow", [id, messageId], { messageId, delivery: "queue" as const }); }
  async saveAttachment(): Promise<{ id: string; mimeType: string; sizeBytes: number }> { throw new Error("unused: the router owns the store"); }
  async resolveAttachment(): Promise<null> { throw new Error("unused: the router owns the store"); }
  async renameConversation(id: string, _requestId: string, title: string) {
    return this.record("renameConversation", [id, title], { conversation: { ...summary(id), title } });
  }
  async cancel(id: string) { return this.record("cancel", [id], { cancelled: true as const }); }
  async undo(id: string) { return this.record("undo", [id], { outcome: "changed" as const, state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } }); }
  async redo(id: string) { return this.record("redo", [id], { outcome: "changed" as const, state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } }); }
  async revert(id: string, messageId: string) { return this.record("revert", [id, messageId], { outcome: "changed" as const, state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } }); }
  async restore(id: string, messageId: string) { return this.record("restore", [id, messageId], { outcome: "changed" as const, state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } }); }
  async respondPermission(id: string, interactionId: string) {
    return this.record("respondPermission", [id, interactionId], { outcome: "approved-once" as const });
  }
  async respondQuestion(id: string, interactionId: string) {
    return this.record("respondQuestion", [id, interactionId], { outcome: { kind: "rejected" as const } });
  }
  async stopTask(id: string, taskId: string) { return this.record("stopTask", [id, taskId], { stopped: true as const }); }
  async release(id: string) { return this.record("release", [id], { released: true as const }); }
  async cancelWakeup(id: string, wakeupId: string) { return this.record("cancelWakeup", [id, wakeupId], { cancelled: true as const }); }
  async taskOutput(id: string, taskId: string) { return this.record("taskOutput", [id, taskId], null); }
  async usage() { return this.record("usage", [], null); }
  async readUsage(requestId: string, mode: UsageReadMode) { return this.record("readUsage", [requestId, mode], { report: null, reason: "no-live-session" as const }); }
  async dispose() { this.calls.push({ method: "dispose", args: [] }); }
  activityState: ChatActivity = { working: false, awaiting: false, unresolved: false };
  activityChanges = new ConversationInventoryBroadcaster();
  async activity() { return this.activityState; }
  async subscribeActivity(options: { signal?: AbortSignal } = {}) { return this.activityChanges.subscribe(options.signal); }
}

describe("background task stops route to the owning agent", () => {
  test("compact worker evidence resolves only the owning agent and verifies the bare conversation", async () => {
    const { service, a, b } = fixture();
    const calls: string[] = [];
    Object.assign(a, { workerEvidence: async (id: string) => {
      calls.push(id); return { version: 1, conversationId: id, complete: true, entries: [] };
    } });
    expect(await service.workerEvidence("opencode:parent")).toEqual({ version: 1, conversationId: "opencode:parent", complete: true, entries: [] });
    expect(calls).toEqual(["parent"]); expect(b.calls).toEqual([]);
    await expect(service.workerEvidence("claude:parent")).rejects.toThrow("unavailable");
    await expect(service.workerEvidence("foreign:parent")).rejects.toThrow();
    Object.assign(a, { workerEvidence: async () => ({ version: 1, conversationId: "foreign", complete: true, entries: [] }) });
    await expect(service.workerEvidence("opencode:parent")).rejects.toThrow("identity mismatch");
  });
  test("parent backgrounding dispatches the bare parent and receipt only to its owning agent", async () => {
    const { service, a, b } = fixture();
    const calls: unknown[] = [];
    Object.assign(a, { backgroundBlockingWork: async (...args: unknown[]) => { calls.push(args); return { accepted: true as const }; } });
    expect(await service.backgroundBlockingWork("opencode:parent", "receipt")).toEqual({ accepted: true });
    expect(calls).toEqual([["parent", "receipt"]]);
    expect(b.calls).toEqual([]);
    await expect(service.backgroundBlockingWork("nope:parent", "receipt")).rejects.toThrow();
    await expect(service.backgroundBlockingWork("claude:parent", "receipt")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  test("stopTask strips the qualifier and reaches the agent that owns the conversation", async () => {
    const { service, a, b } = fixture();
    expect(await service.stopTask("claude:conv-1", "task-9", "req-1")).toEqual({ stopped: true });
    expect(b.calls).toContainEqual({ method: "stopTask", args: ["conv-1", "task-9"] });
    expect(a.calls.some(call => call.method === "stopTask")).toBe(false);
    await expect(service.stopTask("nope:conv-1", "task-9", "req-1")).rejects.toThrow();
  });

  test("release strips the qualifier and reaches the agent that owns the conversation", async () => {
    const { service, a, b } = fixture();
    expect(await service.release("claude:conv-1", "req-1")).toEqual({ released: true });
    expect(b.calls).toContainEqual({ method: "release", args: ["conv-1"] });
    expect(a.calls.some(call => call.method === "release")).toBe(false);
    await expect(service.release("nope:conv-1", "req-1")).rejects.toThrow();
    expect(await service.cancelWakeup("claude:conv-1", "w1", "req-2")).toEqual({ cancelled: true });
    expect(b.calls).toContainEqual({ method: "cancelWakeup", args: ["conv-1", "w1"] });
  });
});

function fixture(): { service: MultiAgentChatService; a: StubAgentService; b: StubAgentService } {
  const a = new StubAgentService();
  const b = new StubAgentService();
  const agents: RegisteredChatAgent[] = [
    { descriptor: { id: "opencode", name: "OpenCode" }, service: a },
    { descriptor: { id: "claude", name: "Claude Code" }, service: b },
  ];
  return { service: new MultiAgentChatService({ workspacePath: process.cwd(), agents }), a, b };
}

describe("accounts changes", () => {
  test("reach only the named agent and tick every inventory subscriber", async () => {
    const { service, a, b } = fixture();
    const subscription = await service.subscribeInventory();
    await subscription.next();
    const tick = subscription.next();
    await service.accountsChanged("claude", { kind: "added" });
    expect(await tick).toEqual({ value: undefined, done: false });
    expect(b.calls.filter(call => call.method === "accountsChanged")).toEqual([{ method: "accountsChanged", args: [{ kind: "added" }] }]);
    expect(a.calls.filter(call => call.method === "accountsChanged")).toEqual([]);
    await expect(service.accountsChanged("nobody", { kind: "added" })).rejects.toThrow("unknown chat agent");
    subscription.cancel();
  });
});

describe("qualified conversation ids", () => {
  test("qualify and parse round-trip, provider ids pass through untouched", () => {
    const qualified = qualifyConversationId("claude", "ses_abc:with:colons");
    expect(qualified).toBe("claude:ses_abc:with:colons");
    expect(parseQualifiedConversationId(qualified)).toEqual({ agentId: "claude", conversationId: "ses_abc:with:colons" });
  });

  test("an unqualified or empty-sided id parses to nothing", () => {
    expect(parseQualifiedConversationId("bare-id")).toBeNull();
    expect(parseQualifiedConversationId(":x")).toBeNull();
    expect(parseQualifiedConversationId("agent:")).toBeNull();
  });

  test("agent ids with colons are rejected at registration", () => {
    expect(() => new MultiAgentChatService({
      workspacePath: process.cwd(),
      agents: [{ descriptor: { id: "a:b", name: "Bad" }, service: new StubAgentService() }],
    })).toThrow('agent id must not contain ":"');
  });
});

describe("routing", () => {
  test("conversation mutations reach the owning agent with the bare id", async () => {
    const { service, a, b } = fixture();
    const accepted = await service.prompt("claude:ses_1", "r1", "hello");
    expect(b.calls).toEqual([{ method: "prompt", args: ["ses_1", "r1", "hello"] }]);
    expect(a.calls).toEqual([]);
    // The result's conversation is re-qualified and attributed.
    expect(accepted.conversation).toEqual(expect.objectContaining({
      id: "claude:ses_1",
      agent: { id: "claude", name: "Claude Code" },
    }));
  });

  test("an unknown agent prefix or a bare id is rejected before reaching any agent", async () => {
    const { service, a, b } = fixture();
    await expect(service.history("codex:ses_1")).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(service.history("ses_1")).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  test("creation defaults to the first registered agent and honors an explicit choice", async () => {
    const { service, a, b } = fixture();
    const defaulted = await service.createConversation();
    expect(defaulted.conversation.agent.id).toBe("opencode");
    expect(defaulted.conversation.id).toBe("opencode:created");
    const chosen = await service.createConversation("claude");
    expect(chosen.conversation.agent.id).toBe("claude");
    expect(a.calls.filter(call => call.method === "createConversation")).toHaveLength(1);
    expect(b.calls.filter(call => call.method === "createConversation")).toHaveLength(1);
    await expect(service.createConversation("codex")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  test("catalog reads are agent-scoped", async () => {
    const { service, a, b } = fixture();
    await service.models("claude");
    await service.modes("opencode");
    expect(b.calls).toEqual([{ method: "models", args: [] }]);
    expect(a.calls).toEqual([{ method: "modes", args: [] }]);
    await expect(service.commands("codex")).rejects.toBeInstanceOf(UnknownAgentError);
  });
});

describe("status and retry", () => {
  test("status fans out per agent and attributes a failure to its agent alone", async () => {
    const { service, b } = fixture();
    b.status = async () => { throw new Error("probe exploded"); };
    const statuses = await service.status();
    expect(statuses).toEqual([
      { agent: { id: "opencode", name: "OpenCode" }, availability: { state: "ready", version: "1.0.0" } },
      { agent: { id: "claude", name: "Claude Code" }, availability: { state: "unavailable", reason: "startup-failed", message: "probe exploded" } },
    ]);
  });

  test("retry touches only the named agent", async () => {
    const { service, a, b } = fixture();
    const status = await service.retry("claude");
    expect(status.agent.id).toBe("claude");
    expect(b.calls).toEqual([{ method: "retry", args: [] }]);
    expect(a.calls).toEqual([]);
  });
});

describe("inventory", () => {
  test("conversations merge across agents, newest first, each attributed", async () => {
    const { service, a, b } = fixture();
    a.conversations = [summary("old", 1)];
    b.conversations = [summary("new", 5)];
    expect(await service.listConversations()).toEqual([
      expect.objectContaining({ id: "claude:new", agent: { id: "claude", name: "Claude Code" } }),
      expect.objectContaining({ id: "opencode:old", agent: { id: "opencode", name: "OpenCode" } }),
    ]);
  });

  test("identical provider ids from different agents do not collide", async () => {
    const { service, a, b } = fixture();
    a.conversations = [summary("same", 2)];
    b.conversations = [summary("same", 1)];
    const ids = (await service.listConversations()).map(conversation => conversation.id);
    expect(ids).toEqual(["opencode:same", "claude:same"]);
  });

  test("a stalled agent does not withhold the healthy agent's list; its late arrival ticks", async () => {
    const a = new StubAgentService();
    const b = new StubAgentService();
    a.conversations = [summary("ready", 5)];
    let released: ConversationSummary[] | null = null;
    let releaseB: (value: ConversationSummary[]) => void = () => undefined;
    b.listConversations = () => released
      ? Promise.resolve(released)
      : new Promise(resolve => { releaseB = value => { released = value; resolve(value); }; });
    const service = new MultiAgentChatService({
      workspacePath: process.cwd(),
      inventoryContributionTimeoutMs: 25,
      agents: [
        { descriptor: { id: "opencode", name: "OpenCode" }, service: a },
        { descriptor: { id: "claude", name: "Claude Code" }, service: b },
      ],
    });
    const subscription = await service.subscribeInventory();
    await subscription.next();
    // The healthy agent answers within the bound; the straggler contributes
    // nothing yet.
    const listed = await service.listConversations();
    expect(listed.map(conversation => conversation.id)).toEqual(["opencode:ready"]);
    // The straggler's late arrival ticks the merged inventory so clients
    // re-fetch and see it.
    const tick = subscription.next();
    releaseB([summary("late", 9)]);
    expect(await tick).toEqual({ value: undefined, done: false });
    expect((await service.listConversations()).map(conversation => conversation.id)).toEqual(["claude:late", "opencode:ready"]);
    subscription.cancel();
  });

  test("a stalled subscription does not hold the merged SSE fan-in; the late agent re-enters", async () => {
    const a = new StubAgentService();
    const b = new StubAgentService();
    let releaseB: () => void = () => undefined;
    const healthySubscribe = b.subscribeInventory.bind(b);
    b.subscribeInventory = (options: { signal?: AbortSignal } = {}) =>
      new Promise(resolve => { releaseB = () => resolve(healthySubscribe(options)); });
    const service = new MultiAgentChatService({
      workspacePath: process.cwd(),
      inventoryContributionTimeoutMs: 25,
      agents: [
        { descriptor: { id: "opencode", name: "OpenCode" }, service: a },
        { descriptor: { id: "claude", name: "Claude Code" }, service: b },
      ],
    });
    // The merged subscription answers within the bound on a alone.
    const subscription = await service.subscribeInventory();
    await subscription.next();
    expect(a.inventory.subscriberCount()).toBe(1);
    const tick = subscription.next();
    a.inventory.invalidate();
    expect(await tick).toEqual({ value: undefined, done: false });
    // The straggler resolves late: its stray subscription is cancelled and
    // the refreshed merge picks it up.
    releaseB();
    for (let attempt = 0; attempt < 200 && b.inventory.subscriberCount() === 0; attempt += 1) await Bun.sleep(5);
    expect(b.inventory.subscriberCount()).toBe(1);
    subscription.cancel();
  });

  test("a failing agent does not empty the chooser", async () => {
    const { service, a, b } = fixture();
    a.conversations = [summary("kept", 3)];
    b.listConversations = async () => { throw new Error("enumeration failed"); };
    expect((await service.listConversations()).map(conversation => conversation.id)).toEqual(["opencode:kept"]);
  });

  test("either agent's inventory tick surfaces on the merged subscription", async () => {
    const { service, a, b } = fixture();
    const subscription = await service.subscribeInventory();
    // Both broadcasters start with a pending bit; drain it first.
    await subscription.next();
    const tick = subscription.next();
    b.inventory.invalidate();
    expect(await tick).toEqual({ value: undefined, done: false });
    const second = subscription.next();
    a.inventory.invalidate();
    expect(await second).toEqual({ value: undefined, done: false });
    subscription.cancel();
    expect(a.inventory.subscriberCount()).toBe(0);
    expect(b.inventory.subscriberCount()).toBe(0);
  });

  test("an agent dropped at connect re-enters the merge after a successful retry", async () => {
    const { service, a, b } = fixture();
    // b's inventory subscription fails while the merged subscription is
    // first established: its source is dropped, no pump exists to heal it.
    const healthySubscribe = b.subscribeInventory.bind(b);
    let broken = true;
    b.subscribeInventory = async (options: { signal?: AbortSignal } = {}) => {
      if (broken) throw new Error("agent down");
      return healthySubscribe(options);
    };
    const subscription = await service.subscribeInventory();
    await subscription.next();
    expect(b.inventory.subscriberCount()).toBe(0);

    // The agent heals and the user retries it: the merge reconnects and
    // b's ticks reach the subscriber again.
    broken = false;
    await service.retry("claude");
    for (let attempt = 0; attempt < 100 && b.inventory.subscriberCount() === 0; attempt += 1) await Bun.sleep(5);
    expect(b.inventory.subscriberCount()).toBe(1);
    const tick = subscription.next();
    b.inventory.invalidate();
    expect(await tick).toEqual({ value: undefined, done: false });
    subscription.cancel();
    void a;
  });

  test("a reconnect settles: deliberately cancelled sources do not churn the merge", async () => {
    const { service, a, b } = fixture();
    let subscribes = 0;
    const countingSubscribe = a.subscribeInventory.bind(a);
    a.subscribeInventory = async (options: { signal?: AbortSignal } = {}) => {
      subscribes += 1;
      return countingSubscribe(options);
    };
    const subscription = await service.subscribeInventory();
    await subscription.next();
    expect(subscribes).toBe(1);
    // One genuine pump death: b's broadcaster dies and is replaced (its
    // adapter restarted).
    const dead = b.inventory;
    b.inventory = new ConversationInventoryBroadcaster();
    dead.dispose();
    // The reconnect fires once and settles; without the tracked-source
    // guard, each reconnect's own cancellations schedule the next one and
    // the merge reconnects every 250ms forever.
    await Bun.sleep(700);
    expect(subscribes).toBe(2);
    subscription.cancel();
  });
});

describe("qualification of snapshots and events", () => {
  test("snapshot items carry qualified interaction and child conversation ids", async () => {
    const { service, b } = fixture();
    const base = snapshot("parent");
    b.history = async () => ({
      ...base,
      items: [
        { id: "permission:p1", type: "permission", createdAt: 1, requestId: "p1", conversationId: "child", action: "edit", resources: [], status: "pending" },
        { id: "tool:t1", type: "tool", createdAt: 2, name: "task", status: "running", childConversationId: "child" },
        { id: "task:k1", type: "background_task", createdAt: 3, taskId: "k1", description: "Review the diff", status: "running", childConversationId: "child" },
      ],
    });
    const qualified = await service.history("claude:parent");
    expect(qualified.conversation.id).toBe("claude:parent");
    expect(qualified.items[0]).toEqual(expect.objectContaining({ conversationId: "claude:child" }));
    expect(qualified.items[1]).toEqual(expect.objectContaining({ childConversationId: "claude:child" }));
    // The task row names the run before its launching tool row settles: an
    // unqualified id here is what would make a running agent task refuse to open.
    expect(qualified.items[2]).toEqual(expect.objectContaining({ childConversationId: "claude:child" }));
  });

  test("subscribed events are re-qualified, including embedded summaries", async () => {
    const { service, b } = fixture();
    const { events } = await service.subscribe("claude:ses_1");
    const received: ChatEvent[] = [];
    const consume = (async () => {
      for (const _ of [1, 2]) {
        for await (const event of events) { received.push(event); break; }
      }
    })();
    b.replay!.push({ generation: "g1", sequence: 1, conversationId: "ses_1", type: "conversation.updated", conversation: summary("ses_1") });
    b.replay!.push({ generation: "g1", sequence: 2, conversationId: "ses_1", type: "item.upsert", item: { id: "tool:t1", type: "tool", createdAt: 1, name: "task", status: "running", childConversationId: "kid" } });
    await consume;
    expect(received[0]).toEqual(expect.objectContaining({
      conversationId: "claude:ses_1",
      conversation: expect.objectContaining({ id: "claude:ses_1", agent: { id: "claude", name: "Claude Code" } }),
    }));
    expect(received[1]).toEqual(expect.objectContaining({
      conversationId: "claude:ses_1",
      item: expect.objectContaining({ childConversationId: "claude:kid" }),
    }));
  });

  test("cancelling the qualified subscription cancels the source", async () => {
    const { service, b } = fixture();
    const { events } = await service.subscribe("opencode:ses_1", undefined);
    void b; // agent a owns this one
    events.cancel();
    // Push after cancel is a no-op on the source; iteration ends immediately.
    const iterator = events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});

describe("lifecycle", () => {
  test("dispose disposes every agent even when one fails", async () => {
    const { service, a, b } = fixture();
    a.dispose = async () => { a.calls.push({ method: "dispose", args: [] }); throw new Error("dispose failed"); };
    await service.dispose();
    expect(a.calls).toEqual([{ method: "dispose", args: [] }]);
    expect(b.calls).toEqual([{ method: "dispose", args: [] }]);
  });
});

describe("workspace activity merges across agents", () => {
  function activityRouter() {
    const a = new StubAgentService();
    const b = new StubAgentService();
    const service = new MultiAgentChatService({
      workspacePath: process.cwd(),
      agents: [
        { descriptor: { id: "a", name: "A" }, service: a },
        { descriptor: { id: "b", name: "B" }, service: b },
      ],
    });
    return { service, a, b };
  }

  async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await Bun.sleep(1);
    expect(predicate()).toBe(true);
  }

  function within<T>(promise: Promise<T>, ms = 500): Promise<T | "timeout"> {
    return Promise.race([promise, Bun.sleep(ms).then(() => "timeout" as const)]);
  }

  test("working in one agent and awaiting in another merge into one summary", async () => {
    const { service, a, b } = activityRouter();
    expect(await service.activity()).toEqual({ working: false, awaiting: false, unresolved: false });
    a.activityState = { working: true, awaiting: false, unresolved: false };
    b.activityState = { working: false, awaiting: true, unresolved: false };
    expect(await service.activity()).toEqual({ working: true, awaiting: true, unresolved: false });
  });

  test("unresolved evidence is ORed independently from other agents' working and awaiting facts", async () => {
    const { service, a, b } = activityRouter();
    a.activityState = { working: false, awaiting: false, unresolved: true };
    b.activityState = { working: true, awaiting: true, unresolved: false };
    expect(await service.activity()).toEqual({ working: true, awaiting: true, unresolved: true });
    b.activityState = { working: false, awaiting: false, unresolved: false };
    expect(await service.activity()).toEqual({ working: false, awaiting: false, unresolved: true });
    a.activityState.unresolved = false;
    expect(await service.activity()).toEqual({ working: false, awaiting: false, unresolved: false });
  });

  test("an agent that cannot answer counts as idle and does not silence the others", async () => {
    const { service, a, b } = activityRouter();
    b.activity = async () => { throw new Error("agent down"); };
    b.subscribeActivity = async () => { throw new Error("agent down"); };
    a.activityState = { working: false, awaiting: true, unresolved: false };
    expect(await service.activity()).toEqual({ working: false, awaiting: true, unresolved: false });

    const changes = await service.subscribeActivity();
    expect((await changes.next()).done).toBe(false);
    await until(() => a.activityChanges.subscriberCount() === 1);
    // Let the source's own opening tick land, then consume it, so the next
    // tick can only be the forwarded change.
    await Bun.sleep(5);
    expect(await within(changes.next())).toEqual({ value: undefined, done: false });
    a.activityState = { working: true, awaiting: true, unresolved: false };
    a.activityChanges.invalidate();
    expect(await within(changes.next())).toEqual({ value: undefined, done: false });
    expect(await service.activity()).toEqual({ working: true, awaiting: true, unresolved: false });
    changes.cancel();
  });

  test("a hung agent neither delays the subscription nor its peers' ticks", async () => {
    const { service, a, b } = activityRouter();
    b.subscribeActivity = () => new Promise(() => undefined);
    const changes = await within(service.subscribeActivity());
    if (changes === "timeout") throw new Error("subscribeActivity waited on the hung agent");
    expect((await changes.next()).done).toBe(false);
    await until(() => a.activityChanges.subscriberCount() === 1);
    await Bun.sleep(5);
    expect(await within(changes.next())).toEqual({ value: undefined, done: false });
    a.activityChanges.invalidate();
    expect(await within(changes.next())).toEqual({ value: undefined, done: false });
    changes.cancel();
  });

  test("ending the merged subscription ends every agent's, by abort or by disposal", async () => {
    const { service, a, b } = activityRouter();
    const abort = new AbortController();
    const aborted = await service.subscribeActivity({ signal: abort.signal });
    await until(() => a.activityChanges.subscriberCount() === 1 && b.activityChanges.subscriberCount() === 1);
    abort.abort();
    expect(a.activityChanges.subscriberCount()).toBe(0);
    expect(b.activityChanges.subscriberCount()).toBe(0);
    expect((await aborted.next()).done).toBe(true);

    const disposed = await service.subscribeActivity();
    await until(() => a.activityChanges.subscriberCount() === 1);
    await service.dispose();
    expect(a.activityChanges.subscriberCount()).toBe(0);
    expect((await disposed.next()).done).toBe(true);
  });
});
