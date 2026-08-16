import type { ConversationItem, ConversationStatus, StructuredQuestion } from "./types";

type RecordValue = Record<string, unknown>;

export type NormalizedProviderUpdate =
  | { kind: "upsert"; item: ConversationItem }
  | { kind: "text"; itemId: string; identity: string; mode: "cumulative" | "incremental"; text: string; item?: ConversationItem }
  | { kind: "remove"; itemId: string }
  | { kind: "status"; status: ConversationStatus; message?: string };

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

export function normalizeProviderEvent(value: unknown, messageRoles?: Map<string, string>): { conversationId?: string; updates: NormalizedProviderUpdate[] } {
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
        message: text(data.text) || "OpenCode context updated",
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
    case "session.next.step.ended":
      return { conversationId, updates: normalizeDiffs(data, createdAt) };
    case "permission.v2.asked":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `permission:${string(data.id, "permission id")}`,
        type: "permission",
        createdAt,
        requestId: string(data.id, "permission id"),
        action: text(data.action),
        resources: stringArray(data.resources),
        status: "pending",
      } }] };
    case "permission.v2.replied": {
      const requestId = string(data.requestID, "permission id");
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `permission:${requestId}`,
        type: "permission",
        createdAt,
        requestId,
        action: "permission",
        resources: [],
        status: "resolved",
        outcome: permissionOutcome(data.reply),
      } }] };
    }
    case "question.v2.asked": {
      const requestId = string(data.id, "question id");
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `question:${requestId}`,
        type: "question",
        createdAt,
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
      const message = errorMessage(data.error) || text(data.message) || "OpenCode turn failed";
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
        message: text(data.message) || errorMessage(data.error) || "OpenCode is retrying the turn",
      } }] };
    case "message.updated": {
      const info = record(data.info ?? data.message);
      const messageId = optionalString(info.id);
      const role = optionalString(info.role);
      if (messageId && role && messageRoles) {
        messageRoles.set(messageId, role);
        if (messageRoles.size > 2_048) messageRoles.delete(messageRoles.keys().next().value!);
      }
      return {
        conversationId: conversationId ?? optionalString(info.sessionID),
        updates: normalizeProviderMessage({ info, parts: [] }).map(item => ({ kind: "upsert", item })),
      };
    }
    case "message.part.updated": {
      const part = record(data.part);
      const messageId = optionalString(part.messageID);
      if (part.type === "text" && messageId && messageRoles?.get(messageId) === "user") {
        return { conversationId: conversationId ?? optionalString(part.sessionID), updates: [{ kind: "upsert", item: {
          id: `message:${messageId}`,
          type: "user_message",
          createdAt: timestamp(record(part.time).created ?? data.time, createdAt),
          text: text(part.text),
        } }] };
      }
      return { conversationId: conversationId ?? optionalString(part.sessionID), updates: normalizePart(part, timestamp(record(data.message).time, createdAt)) };
    }
    case "message.part.removed": {
      const partId = optionalString(data.partID);
      return { conversationId, updates: partId ? [{ kind: "remove", itemId: `part:${partId}` }] : [] };
    }
    default:
      return { conversationId, updates: [] };
  }
}

function normalizeStoredMessage(info: RecordValue, parts: unknown[]): ConversationItem[] {
  const id = string(info.id, "message id");
  const createdAt = timestamp(record(info.time).created, 0);
  if (info.role === "user") {
    const body = parts.map(part => record(part)).filter(part => part.type === "text").map(part => text(part.text)).join("");
    return [{ id: `message:${id}`, type: "user_message", createdAt, text: body }];
  }
  if (info.role === "assistant") {
    return normalizeAssistant({ content: parts, error: info.error, snapshot: info.snapshot }, id, createdAt);
  }
  return [];
}

function normalizeAssistant(message: RecordValue, messageId: string, createdAt: number): ConversationItem[] {
  const items = array(message.content).flatMap(value => normalizePart(record(value), createdAt)).flatMap(update => {
    if (update.kind === "upsert") return [update.item];
    if (update.kind === "text" && update.item) return [update.item];
    return [];
  });
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
    return [{ kind: "upsert", item: {
      id: `part:${id}`,
      type: "reasoning",
      createdAt,
      text: text(part.text),
      status: isFinishedTime(part.time) ? "completed" : "running",
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
