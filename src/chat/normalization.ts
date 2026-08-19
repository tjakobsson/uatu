import type { ConversationItem, ConversationStatus, StructuredQuestion, TokenUsage } from "./types";

type RecordValue = Record<string, unknown>;

export type NormalizedProviderUpdate =
  | { kind: "upsert"; item: ConversationItem }
  | { kind: "text"; itemId: string; identity: string; mode: "cumulative" | "incremental"; text: string; item?: ConversationItem }
  | { kind: "remove"; itemId: string }
  | { kind: "status"; status: ConversationStatus; message?: string };

// Why an event produced no updates. Without this an unrecognized event and one
// we deliberately ignore are the same empty value to the caller, so a counter
// over them would either miss real drops or inflate on expected ones.
export type NormalizedEventOutcome =
  | "handled"
  // Recognized, and correctly produced nothing (a status we already hold, a
  // streaming frame whose start and end are enough).
  | "ignored"
  // No case matched: the workspace does not know this event type at all.
  | "unrecognized"
  // A case matched but the payload did not carry what that case requires.
  | "unparseable";

/**
 * What normalizing one event needs to remember from earlier ones. Bounded on
 * every map: a long session must not grow any of these without limit.
 *
 * - `roles` — a part's sender, which only `message.updated` states.
 * - `lastAssistantPart` — the item a message's token usage decorates. Usage
 *   arrives on `message.updated`, which carries no part, so without this the
 *   only place to put it would be a new usage-only item — and `renderItem`
 *   draws any `assistant_message` as a bubble, so that is a stray empty
 *   message on the timeline.
 * - `pendingUsage` — usage that arrived before the message had any text part,
 *   flushed onto the first one that appears.
 */
export type ProviderEventMemory = {
  roles: Map<string, string>;
  lastAssistantPart: Map<string, string>;
  pendingUsage: Map<string, TokenUsage>;
};

export function createProviderEventMemory(): ProviderEventMemory {
  return { roles: new Map(), lastAssistantPart: new Map(), pendingUsage: new Map() };
}

const MEMORY_LIMIT = 2_048;

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  if (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value!);
}

/**
 * The tokens the agent reported, as our own shape. Missing components stay
 * missing rather than becoming zero: "the agent did not report cache reads"
 * and "there were none" are different statements, and only one of them lets a
 * readout claim a figure.
 *
 * `tokens.total` is deliberately not read — it counts output, so it is not
 * what occupies the context window.
 */
export function tokensToUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tokens = value as RecordValue;
  const cache = record(tokens.cache);
  const usage: TokenUsage = {};
  const put = (key: keyof TokenUsage, raw: unknown) => {
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) usage[key] = raw;
  };
  put("input", tokens.input);
  put("output", tokens.output);
  put("reasoning", tokens.reasoning);
  put("cacheRead", cache.read);
  put("cacheWrite", cache.write);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export type NormalizedProviderEvent = {
  conversationId?: string;
  updates: NormalizedProviderUpdate[];
  outcome: NormalizedEventOutcome;
  // The event's own type, so a caller can count drops per type. Never a
  // payload — a payload can carry file contents.
  eventType: string;
  // The model the assistant message ran, when the event states it. Reported on
  // the envelope rather than on an item: it belongs to the message, and the
  // one thing that needs it — attributing a subagent on its parent's row —
  // reads it from the child's event stream, not from the child's timeline.
  assistantModel?: string;
  // The tokens a message reported, with the message's own id. The item the
  // usage decorates is a *part*, and a message can produce several — keyed by
  // part id, one message's cumulative tokens would be banked once per part and
  // counted that many times over. Aggregation keys on this id instead.
  assistantUsage?: { messageId: string; usage: TokenUsage };
};

