import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compactWorkers } from "../chat/compact-work";
import { WorkerDismissalClient, visibleWorkers, workerExecutionIds } from "../chat/worker-dismissal-client";
import { createClaudeEventMemory, normalizeClaudeMessage } from "../chat/claude/normalization";
import { normalizeProviderMessage } from "../chat/opencode/v1/normalization";
import type { BackgroundTaskItem, ConversationItem, ToolItem } from "../chat/types";
import type { RunningSession } from "./backend";
import { handleWorkerDismissals, readAuthoritativeWorkerEvidence } from "./worker-dismissals-api";
import { WorkerDismissalsStore } from "./worker-dismissals";
import { observeWorkerProjection } from "./worker-dismissals-observation";
import { parseConversationItem } from "../chat/validation";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const conversationId = "opencode:parent";
const running: RunningSession = { workspaceId: "project", instanceId: "fixture", policyTrust: "unavailable", basePath: "/s/project/", endpoint: { hostname: "127.0.0.1", port: 12345 }, token: "fixture", exited: new Promise(() => {}), stop: async () => {} };

function childPages(pages: ConversationItem[][]) {
  const requests: string[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); requests.push(url.searchParams.get("cursor") ?? "first");
    const page = Number(url.searchParams.get("cursor") ?? 0);
    return Response.json({ conversation: { id: conversationId, title: "Fixture", createdAt: 1, updatedAt: 1, status: "idle", agent: { id: "opencode", name: "OpenCode" } }, configuration: {}, generation: "fixture", cursor: "fixture", items: pages[page], ...(page + 1 < pages.length ? { olderCursor: String(page + 1) } : {}) });
  }) as typeof fetch);
  cleanups.push(() => { mock.mockRestore(); });
  return requests;
}

function terminalItems(): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const [status, native] of [["completed", "completed"], ["failed", "error"], ["stopped", "cancelled"]] as const) {
    const memory = createClaudeEventMemory();
    normalizeClaudeMessage({ type: "system", subtype: "task_started", uuid: `start-${status}`, timestamp: "2026-09-15T10:00:00Z", task_id: `background-${status}`, tool_use_id: `background-call-${status}`, description: "Review", task_type: "local_agent", is_backgrounded: true }, memory, "live");
    const notification = normalizeClaudeMessage({ type: "system", subtype: "task_notification", uuid: `end-${status}`, timestamp: "2026-09-15T10:00:01Z", task_id: `background-${status}`, status, summary: "Done" }, memory, "live");
    const task = notification.updates.find(update => update.kind === "upsert" && update.item.type === "background_task");
    if (task?.kind !== "upsert") throw new Error("missing normalized background task");
    items.push(task.item);
    const [tool] = normalizeProviderMessage({ info: { id: `message-${status}`, role: "assistant", time: { created: 10 } }, parts: [
      { id: `foreground-call-${status}`, type: "tool", tool: "task", state: { status: native, input: { description: "Review", prompt: "Review" }, time: { start: 10, end: 20 } } },
    ] });
    if (!tool) throw new Error("missing normalized tool");
    // The adapter closes stale tool rows as cancelled when their turn is no
    // longer live (adapter.ts); providers themselves need not emit cancellation.
    items.push(status === "stopped" && tool.type === "tool" ? { ...tool, status: "cancelled" } : tool);
  }
  return items;
}

