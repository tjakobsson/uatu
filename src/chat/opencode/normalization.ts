import { boundedSet } from "../../shared/bounded-map";
import { attachmentIdFromFileUri, attachmentIdFromText } from "../attachment-store";
import { CHAT_ATTACHMENT_MIME_TYPES, CHAT_ATTACHMENTS_PER_MESSAGE, type ConversationConfiguration, type ConversationItem, type MessageAttachment, type StructuredQuestion, type TokenUsage } from "../types";
import type { NormalizedEventOutcome, NormalizedProviderEvent, NormalizedProviderUpdate, NormalizedSessionLifecycle } from "../provider";

/**
 * The normalization core both OpenCode generations share.
 *
 * OpenCode 2.x's session event vocabulary is 1.18's `session.next.*`
 * generation with the `next.` segment dropped, so the text, reasoning, tool,
 * step, shell, revert, and compaction state machines are one implementation
 * here, keyed by the 2.x (canonical) names and reading the canonical payload
 * shape — which is 1.18's, because that is what the fixtures that define this
 * behavior were captured from. Each generation contributes a
 * `GenerationMapper`: `toCanonical` renames (and, for 2.x, reshapes) a wire
 * event into the canonical form, and `own` handles what that generation alone
 * announces (1.x: cumulative `message.*` records and the `question.*` family;
 * 2.x: the `session.execution.*` turn lifecycle, `form.*`, usage updates).
 *
 * The stored-record readers (`normalizeProviderMessage`, `storedMessageUsage`,
 * `storedPromptId`) read 1.x's two store shapes; 2.x's provider maps its own
 * message records onto `normalizePart` and friends.
 */

// Raw OpenCode payload shapes, private to the normalizers.
export type ProviderMessage = Record<string, unknown>;
export type ProviderEvent = Record<string, unknown>;

export type { NormalizedEventOutcome, NormalizedProviderEvent, NormalizedProviderUpdate, NormalizedSessionLifecycle };

export type RecordValue = Record<string, unknown>;

export type ProviderEventMemory = {
  roles: Map<string, string>;
  // The newest user message seen per session: the prompt an assistant message
  // answers when the event does not name it (the v2 record has no `parentID`).
  prompts: Map<string, string>;
};

export function createProviderEventMemory(): ProviderEventMemory {
  return { roles: new Map(), prompts: new Map() };
}

const MEMORY_LIMIT = 2_048;

export function remember<T>(map: Map<string, T>, key: string, value: T): void {
  boundedSet(map, key, value, MEMORY_LIMIT);
}

/**
 * The tokens the agent reported, as our own shape. Missing components stay
 * missing rather than becoming zero: "the agent did not report cache reads"
 * and "there were none" are different statements, and only one of them lets a
 * readout claim a figure.
 *
 * `tokens.total` is deliberately not read — it counts output, so it is not
 * what occupies the context window.
 *
 * `cost` is the message's price in USD, a sibling of `tokens` on the
 * message rather than a member of it, so it arrives separately. OpenCode
 * reports `0` for a model it has no price for; that is kept as zero (the
 * readout decides that an all-zero conversation shows no cost) and only a
 * missing or malformed figure stays absent.
 */
export function tokensToUsage(value: unknown, cost?: unknown): TokenUsage | undefined {
  const usage: TokenUsage = {};
  const put = (key: keyof TokenUsage, raw: unknown) => {
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) usage[key] = raw;
  };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const tokens = value as RecordValue;
    const cache = record(tokens.cache);
    put("input", tokens.input);
    put("output", tokens.output);
    put("reasoning", tokens.reasoning);
    put("cacheRead", cache.read);
    put("cacheWrite", cache.write);
  }
  put("costUsd", cost);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * A stored assistant message's own accounting: the tokens it reported and the
 * model it ran. Distinct from `normalizeProviderMessage`, which is about the
 * timeline a message produces — this is about the message itself, and exists so
 * a subagent's cost can be rebuilt from its stored history when the live tally
 * for it is gone. Returns nothing for a user message, or for one that reported
 * neither.
 */
