import { appUrl } from "../shared/app-url";
import type {
  ChatMode,
  ChatAvailability,
  ChatCommand,
  ChatEvent,
  ChatModel,
  ConversationConfiguration,
  ConversationSnapshot,
  ConversationSummary,
  ModelSelection,
  PermissionOutcome,
  QuestionOutcome,
} from "./types";
import {
  parseChatMode,
  parseChatAvailability,
  parseChatCommand,
  parseChatEvent,
  parseChatModel,
  parseConversationSnapshot,
  parseConversationConfiguration,
  parseConversationSummary,
} from "./validation";

export class ChatTransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ChatTransportError";
  }
}

type StreamHandlers = {
  event: (event: ChatEvent, cursor: string) => void;
  resync: (reason?: ChatEvent & { type: "resync" }) => void;
  error: (error: ChatTransportError) => void;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ChatEventStream = { close(): void };

export class ChatApiClient {
  constructor(
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
    private readonly eventSourceFactory: (url: string) => EventSource = url => new EventSource(url),
  ) {}

  status(): Promise<ChatAvailability> {
    return this.get(appUrl("/api/chat/status"), parseChatAvailability);
  }

  // POST with no body: retry spawns a process, so it must not sit behind a safe
  // method, and the contract declares no request media types for it.
  retry(): Promise<ChatAvailability> {
    return this.request(appUrl("/api/chat/retry"), { method: "POST" }, parseChatAvailability);
  }

  async conversations(): Promise<ConversationSummary[]> {
    const value = await this.get(appUrl("/api/chat/conversations"), value => value as { conversations?: unknown });
    if (!Array.isArray(value.conversations)) throw new ChatTransportError("Chat returned an invalid conversation list");
    return value.conversations.map(parseConversationSummary);
  }

  async models(): Promise<ChatModel[]> {
    const value = await this.get(appUrl("/api/chat/models"), value => value as { models?: unknown });
    if (!Array.isArray(value.models)) throw new ChatTransportError("Chat returned an invalid model list");
    return value.models.map(parseChatModel);
  }

  async commands(): Promise<ChatCommand[]> {
    const value = await this.get(appUrl("/api/chat/commands"), value => value as { commands?: unknown });
    if (!Array.isArray(value.commands)) throw new ChatTransportError("Chat returned an invalid command list");
    return value.commands.map(parseChatCommand);
  }

  async modes(): Promise<ChatMode[]> {
    const value = await this.get(appUrl("/api/chat/modes"), value => value as { modes?: unknown });
    if (!Array.isArray(value.modes)) throw new ChatTransportError("Chat returned an invalid mode list");
    return value.modes.map(parseChatMode);
  }

  createConversation(): Promise<ConversationSnapshot> {
    return this.mutate(appUrl("/api/chat/conversations"), {}, parseConversationSnapshot);
  }

  snapshot(conversationId: string, cursor?: string): Promise<ConversationSnapshot> {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("cursor", cursor);
    return this.get(appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}?${query}`), parseConversationSnapshot);
  }

  prompt(conversationId: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string): Promise<{
    messageId: string;
    held: boolean;
    configuration: ConversationConfiguration;
    conversation?: ConversationSummary;
  }> {
    return this.mutate(
      appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/prompts`),
      { requestId, text, ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(variant ? { variant } : {}) },
      value => {
        const result = value as { messageId: string; held: boolean; configuration?: unknown; conversation?: unknown };
        return {
          messageId: result.messageId,
          held: result.held === true,
          configuration: parseConversationConfiguration(result.configuration),
          ...(result.conversation ? { conversation: parseConversationSummary(result.conversation) } : {}),
        };
      },
    );
  }

  removeQueued(conversationId: string, messageId: string, requestId: string): Promise<{ removed: boolean }> {
    return this.mutate(
      appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(messageId)}`),
      { requestId },
      value => value as { removed: boolean },
      "DELETE",
    );
  }

  renameConversation(conversationId: string, requestId: string, title: string): Promise<{ conversation: ConversationSummary }> {
    return this.mutate(
      appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}`),
      { requestId, title },
      value => {
        const result = value as { conversation?: unknown };
        return { conversation: parseConversationSummary(result.conversation) };
      },
      "PATCH",
    );
  }

  cancel(conversationId: string, requestId: string): Promise<{ cancelled: boolean }> {
    return this.mutate(appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/cancel`), { requestId }, value => value as { cancelled: boolean });
  }

  permission(conversationId: string, interactionId: string, requestId: string, outcome: PermissionOutcome): Promise<unknown> {
    return this.mutate(appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/permissions/${encodeURIComponent(interactionId)}`), { requestId, outcome }, value => value);
  }

  question(conversationId: string, interactionId: string, requestId: string, outcome: QuestionOutcome): Promise<unknown> {
    return this.mutate(appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(interactionId)}`), { requestId, outcome }, value => value);
  }

  stream(conversationId: string, cursor: string, handlers: StreamHandlers): ChatEventStream {
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCursor = cursor;
    let failures = 0;

    const connect = () => {
      if (closed) return;
      const query = new URLSearchParams();
      if (lastCursor) query.set("cursor", lastCursor);
      source = this.eventSourceFactory(appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/events?${query}`));
      const receive = (raw: MessageEvent<string>) => {
        try {
          const event = parseChatEvent(JSON.parse(raw.data));
          failures = 0;
          if (raw.lastEventId) lastCursor = raw.lastEventId;
          if (event.type === "resync") {
            handlers.resync(event);
            close();
          } else {
            handlers.event(event, lastCursor);
          }
        } catch (error) {
          // A malformed event means this projection can no longer be trusted;
          // drop the stream and ask the owner to reload from a snapshot.
          handlers.error(new ChatTransportError(error instanceof Error ? error.message : "Invalid chat event"));
          close();
          handlers.resync();
        }
      };
      source.addEventListener("chat", receive as EventListener);
      source.addEventListener("resync", receive as EventListener);
      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        failures += 1;
        // The first drop retries silently; a banner only appears once the
        // outage persists past one reconnect attempt.
        if (failures > 1) handlers.error(new ChatTransportError("Chat connection interrupted; reconnecting"));
        reconnectTimer = setTimeout(connect, Math.min(1_000 * 2 ** (failures - 1), 15_000));
      };
    };
    const close = () => {
      closed = true;
      source?.close();
      source = null;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    };
    connect();
    return { close };
  }

  private async get<T>(path: string, parse: (value: unknown) => T): Promise<T> {
    return this.request(path, undefined, parse);
  }

  private async mutate<T>(path: string, body: unknown, parse: (value: unknown) => T, method = "POST"): Promise<T> {
    return this.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, parse);
  }

  private async request<T>(url: string, init: RequestInit | undefined, parse: (value: unknown) => T): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch (error) {
      throw new ChatTransportError(error instanceof Error ? error.message : "Chat request failed");
    }
    const value = await response.json().catch(() => null) as { error?: unknown } | null;
    if (!response.ok) {
      throw new ChatTransportError(typeof value?.error === "string" ? value.error : `Chat request failed (${response.status})`, response.status);
    }
    try {
      return parse(value);
    } catch (error) {
      throw new ChatTransportError(error instanceof Error ? error.message : "Chat returned invalid data");
    }
  }
}