test("actual terminal DTOs reach authoritative Hub evidence and real client POSTs, persist and isolate the next execution", async () => {
  const items = terminalItems();
  expect(items.map(item => item.type)).toEqual(["background_task", "tool", "background_task", "tool", "background_task", "tool"]);
  expect(items.every(item => !("activity" in item))).toBe(true);
  childPages([items.slice(0, 3), items.slice(3)]);
  const root = await mkdtemp(path.join(tmpdir(), "uatu-terminal-dismissals-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "marks.json");
  let store = new WorkerDismissalsStore(file); await store.load();
  const posts: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(JSON.parse(init.body as string).executionId);
    return handleWorkerDismissals(new Request(new URL(url, "http://hub.invalid"), init), {
      user: "alice", workspaceId: "project", store, read: () => readAuthoritativeWorkerEvidence(running, conversationId),
    });
  };
  let ready!: () => void;
  const loaded = new Promise<void>(resolve => { ready = resolve; });
  const client = new WorkerDismissalClient({ fetcher, changed: () => ready() });
  cleanups.push(() => client.dispose());
  client.select(conversationId); await loaded;
  const workers = compactWorkers(items);
  expect(workers.map(worker => worker.state).sort()).toEqual(["completed", "completed", "failed", "failed", "stopped", "stopped"]);
  for (const worker of workers) {
    const ids = workerExecutionIds(worker);
    expect(ids.length).toBeGreaterThan(0);
    await client.dismiss(ids[0], ids);
    expect(client.error).toBe("");
  }
  expect(posts).toHaveLength(6);
  expect(visibleWorkers(workers, client.dismissed)).toHaveLength(0);
  store = new WorkerDismissalsStore(file); await store.load();
  const response = await fetcher(`/api/personal-worker-dismissals?conversationId=${conversationId}`);
  expect(response.status).toBe(200);
  const recovered = new Set<string>((await response.json()).entries.filter((entry: { dismissed: boolean }) => entry.dismissed).map((entry: { executionId: string }) => entry.executionId));
  expect(visibleWorkers(compactWorkers(JSON.parse(JSON.stringify(items))), recovered)).toHaveLength(0);
  const prior = items.find((item): item is ToolItem => item.type === "tool")!;
  expect(visibleWorkers(compactWorkers([{ ...prior, id: "tool:new-execution", childConversationId: "same-child" }]), recovered)).toHaveLength(1);
  const returning = items.find((item): item is BackgroundTaskItem => item.type === "background_task")!;
  const anchor = workerExecutionIds(compactWorkers([returning])[0]!)[0]!;
  returning.status = "running";
  returning.activity = { kind: "needs-answer", executionId: "positive-recovery", request: { kind: "question", id: "canonical" } };
  expect(visibleWorkers(compactWorkers([returning]), recovered)).toHaveLength(1);
  expect((await fetcher(`/api/personal-worker-dismissals?conversationId=${conversationId}`)).status).toBe(200);
  returning.status = "completed"; delete returning.activity;
  store = new WorkerDismissalsStore(file); await store.load();
  const retired = await (await fetcher(`/api/personal-worker-dismissals?conversationId=${conversationId}`)).json();
  expect(retired.entries.find((entry: { executionId: string }) => entry.executionId === anchor).dismissed).toBe(false);
});

test("all-page launcher reconciliation suppresses false terminal evidence from completed async tool rows", async () => {
  const tool: ToolItem = { type: "tool", id: "tool:launch", name: "task", input: '{"description":"Review"}', status: "completed", createdAt: 10 };
  const task: BackgroundTaskItem = { type: "background_task", id: "task:run", taskId: "run", toolUseId: "launch", status: "running", description: "Review", createdAt: 10, activity: { kind: "working", executionId: "exact" } };
  const requests = childPages([[tool], [task]]);
  const evidence = await readAuthoritativeWorkerEvidence(running, conversationId);
  expect(requests).toEqual(["first", "1"]);
  expect(evidence.find(item => item.executionId === "worker-dismissal:tool:launch")).toMatchObject({ active: true, dismissible: false });
  expect(evidence.every(item => item.active && !item.dismissible)).toBe(true);
  tool.id = "launch"; // Legacy provider rows expose the native call directly.
  expect(await readAuthoritativeWorkerEvidence(running, conversationId)).toEqual(evidence);
  expect(compactWorkers([tool, task])).toHaveLength(1);
});

test("terminal launcher evidence is page-order stable and contradictory identities still refuse", async () => {
  const task: BackgroundTaskItem = { type: "background_task", id: "task:run", taskId: "run", toolUseIds: ["second", "first"], status: "failed", description: "Review", createdAt: 10 };
  const tool: ToolItem = { type: "tool", id: "tool:first", name: "task", input: '{"description":"Review"}', status: "completed", createdAt: 10 };
  const pages = [[tool], [task]];
  childPages(pages);
  const first = await readAuthoritativeWorkerEvidence(running, conversationId);
  pages.reverse();
  expect(await readAuthoritativeWorkerEvidence(running, conversationId)).toEqual(first);
  pages.push([{ ...task, id: "task:contradictory", status: "stopped" }]);
  await expect(readAuthoritativeWorkerEvidence(running, conversationId)).rejects.toThrow("ambiguous authoritative worker identity");
});

test("accepted activity without optional executionId retires immutable-anchor marks in client and trusted Hub observation", async () => {
  const item = parseConversationItem({ type: "background_task", id: "task:run", taskId: "run", toolUseId: "call", status: "running", createdAt: 1, description: "Review", childConversationId: "same-child", activity: { kind: "unavailable", executionId: "positive" } }) as BackgroundTaskItem;
  childPages([[item]]);
  const root = await mkdtemp(path.join(tmpdir(), "uatu-optional-dismissal-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new WorkerDismissalsStore(path.join(root, "marks.json")); await store.load();
  const operations: string[] = [];
  let changed: () => void = () => {};
  const client = new WorkerDismissalClient({ changed: () => changed(), fetcher: async (url, init) => {
    if (init?.method === "POST") operations.push(JSON.parse(init.body as string).operation);
    return handleWorkerDismissals(new Request(new URL(url, "http://hub.invalid"), init), { user: "alice", workspaceId: "project", store, read: () => readAuthoritativeWorkerEvidence(running, conversationId) });
  } });
  cleanups.push(() => client.dispose());
  const ready = new Promise<void>(resolve => { changed = resolve; });
  client.select(conversationId); await ready;
  await client.dismiss("worker-dismissal:tool:call");
  expect(client.dismissed.has("worker-dismissal:tool:call")).toBe(true);
  item.activity = { kind: "working" };
  expect(parseConversationItem(JSON.parse(JSON.stringify(item)))).toEqual(item);
  const observations: unknown[] = [];
  observeWorkerProjection({ observe: (...args: unknown[]) => observations.push(args) } as unknown as WorkerDismissalsStore,
    "project", conversationId, { type: "item.upsert", conversationId, item });
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject(["project", conversationId, [
    { executionId: "worker-dismissal:tool:call", active: true, dismissible: false },
    { executionId: "worker-dismissal:task:run", active: true, dismissible: false },
  ]]);
  observeWorkerProjection(store, "project", conversationId, { type: "item.upsert", conversationId, item });
  const hookOnly = await store.reconcile({ user: "alice", workspaceId: "project", conversationId }, async () => []);
  expect(hookOnly.entries.find(entry => entry.executionId === "worker-dismissal:tool:call")?.dismissed).toBe(false);
  const retired = new Promise<void>(resolve => { changed = resolve; });
  client.observe(compactWorkers([item]));
  expect(visibleWorkers(compactWorkers([item]), client.dismissed)).toHaveLength(1);
  await retired;
  expect(operations).toEqual(["dismiss", "retire"]);
  // Positive evidence changes the durable signature, so the stale retirement
  // POST may conflict; wait for its ordinary authoritative refresh to settle.
  if (client.error) await new Promise<void>(resolve => { changed = resolve; });
  expect(client.error).toBe("");
  item.activity = { kind: "unavailable", executionId: "positive" };
  client.observe(compactWorkers([item]));
  expect(visibleWorkers(compactWorkers([item]), client.dismissed)).toHaveLength(1);
  expect(client.error).toBe("");
  const next = { ...item, id: "task:next", taskId: "next", toolUseId: "new-call", activity: { kind: "unavailable" as const } };
  expect(visibleWorkers(compactWorkers([next]), new Set(["worker-dismissal:tool:call"]))).toHaveLength(1);
});

test("header batch DOM skips an accepted oversized identity, posts supported work and retains skipped/storage feedback", async () => {
  const mode = process.env.UATU_DISMISSAL_BATCH_DOM;
  if (!mode) {
    for (const scenario of ["success", "read-failure", "save-failure"]) {
      const child = Bun.spawn({ cmd: [process.execPath, "test", import.meta.path, "--test-name-pattern", "header batch DOM"],
        env: { ...process.env, UATU_DISMISSAL_BATCH_DOM: scenario }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, `${scenario}\n${stdout}\n${stderr}`).toBe(0);
    }
    return;
  }
  const { parseHTML } = await import("linkedom");
  const { document, window } = parseHTML(await Bun.file(`${import.meta.dir}/../index.html`).text());
  const browser = window as unknown as Record<string, unknown>;
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (media: string) => ({ media, matches: media === "(pointer: fine) and (hover: hover)", addEventListener() {}, removeEventListener() {} }) });
  const globals: Record<string, unknown> = { window, document, navigator: window.navigator ?? {}, history: { back() {}, forward() {}, pushState() {}, replaceState() {} },
    EventSource: class { addEventListener() {} close() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0), cancelAnimationFrame: clearTimeout,
    CSS: { escape: (value: string) => value.replaceAll('"', '\\"') }, NodeFilter: { SHOW_TEXT: 4 } };
  for (const name of ["Event", "CustomEvent", "Element", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLTemplateElement", "HTMLTextAreaElement", "Node", "MutationObserver", "customElements"]) globals[name] = browser[name];
  for (const [name, value] of Object.entries(globals)) Reflect.set(globalThis, name, value);
  const prototype = (browser.HTMLElement as { prototype: object }).prototype;
  for (const name of ["scrollTo", "scrollIntoView"]) Object.defineProperty(prototype, name, { configurable: true, value() {} });
  const meta = document.createElement("meta"); meta.name = "uatu-hub"; meta.content = "true"; document.head.append(meta);
  document.documentElement.setAttribute("data-ui-mode", "desktop");
  document.documentElement.setAttribute("data-chat-panel", "open");
  let selected = "";
  Object.defineProperty(document.querySelector("#chat-conversation-select")!, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
  const long: ToolItem = { type: "tool", id: `tool:${"x".repeat(500)}`, name: "task", input: '{"description":"Unsupported newer worker"}', status: "completed", createdAt: 20 };
  const ordinary: ToolItem = { ...long, id: "tool:ordinary", input: '{"description":"Supported older worker"}', createdAt: 10 };
  const items = [long, ordinary].map(item => parseConversationItem(item));
  expect(workerExecutionIds(compactWorkers(items)[0]!)).toHaveLength(0);
  const posts: string[] = []; let reads = 0;
  const entries = [{ executionId: "worker-dismissal:tool:ordinary", revision: 0, dismissed: false }];
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body as string).executionId);
      if (mode === "save-failure") return new Response(null, { status: 503 });
      entries[0]!.dismissed = true;
    } else { reads++; if (mode === "read-failure") return new Response(null, { status: 503 }); }
    return Response.json({ version: 1, conversationId, entries });
  }) as typeof fetch);
  const conversation = { id: conversationId, title: "Fixture", createdAt: 1, updatedAt: 1, status: "idle" as const, agent: { id: "opencode", name: "OpenCode" } };
  const api = { status: async () => [{ agent: conversation.agent, availability: { state: "ready", version: "test", agent: { ...conversation.agent, capabilities: ["subagents", "background-tasks"] } } }],
    conversations: async () => [conversation], commands: async () => [], models: async () => [], modes: async () => [],
    snapshot: async () => ({ conversation, configuration: {}, generation: "fixture", cursor: "fixture", items }),
    stream: () => ({ close() {} }), inventoryStream: () => ({ close() {} }), attachmentUrl: () => "" };
  const { initChat } = await import("../chat/ui");
  const { disposeLiveChannel } = await import("../shell/live");
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 1000; attempt++) { if (predicate()) return; await Bun.sleep(1); }
    throw new Error(`DOM state did not settle: ${document.querySelector(".chat-worker-dismissal-notice")?.textContent}; posts=${posts.length}; reads=${reads}`);
  };
  try {
    initChat(api as unknown as import("../chat/client").ChatApiClient);
    await until(() => document.querySelectorAll("[data-worker-id]").length === 2 && reads > 0);
    if (mode === "read-failure") await until(() => Boolean(document.querySelector(".chat-worker-dismissal-notice")?.textContent?.includes("Could not read")));
    document.querySelector<HTMLButtonElement>(".chat-workers-dismiss")!.click();
    await until(() => posts.length === 1);
    await until(() => Boolean(document.querySelector(".chat-worker-dismissal-notice")?.textContent?.includes("Skipped 1")));
    const notice = document.querySelector(".chat-worker-dismissal-notice")!;
    expect(posts).toEqual(["worker-dismissal:tool:ordinary"]);
    expect(notice.textContent).toContain("unverified execution identity");
    if (mode === "read-failure") expect(notice.textContent).toContain("Could not read saved worker dismissals");
    if (mode === "save-failure") { await until(() => Boolean(notice.textContent?.includes("Could not save"))); expect(notice.textContent).toContain("Could not save"); }
    else await until(() => document.querySelectorAll("[data-worker-id]").length === 1);
    expect(document.querySelector(`[data-worker-id="${long.id}"]`)).not.toBeNull();
  } finally { disposeLiveChannel(); mock.mockRestore(); }
}, 30_000);