export function storedMessageUsage(value: unknown): { messageId: string; createdAt: number; usage?: TokenUsage; model?: string; promptId?: string } | undefined {
  const { info } = unwrapStoredMessage(value);
  const messageId = optionalString(info.id);
  if (!messageId || (info.role !== "assistant" && info.type !== "assistant")) return undefined;
  const usage = tokensToUsage(info.tokens, info.cost);
  const model = messageModel(info);
  if (usage === undefined && model === undefined) return undefined;
  const promptId = answeredPrompt(info);
  return { messageId, createdAt: timestamp(record(info.time).created, 0), ...(usage === undefined ? {} : { usage }), ...(model === undefined ? {} : { model }), ...(promptId === undefined ? {} : { promptId }) };
}

/**
 * The id of a stored USER message, or nothing for any other kind. The v2
 * record names no prompt on an assistant message, so a reader walking the
 * transcript in order pairs each assistant message with the newest user
 * message before it; this is how it recognises one.
 */
export function storedPromptId(value: unknown): string | undefined {
  const { info } = unwrapStoredMessage(value);
  return info.role === "user" || info.type === "user" ? optionalString(info.id) : undefined;
}

/** The user message an assistant message answers, where the record names it (classic: `parentID`). */
export function answeredPrompt(info: RecordValue): string | undefined {
  return optionalString(info.parentID ?? info.parentId);
}

/** The agent that produced a message: `agent` in both stores, `mode` in older classic records. */
export function messageAgent(info: RecordValue): string | undefined {
  return optionalString(info.agent ?? info.mode);
}

/**
 * The model an assistant message ran. The classic store and the bridged
 * events name it `modelID`/`modelId`; a flat v2 record carries a
 * `model: { id, providerID }` reference instead. Both readers — the live
 * event path and the stored-history reconstruction — must accept both, or a
 * persisted v2 child restores its cost with no model label and the completed
 * attribution is then banked without one for good.
 */
export function messageModel(info: RecordValue): string | undefined {
  return optionalString(info.modelID ?? info.modelId) ?? optionalString(record(info.model).id);
}

export function messageModelSelection(info: RecordValue): { providerId: string; modelId: string } | undefined {
  const model = record(info.model);
  const providerId = optionalString(info.providerID ?? info.providerId) ?? optionalString(model.providerID ?? model.providerId);
  const modelId = messageModel(info);
  return providerId && modelId ? { providerId, modelId } : undefined;
}

// Canonical event types recognized as deliberately carrying nothing for the
// timeline. Listed rather than lumped with `unrecognized` so the drop counter
// stays honest about what the workspace genuinely does not understand. Each
// generation adds its own wire-level list on top.
export const CORE_IGNORED: ReadonlySet<string> = new Set([
  // Streaming progress for an operation whose started/ended pair is enough.
  "session.compaction.delta",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  // Server and workspace lifecycle with no conversation meaning.
  "server.connected",
  "installation.updated",
  "integration.updated",
  "project.updated",
  "reference.updated",
  "vcs.branch.updated",
  "pty.created",
  "pty.updated",
  "pty.exited",
  "pty.deleted",
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  "tui.session.select",
]);

/**
 * The classic store wraps each message as { info, parts } and names the
 * sender `role`; the v2 store is flat with a `type`. The one detector every
 * stored-message reader shares — `normalizeProviderMessage` for the timeline,
 * `storedMessageUsage` for the accounting — so a store-shape change is a
 * one-place fix.
 */
function unwrapStoredMessage(value: unknown): { info: RecordValue; parts: unknown[]; classic: boolean } {
  const envelope = record(value);
  const info = record(envelope.info);
  if (optionalString(info.role)) return { info, parts: array(envelope.parts), classic: true };
  return { info: envelope, parts: [], classic: false };
}

/**
 * `mintUsageCarrier` guards the `usage:<id>` fallback for a message whose
 * usage found no text part to decorate. On a real stored read the parts are
 * the whole truth, so no part means no part ever and the carrier is right.
 * The live `message.updated` path reuses this function with parts it KNOWS
 * are empty — there the event memory decides where the usage lands, and a
 * carrier minted here would duplicate (and outlive) that placement.
 */
