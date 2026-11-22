import type { ChatProvider } from "../provider";
import type { AgentRuntime } from "../service";
import { OpenCodeService, type OpenCodeGeneration, type OpenCodeServiceOptions } from "./opencode-service";
import { createOpenCodeV1Provider } from "./v1/provider";
import { createOpenCodeV2Provider } from "./v2/provider";

/**
 * Builds the provider for a ready OpenCode server. Which factory runs is the
 * server's generation, decided by its readiness answer: the 1.x stack over
 * `@opencode-ai/sdk`, the 2.x stack over `@opencode/client`.
 */
export type OpenCodeProviderFactory = (options: { endpoint: string; password: string; directory: string; generation: OpenCodeGeneration }) => ChatProvider;
export type OpenCodeProviderFactories = Partial<Record<OpenCodeGeneration, OpenCodeProviderFactory>>;

const DEFAULT_PROVIDER_FACTORIES: Record<OpenCodeGeneration, OpenCodeProviderFactory> = {
  1: createOpenCodeV1Provider,
  2: createOpenCodeV2Provider,
};

export type OpenCodeAgentRuntimeOptions = OpenCodeServiceOptions & {
  // An already-built server runtime; otherwise one is built from the
  // options above.
  service?: OpenCodeService;
  // One factory for every generation (a test double), or a factory per
  // generation, each defaulting to the real stack for that generation.
  createProvider?: OpenCodeProviderFactory | OpenCodeProviderFactories;
};

/**
 * The OpenCode agent stack: one spawned loopback server whose connection
 * (endpoint + password) feeds the SDK provider. The connection details stay
 * below this seam — the chat service never sees them.
 */
export function openCodeAgentRuntime(options: OpenCodeAgentRuntimeOptions): AgentRuntime {
  const runtime = options.service ?? new OpenCodeService(options);
  const factories = resolveProviderFactories(options.createProvider);
  return {
    status: () => Promise.resolve(runtime.peekStatus()),
    ensure: () => runtime.status(),
    restart: () => runtime.restart(),
    dispose: () => runtime.dispose(),
    createProvider: () => {
      // The connection carries the generation its server answered with, so a
      // restart that finds a replaced binary builds the other stack.
      const connection = runtime.currentConnection();
      if (!connection) return null;
      return factories[connection.generation]({
        endpoint: connection.endpoint,
        password: connection.password,
        directory: options.workspacePath,
        generation: connection.generation,
      });
    },
  };
}

export function resolveProviderFactories(override: OpenCodeAgentRuntimeOptions["createProvider"]): Record<OpenCodeGeneration, OpenCodeProviderFactory> {
  if (typeof override === "function") return { 1: override, 2: override };
  return { ...DEFAULT_PROVIDER_FACTORIES, ...(override ?? {}) };
}