// Event types recognized as deliberately carrying nothing for the timeline.
// Listed rather than lumped with `unrecognized` so the drop counter stays
// honest about what the workspace genuinely does not understand.
const INTENTIONALLY_IGNORED = new Set([
  // Streaming progress for an operation whose started/ended pair is enough.
  "session.next.compaction.delta",
  "session.next.tool.input.started",
  "session.next.tool.input.delta",
  "session.next.tool.input.ended",
  // Server and workspace lifecycle with no conversation meaning.
  "server.connected",
  "server.heartbeat",
  "server.instance.disposed",
  "global.disposed",
  "installation.updated",
  "installation.update.available",
  "catalog.updated",
  "plugin.added",
  "integration.updated",
  "integration.connection.updated",
  "project.updated",
  "project.directories.updated",
  "file.watcher.updated",
  "reference.updated",
  "lsp.updated",
  "mcp.tools.changed",
  "mcp.browser.open.failed",
  "vcs.branch.updated",
  "workspace.ready",
  "workspace.failed",
  "workspace.status",
  "worktree.ready",
  "worktree.failed",
  "pty.created",
  "pty.updated",
  "pty.exited",
  "pty.deleted",
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  "tui.session.select",
]);

export function normalizeProviderMessage(value: unknown): ConversationItem[] {
  const envelope = record(value);
  const info = record(envelope.info);
  // The classic store wraps each message as { info, parts } and names the
  // sender `role`; the v2 store is flat with a `type`.
  if (optionalString(info.role)) return normalizeStoredMessage(info, array(envelope.parts));
  const message = envelope;
  const id = string(message.id, "message id");
  const createdAt = timestamp(record(message.time).created, 0);
  switch (message.type) {
    case "user":
      return [{ id: `message:${id}`, type: "user_message", createdAt, text: text(message.text) }];
    case "assistant":
      return normalizeAssistant(message, id, createdAt);
    case "shell":
      return [{
        id: `command:${string(message.callID, "call id")}`,
        type: "command",
        createdAt,
        command: text(message.command),
        output: text(message.output),
        status: isFinishedTime(message.time) ? "completed" : "running",
      }];
    case "synthetic":
    case "system":
      return [{ id: `notice:${id}`, type: "notice", createdAt, level: "info", message: text(message.text) || String(message.type) }];
    case "compaction":
      return [{ id: `notice:${id}`, type: "notice", createdAt, level: "info", message: text(message.summary) || "Conversation compacted" }];
    default:
      return [];
  }
}

// Public boundary. Every failure mode resolves to an outcome rather than an
// exception, so one malformed payload costs one event instead of the pump.
export function normalizeProviderEvent(value: unknown, memory?: ProviderEventMemory): NormalizedProviderEvent {
  const eventType = optionalString(record(value).type) ?? "";
  try {
    const matched = normalizeKnownEvent(value, memory);
    if (matched) return { ...matched, outcome: matched.updates.length > 0 ? "handled" : "ignored", eventType };
    return {
      conversationId: conversationIdOf(value),
      updates: [],
      outcome: INTENTIONALLY_IGNORED.has(eventType) ? "ignored" : "unrecognized",
      eventType,
    };
  } catch {
    // A recognized type whose payload lacks what its case requires. Reported,
    // never rethrown: the caller must keep consuming the stream.
    return { conversationId: conversationIdOf(value), updates: [], outcome: "unparseable", eventType };
  }
}

function conversationIdOf(value: unknown): string | undefined {
  try {
    const data = record(record(value).data ?? record(value).properties);
    return optionalString(data.sessionID) ?? optionalString(data.sessionId);
  } catch {
    return undefined;
  }
}

type KnownEvent = {
  conversationId?: string;
  updates: NormalizedProviderUpdate[];
  assistantModel?: string;
  assistantUsage?: { messageId: string; usage: TokenUsage };
};