export function normalizeProviderMessage(value: unknown, mintUsageCarrier = true): ConversationItem[] {
  const { info, parts, classic } = unwrapStoredMessage(value);
  if (classic) return normalizeStoredMessage(info, parts, mintUsageCarrier);
  const message = info;
  const id = string(message.id, "message id");
  const createdAt = timestamp(record(message.time).created, 0);
  switch (message.type) {
    case "user": {
      const attachments = normalizeUserAttachments(message.files);
      return [{ id: `message:${id}`, type: "user_message", createdAt, text: text(message.text), ...(attachments.length ? { attachments } : {}) }];
    }
    case "assistant":
      return normalizeAssistant(message, id, createdAt, mintUsageCarrier);
    case "shell":
      return [{
        id: `command:${string(message.callID, "call id")}`,
        type: "command",
        createdAt,
        command: text(message.command),
        output: text(message.output),
        status: isFinishedTime(message.time) ? "completed" : "running",
        ...completionTime(finishedTime(message.time)),
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

// What one event contributes beyond its timeline updates. Assembled by the
// core's canonical cases and by each generation's own handlers alike.
export type KnownEvent = {
  conversationId?: string;
  updates: NormalizedProviderUpdate[];
  assistantModel?: { messageId: string; model: string; createdAt: number; promptId?: string };
  assistantUsage?: { messageId: string; usage: TokenUsage; promptId?: string };
  removedMessageId?: string;
  configuration?: ConversationConfiguration;
  replaceModel?: boolean;
  sessionLifecycle?: NormalizedSessionLifecycle;
  revertLifecycle?: "staged" | "committed" | "cleared";
};

// The identity every handler needs, computed once per event from its payload:
// the owning session, an id for items minted from the event itself, and when
// it happened.
export type EventContext = {
  conversationId: string | undefined;
  eventId: string;
  createdAt: number;
};

export function eventContext(event: RecordValue, data: RecordValue): EventContext {
  return {
    conversationId: optionalString(data.sessionID) ?? optionalString(data.sessionId),
    eventId: optionalString(event.id) ?? `${String(event.type)}:${timestamp(data.timestamp, Date.now())}`,
    createdAt: timestamp(data.timestamp ?? data.timeCreated, Date.now()),
  };
}

// A canonical event: a 2.x type name over the canonical payload shape.
export type CanonicalEvent = { type: string; data: RecordValue };

/**
 * What one OpenCode generation contributes to normalization. `own` runs first
 * and handles what only that generation announces; otherwise `toCanonical`
 * maps the wire event onto a canonical one for the shared cases. Returning
 * `undefined` from both leaves the event to the ignore list, or to the
 * `unrecognized` counter.
 */
export type GenerationMapper<Memory extends ProviderEventMemory = ProviderEventMemory> = {
  own(event: RecordValue, data: RecordValue, context: EventContext, memory?: Memory): KnownEvent | undefined;
  toCanonical(type: string, data: RecordValue, event: RecordValue): CanonicalEvent | undefined;
  // Wire-level types this generation deliberately carries nothing for, on
  // top of `CORE_IGNORED` (which is matched against the canonical name).
  ignored: ReadonlySet<string>;
};

// Public boundary. Every failure mode resolves to an outcome rather than an
// exception, so one malformed payload costs one event instead of the pump.
export function normalizeEventWith<Memory extends ProviderEventMemory>(value: unknown, mapper: GenerationMapper<Memory>, memory?: Memory): NormalizedProviderEvent {
  const event = record(value);
  const eventType = optionalString(event.type) ?? "";
  try {
    const data = record(event.data ?? event.properties);
    const context = eventContext(event, data);
    let matched = mapper.own(event, data, context, memory);
    let canonicalType: string | undefined;
    if (!matched) {
      const canonical = mapper.toCanonical(eventType, data, event);
      if (canonical) {
        canonicalType = canonical.type;
        matched = normalizeCanonicalEvent(canonical.type, canonical.data, eventContext(event, canonical.data));
      }
    }
    if (matched) return { ...matched, outcome: matched.updates.length > 0 || matched.sessionLifecycle || matched.revertLifecycle ? "handled" : "ignored", eventType };
    return {
      conversationId: conversationIdOf(value),
      updates: [],
      outcome: mapper.ignored.has(eventType) || CORE_IGNORED.has(canonicalType ?? eventType) ? "ignored" : "unrecognized",
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
    const info = record(data.info ?? data.session);
    return optionalString(data.sessionID) ?? optionalString(data.sessionId) ?? optionalString(info.id);
  } catch {
    return undefined;
  }
}

// The shared cases, by canonical (2.x) name over the canonical payload shape.
// 1.x reaches them by renaming `session.next.X`; 2.x by reshaping its typed
// payloads onto the same fields.
export function normalizeCanonicalEvent(type: string, data: RecordValue, context: EventContext): KnownEvent | undefined {
  const { conversationId, eventId, createdAt } = context;
  switch (type) {
    case "session.created": {
      const sessionLifecycle = normalizeSessionLifecycle("created", data);
      return { conversationId: conversationId ?? sessionLifecycle.id, updates: [], sessionLifecycle };
    }
    case "session.agent.selected":
      return { conversationId, updates: [], configuration: { mode: string(data.agent, "session agent") } };
    case "session.model.selected": {
      const model = record(data.model);
      const providerId = string(model.providerID ?? model.providerId, "model provider id");
      const modelId = string(model.id ?? model.modelID ?? model.modelId, "model id");
      const reportedVariant = optionalString(model.variant);
      const variant = reportedVariant === "default" ? undefined : reportedVariant;
      return {
        conversationId,
        updates: [],
        configuration: { model: { providerId, modelId }, ...(variant ? { variant } : {}) },
        replaceModel: true,
      };
    }
    case "session.updated": {
      const info = record(data.info ?? data.session);
      const sessionLifecycle = normalizeSessionLifecycle("updated", data);
      const configuration = configurationFromRecord(info);
      return {
        conversationId: conversationId ?? sessionLifecycle.id,
        updates: [],
        sessionLifecycle,
        ...(configuration ? { configuration } : {}),
        ...(configuration?.model ? { replaceModel: true } : {}),
      };
    }
    case "session.deleted": {
      const sessionLifecycle = normalizeSessionLifecycle("deleted", data);
      return { conversationId: conversationId ?? sessionLifecycle.id, updates: [], sessionLifecycle };
    }
    case "session.synthetic":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "info",
        message: text(data.text) || "Context updated",
      } }] };
    case "session.text.started":
      return textUpdate(data, eventId, createdAt, "cumulative", "");
    case "session.text.delta":
      return textUpdate(data, eventId, createdAt, "incremental", text(data.delta ?? data.text));
    case "session.text.ended":
      return textUpdate(data, eventId, createdAt, "cumulative", text(data.text));
    case "session.reasoning.started":
    case "session.reasoning.delta":
    case "session.reasoning.ended": {
      const partId = optionalString(data.reasoningID) ?? optionalString(data.partID) ?? optionalString(data.id) ?? eventId;
      const item = {
        id: `reasoning:${partId}`,
        type: "reasoning" as const,
        createdAt,
        text: "",
        status: type.endsWith("ended") ? "completed" as const : "running" as const,
      };
      return { conversationId, updates: [{
        kind: "text",
        itemId: item.id,
        identity: partId,
        mode: type.endsWith("delta") ? "incremental" : "cumulative",
        text: text(data.text ?? data.delta),
        item,
      }] };
    }
    case "session.shell.started":
    case "session.shell.ended": {
      const callId = optionalString(data.callID) ?? eventId;
      const exitCode = number(data.exitCode);
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `command:${callId}`,
        type: "command",
        createdAt,
        command: text(data.command) || "command",
        output: optionalString(data.output),
        exitCode,
        status: type.endsWith("ended") ? (exitCode === undefined || exitCode === 0 ? "completed" : "failed") : "running",
        ...(type === "session.shell.ended" ? completionTime(data.timestamp) : {}),
      } }] };
    }
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed":
      return normalizeToolEvent(type, data, conversationId, eventId, createdAt);
    // Compaction and revert both change what the transcript means. Unmapped,
    // a compacted conversation looks like it silently lost content and
    // reverted work keeps rendering as though it still applies. Notices rather
    // than a new item type: the requirement is that the transcript stop lying,
    // and a new type would drag the published ConversationItem schema — and an
    // API revision — into a change that otherwise needs none.
    case "session.compaction.started":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "info",
        message: "Compacting conversation context…",
      } }] };
    case "session.compaction.ended":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "info",
        message: text(data.summary) || "Conversation context compacted. Earlier turns are summarized.",
      } }] };
    case "session.revert.staged":
    case "session.revert.committed":
    case "session.revert.cleared":
      return {
        conversationId,
        updates: [],
        revertLifecycle: type === "session.revert.staged"
          ? "staged"
          : type === "session.revert.committed" ? "committed" : "cleared",
      };
    case "session.step.ended":
      return { conversationId, updates: normalizeDiffs(data, createdAt) };
    // 1.18 announces one request under two naming generations: v2 is native
    // and the classic name is bridged from it (`action`→`permission`,
    // `resources`→`patterns`, `save`→`always`); 2.x announces only the native
    // one. Both carry the same request id, so mapping both onto
    // `permission:<id>` makes the projection upsert the dedupe — whichever
    // arrives second merges into the same entry. `always`/`save` is what an
    // "always" reply installs: `git status *` for a `git status --short`
    // request (captured live from 1.18.29). It is carried apart from the
    // request's own patterns so the card can show the user the rule they are
    // about to grant rather than the command.
    case "permission.asked":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `permission:${string(data.id, "permission id")}`,
        type: "permission",
        createdAt,
        conversationId,
        requestId: string(data.id, "permission id"),
        ...pendingPermissionFields(data),
        status: "pending",
      } }] };
    case "permission.replied": {
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
    case "session.status": {
      const providerStatus = record(data.status);
      const statusType = optionalString(providerStatus.type) ?? optionalString(data.status);
      return { conversationId, updates: [{ kind: "status", status: statusType === "idle" ? "completed" : "running" }] };
    }
    case "session.idle":
      return { conversationId, updates: [{ kind: "status", status: "completed" }] };
    case "session.step.failed": {
      const message = errorMessage(data.error) || text(data.message) || "The turn failed";
      return { conversationId, updates: [
        { kind: "upsert", item: { id: `notice:${eventId}`, type: "notice", createdAt, level: "error", message } },
        { kind: "status", status: "failed", message },
      ] };
    }
    case "session.retry.scheduled":
      return { conversationId, updates: [{ kind: "upsert", item: {
        id: `notice:${eventId}`,
        type: "notice",
        createdAt,
        level: "warning",
        message: text(data.message) || errorMessage(data.error) || "Retrying the turn",
      } }] };
    default:
      // No case matched. The wrapper decides whether that is expected.
      return undefined;
  }
}

