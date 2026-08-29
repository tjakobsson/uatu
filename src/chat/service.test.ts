import { describe, expect, test } from "bun:test";

import type { OpenCodeProvider } from "./provider";
import type { ChatAgent, ReversibleHistoryResult } from "./types";

// What `provider()` below declares — the ready state carries it once the
// adapter exists, so every ready assertion names it.
const FAKE_AGENT: ChatAgent = { id: "opencode", name: "OpenCode", capabilities: ["models", "commands", "permissions"] };
import { OpenCodeChatAdapter, ReversibleHistoryUnsupportedError } from "./adapter";
import { OpenCodeService, type SpawnedOpenCode } from "./opencode-service";
import { LazyOpenCodeChatService } from "./service";

function provider(): OpenCodeProvider {
  return {
    describe(): ChatAgent { return FAKE_AGENT; },
    async listCommands() { return []; },
    async listModels() { return []; },
    async switchModel() {},
    async listSessions() { return []; },
    async newConversationConfiguration() { return {}; },
    async createSession() { throw new Error("unused"); },
    async getSession() { return null; },
    async getConversationConfiguration() { return {}; },
    async listMessages() { return { items: [] }; },
    async *events(signal) { while (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); },
    async prompt() { throw new Error("unused"); },
    async command() { throw new Error("unused"); },
    async interrupt() {},
    async replyPermission() {},
    async replyQuestion() {},
    async rejectQuestion() {},
  };
}

function fixtureRuntime(): OpenCodeService {
  // Fresh child per spawn: restart() terminates the old process and spawns a
  // replacement, which a single shared child (whose `exited` promise has
  // already resolved) cannot model.
  const exits: Array<(code: number) => void> = [];
  return new OpenCodeService({
    workspacePath: "/workspace",
    discoverCandidates: async () => ["/bin/opencode"],
    allocatePort: async () => 43210,
    spawn: (): SpawnedOpenCode => {
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { resolveExit = resolve; });
      exits.push(resolveExit);
      return {
        pid: 42,
        exited,
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        kill() { resolveExit(143); },
      };
    },
    fetch: async () => Response.json({ healthy: true, version: "test" }),
    killGroup: () => { for (const resolve of exits) resolve(143); },
  });
}