function normalizeKnownEvent(value: unknown, memory?: ProviderEventMemory): KnownEvent | undefined {
  const event = record(value);
  const data = record(event.data ?? event.properties);
  const conversationId = optionalString(data.sessionID) ?? optionalString(data.sessionId);
  const eventId = optionalString(event.id) ?? `${String(event.type)}:${timestamp(data.timestamp, Date.now())}`;
  const createdAt = timestamp(data.timestamp ?? data.timeCreated, Date.now());

  switch (event.type) {
    case "session.next.prompted":
    case "session.next.prompt.admitted": {
      const prompt = record(data.prompt);
      const messageId = optionalString(data.messageID) ?? optionalString(data.id) ?? eventId;
      return {
        conversationId,
        updates: [{ kind: "upsert", item: {
          id: `message:${messageId}`,
          type: "user_message",
          createdAt,
          text: text(prompt.text),
          requestId: optionalString(data.id),
        } }],
      };
    }
    case "session.next.context.updated":
    case "session.next.synthetic":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "info",
        message: text(data.text) || "Context updated",
      } }] };
    case "session.next.text.started":
      return textUpdate(data, eventId, createdAt, "cumulative", "");
    case "session.next.text.delta":
    case "message.part.delta":
      return textUpdate(data, eventId, createdAt, "incremental", text(data.delta ?? data.text));
    case "session.next.text.ended":
      return textUpdate(data, eventId, createdAt, "cumulative", text(data.text));
    case "session.next.reasoning.started":
    case "session.next.reasoning.delta":
    case "session.next.reasoning.ended": {
      const partId = optionalString(data.reasoningID) ?? optionalString(data.partID) ?? optionalString(data.id) ?? eventId;
      const item = {
        id: `reasoning:${partId}`,
        type: "reasoning" as const,
        createdAt,
        text: "",
        status: String(event.type).endsWith("ended") ? "completed" as const : "running" as const,
      };
      return { conversationId, updates: [{
        kind: "text",
        itemId: item.id,
        identity: partId,
        mode: String(event.type).endsWith("delta") ? "incremental" : "cumulative",
        text: text(data.text ?? data.delta),
        item,
      }] };
    }
    case "session.next.shell.started":
    case "session.next.shell.ended": {
      const callId = optionalString(data.callID) ?? eventId;
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `command:${callId}`,
        type: "command",
        createdAt,
        command: text(data.command) || "command",
        output: optionalString(data.output),
        exitCode: number(data.exitCode),
        status: String(event.type).endsWith("ended") ? (number(data.exitCode) === 0 ? "completed" : "failed") : "running",
      } }] };
    }
    case "session.next.tool.called":
    case "session.next.tool.progress":
    case "session.next.tool.success":
    case "session.next.tool.failed":
      return normalizeToolEvent(event, data, conversationId, eventId, createdAt);
    // Compaction and revert both change what the transcript means. Unmapped,
    // a compacted conversation looks like it silently lost content and
    // reverted work keeps rendering as though it still applies. Notices rather
    // than a new item type: the requirement is that the transcript stop lying,
    // and a new type would drag the published ConversationItem schema — and an
    // API revision — into a change that otherwise needs none.
    case "session.next.compaction.started":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "info",
        message: "Compacting conversation context…",
      } }] };
    case "session.next.compaction.ended":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "info",
        message: text(data.summary) || "Conversation context compacted. Earlier turns are summarized.",
      } }] };
    case "session.next.revert.staged":
    case "session.next.revert.committed":
    case "session.next.revert.cleared":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "warning",
        message: event.type === "session.next.revert.cleared"
          ? "Revert cleared. Earlier changes apply again."
          : event.type === "session.next.revert.committed"
            ? "Changes reverted. Work shown above this point no longer applies."
            : "Revert staged. Work shown above this point is pending reversal.",
      } }] };
    case "session.next.step.ended":
      return { conversationId, updates: normalizeDiffs(data, createdAt) };
    // OpenCode 1.18 announces one request under two naming generations: v2 is
    // native and the classic name is bridged from it (`action`→`permission`,
    // `resources`→`patterns`, `save`→`always`). Both carry the same request id,
    // so mapping both onto `permission:<id>` makes the projection upsert the
    // dedupe — whichever arrives second merges into the same entry.
    case "permission.asked":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `permission:${string(data.id, "permission id")}`,
        type: "permission",
        createdAt,
        conversationId,
        requestId: string(data.id, "permission id"),
        action: text(data.permission),
        resources: stringArray(data.patterns),
        status: "pending",
        ...permissionDiff(data),
      } }] };
    case "permission.replied":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `permission:${string(data.requestID, "permission id")}`,
        type: "permission",
        createdAt,
        conversationId,
        requestId: string(data.requestID, "permission id"),
        action: "permission",
        resources: [],
        status: "resolved",
        outcome: permissionOutcome(data.reply),
      } }] };
    case "permission.v2.asked":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `permission:${string(data.id, "permission id")}`,
        type: "permission",
        createdAt,
        conversationId,
        requestId: string(data.id, "permission id"),
        action: text(data.action),
        resources: stringArray(data.resources),
        status: "pending",
        ...permissionDiff(data),
      } }] };
    case "permission.v2.replied": {
      const requestId = string(data.requestID, "permission id");
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `permission:${requestId}`,
        type: "permission",
        createdAt,
        conversationId,
        requestId,
        action: "permission",
        resources: [],
        status: "resolved",
        outcome: permissionOutcome(data.reply),
      } }] };
    }
    // Same two-generation story as permissions. This one matters more: the
    // workspace previously saw no live question signal at all and fell back to
    // polling, because it was listening only for the v2 name.
    case "question.asked": {
      const requestId = string(data.id, "question id");
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `question:${requestId}`,
        type: "question",
        createdAt,
        conversationId,
        requestId,
        questions: array(data.questions).map(normalizeQuestion),
        status: "pending",
      } }] };
    }
    case "question.replied":
    case "question.rejected": {
      const requestId = string(data.requestID, "question id");
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `question:${requestId}`,
        type: "question",
        createdAt,
        conversationId,
        requestId,
        questions: [],
        status: "resolved",
        outcome: event.type === "question.rejected"
          ? { kind: "rejected" }
          : { kind: "answered", answers: array(data.answers).map(stringArray) },
      } }] };
    }
    case "question.v2.asked": {
      const requestId = string(data.id, "question id");
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `question:${requestId}`,
        type: "question",
        createdAt,
        conversationId,
        requestId,
        questions: array(data.questions).map(normalizeQuestion),
        status: "pending",
      } }] };
    }
    case "question.v2.replied":
    case "question.v2.rejected": {
      const requestId = string(data.requestID, "question id");
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `question:${requestId}`,
        type: "question",
        createdAt,
        conversationId,
        requestId,
        questions: [],
        status: "resolved",
        outcome: event.type === "question.v2.rejected"
          ? { kind: "rejected" }
          : { kind: "answered", answers: array(data.answers).map(stringArray) },
      } }] };
    }
    case "session.status": {
      const providerStatus = record(data.status);
      const type = optionalString(providerStatus.type) ?? optionalString(data.status);
      return { conversationId, updates: [{ kind: "status", status: type === "idle" ? "completed" : "running" }] };
    }
    case "session.idle":
      return { conversationId, updates: [{ kind: "status", status: "completed" }] };
    case "session.error":
    case "session.next.step.failed": {
      const message = errorMessage(data.error) || text(data.message) || "The turn failed";
      return { conversationId, updates: [
        { kind: "upsert", item: { id: `notice:${eventId}`, type: "notice", createdAt, level: "error", message } },
        { kind: "status", status: "failed", message },
      ] };
    }
    case "session.next.retried":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "warning",
        message: text(data.message) || errorMessage(data.error) || "Retrying the turn",
      } }] };
    case "message.updated": {
      const info = record(data.info ?? data.message);
      const messageId = optionalString(info.id);
      const role = optionalString(info.role) ?? optionalString(info.type);
      if (messageId && role && memory) remember(memory.roles, messageId, role);
      const updates: NormalizedProviderUpdate[] = normalizeProviderMessage({ info, parts: [] })
        .map(item => ({ kind: "upsert" as const, item }));
      // The message's token usage decorates the last text part it produced —
      // an item that already renders — rather than becoming an item of its
      // own. Before any part exists it waits in `pendingUsage`; a `message.updated`
      // is not evidence that a bubble should appear.
      const usage = role === "assistant" ? tokensToUsage(info.tokens) : undefined;
      let reported: { messageId: string; usage: TokenUsage } | undefined;
      if (usage && messageId && memory) {
        const partId = memory.lastAssistantPart.get(messageId);
        if (partId) {
          updates.push(usageUpsert(partId, timestamp(record(info.time).created, createdAt), usage));
          reported = { messageId, usage };
        } else {
          remember(memory.pendingUsage, messageId, usage);
        }
      }
      const assistantModel = role === "assistant" ? optionalString(info.modelID ?? info.modelId) : undefined;
      return {
        conversationId: conversationId ?? optionalString(info.sessionID),
        updates,
        ...(assistantModel === undefined ? {} : { assistantModel }),
        ...(reported === undefined ? {} : { assistantUsage: reported }),
      };
    }
    case "message.part.updated": {
      const part = record(data.part);
      const messageId = optionalString(part.messageID);
      if (part.type === "text" && messageId && memory?.roles.get(messageId) === "user") {
        return { conversationId: conversationId ?? optionalString(part.sessionID), updates: [{ kind: "upsert", item: {
          id: `message:${messageId}`,
          type: "user_message",
          createdAt: timestamp(record(part.time).created ?? data.time, createdAt),
          text: text(part.text),
        } }] };
      }
      const partCreatedAt = timestamp(record(data.message).time, createdAt);
      const updates = normalizePart(part, partCreatedAt);
      const partId = optionalString(part.id);
      let flushed: { messageId: string; usage: TokenUsage } | undefined;
      if (part.type === "text" && messageId && partId && memory) {
        remember(memory.lastAssistantPart, messageId, `part:${partId}`);
        // Usage that beat the first part to the stream lands here, on the part
        // it was always meant to decorate.
        const pending = memory.pendingUsage.get(messageId);
        if (pending) {
          memory.pendingUsage.delete(messageId);
          updates.push(usageUpsert(`part:${partId}`, partCreatedAt, pending));
          flushed = { messageId, usage: pending };
        }
      }
      return {
        conversationId: conversationId ?? optionalString(part.sessionID),
        updates,
        ...(flushed === undefined ? {} : { assistantUsage: flushed }),
      };
    }
    case "message.part.removed": {
      const partId = optionalString(data.partID);
      return { conversationId, updates: partId ? [{ kind: "remove", itemId: `part:${partId}` }] : [] };
    }
    default:
      // No case matched. The wrapper decides whether that is expected.
      return undefined;
  }
}