export function normalizeSessionLifecycle(kind: NormalizedSessionLifecycle["kind"], data: RecordValue): NormalizedSessionLifecycle {
  const info = record(data.info ?? data.session);
  const id = string(info.id ?? data.sessionID ?? data.sessionId, "session id");
  const directory = string(info.directory ?? record(info.location).directory, "session directory");
  if (typeof info.title !== "string") throw new Error("invalid OpenCode session title");
  const parent = info.parentID ?? info.parentId;
  if (parent !== undefined && parent !== null && typeof parent !== "string") {
    throw new Error("invalid OpenCode session parent id");
  }
  const parentId = optionalString(parent);
  return { kind, id, directory, title: info.title, ...(parentId ? { parentId } : {}) };
}

export function configurationFromRecord(value: RecordValue): ConversationConfiguration | undefined {
  const modelRecord = record(value.model);
  const providerId = optionalString(value.providerID ?? value.providerId) ?? optionalString(modelRecord.providerID ?? modelRecord.providerId);
  const modelId = optionalString(value.modelID ?? value.modelId) ?? optionalString(modelRecord.id ?? modelRecord.modelID ?? modelRecord.modelId);
  const model = providerId && modelId ? { providerId, modelId } : undefined;
  const mode = optionalString(value.agent ?? value.mode);
  const reportedVariant = model ? optionalString(value.variant ?? modelRecord.variant) : undefined;
  const variant = reportedVariant === "default" ? undefined : reportedVariant;
  if (!model && !mode) return undefined;
  return { ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(variant ? { variant } : {}) };
}

