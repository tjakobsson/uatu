import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

import { SdkV2Provider, stableProviderId } from "./sdk-v2-provider";

describe("OpenCode v2 identity policy", () => {
  test("lists models from every authenticated provider", async () => {
    const client = {
      provider: {
        list: async () => ({ data: {
          connected: ["openai", "opencode"],
          default: {},
          all: [
            { id: "unused", name: "Unused", models: { hidden: { id: "hidden", name: "Hidden" } } },
            { id: "openai", name: "OpenAI", models: { sol: { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" } } },
            { id: "opencode", name: "OpenCode", models: { free: { id: "free", name: "Free" } } },
          ],
        } }),
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    expect(await provider.listModels()).toEqual([
      { selection: { providerId: "openai", modelId: "gpt-5.6-sol" }, provider: "OpenAI", name: "GPT-5.6 Sol" },
      { selection: { providerId: "opencode", modelId: "free" }, provider: "OpenCode", name: "Free" },
    ]);
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

    expect((await provider.createSession("client-uuid")).id).toBe("ses_provider");
    expect(createInput).toEqual({ directory: "/workspace", metadata: { "uatu.transport": "compatibility" } });

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
        ] }),
      },
      session: {
        create: async () => ({ data: { ...session("ses_agenty"), directory: "/workspace" } }),
        promptAsync: async (input: Record<string, unknown>) => { promptInput = input; return { data: undefined }; },
      },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(client, "/workspace");

    expect(await provider.listAgents()).toEqual([
      { name: "build", description: "Writes code" },
      { name: "plan", description: "Read-only" },
    ]);

    await provider.createSession("client-uuid");
    await provider.prompt("ses_agenty", { id: "client-uuid", text: "hello", delivery: "queue", agent: "build" });
    expect(promptInput).toEqual(expect.objectContaining({ agent: "build" }));
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
    return {
      session: { messages: async () => ({ data: legacy }) },
      v2: {
        session: {
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
    expect(newest.nextCursor).toBe("1");

    const older = await provider.listMessages("ses_legacy", { limit: 2, cursor: newest.nextCursor });
    expect(older.items.map(item => (item as { info: { id: string } }).info.id)).toEqual(["msg_1"]);
    expect(older.nextCursor).toBeUndefined();
  });

  test("never combines order with a cursor, which OpenCode rejects", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let page = 0;
    const paging = {
      session: { messages: async () => ({ data: [] }) },
      v2: {
        session: {
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
      v2: { session: { messages: async () => ({ data: { data: [modern("msg_only", 1)], cursor: { next: null } } }) } },
    } as unknown as OpencodeClient;
    const provider = new SdkV2Provider(modernOnly, "/workspace");
    expect((await provider.listMessages("ses_v2", { limit: 10 })).items).toHaveLength(1);
  });
});

function session(id: string) {
  return {
    id,
    title: "Conversation",
    location: { directory: "/workspace" },
    time: { created: 1, updated: 1 },
  };
}