/**
 * A usage-only decoration of an existing assistant part. Empty markdown is the
 * signal that this carries no text: `mergeInteraction` and the client
 * projection both keep the streamed answer rather than blanking it, and keep
 * the part's own timestamp rather than resorting the timeline.
 */
function usageUpsert(itemId: string, createdAt: number, usage: TokenUsage): NormalizedProviderUpdate {
  return { kind: "upsert", item: { id: itemId, type: "assistant_message", createdAt, markdown: "", usage } };
}

function normalizeStoredMessage(info: RecordValue, parts: unknown[]): ConversationItem[] {
  const id = string(info.id, "message id");
  const createdAt = timestamp(record(info.time).created, 0);
  if (info.role === "user") {
    const body = parts.map(part => record(part)).filter(part => part.type === "text").map(part => text(part.text)).join("");
    return [{ id: `message:${id}`, type: "user_message", createdAt, text: body }];
  }
  if (info.role === "assistant") {
    return normalizeAssistant({ content: parts, error: info.error, snapshot: info.snapshot, tokens: info.tokens }, id, createdAt);
  }
  return [];
}

function normalizeAssistant(message: RecordValue, messageId: string, createdAt: number): ConversationItem[] {
  const items = array(message.content).flatMap(value => normalizePart(record(value), createdAt)).flatMap(update => {
    if (update.kind === "upsert") return [update.item];
    if (update.kind === "text" && update.item) return [update.item];
    return [];
  });
  // The stored message states what the turn spent; it goes on the last text
  // part, which is the item on screen when the turn is read back. This is the
  // authoritative path — it is what populates the indicator on opening a
  // conversation, before any new turn is taken.
  const usage = tokensToUsage(message.tokens);
  if (usage) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (item.type !== "assistant_message") continue;
      items[index] = { ...item, usage };
      break;
    }
  }
  const error = errorMessage(message.error);
  if (error) items.push({ id: `notice:${messageId}:error`, type: "notice", createdAt, level: "error", message: error });
  for (const path of stringArray(record(message.snapshot).files)) {
    items.push({ id: `file:${messageId}:${path}`, type: "file_change", createdAt, path, operation: "update" });
  }
  return items;
}