describe("LazyOpenCodeChatService", () => {
  test("creates the SDK provider and adapter only after the runtime is ready", async () => {
    let providerCalls = 0;
    let adapterCalls = 0;
    const runtime = fixtureRuntime();
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime,
      createProvider(options) {
        providerCalls += 1;
        expect(runtime.currentConnection()).toEqual({ endpoint: options.endpoint, password: options.password });
        return provider();
      },
      createAdapter(options) {
        adapterCalls += 1;
        return new OpenCodeChatAdapter({ ...options, generation: "test" });
      },
    });

    expect(providerCalls).toBe(0);
    expect(adapterCalls).toBe(0);
    expect(await service.status()).toEqual({ state: "ready", version: "test", agent: FAKE_AGENT });
    expect(providerCalls).toBe(1);
    expect(adapterCalls).toBe(1);
    expect(await service.models()).toEqual([]);
    expect(await service.commands()).toEqual([]);
    await service.listConversations();
    expect(providerCalls).toBe(1);
    await service.dispose();
  });

  test("passes provider-neutral inventory subscriptions and abort signals to the adapter", async () => {
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime: fixtureRuntime(),
      createProvider: () => provider(),
      createAdapter: options => new OpenCodeChatAdapter({ ...options, generation: "test" }),
    });
    const controller = new AbortController();

    const inventory = await service.subscribeInventory({ signal: controller.signal });
    expect(await inventory.next()).toEqual({ value: undefined, done: false });
    const waiting = inventory.next();

    controller.abort();

    expect((await waiting).done).toBe(true);
    expect((await inventory.next()).done).toBe(true);
    await service.dispose();
  });

  test("forwards reversible-history results and adapter failures unchanged", async () => {
    const changed: ReversibleHistoryResult = {
      outcome: "changed",
      state: { staged: true, canUndo: false, canRedo: true },
      restoredDraft: { text: "Restored prompt" },
    };
    const noOp: ReversibleHistoryResult = {
      outcome: "nothing-to-redo",
      state: { staged: false, canUndo: true, canRedo: false },
    };
    let undo: (id: string, requestId: string) => Promise<ReversibleHistoryResult> = async () => changed;
    let redo: (id: string, requestId: string) => Promise<ReversibleHistoryResult> = async () => noOp;
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime: fixtureRuntime(),
      createProvider: () => provider(),
      createAdapter: options => {
        const adapter = new OpenCodeChatAdapter({ ...options, generation: "test" });
        adapter.undo = (id, requestId) => undo(id, requestId);
        adapter.redo = (id, requestId) => redo(id, requestId);
        return adapter;
      },
    });

    expect(await service.undo("conversation", "undo-1")).toEqual(changed);
    expect(await service.redo("conversation", "redo-1")).toEqual(noOp);

    const unsupported = new ReversibleHistoryUnsupportedError();
    undo = async () => { throw unsupported; };
    await expect(service.undo("conversation", "undo-2")).rejects.toBe(unsupported);

    const providerFailure = new Error("provider failed");
    redo = async () => { throw providerFailure; };
    await expect(service.redo("conversation", "redo-2")).rejects.toBe(providerFailure);
    await service.dispose();
  });

  test("a failed adapter probe is retried on the next status call instead of caching unsupported", async () => {
    let probes = 0;
    const flaky = {
      ...provider(),
      async listModels() {
        probes += 1;
        if (probes === 1) throw new Error("transient blip");
        return [];
      },
    } satisfies OpenCodeProvider;
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime: fixtureRuntime(),
      createProvider: () => flaky,
      createAdapter: options => new OpenCodeChatAdapter({ ...options, generation: "test" }),
    });

    expect(await service.status()).toEqual({
      state: "unavailable",
      reason: "unsupported",
      message: "The installed OpenCode version is not compatible with chat.",
    });
    expect(await service.status()).toEqual({ state: "ready", version: "test", agent: FAKE_AGENT });
    expect(probes).toBe(2);
    expect(await service.models()).toEqual([]);
    await service.dispose();
  });

  test("an incompatible provider keeps reporting unsupported and blocks operations", async () => {
    const incompatible = {
      ...provider(),
      async listModels(): Promise<never> { throw new Error("404 not found"); },
    } satisfies OpenCodeProvider;
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime: fixtureRuntime(),
      createProvider: () => incompatible,
      createAdapter: options => new OpenCodeChatAdapter({ ...options, generation: "test" }),
    });

    const first = await service.status();
    expect(first.state).toBe("unavailable");
    const second = await service.status();
    expect(second).toEqual(first);
    await expect(service.models()).rejects.toThrow("chat is unavailable");
    await service.dispose();
  });

  test("restarts the event pump when the provider stream dies", async () => {
    let pumpStarts = 0;
    const failing = {
      ...provider(),
      async *events() {
        pumpStarts += 1;
        // Model a provider stream that dies immediately, as it does when the
        // OpenCode server restarts underneath us.
        throw new Error("stream closed");
      },
    } satisfies OpenCodeProvider;
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime: fixtureRuntime(),
      createProvider: () => failing,
      createAdapter: options => new OpenCodeChatAdapter({ ...options, generation: "test" }),
    });

    await service.status();
    await Bun.sleep(1);
    expect(pumpStarts).toBe(1);

    // The supervisor waits out its backoff before the next attempt.
    await Bun.sleep(1_500);
    expect(pumpStarts).toBeGreaterThan(1);

    await service.dispose();
    const afterDispose = pumpStarts;
    await Bun.sleep(2_500);
    expect(pumpStarts).toBe(afterDispose);
  }, 10_000);

  test("retry restarts the runtime so a replaced binary is picked up", async () => {
    // Models an incompatible install that the user then fixes: the runtime is
    // "ready" the whole time, so only a real process restart re-probes the
    // binary that is actually on disk now.
    let spawns = 0;
    const exits: Array<(code: number) => void> = [];
    const runtime = new OpenCodeService({
      workspacePath: "/workspace",
      discoverCandidates: async () => ["/bin/opencode"],
      allocatePort: async () => 43210,
      spawn: (): SpawnedOpenCode => {
        spawns += 1;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>(resolve => { resolveExit = resolve; });
        exits.push(resolveExit);
        return {
          pid: 42,
          exited,
          stderr: new ReadableStream({ start(controller) { controller.close(); } }),
          kill() { resolveExit(143); },
        };
      },
      fetch: async () => Response.json({ healthy: true, version: "test" }),
      killGroup: () => { for (const resolve of exits) resolve(143); },
    });
    let probes = 0;
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime,
      createProvider: () => ({
        ...provider(),
        async listModels() {
          probes += 1;
          if (probes === 1) throw new Error("404 not found");
          return [];
        },
      } satisfies OpenCodeProvider),
      createAdapter: options => new OpenCodeChatAdapter({ ...options, generation: "test" }),
    });

    expect(await service.status()).toEqual({
      state: "unavailable",
      reason: "unsupported",
      message: "The installed OpenCode version is not compatible with chat.",
    });
    expect(spawns).toBe(1);
    expect(await service.retry()).toEqual({ state: "ready", version: "test", agent: FAKE_AGENT });
    // The incompatible process was replaced, not merely re-probed.
    expect(spawns).toBe(2);
    expect(probes).toBe(2);
    await service.dispose();
  });

  test("concurrent service retries join one sequence instead of double-restarting", async () => {
    let spawns = 0;
    const exits: Array<(code: number) => void> = [];
    const runtime = new OpenCodeService({
      workspacePath: "/workspace",
      discoverCandidates: async () => ["/bin/opencode"],
      allocatePort: async () => 43210,
      spawn: (): SpawnedOpenCode => {
        spawns += 1;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>(resolve => { resolveExit = resolve; });
        exits.push(resolveExit);
        return {
          pid: 42,
          exited,
          stderr: new ReadableStream({ start(controller) { controller.close(); } }),
          kill() { resolveExit(143); },
        };
      },
      fetch: async () => Response.json({ healthy: true, version: "test" }),
      killGroup: () => { for (const resolve of exits) resolve(143); },
    });
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime,
      createProvider: () => provider(),
      createAdapter: options => new OpenCodeChatAdapter({ ...options, generation: "test" }),
    });

    await service.status();
    expect(spawns).toBe(1);
    // Runtime-level joining cannot help two retries that reach it at
    // different times — the first can stall on pump shutdown and then
    // restart the runtime the second one just built.
    const [first, second] = await Promise.all([service.retry(), service.retry()]);
    expect(first).toEqual({ state: "ready", version: "test", agent: FAKE_AGENT });
    expect(second).toEqual(first);
    expect(spawns).toBe(2);
    await service.dispose();
  });

  test("an adapter built during retry teardown is retired, not published", async () => {
    let spawnIndex = 0;
    const exits: Array<(code: number) => void> = [];
    const runtime = new OpenCodeService({
      workspacePath: "/workspace",
      discoverCandidates: async () => ["/bin/opencode"],
      allocatePort: async () => 43200 + spawnIndex,
      spawn: (): SpawnedOpenCode => {
        spawnIndex += 1;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>(resolve => { resolveExit = resolve; });
        exits.push(resolveExit);
        return {
          pid: 42,
          exited,
          stderr: new ReadableStream({ start(controller) { controller.close(); } }),
          kill() { resolveExit(143); },
        };
      },
      fetch: async () => Response.json({ healthy: true, version: "test" }),
      killGroup: () => { for (const resolve of exits) resolve(143); },
    });
    const endpoints: string[] = [];
    let releasePump: (() => void) | null = null;
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime,
      createProvider: options => { endpoints.push(options.endpoint); return provider(); },
      createAdapter: options => {
        const adapter = new OpenCodeChatAdapter({ ...options, generation: "test" });
        if (endpoints.length === 1) {
          // The first adapter's pump stop stalls, widening the teardown
          // window another request can race into.
          const original = adapter.stopEventPump.bind(adapter);
          adapter.stopEventPump = async () => {
            await new Promise<void>(resolve => { releasePump = resolve; });
            await original();
          };
        }
        return adapter;
      },
    });

    await service.status();
    const retrying = service.retry();
    while (!releasePump) await Bun.sleep(1);
    // Another client asks while the retry is tearing down: this builds an
    // adapter against the old endpoint, which must not survive the restart.
    const during = service.status();
    await Bun.sleep(5);
    (releasePump as unknown as () => void)();
    expect(await retrying).toEqual({ state: "ready", version: "test", agent: FAKE_AGENT });
    await during;

    // Initial, the stray built mid-teardown, and the post-restart rebuild —
    // and what is current now is the post-restart connection, not the stray.
    expect(endpoints).toHaveLength(3);
    expect(endpoints.at(-1)).toBe(runtime.currentConnection()?.endpoint);
    await service.dispose();
  });

  test("retry retires the previous adapter's supervisor instead of leaking it", async () => {
    const pumpStarts: number[] = [];
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime: fixtureRuntime(),
      createProvider: () => {
        const index = pumpStarts.push(0) - 1;
        return {
          ...provider(),
          async *events() {
            pumpStarts[index] += 1;
            throw new Error("stream closed");
          },
        } satisfies OpenCodeProvider;
      },
      createAdapter: options => new OpenCodeChatAdapter({ ...options, generation: "test" }),
    });

    await service.status();
    await Bun.sleep(1);
    expect(pumpStarts[0]).toBeGreaterThanOrEqual(1);

    await service.retry();
    await Bun.sleep(1);
    const stale = pumpStarts[0]!;
    // The retired supervisor never reconnects the dead adapter, while the
    // replacement's supervisor runs — one loop per retry must not accumulate.
    await Bun.sleep(2_500);
    expect(pumpStarts[0]).toBe(stale);
    expect(pumpStarts[1]).toBeGreaterThan(0);

    await service.dispose();
  }, 10_000);

  test("retry terminally disposes the retired adapter and closes its inventory subscribers", async () => {
    const adapters: OpenCodeChatAdapter[] = [];
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime: fixtureRuntime(),
      createProvider: () => provider(),
      createAdapter: options => {
        const adapter = new OpenCodeChatAdapter({ ...options, generation: "test" });
        adapters.push(adapter);
        return adapter;
      },
    });

    await service.status();
    const inventory = await service.subscribeInventory();
    expect((await inventory.next()).done).toBe(false);
    const waiting = inventory.next();

    await service.retry();

    expect((await waiting).done).toBe(true);
    expect((await adapters[0]!.subscribeInventory().next()).done).toBe(true);
    expect(adapters).toHaveLength(2);
    await service.dispose();
  });
});
