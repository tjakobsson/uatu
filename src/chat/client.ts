import { appUrl } from "../shared/app-url";
import type {
  AgentChatStatus,
  ChatMode,
  ChatCommand,
  ChatEvent,
  ChatModel,
  ConversationConfiguration,
  ConversationInventoryEvent,
  ConversationSnapshot,
  ConversationSummary,
  MessageAttachment,
  ModelSelection,
  PermissionOutcome,
  QuestionOutcome,
  ReversibleHistoryResult,
} from "./types";
import {
  parseAgentChatStatuses,
  parseChatMode,
  parseChatCommand,
  parseChatEvent,
  parseChatModel,
  parseConversationInventoryEvent,
  parseConversationSnapshot,
  parseConversationConfiguration,
  parseConversationSummary,
  parseReversibleHistoryResult,
} from "./validation";

export class ChatTransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ChatTransportError";
  }
}

// A transport gap the client is already recovering from — distinct from a
// provider failure, a rejected turn, or invalid data, all of which need the
// user to do something. Typed rather than string-matched so the surface can
// own the reconnect message specifically: on a successful open it removes
// this one and leaves any other error standing.
export class ChatConnectionInterruptedError extends ChatTransportError {
  constructor(message: string) {
    super(message);
    this.name = "ChatConnectionInterruptedError";
  }
}

type StreamHandlers = {
  event: (event: ChatEvent, cursor: string) => void;
  resync: (reason?: ChatEvent & { type: "resync" }) => void;
  error: (error: ChatTransportError) => void;
  // The stream opened. Only transport is proven: cursor replay and the
  // `resync` event still own whether the projection is correct.
  recovered?: () => void;
};

type InventoryStreamHandlers = {
  invalidation: (event: ConversationInventoryEvent) => void;
  error: (error: ChatTransportError) => void;
  // The stream opened. Transport is healthy again; nothing about the
  // conversation projection is implied.
  recovered?: () => void;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ChatClientTimers = {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const RECONNECT_BASE_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;
const defaultTimers: ChatClientTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
};

function reconnectDelay(failures: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (failures - 1), MAX_RECONNECT_DELAY_MS);
}

export type ChatEventStream = { close(): void };

export class ChatApiClient {
  constructor(
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
    private readonly eventSourceFactory: (url: string) => EventSource = url => new EventSource(url),
    private readonly timers: ChatClientTimers = defaultTimers,
  ) {}

  status(): Promise<AgentChatStatus[]> {
    return this.get(appUrl("/api/chat/status"), parseAgentChatStatuses);
  }

  // POST, not a safe method: retry spawns the named agent's process.
  retry(agentId: string): Promise<AgentChatStatus> {
    return this.mutate(appUrl("/api/chat/retry"), { agentId }, value => {
      const record = value as { agent?: unknown; availability?: unknown };
      return parseAgentChatStatuses({ agents: [record] })[0]!;
    });
  }

  async conversations(): Promise<ConversationSummary[]> {
    const value = await this.get(appUrl("/api/chat/conversations"), value => value as { conversations?: unknown });
    if (!Array.isArray(value.conversations)) throw new ChatTransportError("Chat returned an invalid conversation list");
    return value.conversations.map(parseConversationSummary);
  }

  async models(agentId: string): Promise<ChatModel[]> {
    const value = await this.get(appUrl(`/api/chat/models?agent=${encodeURIComponent(agentId)}`), value => value as { models?: unknown });
    if (!Array.isArray(value.models)) throw new ChatTransportError("Chat returned an invalid model list");
    return value.models.map(parseChatModel);
  }

  async commands(agentId: string): Promise<ChatCommand[]> {
    const value = await this.get(appUrl(`/api/chat/commands?agent=${encodeURIComponent(agentId)}`), value => value as { commands?: unknown });
    if (!Array.isArray(value.commands)) throw new ChatTransportError("Chat returned an invalid command list");
    return value.commands.map(parseChatCommand);
  }

  async modes(agentId: string): Promise<ChatMode[]> {
    const value = await this.get(appUrl(`/api/chat/modes?agent=${encodeURIComponent(agentId)}`), value => value as { modes?: unknown });
    if (!Array.isArray(value.modes)) throw new ChatTransportError("Chat returned an invalid mode list");
    return value.modes.map(parseChatMode);
  }

  createConversation(agentId?: string): Promise<ConversationSnapshot> {
    return this.mutate(appUrl("/api/chat/conversations"), agentId ? { agentId } : {}, parseConversationSnapshot);
  }

  snapshot(conversationId: string, cursor?: string): Promise<ConversationSnapshot> {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("cursor", cursor);
    return this.get(appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}?${query}`), parseConversationSnapshot);
  }

  prompt(conversationId: string, requestId: string, text: string, model?: ModelSelection, mode?: string, variant?: string, attachments?: MessageAttachment[]): Promise<{
    messageId: string;
    held: boolean;
    configuration: ConversationConfiguration;
    conversation?: ConversationSummary;
  }> {
    return this.mutate(
      appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/prompts`),
      { requestId, text, ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(variant ? { variant } : {}), ...(attachments?.length ? { attachments } : {}) },
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