function normalizePart(part: RecordValue, createdAt: number): NormalizedProviderUpdate[] {
  const id = string(part.id, "part id");
  if (part.type === "text") {
    const item: ConversationItem = { id: `part:${id}`, type: "assistant_message", createdAt, markdown: text(part.text) };
    return [{ kind: "text", itemId: item.id, identity: id, mode: "cumulative", text: text(part.text), item }];
  }
  if (part.type === "reasoning") {
    // Every part in a message carries the message's created time, never its
    // own: history is ordered by `createdAt` (adapter.history), so a
    // part-level timestamp here would sort reasoning past the text and tool
    // parts it ran between and strand it at the end of the replayed turn.
    // Within-message order comes from the provider's part order instead.
    const time = record(part.time);
    const durationMs = typeof time.start === "number" && typeof time.end === "number" && time.end >= time.start
      ? time.end - time.start
      : undefined;
    return [{ kind: "upsert", item: {
      id: `part:${id}`,
      type: "reasoning",
      createdAt,
      text: text(part.text),
      status: isFinishedTime(part.time) ? "completed" : "running",
      ...(durationMs === undefined ? {} : { durationMs }),
    } }];
  }
  if (part.type === "tool") return [normalizeToolPart(part, createdAt)];
  return [];
}

function normalizeToolPart(part: RecordValue, createdAt: number): NormalizedProviderUpdate {
  const state = record(part.state);
  const name = text(part.name ?? part.tool) || "tool";
  const id = optionalString(part.id) ?? optionalString(part.callID) ?? name;
  const input = typeof state.input === "string" ? state.input : json(state.input);
  const output = toolContent(state.content) || optionalString(state.output) || json(state.result);
  const error = errorMessage(state.error);
  if (isCommand(name, state)) {
    return { kind: "upsert", item: {
      id: `tool:${id}`,
      type: "command",
      createdAt,
      command: commandText(state),
      status: activityStatus(state.status),
      output,
      exitCode: number(record(state.metadata).exitCode),
    } };
  }
  // A `task` tool's metadata names the child session the subagent ran as;
  // carrying it makes the transcript openable as its own conversation.
  const childConversationId = optionalString(record(state.metadata).sessionId ?? record(state.metadata).sessionID);
  return { kind: "upsert", item: {
    id: `tool:${id}`,
    type: "tool",
    createdAt,
    name,
    status: activityStatus(state.status),
    input,
    output,
    error,
    ...(childConversationId === undefined ? {} : { childConversationId }),
  } };
}