/**
 * The `usage:<messageId>` carrier: what a message spent, as an item of its
 * own. Empty markdown is the signal that it carries no text — the renderer
 * draws no bubble for it, and `mergeAssistantMessage` (usage.ts), the one
 * merge both the server and client projections apply, keeps the earlier
 * timestamp rather than resorting the timeline as the figure is restated.
 */
export function usageUpsert(itemId: string, createdAt: number, usage: TokenUsage, model?: { providerId: string; modelId: string }, agent?: string): NormalizedProviderUpdate {
  return { kind: "upsert", item: { id: itemId, type: "assistant_message", createdAt, markdown: "", usage, ...(model ? { model } : {}), ...(agent ? { agent } : {}) } };
}

// V2 user messages echo `files: [{uri, mime, name}]` with the `file:` uri we
// sent verbatim (verified against a live OpenCode 1.18 server; the classic
// parts view does NOT preserve it — see normalizeStoredMessage). The uri
// basename is the issued attachment id (design D5), which the client turns
// into the workspace's serve-route URL. An entry whose uri does not parse to
// an issued-id shape becomes an id-less placeholder reference.
export function normalizeUserAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const file = record(entry);
    // Same contract rule as the stored path: only the four image types the
    // wire schema admits become attachment references.
    const mimeType = contractImageMime(optionalString(file.mime));
    if (mimeType === null) return [];
    const id = attachmentIdFromFileUri(optionalString(file.uri) ?? "");
    return [{
      ...(id ? { id } : {}),
      name: boundReplayedName(optionalString(file.name) ?? "attachment"),
      mimeType,
    }];
  }).slice(0, CHAT_ATTACHMENTS_PER_MESSAGE);
}

