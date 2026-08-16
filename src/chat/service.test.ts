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

describe("LazyOpenCodeChatService", () => {
  test("creates the SDK provider and adapter only after the runtime is ready", async () => {
    let providerCalls = 0;
    let adapterCalls = 0;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const child: SpawnedOpenCode = {
      pid: 42,
      exited,
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      kill() { resolveExit(143); },
    };
    const runtime = new OpenCodeService({
      workspacePath: "/workspace",
      discoverExecutable: async () => "/bin/opencode",
      allocatePort: async () => 43210,
      spawn: () => child,
      fetch: async () => Response.json({ healthy: true, version: "test" }),
      killGroup: () => resolveExit(143),
    });
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
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const child: SpawnedOpenCode = {
      pid: 42,
      exited,
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      kill() { resolveExit(143); },
    };
    const runtime = new OpenCodeService({
      workspacePath: "/workspace",
      discoverExecutable: async () => "/bin/opencode",
      allocatePort: async () => 43210,
      spawn: () => child,
      fetch: async () => Response.json({ healthy: true, version: "test" }),
      killGroup: () => resolveExit(143),
    });
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
      runtime,
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
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const child: SpawnedOpenCode = {
      pid: 42,
      exited,
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      kill() { resolveExit(143); },
    };
    const runtime = new OpenCodeService({
      workspacePath: "/workspace",
      discoverExecutable: async () => "/bin/opencode",
      allocatePort: async () => 43210,
      spawn: () => child,
      fetch: async () => Response.json({ healthy: true, version: "test" }),
      killGroup: () => resolveExit(143),
    });
    const incompatible = {
      ...provider(),
      async listModels(): Promise<never> { throw new Error("404 not found"); },
    } satisfies OpenCodeProvider;
    const service = new LazyOpenCodeChatService({
      workspacePath: "/workspace",
      runtime,
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
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const child: SpawnedOpenCode = {
      pid: 42,
      exited,
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      kill() { resolveExit(143); },
    };
    const runtime = new OpenCodeService({
      workspacePath: "/workspace",
      discoverExecutable: async () => "/bin/opencode",
      allocatePort: async () => 43210,
      spawn: () => child,
      fetch: async () => Response.json({ healthy: true, version: "test" }),
      killGroup: () => resolveExit(143),
    });
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
      runtime,
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
});