function normalizeToolEvent(event: RecordValue, data: RecordValue, conversationId: string | undefined, eventId: string, createdAt: number) {
  const callId = optionalString(data.callID) ?? eventId;
  const state = {
    status: String(event.type).endsWith("success") ? "completed" : String(event.type).endsWith("failed") ? "error" : "running",
    input: data.input,
    content: data.content,
    result: data.result,
    error: data.error,
  };
  return {
    conversationId,
    updates: [
      normalizeToolPart({ id: callId, type: "tool", name: data.tool ?? data.name, state }, createdAt),
      ...stringArray(data.outputPaths).map((path, index): NormalizedProviderUpdate => ({ kind: "upsert", item: {
        id: `file:${callId}:${index}:${path}`,
        type: "file_change",
        createdAt,
        path,
        operation: "update",
      } })),
    ],
  };
}

function normalizeDiffs(data: RecordValue, createdAt: number): NormalizedProviderUpdate[] {
  return array(data.diffs ?? data.files).flatMap((value, index) => {
    const diff = typeof value === "string" ? { path: value } : record(value);
    const path = optionalString(diff.path);
    if (!path) return [];
    const status = optionalString(diff.status);
    return [{ kind: "upsert", item: {
      id: `file:${optionalString(data.messageID) ?? createdAt}:${index}:${path}`,
      type: "file_change",
      createdAt,
      path,
      operation: status === "added" ? "create" : status === "deleted" ? "delete" : "update",
      additions: number(diff.additions),
      deletions: number(diff.deletions),
    } } satisfies NormalizedProviderUpdate];
  });
}

