import { describe, expect, test } from "bun:test";

import type { OpenCodeProvider } from "./provider";
import { OpenCodeChatAdapter } from "./adapter";
import { OpenCodeService, type SpawnedOpenCode } from "./opencode-service";
import { LazyOpenCodeChatService } from "./service";

function provider(): OpenCodeProvider {
  return {
    async listCommands() { return []; },
    async listModels() { return []; },
    async switchModel() {},
    async listSessions() { return []; },
    async createSession() { throw new Error("unused"); },
    async getSession() { return null; },
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
    expect(await service.status()).toEqual({ state: "ready", version: "test" });
    expect(providerCalls).toBe(1);
    expect(adapterCalls).toBe(1);
    expect(await service.models()).toEqual([]);
    expect(await service.commands()).toEqual([]);
    await service.listConversations();
    expect(providerCalls).toBe(1);
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
    expect(await service.status()).toEqual({ state: "ready", version: "test" });
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
    expect(await service.retry()).toEqual({ state: "ready", version: "test" });
    // The incompatible process was replaced, not merely re-probed.
    expect(spawns).toBe(2);
    expect(probes).toBe(2);
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
});
