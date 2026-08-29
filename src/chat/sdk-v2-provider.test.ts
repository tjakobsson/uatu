import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

import { normalizePersistedConversationConfiguration, resolveNewConversationConfiguration, SdkV2Provider, stableProviderId } from "./sdk-v2-provider";
import { ReversibleHistoryTargetError } from "./provider";

describe("OpenCode v2 identity policy", () => {
  test("declares durable conversation rename support", () => {
    const provider = new SdkV2Provider({} as OpencodeClient, "/workspace");
    expect(provider.describe().capabilities).toContain("conversation-rename");
  });

  test("normalizes native and compatibility persisted configuration without inventing fields", () => {
    expect(normalizePersistedConversationConfiguration([{
      model: { providerID: "openai", id: "gpt-5", variant: "high" },
      agent: "build",
    }], [])).toEqual({ model: { providerId: "openai", modelId: "gpt-5" }, mode: "build", variant: "high" });
    expect(normalizePersistedConversationConfiguration([{
      model: { providerID: "lmstudio", id: "qwen3.8", variant: "default" },
      agent: "build",
    }], [])).toEqual({ model: { providerId: "lmstudio", modelId: "qwen3.8" }, mode: "build" });

    expect(normalizePersistedConversationConfiguration([], [{
      info: {
        id: "msg_user",
        role: "user",
        time: { created: 2 },
        agent: "plan",
        model: { providerID: "anthropic", modelID: "claude" },
        variant: "max",
      },
      parts: [],
    }])).toEqual({ model: { providerId: "anthropic", modelId: "claude" }, mode: "plan", variant: "max" });

    expect(normalizePersistedConversationConfiguration([], [{
      info: { id: "msg_assistant", role: "assistant", time: { created: 1 }, mode: "build", modelID: "claude", providerID: "anthropic" },
      parts: [],
    }])).toEqual({ model: { providerId: "anthropic", modelId: "claude" }, mode: "build" });
    expect(normalizePersistedConversationConfiguration([], [{ info: { id: "msg", role: "user", time: { created: 1 }, variant: "high" }, parts: [] }])).toEqual({});
  });

  test("a fresh provider reconstructs configuration from persisted records", async () => {
    const persisted = [{
      info: {
        id: "msg_user",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
      },
      parts: [],
    }];
    const client = {
      session: {
        get: async () => ({ data: { ...session("ses_restart"), metadata: { "uatu.transport": "compatibility" } } }),
        messages: async () => ({ data: persisted }),
      },
      v2: {
        session: {
          get: async () => ({ error: { message: "missing" }, response: { status: 404 } }),
          messages: async () => ({ data: { data: [], cursor: { next: null } } }),
        },
      },
    } as unknown as OpencodeClient;

    const restarted = new SdkV2Provider(client, "/workspace");
    expect(await restarted.getConversationConfiguration("ses_restart")).toEqual({
      model: { providerId: "openai", modelId: "gpt-5" },
      mode: "build",
      variant: "high",
    });
  });

  test("configuration recovery reuses messages already loaded for history", async () => {
    let messageReads = 0;
    const client = {
      session: {
        get: async () => ({ data: { ...session("ses_reuse"), metadata: { "uatu.transport": "compatibility" } } }),
        messages: async () => { messageReads += 1; return { data: [] }; },
      },
      v2: {
        session: {
          get: async () => ({ error: { message: "missing" }, response: { status: 404 } }),
          messages: async () => { messageReads += 1; return { data: { data: [], cursor: { next: null } } }; },
        },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");
    const messages = [{
      info: {
        id: "msg_user",
        role: "user",
        time: { created: 1 },
        agent: "plan",
        model: { providerID: "openai", modelID: "gpt" },
      },
      parts: [],
    }];

    expect(await provider.getConversationConfiguration("ses_reuse", messages)).toEqual({
      model: { providerId: "openai", modelId: "gpt" },
      mode: "plan",
    });
    expect(messageReads).toBe(0);
  });

  test("resolves new conversations with OpenCode's durable cold-TUI policy", () => {
    const agents = [
      { name: "plan", mode: "primary" },
      { name: "build", mode: "primary", model: { providerID: "anthropic", modelID: "claude" } },
      { name: "explore", mode: "subagent", model: { providerID: "openai", modelID: "gpt" } },
    ];
    const providers = {
      providers: [
        { id: "openai", models: { gpt: { id: "gpt", variants: { high: {} } } } },
        { id: "anthropic", models: { claude: { id: "claude", variants: { max: {} } } } },
      ],
      default: { openai: "gpt", anthropic: "claude" },
    };
    const preferences = {
      recent: [{ providerID: "openai", modelID: "gpt" }],
      variant: { "anthropic/claude": "max", "openai/gpt": "default" },
    };

    // The built-in default is Build, and its configured model outranks config
    // and recency. A currently advertised durable variant follows the model.
    expect(resolveNewConversationConfiguration(
      { model: "openai/gpt" },
      agents,
      providers,
      preferences,
    )).toEqual({ model: { providerId: "anthropic", modelId: "claude" }, mode: "build", variant: "max" });

    // A configured default agent wins. Without an agent model, workspace
    // config wins recency, while the TUI's "default" sentinel stays absent.
    expect(resolveNewConversationConfiguration(
      { default_agent: "plan", model: "openai/gpt" },
      agents,
      providers,
      preferences,
    )).toEqual({ model: { providerId: "openai", modelId: "gpt" }, mode: "plan" });

    // With no configured model, the most recently selected valid model wins.
    expect(resolveNewConversationConfiguration(
      { default_agent: "plan" },
      agents,
      providers,
      { recent: [{ providerID: "anthropic", modelID: "claude" }], variant: { "anthropic/claude": "stale" } },
    )).toEqual({ model: { providerId: "anthropic", modelId: "claude" }, mode: "plan" });
  });
  test("lists models from every authenticated provider", async () => {
    const client = {
      provider: {
        list: async () => ({ data: {
          connected: ["openai", "opencode"],
          default: {},
          all: [
            { id: "unused", name: "Unused", models: { hidden: { id: "hidden", name: "Hidden" } } },
            { id: "openai", name: "OpenAI", models: { sol: { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", variants: { high: {}, xhigh: {} }, limit: { context: 200000 } } } },
            { id: "opencode", name: "OpenCode", models: { free: { id: "free", name: "Free" } } },
          ],
        } }),
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    expect(await provider.listModels()).toEqual([
      { selection: { providerId: "openai", modelId: "gpt-5.6-sol" }, provider: "OpenAI", name: "GPT-5.6 Sol", variants: ["high", "xhigh"], contextLimit: 200000 },
      { selection: { providerId: "opencode", modelId: "free" }, provider: "OpenCode", name: "Free" },
    ]);
    // The variants capability is declared now that listModels reports variants.
    expect(provider.describe().capabilities).toContain("variants");
  });

  test("maps and deduplicates compatibility commands and supplies missing built-ins", async () => {
    let listInput: Record<string, unknown> | undefined;
    const client = {
      command: {
        list: async (input: Record<string, unknown>) => {
          listInput = input;
          return { data: [
            { name: "review", description: "Review changes", hints: ["[focus]"], source: "command" },
            { name: "review", description: "Duplicate", hints: [], source: "skill" },
            { name: "docs", description: "Use docs", hints: ["<topic>", "[detail]"], source: "skill" },
            { name: "compact", description: "Provider compact", hints: [], source: "command" },
          ] };
        },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    expect(await provider.listCommands()).toEqual([
      { name: "review", description: "Review changes", argumentHint: "[focus]", kind: "command" },
      { name: "docs", description: "Use docs", argumentHint: "<topic> [detail]", kind: "skill" },
      { name: "compact", description: "Provider compact", argumentHint: "", kind: "command" },
      { name: "summarize", description: "Summarize and compact the conversation context", argumentHint: "", kind: "command" },
    ]);
    expect(listInput).toEqual({ directory: "/workspace" });
  });

  test("dispatches compatibility commands with stable IDs and provider/model strings", async () => {
    let commandInput: Record<string, unknown> | undefined;
    let summarizeInput: Record<string, unknown> | undefined;
    const client = {
      session: {
        command: async (input: Record<string, unknown>) => { commandInput = input; return { data: { info: {}, parts: [] } }; },
        summarize: async (input: Record<string, unknown>) => { summarizeInput = input; return { data: true }; },
      },
      // A v2-native command re-sends the model reference before dispatching,
      // exactly as prompt does; this test's assertions are about the dispatch.
      v2: { session: { switchModel: async () => ({ data: undefined }) } },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");
    const model = { providerId: "anthropic", modelId: "claude-sonnet" };

    const accepted = await provider.command("ses_provider", { id: "request", name: "review", arguments: "API routes", model });
    expect(accepted.messageId).toMatch(/^msg_[a-f0-9]{26}$/);
    expect(commandInput).toEqual({
      sessionID: "ses_provider",
      directory: "/workspace",
      messageID: accepted.messageId,
      command: "review",
      arguments: "API routes",
      model: "anthropic/claude-sonnet",
    });

    await provider.command("ses_provider", { id: "compact-request", name: "compact", arguments: "", model });
    expect(summarizeInput).toEqual({
      sessionID: "ses_provider",
      directory: "/workspace",
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
  });

  test("a command's variant rides the transport the session lives in", async () => {
    // v2-native: the variant is not a body field — it is applied through
    // switchModel before dispatch, exactly as the prompt path does.
    const calls: Array<[string, Record<string, unknown>]> = [];
    const nativeClient = {
      session: {
        command: async (input: Record<string, unknown>) => { calls.push(["command", input]); return { data: { info: {}, parts: [] } }; },
      },
      v2: {
        session: {
          switchModel: async (input: Record<string, unknown>) => { calls.push(["switchModel", input]); return { data: undefined }; },
        },
      },
    } as unknown as OpencodeClient;
    const model = { providerId: "openai", modelId: "gpt-5.6-sol" };
    const native = new SdkV2Provider(nativeClient, "/workspace");
    await native.command("ses_native", { id: "r1", name: "review", arguments: "", model, variant: "xhigh" });
    expect(calls[0]).toEqual(["switchModel", { sessionID: "ses_native", model: { providerID: "openai", id: "gpt-5.6-sol", variant: "xhigh" } }]);
    expect(calls[1]![0]).toBe("command");
    expect(calls[1]![1]).not.toHaveProperty("variant");

    // "Reasoning: default" is a choice too: the model reference is re-sent
    // WITHOUT a variant, exactly as the prompt path does — skipping the call
    // would leave the xhigh applied above silently active for command turns.
    // Unconditional even for a fresh provider: OpenCode keeps a session's
    // variant across restarts, so local memory of "none applied" proves
    // nothing. A recreated provider must reset the same way.
    calls.length = 0;
    const recreated = new SdkV2Provider(nativeClient, "/workspace");
    await recreated.command("ses_native", { id: "r2", name: "review", arguments: "", model });
    expect(calls[0]).toEqual(["switchModel", { sessionID: "ses_native", model: { providerID: "openai", id: "gpt-5.6-sol" } }]);
    expect(calls[1]![0]).toBe("command");

    // Compatibility: prompt and ordinary command carry variant directly;
    // summarize alone has no such field in the pinned transport.
    let commandInput: Record<string, unknown> | undefined;
    let promptInput: Record<string, unknown> | undefined;
    let summarizeInput: Record<string, unknown> | undefined;
    const classicClient = {
      session: {
        create: async () => ({ data: { ...session("ses_classic"), directory: "/workspace" } }),
        command: async (input: Record<string, unknown>) => { commandInput = input; return { data: { info: {}, parts: [] } }; },
        promptAsync: async (input: Record<string, unknown>) => { promptInput = input; return { data: undefined }; },
        summarize: async (input: Record<string, unknown>) => { summarizeInput = input; return { data: true }; },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(classicClient, "/workspace");
    await provider.createSession("client-uuid");
    await provider.command("ses_classic", { id: "r2", name: "review", arguments: "", model, variant: "xhigh" });
    await provider.prompt("ses_classic", { id: "r3", text: "go", delivery: "queue", model, variant: "xhigh" });
    expect(commandInput).toEqual(expect.objectContaining({ model: "openai/gpt-5.6-sol", variant: "xhigh" }));
    expect(promptInput).toEqual(expect.objectContaining({ model: { providerID: "openai", modelID: "gpt-5.6-sol" }, variant: "xhigh" }));
    await expect(provider.command("ses_classic", { id: "r4", name: "compact", arguments: "", model, variant: "xhigh" })).rejects.toThrow("compatibility compaction");
    expect(summarizeInput).toBeUndefined();
  });

  test("session lookup treats 404 as a store miss but propagates other errors", async () => {
    const client = (classicStatus: number, v2Status: number) => ({
      session: { get: async () => ({ error: { message: "classic" }, response: { status: classicStatus } }) },
      v2: { session: { get: async () => ({ error: { message: "v2" }, response: { status: v2Status } }) } },
    }) as unknown as OpencodeClient;

    // Both stores answer not-found: the session is genuinely absent.
    expect(await new SdkV2Provider(client(404, 404), "/workspace").getSession("ses_x")).toBeNull();
    // A transient auth/server failure must surface, not read as missing —
    // requireSession's pump path relies on the distinction.
    await expect(new SdkV2Provider(client(401, 404), "/workspace").getSession("ses_x")).rejects.toThrow("session lookup failed");
    await expect(new SdkV2Provider(client(404, 500), "/workspace").getSession("ses_x")).rejects.toThrow("session lookup failed");
  });

  test("a command rejected within the admission window propagates to the caller", async () => {
    const client = {
      session: {
        command: async () => ({ error: { message: "unknown command" } }),
        summarize: async () => ({ error: { message: "provider unavailable" } }),
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    await expect(provider.command("ses", { id: "r1", name: "review", arguments: "" })).rejects.toThrow("OpenCode request failed");
    await expect(provider.command("ses", { id: "r2", name: "compact", arguments: "" })).rejects.toThrow("OpenCode request failed");
  });

  test("a command still running after the admission window is reported accepted", async () => {
    const client = {
      session: {
        // Models the classic route, which resolves only when the turn ends.
        command: () => new Promise(() => {}),
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace", 20);

    const accepted = await provider.command("ses", { id: "slow", name: "review", arguments: "" });
    expect(accepted.messageId).toMatch(/^msg_[a-f0-9]{26}$/);
  });

  test("merges native and compatibility event streams without duplicates", async () => {
    const stream = (events: unknown[]) => ({
      async *[Symbol.asyncIterator]() { for (const event of events) yield event; },
    });
    const duplicate = { id: "shared", type: "session.idle", data: { sessionID: "ses_provider" } };
    const client = {
      event: { subscribe: async () => ({ stream: stream([duplicate, { id: "classic", type: "message.updated", data: {} }]) }) },
      v2: { event: { subscribe: async () => ({ stream: stream([duplicate, { id: "native", type: "session.next.prompted", data: {} }]) }) } },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    const events = [];
    for await (const event of provider.events(new AbortController().signal)) events.push(event.id);
    expect(events.sort()).toEqual(["classic", "native", "shared"]);
  });

  test("repeated identical id-less events from one stream all pass while cross-stream copies dedupe", async () => {
    const repeat = { type: "message.part.delta", data: { delta: " " } };
    const stream = (events: unknown[]) => ({
      async *[Symbol.asyncIterator]() { for (const event of events) yield event; },
    });
    const client = {
      // The classic stream mirrors the native one: same id-less payloads in
      // the same order.
      event: { subscribe: async () => ({ stream: stream([repeat, repeat]) }) },
      v2: { event: { subscribe: async () => ({ stream: stream([repeat, repeat]) }) } },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    const events: unknown[] = [];
    for await (const event of provider.events(new AbortController().signal)) events.push(event);
    // Two legitimate repeats survive; the mirrored stream's copies are dropped.
    expect(events).toHaveLength(2);
  });

  test("a mid-stream failure propagates after queued events instead of ending the merge silently", async () => {
    const client = {
      event: {
        subscribe: async () => ({
          stream: {
            async *[Symbol.asyncIterator]() {
              yield { id: "classic", type: "message.updated", data: {} };
              throw new Error("stream died");
            },
          },
        }),
      },
      v2: {
        event: {
          subscribe: async () => ({
            stream: { async *[Symbol.asyncIterator]() { yield { id: "native", type: "session.idle", data: {} }; } },
          }),
        },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    const events: unknown[] = [];
    const consume = async () => {
      for await (const event of provider.events(new AbortController().signal)) events.push(event.id);
    };
    await expect(consume()).rejects.toThrow("stream died");
  });

  test("lets OpenCode issue session IDs and maps request IDs to stable message IDs", async () => {
    let createInput: Record<string, unknown> | undefined;
    let promptInput: Record<string, unknown> | undefined;
    const client = {
      session: {
        create: async (input: Record<string, unknown>) => {
          createInput = input;
          return { data: { ...session("ses_provider"), directory: "/workspace" } };
        },
        promptAsync: async (input: Record<string, unknown>) => {
          promptInput = input;
          return { data: undefined };
        },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    expect((await provider.createSession("client-uuid", {
      model: { providerId: "openai", modelId: "gpt-5.6-sol" },
      mode: "plan",
      variant: "high",
    })).id).toBe("ses_provider");
    expect(createInput).toEqual({
      directory: "/workspace",
      metadata: { "uatu.transport": "compatibility" },
      agent: "plan",
      model: { providerID: "openai", id: "gpt-5.6-sol", variant: "high" },
    });

    const model = { providerId: "openai", modelId: "gpt-5.6-sol" };
    const first = await provider.prompt("ses_provider", { id: "client-uuid", text: "hello", delivery: "queue", model });
    const second = await provider.prompt("ses_provider", { id: "client-uuid", text: "hello", delivery: "queue", model });
    expect(first.messageId).toBe(second.messageId);
    expect(first.messageId).toMatch(/^msg_[a-f0-9]{26}$/);
    expect(promptInput).toEqual({
      sessionID: "ses_provider",
      directory: "/workspace",
      messageID: first.messageId,
      parts: [{ type: "text", text: "hello" }],
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
    });
  });

  test("preserves an already valid provider message ID", () => {
    expect(stableProviderId("msg", "msg_existing")).toBe("msg_existing");
  });

  test("lists primary agents only and sends the chosen agent with the prompt", async () => {
    let promptInput: Record<string, unknown> | undefined;
    const client = {
      app: {
        agents: async () => ({ data: [
          { name: "build", description: "Writes code", mode: "primary" },
          { name: "plan", description: "Read-only", mode: "all" },
          { name: "explore", description: "Task-tool only", mode: "subagent" },
          { name: "build", description: "duplicate", mode: "primary" },
          // System agents are primary-mode but hidden on the wire — the field
          // the SDK type omits. They run OpenCode's own bookkeeping turns.
          { name: "title", description: "Names sessions", mode: "primary", hidden: true },
          { name: "compaction", description: "Compacts context", mode: "primary", hidden: true },
          { name: "summary", description: "Summarizes", mode: "primary", hidden: true },
        ] }),
      },
      session: {
        create: async () => ({ data: { ...session("ses_agenty"), directory: "/workspace" } }),
        promptAsync: async (input: Record<string, unknown>) => { promptInput = input; return { data: undefined }; },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    expect(await provider.listModes()).toEqual([
      { name: "build", description: "Writes code" },
      { name: "plan", description: "Read-only" },
    ]);

    await provider.createSession("client-uuid");
    await provider.prompt("ses_agenty", { id: "client-uuid", text: "hello", delivery: "queue", mode: "build" });
    expect(promptInput).toEqual(expect.objectContaining({ agent: "build" }));
  });

  test("switches a v2 session's mode at the session level, not on the prompt", async () => {
    // The generated v2 prompt serializer passes through only
    // id/prompt/delivery/resume — the mode (OpenCode's `agent` field) there is
    // silently dropped, so the switch must be its own call.
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = {
      v2: {
        session: {
          switchAgent: async (input: Record<string, unknown>) => { calls.push(["switchAgent", input]); return { data: undefined }; },
          prompt: async (input: Record<string, unknown>) => { calls.push(["prompt", input]); return { data: { data: { id: "msg_native" } } }; },
        },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    await provider.prompt("ses_native", { id: "client-uuid", text: "go", delivery: "queue", mode: "build" });
    expect(calls[0]).toEqual(["switchAgent", { sessionID: "ses_native", agent: "build" }]);
    expect(calls[1]![0]).toBe("prompt");
    expect(calls[1]![1]).not.toHaveProperty("agent");
  });

  test("answers a subagent's permission through its parent's store", async () => {
    const replies: string[] = [];
    const client = {
      session: {
        create: async () => ({ data: { ...session("ses_parent"), directory: "/workspace" } }),
        get: async (input: { sessionID: string }) => ({
          data: input.sessionID === "ses_child"
            ? { ...session("ses_child"), parentID: "ses_parent" }
            : session("ses_parent"),
        }),
      },
      permission: {
        reply: async (input: Record<string, unknown>) => { replies.push(`classic:${input.requestID}`); return { data: undefined }; },
      },
      v2: {
        session: {
          permission: {
            reply: async () => { replies.push("v2"); return { error: { message: "no such session in the v2 store" } }; },
          },
        },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    await provider.createSession("client-uuid");
    // The adapter always resolves the session before replying; that lookup is
    // where the child learns it lives in its parent's store.
    await provider.getSession("ses_child");
    await provider.replyPermission("ses_child", "perm_1", "once");
    expect(replies).toEqual(["classic:perm_1"]);
  });

  test("the pending-permission list carries the edit's diff through recovery", async () => {
    const client = {
      permission: {
        list: async () => ({ data: [
          { id: "perm_edit", sessionID: "ses_a", action: "edit", resources: ["src/app.ts"], metadata: { diff: "@@ -1 +1 @@\n-old\n+new" } },
          { id: "perm_cmd", sessionID: "ses_a", permission: "shell", patterns: ["bun test"] },
        ] }),
      },
    } as unknown as OpencodeClient;
    const pending = await new SdkV2Provider(client, "/workspace").listPermissions();
    // The edit's diff rides along — a card rebuilt from this list is shown to
    // a reader who missed the live event, and they must see the same change.
    expect(pending).toEqual([
      { requestId: "perm_edit", conversationId: "ses_a", action: "edit", resources: ["src/app.ts"], diff: "@@ -1 +1 @@\n-old\n+new" },
      { requestId: "perm_cmd", conversationId: "ses_a", action: "shell", resources: ["bun test"] },
    ]);
  });

  test("pending questions enable custom answers unless explicitly disabled", async () => {
    const client = {
      question: {
        list: async () => ({ data: [
          { id: "que_omitted", sessionID: "ses_a", questions: [{ question: "Omitted", header: "Choice", options: [] }] },
          { id: "que_true", sessionID: "ses_a", questions: [{ question: "True", header: "Choice", options: [], custom: true }] },
          { id: "que_false", sessionID: "ses_a", questions: [{ question: "False", header: "Choice", options: [], custom: false }] },
        ] }),
      },
    } as unknown as OpencodeClient;

    const pending = await new SdkV2Provider(client, "/workspace").listQuestions();
    expect(pending.map(request => request.questions[0]?.allowFreeForm)).toEqual([true, true, false]);
  });

  test("inherits the compatibility store across the inventory even when children list first", async () => {
    const replies: string[] = [];
    const client = {
      session: {
        list: async () => ({ data: [
          { ...session("ses_grandchild"), parentID: "ses_child" },
          { ...session("ses_child"), parentID: "ses_parent" },
          { ...session("ses_parent"), metadata: { "uatu.transport": "compatibility" } },
        ] }),
      },
      permission: {
        reply: async (input: Record<string, unknown>) => { replies.push(`classic:${input.requestID}`); return { data: undefined }; },
      },
      v2: {
        session: {
          list: async () => ({ data: { data: [], cursor: { next: null } } }),
          permission: {
            reply: async () => { replies.push("v2"); return { error: { message: "no such session in the v2 store" } }; },
          },
        },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    await provider.listSessions();
    await provider.replyPermission("ses_grandchild", "perm_2", "reject");
    expect(replies).toEqual(["classic:perm_2"]);
  });

  test("lists connected provider models and switches with provider IDs intact", async () => {
    let switchInput: Record<string, unknown> | undefined;
    const client = {
      provider: {
        list: async () => ({ data: {
          connected: ["anthropic", "openai"],
          default: {},
          all: [
            { id: "anthropic", name: "Anthropic", models: { sonnet: { id: "claude-sonnet", name: "Claude Sonnet" } } },
            { id: "openai", name: "OpenAI", models: { gpt: { id: "gpt", name: "GPT" } } },
            { id: "google", name: "Google", models: { gemini: { id: "gemini", name: "Gemini" } } },
          ],
        } }),
      },
      v2: {
        session: {
          switchModel: async (input: Record<string, unknown>) => { switchInput = input; return { data: undefined }; },
        },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    expect(await provider.listModels()).toEqual([
      {
        selection: { providerId: "anthropic", modelId: "claude-sonnet" },
        provider: "Anthropic",
        name: "Claude Sonnet",
      },
      {
        selection: { providerId: "openai", modelId: "gpt" },
        provider: "OpenAI",
        name: "GPT",
      },
    ]);
    await provider.switchModel("ses_provider", { providerId: "anthropic", modelId: "claude-sonnet" });
    expect(switchInput).toEqual({
      sessionID: "ses_provider",
      model: { providerID: "anthropic", id: "claude-sonnet" },
    });
  });

  test("renames through the provider session endpoint and returns v2 authoritative state", async () => {
    let updateInput: Record<string, unknown> | undefined;
    const renamed = { ...session("ses_provider"), title: "Implement model selection" };
    const client = {
      session: {
        update: async (input: Record<string, unknown>) => { updateInput = input; return { data: {} }; },
        get: async () => ({ data: undefined }),
      },
      v2: {
        session: {
          get: async () => ({ data: { data: renamed } }),
        },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    expect(await provider.renameSession("ses_provider", renamed.title)).toEqual(expect.objectContaining({ title: renamed.title }));
    expect(updateInput).toEqual({ sessionID: "ses_provider", directory: "/workspace", title: renamed.title });
  });
});

describe("history across both OpenCode message stores", () => {
  function client(v2Pages: Array<{ data: unknown[]; next?: string }>, legacy: unknown[]): OpencodeClient {
    let page = 0;
    const classic = legacy.length > 0;
    return {
      session: {
        get: async () => classic
          ? { data: session("ses_history") }
          : { error: { message: "missing" }, response: { status: 404 } },
        messages: async () => ({ data: legacy }),
      },
      v2: {
        session: {
          get: async () => classic
            ? { error: { message: "missing" }, response: { status: 404 } }
            : { data: { data: session("ses_history") } },
          messages: async () => {
            const current = v2Pages[page] ?? { data: [] };
            page += 1;
            return { data: { data: current.data, cursor: { next: current.next ?? null } } };
          },
        },
      },
    } as unknown as OpencodeClient;
  }

  const classic = (id: string, created: number) => ({ info: { id, role: "user", time: { created } }, parts: [] });
  const modern = (id: string, created: number) => ({ id, type: "user", time: { created }, text: "hi" });

  test("reads the classic store when the v2 store is empty for a session", async () => {
    const provider = new SdkV2Provider(client([{ data: [] }], [classic("msg_b", 2), classic("msg_a", 1)]), "/workspace");
    const page = await provider.listMessages("ses_legacy", { limit: 50 });
    expect(page.items.map(item => (item as { info: { id: string } }).info.id)).toEqual(["msg_a", "msg_b"]);
    expect(page.nextCursor).toBeUndefined();
  });

  test("merges both stores, deduplicates by id, and orders by creation", async () => {
    const provider = new SdkV2Provider(client([{ data: [modern("msg_new", 3)] }], [classic("msg_old", 1), classic("msg_new", 3)]), "/workspace");
    const page = await provider.listMessages("ses_mixed", { limit: 50 });
    expect(page.items).toHaveLength(2);
    expect(page.items.map(item => {
      const value = item as { id?: string; info?: { id: string } };
      return value.id ?? value.info!.id;
    })).toEqual(["msg_old", "msg_new"]);
  });

  test("pages locally from the newest message backwards", async () => {
    const legacy = [classic("msg_1", 1), classic("msg_2", 2), classic("msg_3", 3)];
    const provider = new SdkV2Provider(client([{ data: [] }], legacy), "/workspace");
    const newest = await provider.listMessages("ses_legacy", { limit: 2 });
    expect(newest.items.map(item => (item as { info: { id: string } }).info.id)).toEqual(["msg_2", "msg_3"]);
    expect(newest.configurationItems?.map(item => (item as { info: { id: string } }).info.id)).toEqual(["msg_1", "msg_2", "msg_3"]);
    expect(newest.nextCursor).toBe("1");

    const older = await provider.listMessages("ses_legacy", { limit: 2, cursor: newest.nextCursor });
    expect(older.items.map(item => (item as { info: { id: string } }).info.id)).toEqual(["msg_1"]);
    expect(older.nextCursor).toBeUndefined();
  });

  test("never combines order with a cursor, which OpenCode rejects", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let page = 0;
    const paging = {
      session: {
        get: async () => ({ error: { message: "missing" }, response: { status: 404 } }),
        messages: async () => ({ data: [] }),
      },
      v2: {
        session: {
          get: async () => ({ data: { data: session("ses_paged") } }),
          messages: async (input: Record<string, unknown>) => {
            calls.push(input);
            if (input.order !== undefined && input.cursor !== undefined) {
              return { error: { _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" } };
            }
            page += 1;
            return page === 1
              ? { data: { data: [modern("msg_1", 1)], cursor: { next: "page-2" } } }
              : { data: { data: [modern("msg_2", 2)], cursor: { next: null } } };
          },
        },
      },
    } as unknown as OpencodeClient;

    const provider = new SdkV2Provider(paging, "/workspace");
    expect((await provider.listMessages("ses_paged", { limit: 10 })).items).toHaveLength(2);
    expect(calls[0]).toEqual({ sessionID: "ses_paged", order: "asc", limit: 100 });
    expect(calls[1]).toEqual({ sessionID: "ses_paged", limit: 100, cursor: "page-2" });
  });

  test("survives an OpenCode build without the classic endpoint", async () => {
    const modernOnly = {
      session: { get: async () => ({ error: { message: "missing" }, response: { status: 404 } }) },
      v2: { session: {
        get: async () => ({ data: { data: session("ses_v2") } }),
        messages: async () => ({ data: { data: [modern("msg_only", 1)], cursor: { next: null } } }),
      } },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(modernOnly, "/workspace");
    expect((await provider.listMessages("ses_v2", { limit: 10 })).items).toHaveLength(1);
  });
});

describe("reversible history across both OpenCode stores", () => {
  const availableId = "11111111-2222-4333-8444-555555555555";
  const classicUser = (id: string, created: number, text: string, attachment: "available" | "missing" | undefined = undefined) => ({
    info: { id, role: "user", time: { created } },
    parts: [
      { type: "text", text },
      ...(attachment === undefined ? [] : [
        ...(attachment === "available" ? [{
          type: "text", synthetic: true,
          text: `Called the Read tool with the following input: {"filePath":"/state/${availableId}.png"}`,
        }] : []),
        { type: "file", mime: "image/png", filename: `${attachment}.png`, url: "data:image/png;base64,AAAA" },
      ]),
    ],
  });
  const nativeUser = (id: string, created: number, text: string, attachment: "available" | "missing" | undefined = undefined) => ({
    id, type: "user", time: { created }, text,
    ...(attachment === undefined ? {} : { files: [{
      uri: attachment === "available" ? `file:///state/${availableId}.png` : "data:image/png;base64,AAAA",
      mime: "image/png",
      name: `${attachment}.png`,
    }] }),
  });

  function reversibleClient(
    store: "classic" | "native",
    turns: unknown[],
    initialBoundary?: string,
    options: { metadata?: boolean } = {},
  ) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const raw = {
      ...session(`ses_${store}`),
      ...(store === "classic" && options.metadata !== false ? { metadata: { "uatu.transport": "compatibility" } } : {}),
      ...(initialBoundary ? { revert: { messageID: initialBoundary } } : {}),
    };
    const stage = (name: string, input: Record<string, unknown>) => {
      calls.push([name, input]);
      raw.revert = { messageID: input.messageID as string };
      return store === "classic" ? { data: raw } : { data: { data: raw.revert } };
    };
    const clear = (name: string, input: Record<string, unknown>) => {
      calls.push([name, input]);
      delete raw.revert;
      return { data: undefined };
    };
    const client = {
      session: {
        get: async () => store === "classic"
          ? { data: raw }
          : { error: { message: "missing" }, response: { status: 404 } },
        messages: async () => ({ data: store === "classic" ? turns : [] }),
        revert: async (input: Record<string, unknown>) => stage("classic.revert", input),
        unrevert: async (input: Record<string, unknown>) => clear("classic.unrevert", input),
      },
      v2: {
        session: {
          get: async () => store === "native"
            ? { data: { data: raw } }
            : { error: { message: "missing" }, response: { status: 404 } },
          messages: async () => ({ data: { data: store === "native" ? turns : [], cursor: { next: null } } }),
          revert: {
            stage: async (input: Record<string, unknown>) => stage("v2.stage", input),
            clear: async (input: Record<string, unknown>) => clear("v2.clear", input),
          },
        },
      },
    } as unknown as OpencodeClient;
    return { client, calls };
  }

  test("derives clear, oldest, and newest state from authoritative boundaries and excludes synthetic messages", async () => {
    const turns = [
      nativeUser("msg_1", 1, "first"),
      { id: "msg_synthetic", type: "synthetic", time: { created: 2 }, text: "bookkeeping" },
      nativeUser("msg_2", 3, "second"),
    ];
    const clear = reversibleClient("native", turns);
    expect(await new SdkV2Provider(clear.client, "/workspace").getReversibleHistoryState("ses_native"))
      .toEqual({ staged: false, canUndo: true, canRedo: false, revertedMessages: [] });

    const oldest = reversibleClient("native", turns, "msg_1");
    expect(await new SdkV2Provider(oldest.client, "/workspace").getReversibleHistoryState("ses_native"))
      .toEqual({
        staged: true,
        canUndo: false,
        canRedo: true,
        revertedMessages: [
          { id: "message:msg_1", text: "first" },
          { id: "message:msg_2", text: "second" },
        ],
      });

    const newest = reversibleClient("native", turns, "msg_2");
    expect(await new SdkV2Provider(newest.client, "/workspace").getReversibleHistoryState("ses_native"))
      .toEqual({ staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "message:msg_2", text: "second" }] });
  });

  test("filters classic and native visible history at the boundary before pagination and configuration recovery", async () => {
    for (const store of ["classic", "native"] as const) {
      const turns = store === "classic"
        ? [
            {
              ...classicUser("msg_z", 1, "first"),
              info: {
                ...classicUser("msg_z", 1, "first").info,
                agent: "build",
                model: { providerID: "openai", modelID: "visible" },
              },
            },
            { info: { id: "msg_y", role: "assistant", time: { created: 1 } }, parts: [] },
            {
              ...classicUser("msg_a", 1, "hidden"),
              info: {
                ...classicUser("msg_a", 1, "hidden").info,
                agent: "plan",
                model: { providerID: "openai", modelID: "hidden" },
              },
            },
            classicUser("msg_suffix", 2, "also hidden"),
          ]
        : [
            { ...nativeUser("msg_z", 1, "first"), agent: "build", model: { providerID: "openai", id: "visible" } },
            { id: "msg_y", type: "assistant", time: { created: 1 }, text: "reply" },
            { ...nativeUser("msg_a", 1, "hidden"), agent: "plan", model: { providerID: "openai", id: "hidden" } },
            nativeUser("msg_suffix", 2, "also hidden"),
          ];
      const fixture = reversibleClient(store, turns, "msg_a");
      const provider = new SdkV2Provider(fixture.client, "/workspace");

      const newest = await provider.listMessages(`ses_${store}`, { limit: 1 });
      expect(newest.items.map(messageId)).toEqual(["msg_y"]);
      expect(newest.configurationItems?.map(messageId)).toEqual(["msg_z", "msg_y"]);
      expect(await provider.getConversationConfiguration(`ses_${store}`, newest.configurationItems)).toEqual({
        model: { providerId: "openai", modelId: "visible" },
        mode: "build",
      });
      expect(newest.nextCursor).toBe("1");
      const older = await provider.listMessages(`ses_${store}`, { limit: 1, cursor: newest.nextCursor });
      expect(older.items.map(messageId)).toEqual(["msg_z"]);
      expect(older.nextCursor).toBeUndefined();
    }
  });

  test("keeps provider-returned history when no boundary exists or its id is absent", async () => {
    const turns = [nativeUser("msg_1", 1, "first"), nativeUser("msg_2", 2, "second")];
    const clear = reversibleClient("native", turns);
    const missing = reversibleClient("native", turns, "msg_already_hidden");

    expect((await new SdkV2Provider(clear.client, "/workspace").listMessages("ses_native", { limit: 10 })).items.map(messageId))
      .toEqual(["msg_1", "msg_2"]);
    expect((await new SdkV2Provider(missing.client, "/workspace").listMessages("ses_native", { limit: 10 })).items.map(messageId))
      .toEqual(["msg_1", "msg_2"]);
  });

  test("detects an empty metadata-free classic TUI session from the classic lookup", async () => {
    const fixture = reversibleClient("classic", [], undefined, { metadata: false });
    const provider = new SdkV2Provider(fixture.client, "/workspace");

    expect(await provider.getReversibleHistoryState("ses_classic"))
      .toEqual({ staged: false, canUndo: false, canRedo: false, revertedMessages: [] });
    expect(await provider.undo("ses_classic")).toEqual({
      outcome: "nothing-to-undo",
      state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] },
    });
    expect(fixture.calls).toEqual([]);
  });

  test("uses native stage and clear shapes while Redo advances one hidden user turn", async () => {
    const fixture = reversibleClient("native", [
      nativeUser("msg_1", 1, "first"),
      nativeUser("msg_2", 2, "second", "available"),
      nativeUser("msg_3", 3, "third", "missing"),
    ]);
    const provider = new SdkV2Provider(fixture.client, "/workspace");

    expect(await provider.undo("ses_native")).toEqual(expect.objectContaining({
      outcome: "changed",
      restoredDraft: { text: "third", attachments: [{ name: "missing.png", mimeType: "image/png" }] },
    }));
    expect((await provider.listMessages("ses_native", { limit: 10 })).items.map(messageId))
      .toEqual(["msg_1", "msg_2"]);
    expect(await provider.undo("ses_native")).toEqual(expect.objectContaining({
      restoredDraft: { text: "second", attachments: [{ id: availableId, name: "available.png", mimeType: "image/png" }] },
    }));
    expect(await provider.redo("ses_native")).toEqual(expect.objectContaining({
      restoredDraft: { text: "third", attachments: [{ name: "missing.png", mimeType: "image/png" }] },
    }));
    expect(await provider.redo("ses_native")).toEqual({
      outcome: "changed",
      state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
    });
    expect(fixture.calls).toEqual([
      ["v2.stage", { sessionID: "ses_native", messageID: "msg_3" }],
      ["v2.stage", { sessionID: "ses_native", messageID: "msg_2" }],
      ["v2.stage", { sessionID: "ses_native", messageID: "msg_3" }],
      ["v2.clear", { sessionID: "ses_native" }],
    ]);
  });

  test("reverts directly to a selected visible turn and restores through a selected hidden turn", async () => {
    const fixture = reversibleClient("native", [
      nativeUser("msg_1", 1, "first"),
      nativeUser("msg_2", 2, "second"),
      nativeUser("msg_3", 3, "third"),
      nativeUser("msg_4", 4, "fourth"),
    ]);
    const provider = new SdkV2Provider(fixture.client, "/workspace");

    expect(await provider.revert("ses_native", "message:msg_2")).toEqual({
      outcome: "changed",
      state: {
        staged: true,
        canUndo: true,
        canRedo: true,
        revertedMessages: [
          { id: "message:msg_2", text: "second" },
          { id: "message:msg_3", text: "third" },
          { id: "message:msg_4", text: "fourth" },
        ],
      },
      restoredDraft: { text: "second" },
    });
    await expect(provider.revert("ses_native", "message:msg_3")).rejects.toBeInstanceOf(ReversibleHistoryTargetError);
    await expect(provider.restore("ses_native", "message:msg_1")).rejects.toBeInstanceOf(ReversibleHistoryTargetError);

    expect(await provider.restore("ses_native", "message:msg_3")).toEqual({
      outcome: "changed",
      state: {
        staged: true,
        canUndo: true,
        canRedo: true,
        revertedMessages: [{ id: "message:msg_4", text: "fourth" }],
      },
      restoredDraft: { text: "fourth" },
    });
    expect(await provider.restore("ses_native", "message:msg_4")).toEqual({
      outcome: "changed",
      state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
    });
    expect(fixture.calls).toEqual([
      ["v2.stage", { sessionID: "ses_native", messageID: "msg_2" }],
      ["v2.stage", { sessionID: "ses_native", messageID: "msg_4" }],
      ["v2.clear", { sessionID: "ses_native" }],
    ]);
  });

  test("uses exact classic revert and unrevert shapes", async () => {
    const fixture = reversibleClient("classic", [
      classicUser("msg_1", 1, "first"),
      classicUser("msg_2", 2, "second", "available"),
    ]);
    const provider = new SdkV2Provider(fixture.client, "/workspace");

    await provider.undo("ses_classic");
    const oldest = await provider.undo("ses_classic");
    expect(oldest.state).toEqual({
      staged: true,
      canUndo: false,
      canRedo: true,
      revertedMessages: [
        { id: "message:msg_1", text: "first" },
        { id: "message:msg_2", text: "second" },
      ],
    });
    expect(oldest.restoredDraft).toEqual({ text: "first" });
    await provider.redo("ses_classic");
    await provider.redo("ses_classic");
    expect(fixture.calls).toEqual([
      ["classic.revert", { sessionID: "ses_classic", directory: "/workspace", messageID: "msg_2" }],
      ["classic.revert", { sessionID: "ses_classic", directory: "/workspace", messageID: "msg_1" }],
      ["classic.revert", { sessionID: "ses_classic", directory: "/workspace", messageID: "msg_2" }],
      ["classic.unrevert", { sessionID: "ses_classic", directory: "/workspace" }],
    ]);
  });

  test("uses classic transport shapes for selected Revert and Restore", async () => {
    const fixture = reversibleClient("classic", [
      classicUser("msg_1", 1, "first"),
      classicUser("msg_2", 2, "second"),
      classicUser("msg_3", 3, "third"),
    ]);
    const provider = new SdkV2Provider(fixture.client, "/workspace");

    await provider.revert("ses_classic", "message:msg_1");
    await provider.restore("ses_classic", "message:msg_2");
    await provider.restore("ses_classic", "message:msg_3");
    expect(fixture.calls).toEqual([
      ["classic.revert", { sessionID: "ses_classic", directory: "/workspace", messageID: "msg_1" }],
      ["classic.revert", { sessionID: "ses_classic", directory: "/workspace", messageID: "msg_3" }],
      ["classic.unrevert", { sessionID: "ses_classic", directory: "/workspace" }],
    ]);
  });

  test("reports harmless oldest Undo and unstaged Redo without transport calls", async () => {
    const oldest = reversibleClient("classic", [classicUser("msg_1", 1, "first")], "msg_1");
    const provider = new SdkV2Provider(oldest.client, "/workspace");
    expect(await provider.undo("ses_classic")).toEqual({
      outcome: "nothing-to-undo",
      state: { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:msg_1", text: "first" }] },
    });

    const clear = reversibleClient("native", [nativeUser("msg_1", 1, "first")]);
    expect(await new SdkV2Provider(clear.client, "/workspace").redo("ses_native")).toEqual({
      outcome: "nothing-to-redo",
      state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
    });
    expect(oldest.calls).toEqual([]);
    expect(clear.calls).toEqual([]);
  });
});

function messageId(value: unknown): string {
  const message = value as { id?: string; info?: { id?: string } };
  return message.id ?? message.info?.id ?? "";
}

function session(id: string) {
  return {
    id,
    title: "Conversation",
    location: { directory: "/workspace" },
    time: { created: 1, updated: 1 },
  };
}

describe("prompt attachments", () => {
  const attachment = {
    id: "11111111-2222-4333-8444-555555555555",
    name: "shot.png",
    mimeType: "image/png",
    absolutePath: "/state/attachments/ws/11111111-2222-4333-8444-555555555555.png",
  };

  test("declares the attachments capability", () => {
    const provider = new SdkV2Provider({} as unknown as OpencodeClient, "/workspace");
    expect(provider.describe().capabilities).toContain("attachments");
  });

  test("maps per-model image support from input.image or the legacy attachment flag", async () => {
    const client = {
      provider: {
        list: async () => ({ data: {
          connected: ["a"],
          default: {},
          all: [{ id: "a", name: "A", models: {
            vision: { id: "vision", name: "Vision", capabilities: { input: { image: true } } },
            legacy: { id: "legacy", name: "Legacy", capabilities: { attachment: true, input: { image: false } } },
            blind: { id: "blind", name: "Blind", capabilities: { attachment: false, input: { image: false } } },
            silent: { id: "silent", name: "Silent" },
          } }],
        } }),
      },
    } as unknown as OpencodeClient;
    const models = await new SdkV2Provider(client, "/workspace").listModels();
    const byId = new Map(models.map(model => [model.selection.modelId, model.imageInput]));
    expect(byId.get("vision")).toBe(true);
    expect(byId.get("legacy")).toBe(true);
    // Absence of both signals reads as "cannot", never as "unknown".
    expect(byId.get("blind")).toBeUndefined();
    expect(byId.get("silent")).toBeUndefined();
  });

  test("v2 prompts carry attachments as file: uris and omit the key when there are none", async () => {
    const promptInputs: Array<Record<string, unknown>> = [];
    const client = {
      v2: { session: { prompt: async (input: Record<string, unknown>) => { promptInputs.push(input); return { data: { data: { id: "msg_native" } } }; } } },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");
    await provider.prompt("ses_native", { id: "r1", text: "look", delivery: "queue", attachments: [attachment] });
    await provider.prompt("ses_native", { id: "r2", text: "plain", delivery: "queue" });
    expect(promptInputs[0]!.prompt).toEqual({
      text: "look",
      files: [{ uri: "file:///state/attachments/ws/11111111-2222-4333-8444-555555555555.png", name: "shot.png" }],
    });
    expect(promptInputs[1]!.prompt).toEqual({ text: "plain" });
  });

  test("compatibility prompts carry classic file parts with mime, filename, and file: url", async () => {
    let promptInput: Record<string, unknown> | undefined;
    const client = {
      session: {
        create: async () => ({ data: { ...session("ses_classic"), directory: "/workspace" } }),
        promptAsync: async (input: Record<string, unknown>) => { promptInput = input; return { data: undefined }; },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");
    await provider.createSession("client-uuid");
    await provider.prompt("ses_classic", { id: "r1", text: "look", delivery: "queue", attachments: [attachment] });
    expect(promptInput!.parts).toEqual([
      { type: "text", text: "look" },
      { type: "file", mime: "image/png", filename: "shot.png", url: "file:///state/attachments/ws/11111111-2222-4333-8444-555555555555.png" },
    ]);
  });
});