test("withheld identity on proven alias overflow fails visibly and cannot resurrect old marks on the same page", async () => {
  const task = parseConversationItem({ type: "background_task", id: "task:run", taskId: "run", toolUseIds: Array.from({ length: 65 }, (_, i) => `call-${i}`), description: "Review", status: "running", createdAt: 1, childConversationId: "same-child", activity: { kind: "working" } }) as BackgroundTaskItem;
  let posts = 0; let changed: () => void = () => {};
  const client = new WorkerDismissalClient({ changed: () => changed(), fetcher: async (_url, init) => {
    if (init?.method === "POST") posts++;
    return Response.json({ version: 1, conversationId, entries: [{ executionId: "worker-dismissal:tool:call-0", dismissed: true, revision: 1 }] });
  } });
  cleanups.push(() => client.dispose());
  const loaded = new Promise<void>(resolve => { changed = resolve; }); client.select(conversationId); await loaded;
  expect(client.dismissed.size).toBe(1);
  client.observe(compactWorkers([task]));
  expect(client.dismissed.size).toBe(0);
  expect(client.error).toContain("execution identity");
  expect(client.error).toContain("saved dismissals");
  const unavailable = { ...task, toolUseIds: ["call-0"], activity: { kind: "unavailable" as const, executionId: "restored" } };
  client.observe(compactWorkers([unavailable]));
  expect(visibleWorkers(compactWorkers([unavailable]), client.dismissed)).toHaveLength(1);
  await client.dismiss("worker-dismissal:tool:call-0");
  expect(posts).toBe(0);
  expect(client.error).toContain("execution identity");
  const refreshed = new Promise<void>(resolve => { changed = resolve; }); client.refresh(); await refreshed;
  expect(client.dismissed.size).toBe(0);
  expect(client.error).toContain("execution identity");
});
