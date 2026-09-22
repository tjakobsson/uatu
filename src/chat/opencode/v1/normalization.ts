import {
  type EventContext,
  type GenerationMapper,
  type KnownEvent,
  type NormalizedProviderEvent,
  type NormalizedProviderUpdate,
  type ProviderEventMemory,
  type RecordValue,
  answeredPrompt,
  array,
  messageAgent,
  messageModel,
  messageModelSelection,
  normalizeEventWith,
  normalizePart,
  normalizeProviderMessage,
  normalizeQuestion,
  optionalString,
  record,
  remember,
  string,
  stringArray,
  text,
  timestamp,
  tokensToUsage,
  usageUpsert,
} from "../normalization";
import type { TokenUsage } from "../../types";

// The OpenCode 1.x mapper over the shared normalization core: 1.18's
// `session.next.*` generation is the canonical vocabulary minus a `next.`
// segment, and what only 1.x announces — the cumulative `message.*` records,
// the `question.*` family, prompt admission — is handled here.
export {
  createProviderEventMemory,
  normalizeProviderMessage,
  normalizeQuestion,
  pendingPermissionFields,
  permissionDiff,
  storedMessageUsage,
  storedPromptId,
  tokensToUsage,
} from "../normalization";
export type { NormalizedEventOutcome, NormalizedProviderEvent, NormalizedProviderUpdate, NormalizedSessionLifecycle, ProviderEvent, ProviderEventMemory, ProviderMessage } from "../normalization";

// 1.x wire types recognized as deliberately carrying nothing for the
// timeline, beyond the core's canonical list.
const IGNORED: ReadonlySet<string> = new Set([
  "server.heartbeat",
  "server.instance.disposed",
  "global.disposed",
  "installation.update.available",
  "catalog.updated",
  "plugin.added",
  "integration.connection.updated",
  "project.directories.updated",
  "file.watcher.updated",
  "lsp.updated",
  "mcp.tools.changed",
  "mcp.browser.open.failed",
  "workspace.ready",
  "workspace.failed",
  "workspace.status",
  "worktree.ready",
  "worktree.failed",
]);

// 1.x names whose canonical counterpart is not the plain `next.` drop.
const RENAMED: Record<string, string> = {
  "session.next.retried": "session.retry.scheduled",
  "session.next.agent.switched": "session.agent.selected",
  "session.next.model.switched": "session.model.selected",
  "permission.v2.asked": "permission.asked",
  "permission.v2.replied": "permission.replied",
  // A text delta under the compatibility name carries the same fields.
  "message.part.delta": "session.text.delta",
  // A session-level error ends the turn the way a failed step does.
  "session.error": "session.step.failed",
};

function toCanonical(type: string, data: RecordValue): { type: string; data: RecordValue } | undefined {
  const renamed = RENAMED[type];
  if (renamed) return { type: renamed, data };
  if (type.startsWith("session.next.")) return { type: `session.${type.slice("session.next.".length)}`, data };
  if (type.startsWith("session.") || type.startsWith("permission.")) return { type, data };
  return undefined;
}

function own(event: RecordValue, data: RecordValue, context: EventContext, memory?: ProviderEventMemory): KnownEvent | undefined {
  const { conversationId, eventId, createdAt } = context;
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
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "info",
        message: text(data.text) || "Context updated",
      } }] };
    // Same two-generation story as permissions. This one matters more: the
    // workspace previously saw no live question signal at all and fell back to
    // polling, because it was listening only for the v2 name.
    case "question.asked":
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
    case "question.replied":
    case "question.rejected":
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
        outcome: String(event.type).endsWith("rejected")
          ? { kind: "rejected" }
          : { kind: "answered", answers: array(data.answers).map(stringArray) },
      } }] };
    }
    case "message.updated": {
      const info = record(data.info ?? data.message);
      const messageId = optionalString(info.id);
      const role = optionalString(info.role) ?? optionalString(info.type);
      if (messageId && role && memory) remember(memory.roles, messageId, role);
      const sessionId = conversationId ?? optionalString(info.sessionID);
      if (messageId && role === "user" && sessionId && memory) remember(memory.prompts, sessionId, messageId);
      // Named by the event where it can be (classic `parentID`); otherwise the
      // newest prompt this session was seen to receive.
      const promptId = role === "assistant" ? answeredPrompt(info) ?? (sessionId ? memory?.prompts.get(sessionId) : undefined) : undefined;
      const updates: NormalizedProviderUpdate[] = normalizeProviderMessage({ info, parts: [] }, false)
        .map(item => ({ kind: "upsert" as const, item }));
      // A message's tokens are the message's, so they ride one item keyed by
      // the message — never a text part it produced. `message.updated`
      // restates a growing cumulative figure, and a message can emit several
      // text parts: decorating "the newest part" left the earlier part still
      // claiming the same total, so one message's spend appeared on two items
      // and anything aggregating them counted it twice. One carrier per
      // message cannot double-count, needs no memory of which part came last,
      // and covers the message that produces no text part at all (a purely
      // agentic turn still fills the context window). Empty markdown is what
      // keeps it off the screen — the renderer draws no bubble for it.
      const usage = role === "assistant" ? tokensToUsage(info.tokens, info.cost) : undefined;
      let reported: { messageId: string; usage: TokenUsage; promptId?: string } | undefined;
      if (usage && messageId) {
        reported = { messageId, usage, ...(promptId === undefined ? {} : { promptId }) };
        updates.push(usageUpsert(`usage:${messageId}`, timestamp(record(info.time).created, createdAt), usage, messageModelSelection(info), messageAgent(info)));
      }
      const model = role === "assistant" ? messageModel(info) : undefined;
      const assistantModel = model && messageId
        ? { messageId, model, createdAt: timestamp(record(info.time).created, createdAt), ...(promptId === undefined ? {} : { promptId }) }
        : undefined;
      return {
        conversationId: conversationId ?? optionalString(info.sessionID),
        updates,
        ...(assistantModel === undefined ? {} : { assistantModel }),
        ...(reported === undefined ? {} : { assistantUsage: reported }),
      };
    }
    case "message.removed": {
      const messageId = optionalString(data.messageID) ?? optionalString(data.messageId);
      if (!messageId) return { conversationId, updates: [] };
      memory?.roles.delete(messageId);
      return {
        conversationId,
        updates: [
          { kind: "remove", itemId: `message:${messageId}` },
          { kind: "remove", itemId: `usage:${messageId}` },
        ],
        removedMessageId: messageId,
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
      // A part carries no token report of its own: usage arrives on
      // `message.updated` and lands on the message's own carrier, so a part
      // needs no bookkeeping about where a figure should go.
      const partCreatedAt = timestamp(record(data.message).time, createdAt);
      return {
        conversationId: conversationId ?? optionalString(part.sessionID),
        updates: normalizePart(part, partCreatedAt),
      };
    }
    case "message.part.removed": {
      const partId = optionalString(data.partID);
      return { conversationId, updates: partId ? [{ kind: "remove", itemId: `part:${partId}` }] : [] };
    }
    default:
      return undefined;
  }
}

export const openCodeV1Mapper: GenerationMapper = { own, toCanonical, ignored: IGNORED };

// Public boundary for a 1.x event stream. Every failure mode resolves to an
// outcome rather than an exception, so one malformed payload costs one event
// instead of the pump.
export function normalizeProviderEvent(value: unknown, memory?: ProviderEventMemory): NormalizedProviderEvent {
  return normalizeEventWith(value, openCodeV1Mapper, memory);
}