  // Multipart, not JSON: the bytes ride the form field and the response is
  // the reference every later payload uses. No content-type header set by
  // hand — the browser owns the multipart boundary.
  uploadAttachment(conversationId: string, file: Blob): Promise<{ id: string; mimeType: string; sizeBytes: number }> {
    const form = new FormData();
    form.append("file", file);
    return this.request(
      appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/attachments`),
      { method: "POST", body: form },
      value => {
        const result = value as { id?: unknown; mimeType?: unknown; sizeBytes?: unknown };
        if (typeof result.id !== "string" || typeof result.mimeType !== "string" || typeof result.sizeBytes !== "number") {
          throw new ChatTransportError("Chat returned an invalid attachment record");
        }
        return { id: result.id, mimeType: result.mimeType, sizeBytes: result.sizeBytes };
      },
    );
  }

  // Where a stored attachment's bytes are served from; rides the same
  // workspace authorization as every chat request.
  attachmentUrl(id: string): string {
    return appUrl(`/api/chat/attachments/${encodeURIComponent(id)}`);
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

  undo(conversationId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.mutate(
      appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/undo`),
      { requestId },
      parseReversibleHistoryResult,
    );
  }

  redo(conversationId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.mutate(
      appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/redo`),
      { requestId },
      parseReversibleHistoryResult,
    );
  }

  revert(conversationId: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.mutate(
      appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/revert`),
      { requestId, messageId },
      parseReversibleHistoryResult,
    );
  }

  restore(conversationId: string, messageId: string, requestId: string): Promise<ReversibleHistoryResult> {
    return this.mutate(
      appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/restore`),
      { requestId, messageId },
      parseReversibleHistoryResult,
    );
  }

  permission(conversationId: string, interactionId: string, requestId: string, outcome: PermissionOutcome, choiceId?: string): Promise<unknown> {
    return this.mutate(appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/permissions/${encodeURIComponent(interactionId)}`), { requestId, outcome, ...(choiceId ? { choiceId } : {}) }, value => value);
  }

  question(conversationId: string, interactionId: string, requestId: string, outcome: QuestionOutcome): Promise<unknown> {
    return this.mutate(appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(interactionId)}`), { requestId, outcome }, value => value);
  }

  stopTask(conversationId: string, taskId: string, requestId: string): Promise<unknown> {
    return this.mutate(appUrl(`/api/chat/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}/stop`), { requestId }, value => value);
  }

  inventoryStream(handlers: InventoryStreamHandlers): ChatEventStream {
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const connect = () => {
      if (closed) return;
      const nextSource = this.eventSourceFactory(appUrl("/api/chat/conversations/events"));
      source = nextSource;
      // A successful open is the proof of transport recovery. Waiting for an
      // inventory event instead would leave an idle workspace — one where no
      // conversation is changing — reporting "reconnecting" indefinitely, and
      // would make the next interruption inherit an inflated failure count.
      nextSource.addEventListener("open", (() => {
        if (source !== nextSource || closed) return;
        failures = 0;
        handlers.recovered?.();
      }) as EventListener);
      nextSource.addEventListener("inventory", ((raw: MessageEvent<string>) => {
        let event: ConversationInventoryEvent;
        try {
          event = parseConversationInventoryEvent(JSON.parse(raw.data));
        } catch (error) {
          handlers.error(new ChatTransportError(error instanceof Error ? error.message : "Invalid conversation inventory event"));
          return;
        }
        failures = 0;
        handlers.invalidation(event);
      }) as EventListener);
      nextSource.onerror = () => {
        if (source !== nextSource) return;
        nextSource.close();
        source = null;
        if (closed) return;
        failures += 1;
        if (failures > 1) handlers.error(new ChatConnectionInterruptedError("Chat inventory connection interrupted; reconnecting"));
        if (closed) return;
        reconnectTimer = this.timers.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelay(failures));
      };
    };
    const close = () => {
      closed = true;
      source?.close();
      source = null;
      if (reconnectTimer !== null) {
        this.timers.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    connect();
    return { close };
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
      const opened = source;
      opened.addEventListener("open", (() => {
        if (source !== opened || closed) return;
        failures = 0;
        handlers.recovered?.();
      }) as EventListener);
      source.addEventListener("chat", receive as EventListener);
      source.addEventListener("resync", receive as EventListener);
      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        failures += 1;
        // The first drop retries silently; a banner only appears once the
        // outage persists past one reconnect attempt.
        if (failures > 1) handlers.error(new ChatConnectionInterruptedError("Chat connection interrupted; reconnecting"));
        reconnectTimer = this.timers.setTimeout(connect, reconnectDelay(failures));
      };
    };
    const close = () => {
      closed = true;
      source?.close();
      source = null;
      if (reconnectTimer !== null) this.timers.clearTimeout(reconnectTimer);
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