function textUpdate(data: RecordValue, fallbackId: string, createdAt: number, mode: "cumulative" | "incremental", value: string) {
  const partId = optionalString(data.textID) ?? optionalString(data.partID) ?? optionalString(data.id) ?? fallbackId;
  const itemId = `part:${partId}`;
  return {
    conversationId: optionalString(data.sessionID),
    updates: [{
      kind: "text" as const,
      itemId,
      identity: partId,
      mode,
      text: value,
      item: { id: itemId, type: "assistant_message" as const, createdAt, markdown: "" },
    }],
  };
}

export function normalizeQuestion(value: unknown): StructuredQuestion {
  const question = record(value);
  return {
    prompt: text(question.question),
    header: text(question.header),
    options: array(question.options).map(option => {
      const item = record(option);
      return { label: text(item.label), description: text(item.description) };
    }),
    multiple: question.multiple === true,
    allowFreeForm: question.custom === true,
  };
}

function permissionOutcome(value: unknown): "approved-once" | "approved-session" | "rejected" {
  return value === "once" ? "approved-once" : value === "always" ? "approved-session" : "rejected";
}

// The change a file-edit permission would apply, when the agent attaches one.
// OpenCode puts a unified diff on the permission's `metadata.diff` — the same
// string its own edit-tool renderer reads. A permission with none (a command,
// a fetch) yields nothing to spread.
function permissionDiff(data: RecordValue): { diff?: string } {
  const diff = optionalString(record(data.metadata).diff);
  return diff && diff.trim() ? { diff } : {};
}

function activityStatus(value: unknown): "pending" | "running" | "completed" | "failed" {
  return value === "pending" ? "pending" : value === "completed" ? "completed" : value === "error" ? "failed" : "running";
}

function isCommand(name: string, state: RecordValue): boolean {
  return /^(bash|shell|command|terminal)$/i.test(name) || optionalString(record(state.structured).command) !== undefined;
}

function commandText(state: RecordValue): string {
  const structured = record(state.structured);
  const input = record(state.input);
  return text(structured.command ?? input.command ?? input.cmd) || "command";
}

function toolContent(value: unknown): string | undefined {
  const content = array(value).map(item => record(item)).filter(item => item.type === "text").map(item => text(item.text)).join("\n");
  return content || undefined;
}

function errorMessage(value: unknown): string | undefined {
  const error = record(value);
  return optionalString(error.message) ?? optionalString(record(error.data).message);
}

/**
 * The two OpenCode stores mark completion differently: the v2 store sets
 * `time.completed`, the classic store sets `time.end`. Reading only one leaves
 * replayed history claiming it is still running.
 */
function isFinishedTime(value: unknown): boolean {
  const time = record(value);
  return time.completed !== undefined || time.end !== undefined;
}

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`invalid OpenCode ${field}`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}

function json(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