// The response contract bounds attachment names to 200 characters; provider
// history is under no such obligation, so replayed names are truncated (by
// code point, matching JSON Schema maxLength) rather than emitted verbatim
// for strict consumers to reject.
export function boundReplayedName(name: string): string {
  const points = [...name];
  return points.length <= 200 ? name : points.slice(0, 200).join("");
}

export function contractImageMime(mime: string | undefined): string | null {
  const normalized = mime?.toLowerCase();
  return normalized !== undefined && (CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(normalized) ? normalized : null;
}

function normalizeStoredMessage(info: RecordValue, parts: unknown[], mintUsageCarrier: boolean): ConversationItem[] {
  const id = string(info.id, "message id");
  const createdAt = timestamp(record(info.time).created, 0);
  if (info.role === "user") {
    const records = parts.map(part => record(part));
    // Synthetic text parts are OpenCode's own captions addressed to the model
    // (e.g. "Called the Read tool with {filePath: ...}" beside an attachment)
    // — never words the user typed, so they stay out of the bubble.
    const body = records.filter(part => part.type === "text" && part.synthetic !== true).map(part => text(part.text)).join("");
    // The durable store rewrites file parts to inline data: URLs, losing the
    // issued id — but each attachment's synthetic caption carries the stored
    // path, whose basename IS the id (verified against a live session's
    // store). Captions pair with file parts in order; an unpaired file part
    // stays an id-less placeholder. Bytes are never passed through either
    // way: projections carry references, not image payloads.
    // Slots stay aligned, nulls included: one caption per file part, in
    // order. Compacting away an unparseable caption would shift a later
    // caption's id onto an earlier file — showing the wrong stored image is
    // strictly worse than the spec'd placeholder.
    const fileParts = records.filter(part => part.type === "file");
    const parsedCaptions = records
      .filter(part => part.type === "text" && part.synthetic === true)
      .map(part => attachmentIdFromText(text(part.text)));
    // Positional pairing is only trustworthy when one caption exists per
    // file part. Any other cardinality means a caption is missing outright,
    // and assigning the remainder by position could put a later id on an
    // earlier file — the wrong stored image, strictly worse than the
    // placeholder every unproven slot degrades to.
    const captionSlots = parsedCaptions.length === fileParts.length ? parsedCaptions : [];
    const attachments: MessageAttachment[] = fileParts.flatMap((part, index) => {
      // The wire contract admits exactly the four image types; a
      // pre-existing conversation's other files (a text attachment from the
      // OpenCode TUI, a mime-less part) stay out of the attachments field
      // rather than violating every strict consumer of revision 8.
      const mimeType = contractImageMime(optionalString(part.mime));
      if (mimeType === null) return [];
      const recovered = attachmentIdFromFileUri(optionalString(part.url) ?? "") ?? captionSlots[index] ?? undefined;
      return [{
        ...(recovered ? { id: recovered } : {}),
        name: boundReplayedName(optionalString(part.filename) ?? "attachment"),
        mimeType,
      }];
    // The response contract caps attachments at eight per message; provider
    // history is under no such bound, so the excess is dropped rather than
    // emitted for strict consumers to reject.
    }).slice(0, CHAT_ATTACHMENTS_PER_MESSAGE);
    return [{ id: `message:${id}`, type: "user_message", createdAt, text: body, ...(attachments.length ? { attachments } : {}) }];
  }
  if (info.role === "assistant") {
    return normalizeAssistant({ content: parts, error: info.error, snapshot: info.snapshot, tokens: info.tokens, cost: info.cost, modelID: info.modelID ?? info.modelId, providerID: info.providerID ?? info.providerId, model: info.model, agent: info.agent ?? info.mode }, id, createdAt, mintUsageCarrier);
  }
  return [];
}

export function normalizeAssistant(message: RecordValue, messageId: string, createdAt: number, mintUsageCarrier: boolean): ConversationItem[] {
  const items = array(message.content).flatMap(value => normalizePart(record(value), createdAt)).flatMap(update => {
    if (update.kind === "upsert") return [update.item];
    if (update.kind === "text" && update.item) return [update.item];
    return [];
  });
  // What the turn spent, on the message's own carrier — the same item id the
  // live path uses, so a conversation reads back exactly as it streamed. This
  // is the authoritative path: it populates the readout on opening a
  // conversation, before any new turn is taken. Never attached to a text
  // part: a message can emit several, and a per-part figure is one message's
  // spend claimed by two items.
  const usage = tokensToUsage(message.tokens, message.cost);
  if (usage && mintUsageCarrier) {
    const model = messageModelSelection(message);
    const agent = messageAgent(message);
    items.push({ id: `usage:${messageId}`, type: "assistant_message", createdAt, markdown: "", usage, ...(model ? { model } : {}), ...(agent ? { agent } : {}) });
  }
  const error = errorMessage(message.error);
  if (error) items.push({ id: `notice:${messageId}:error`, type: "notice", createdAt, level: "error", message: error });
  for (const path of stringArray(record(message.snapshot).files)) {
    items.push({ id: `file:${messageId}:${path}`, type: "file_change", createdAt, path, operation: "update" });
  }
  return items;
}

export function normalizePart(part: RecordValue, createdAt: number): NormalizedProviderUpdate[] {
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

export function normalizeToolPart(part: RecordValue, createdAt: number): NormalizedProviderUpdate {
  const state = record(part.state);
  // Classic parts keep the terminal time on state; v2 keeps it on the part.
  // A stray end time on pending/running state is not a completion signal.
  const completed = state.status === "completed" || state.status === "error"
    ? completionTime(finishedTime(state.time) ?? finishedTime(part.time)) : {};
  const metadata = record(state.metadata);
  const name = text(part.name ?? part.tool) || "tool";
  const id = optionalString(part.id) ?? optionalString(part.callID) ?? name;
  const input = typeof state.input === "string" ? state.input : json(state.input);
  const output = toolContent(state.content)
    ?? (typeof state.output === "string" ? state.output : undefined)
    ?? (typeof metadata.output === "string" ? metadata.output : undefined)
    ?? json(state.result);
  const error = errorMessage(state.error);
  if (isCommand(name, state)) {
    const exitCode = number(metadata.exit) ?? number(metadata.exitCode);
    const status = activityStatus(state.status);
    return { kind: "upsert", item: {
      id: `tool:${id}`,
      type: "command",
      createdAt,
      command: commandText(state),
      ...completed,
      status: exitCode !== undefined && exitCode !== 0 ? "failed" : status,
      output,
      exitCode,
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
    ...completed,
    input,
    output,
    error,
    ...(childConversationId === undefined ? {} : { childConversationId }),
  } };
}

function normalizeToolEvent(type: string, data: RecordValue, conversationId: string | undefined, eventId: string, createdAt: number): KnownEvent {
  const callId = optionalString(data.callID) ?? eventId;
  const state = {
    status: type.endsWith("success") ? "completed" : type.endsWith("failed") ? "error" : "running",
    input: data.input,
    content: data.content,
    output: data.output,
    result: data.result,
    error: data.error,
    metadata: data.metadata,
    time: { end: data.timestamp },
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

export function textUpdate(data: RecordValue, fallbackId: string, createdAt: number, mode: "cumulative" | "incremental", value: string): KnownEvent {
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
    allowFreeForm: question.custom !== false,
  };
}

export function permissionOutcome(value: unknown): "approved-once" | "approved-session" | "rejected" {
  return value === "once" ? "approved-once" : value === "always" ? "approved-session" : "rejected";
}

// What a pending permission carries, read from either generation's field
// names (v2: action/resources/save; the classic bridge: permission/patterns/
// always). One reader for the live events and the pending list, so a field
// cannot land on one path and not the other. `alwaysPatterns` is what an
// "always" reply installs; missing on both spellings is an empty list, since
// OpenCode installs nothing then and the card should say so rather than guess.
// Empty strings are dropped: the client validator refuses them, and a
// server item the client cannot parse would loop the stream through resync.
export function pendingPermissionFields(data: RecordValue): { action: string; resources: string[]; alwaysPatterns: string[]; diff?: string } {
  return {
    action: text(data.action ?? data.permission),
    resources: stringArray(data.resources ?? data.patterns).filter(Boolean),
    alwaysPatterns: stringArray(data.always ?? data.save).filter(Boolean),
    ...permissionDiff(data),
  };
}

// The change a file-edit permission would apply, when the agent attaches one.
// OpenCode puts a unified diff on the permission's `metadata.diff` — the same
// string its own edit-tool renderer reads. A permission with none (a command,
// a fetch) yields nothing to spread. Exported because the pending-permission
// recovery list carries the same metadata: a card rebuilt after a missed
// event must show the same change the live announcement would have.
export function permissionDiff(data: RecordValue): { diff?: string } {
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

export function errorMessage(value: unknown): string | undefined {
  const error = record(value);
  return optionalString(error.message) ?? optionalString(record(error.data).message);
}

/**
 * The two OpenCode stores mark completion differently: the v2 store sets
 * `time.completed`, the classic store sets `time.end`. Reading only one leaves
 * replayed history claiming it is still running.
 */
export function isFinishedTime(value: unknown): boolean {
  return finishedTime(value) !== undefined;
}

export function finishedTime(value: unknown): number | undefined {
  const time = record(value);
  return completionTime(time.completed).completedAt ?? completionTime(time.end).completedAt;
}

export function completionTime(value: unknown): { completedAt?: number } {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? { completedAt: value } : {};
}

export function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`invalid OpenCode ${field}`);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringArray(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}

export function json(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
