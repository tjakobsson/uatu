import path from "node:path";

import {
  type CanonicalEvent,
  type EventContext,
  type GenerationMapper,
  type KnownEvent,
  type NormalizedProviderEvent,
  type NormalizedProviderUpdate,
  type ProviderEventMemory,
  type RecordValue,
  array,
  createProviderEventMemory,
  errorMessage,
  normalizeCanonicalEvent,
  normalizeEventWith,
  normalizeToolPart,
  number,
  optionalString,
  record,
  remember,
  string,
  stringArray,
  text,
  timestamp,
  tokensToUsage,
  usageUpsert, compactionNoticeId } from "../normalization";
import type { ConversationItem, StructuredQuestion, TokenUsage } from "../../types";

export type { NormalizedProviderEvent };

/**
 * The OpenCode 2.x mapper over the shared normalization core.
 *
 * 2.x's session vocabulary is the canonical one, so most events pass through
 * with their payload reshaped onto the canonical field names (part identity
 * is `<assistantMessageID>:<kind>:<ordinal>`, a tool's call id is `data.id`, a
 * shell's fields sit under `data.shell`). What 2.x alone announces is handled
 * here: the `session.execution.*` turn lifecycle, the inbox (where a prompt
 * becomes a user message), per-step usage on `session.step.ended` (the
 * per-message figure the cost receipt keys on — `session.usage.updated` is
 * the session's running total and is deliberately not a second carrier),
 * `form.*` presented as structured questions, and content restatements.
 *
 * Every event carrying a `location` for another directory yields nothing:
 * one 2.x server serves every directory of one database, and the workspace
 * owns only its own.
 */
export type OpenCodeV2Memory = ProviderEventMemory & {
  // Tool name by call id: `session.tool.called` carries no name, only the
  // preceding `session.tool.input.started` does.
  toolNames: Map<string, string>;
  // The step that produced an assistant message, for the usage carrier's
  // model and agent and for attributing the message on its parent's row.
  steps: Map<string, { agent?: string; model?: { providerId: string; modelId: string }; startedAt: number }>;
  // A form's field keys in order, so an answer map folds back to the ordered
  // answers the seam speaks.
  forms: Map<string, string[]>;
  // The message of a session's failed step, so the turn's own failure event,
  // which repeats it, adds no second notice.
  failures: Map<string, string>;
};

export function createOpenCodeV2Memory(): OpenCodeV2Memory {
  return { ...createProviderEventMemory(), toolNames: new Map(), steps: new Map(), forms: new Map(), failures: new Map() };
}

// 2.x wire types recognized as deliberately carrying nothing for the
// timeline, beyond the core's canonical list.
const IGNORED: ReadonlySet<string> = new Set([
  "session.inbox.delivered",
  "session.inbox.delivery.changed",
  "session.instructions.updated",
  "session.step.streamed",
  // The session's running total; per-message figures ride `session.step.ended`.
  "session.usage.updated",
  "session.usage.recorded",
  "session.viewed",
  "session.permissions",
  "shell.created",
  "shell.exited",
  "shell.deleted",
  "filesystem.changed",
  "agent.updated",
  "model.updated",
  "provider.updated",
  "command.updated",
  "skill.updated",
  "websearch.updated",
  "plugin.updated",
  "config.updated",
  "credential.updated",
  "credential.switched",
  "mcp.status.changed",
  "mcp.resources.changed",
  "worktree.updated",
  "worktree.resolved",
  "persistent-pty.added",
  "persistent-pty.removed",
  "location.shutdown",
  "models-dev.refreshed",
  "installation.update-available",
  "log.synced",
]);

export function createOpenCodeV2Mapper(directory: string): GenerationMapper<OpenCodeV2Memory> {
  const workspace = path.resolve(directory);
  const foreign = (event: RecordValue): boolean => {
    const location = optionalString(record(event.location).directory);
    return location !== undefined && path.resolve(location) !== workspace;
  };

  function toCanonical(type: string, data: RecordValue, event: RecordValue): CanonicalEvent | undefined {
    if (foreign(event)) return undefined;
    const created = number(event.created);
    const stamped: RecordValue = created === undefined ? { ...data } : { ...data, timestamp: created };
    switch (type) {
      case "session.created":
        return { type, data: { ...stamped, info: {
          id: string(data.sessionID, "session id"),
          title: text(data.title),
          directory: optionalString(record(data.location).directory) ?? optionalString(record(event.location).directory) ?? workspace,
          parentID: data.parentID,
        } } };
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
        return { type, data: { ...stamped, textID: partIdentity(data, "text") } };
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended":
        return { type, data: { ...stamped, reasoningID: partIdentity(data, "reasoning") } };
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed":
        // The name is filled in by `own` from memory before this runs; a
        // reshape without one is the memoryless fallback.
        return { type, data: { ...stamped, callID: string(data.id, "tool call id"), tool: optionalString(data.tool) ?? "tool" } };
      case "session.shell.started":
      case "session.shell.ended": {
        const shell = record(data.shell);
        return { type, data: {
          sessionID: data.sessionID,
          callID: string(shell.id, "shell id"),
          command: text(shell.command),
          output: optionalString(record(data.output).output),
          exitCode: number(shell.exit),
          timestamp: number(record(shell.time).completed) ?? created,
        } };
      }
      case "session.compaction.ended":
        return { type, data: { ...stamped, summary: data.text } };
      default:
        return type.startsWith("session.") || type.startsWith("permission.") ? { type, data: stamped } : undefined;
    }
  }

  function own(event: RecordValue, data: RecordValue, context: EventContext, memory?: OpenCodeV2Memory): KnownEvent | undefined {
    if (foreign(event)) return { updates: [] };
    const { conversationId, eventId } = context;
    const createdAt = number(event.created) ?? context.createdAt;
    switch (event.type) {
      case "session.renamed": {
        // Only the id and the title travel. Passed to the core as a full
        // `session.updated`, the missing parent would read as "top-level"
        // and a renamed child would lose its attribution; flagged sparse,
        // the adapter keeps the parent it knows.
        const id = string(data.sessionID, "session id");
        return { conversationId: conversationId ?? id, updates: [], sessionLifecycle: {
          kind: "updated",
          id,
          directory: optionalString(record(event.location).directory) ?? workspace,
          title: text(data.title),
          sparse: true,
        } };
      }
      case "session.deleted": {
        // Only the id travels, and never a location: a deletion in another
        // directory on a shared server reads the same as one here. Flagged
        // sparse, the adapter acts on it only for a session it already
        // listed, instead of taking the workspace label on trust.
        const id = string(data.sessionID, "session id");
        return { conversationId: conversationId ?? id, updates: [], sessionLifecycle: { kind: "deleted", id, directory: workspace, title: "", sparse: true } };
      }
      case "session.inbox.enqueued": {
        const item = record(data.item);
        const payload = record(item.payload);
        const messageId = string(data.inboxID, "inbox id");
        if (item.type === "user") {
          const sessionId = conversationId;
          if (memory) {
            remember(memory.roles, messageId, "user");
            if (sessionId) remember(memory.prompts, sessionId, messageId);
          }
          return { conversationId, updates: [{ kind: "upsert", item: {
            id: `message:${messageId}`,
            type: "user_message",
            createdAt,
            text: text(payload.text),
            requestId: messageId,
          } }] };
        }
        if (item.type === "synthetic") {
          // A shell command's transcript is delivered to the model as a
          // synthetic note; the command item already shows it.
          if (optionalString(record(payload.metadata).source) === "shell") return { conversationId, updates: [] };
          return { conversationId, updates: [{ kind: "upsert", item: {
            id: `notice:${messageId}`,
            type: "notice",
            createdAt,
            level: "info",
            message: text(payload.text) || "Context updated",
          } }] };
        }
        return { conversationId, updates: [] };
      }
      case "session.execution.started":
        if (memory && conversationId) memory.failures.delete(conversationId);
        return { conversationId, updates: [{ kind: "status", status: "running" }] };
      case "session.execution.succeeded":
        return { conversationId, updates: [{ kind: "status", status: "completed" }] };
      case "session.execution.interrupted":
        return { conversationId, updates: [{ kind: "status", status: "interrupted" }] };
      case "session.execution.failed": {
        const message = errorMessage(data.error) || "The turn failed";
        // A step that failed has already shown this message on its own
        // event; the turn's end repeats it. One red row, not two.
        const reported = memory && conversationId ? memory.failures.get(conversationId) : undefined;
        if (memory && conversationId) memory.failures.delete(conversationId);
        if (reported === message) return { conversationId, updates: [{ kind: "status", status: "failed", message }] };
        return { conversationId, updates: [
          { kind: "upsert", item: { id: `notice:${eventId}`, type: "notice", createdAt, level: "error", message } },
          { kind: "status", status: "failed", message },
        ] };
      }
      case "session.step.started": {
        const messageId = string(data.assistantMessageID, "assistant message id");
        const model = record(data.model);
        const selection = optionalString(model.providerID) && optionalString(model.id)
          ? { providerId: model.providerID as string, modelId: model.id as string }
          : undefined;
        const startedAt = timestamp(data.started, createdAt);
        if (memory) remember(memory.steps, messageId, { agent: optionalString(data.agent), model: selection, startedAt });
        const promptId = conversationId ? memory?.prompts.get(conversationId) : undefined;
        return {
          conversationId,
          updates: [],
          ...(selection ? { assistantModel: { messageId, model: selection.modelId, createdAt: startedAt, ...(promptId === undefined ? {} : { promptId }) } } : {}),
        };
      }
      case "session.step.ended":
      case "session.step.failed": {
        const messageId = string(data.assistantMessageID, "assistant message id");
        // A Stop reaches the wire as `session.step.failed` with an `aborted`
        // error, followed by `session.execution.interrupted`. The interrupt
        // is the turn's end; the step carries no failure to show, only the
        // tokens it spent.
        const aborted = event.type === "session.step.failed" && record(data.error).type === "aborted";
        if (event.type === "session.step.failed" && !aborted && memory && conversationId) {
          memory.failures.set(conversationId, errorMessage(data.error) || text(data.message) || "The turn failed");
        }
        const canonical = (aborted ? undefined : normalizeCanonicalEvent(String(event.type), {
          ...data,
          messageID: messageId,
          timestamp: createdAt,
        }, { ...context, createdAt })) ?? { conversationId, updates: [] };
        const usage = tokensToUsage(data.tokens, data.cost);
        if (!usage) return canonical;
        const step = memory?.steps.get(messageId);
        const promptId = conversationId ? memory?.prompts.get(conversationId) : undefined;
        const reported: { messageId: string; usage: TokenUsage; promptId?: string } = { messageId, usage, ...(promptId === undefined ? {} : { promptId }) };
        return {
          ...canonical,
          updates: [...canonical.updates, usageUpsert(`usage:${messageId}`, step?.startedAt ?? createdAt, usage, step?.model, step?.agent)],
          assistantUsage: reported,
        };
      }
      case "session.tool.input.started": {
        const callId = optionalString(data.id);
        const name = optionalString(data.name);
        if (memory && callId && name) remember(memory.toolNames, callId, name);
        return { conversationId, updates: [] };
      }
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed": {
        const callId = optionalString(data.id);
        const name = callId ? memory?.toolNames.get(callId) : undefined;
        if (!name) return undefined;
        const canonical = toCanonical(String(event.type), { ...data, tool: name }, event);
        return canonical ? normalizeCanonicalEvent(canonical.type, canonical.data, { ...context, createdAt }) : undefined;
      }
      case "session.compaction.failed":
        // The same row the started phase opened, so the failure replaces
        // the "Compacting…" marker rather than joining it.
        return { conversationId, updates: [{ kind: "upsert", item: {
          id: compactionNoticeId(data, eventId),
          type: "notice",
          createdAt,
          level: "warning",
          message: `Compaction failed: ${errorMessage(data.error) ?? "unknown error"}`,
        } }] };
      case "session.message.content.updated": {
        const messageId = string(data.messageID, "message id");
        const skippedBlocks: string[] = [];
        const updates = assistantContentUpdates(messageId, array(data.content), createdAt, skippedBlocks);
        return { conversationId, updates, ...(skippedBlocks.length ? { skippedBlocks } : {}) };
      }
      case "form.created": {
        const form = record(data.form);
        const requestId = string(form.id, "form id");
        if (memory) remember(memory.forms, requestId, supportedFormFields(form.fields).map(field => text(field.key)));
        const intro = optionalString(form.title);
        const presentation = formPresentation(form);
        return { conversationId: conversationId ?? optionalString(form.sessionID), updates: [{ kind: "upsert", item: {
          id: `question:${requestId}`,
          type: "question",
          createdAt,
          conversationId: conversationId ?? optionalString(form.sessionID),
          requestId,
          questions: presentation.questions,
          status: "pending",
          ...(intro ? { intro } : {}),
          ...(presentation.link ? { link: presentation.link } : {}),
        } }] };
      }
      case "form.replied":
      case "form.cancelled": {
        const requestId = string(data.id, "form id");
        const answer = record(data.answer);
        const keys = memory?.forms.get(requestId) ?? Object.keys(answer);
        return { conversationId, updates: [{ kind: "upsert", item: {
          id: `question:${requestId}`,
          type: "question",
          createdAt,
          conversationId,
          requestId,
          questions: [],
          status: "resolved",
          outcome: event.type === "form.cancelled"
            ? { kind: "rejected" }
            : { kind: "answered", answers: keys.map(key => answerValues(answer[key])) },
        } }] };
      }
      default:
        return undefined;
    }
  }

  return { own, toCanonical, ignored: IGNORED };
}

// Streamed parts are identified by their message, kind, and per-kind
// ordinal: OpenCode numbers text and reasoning independently, so one message
// has a text 0 and a reasoning 0, and an identity without the kind would
// fold both into one reconciler entry. The same identity is minted for a
// content restatement, so the two merge.
function partIdentity(data: RecordValue, kind: "text" | "reasoning"): string {
  return `${string(data.assistantMessageID, "assistant message id")}:${kind}:${timestamp(data.ordinal, 0)}`;
}

/**
 * An assistant message's content as the core's part updates: text and
 * reasoning under the streamed identities (so a restatement deduplicates
 * against what already streamed), tools through the shared tool-part reader.
 * Used by the live `session.message.content.updated` path and by the stored
 * assistant record, which is the same array. A part of any other type is
 * skipped; its type lands in `skipped` when the caller reports skips.
 */
export function assistantContentUpdates(messageId: string, content: unknown[], createdAt: number, skipped?: string[]): NormalizedProviderUpdate[] {
  const ordinals = { text: 0, reasoning: 0 };
  return content.flatMap((value): NormalizedProviderUpdate[] => {
    const part = record(value);
    if (part.type === "text") {
      const identity = `${messageId}:text:${ordinals.text++}`;
      const itemId = `part:${identity}`;
      const item: ConversationItem = { id: itemId, type: "assistant_message", createdAt, markdown: text(part.text) };
      return [{ kind: "text", itemId, identity, mode: "cumulative", text: text(part.text), item }];
    }
    if (part.type === "reasoning") {
      const identity = `${messageId}:reasoning:${ordinals.reasoning++}`;
      const time = record(part.time);
      const started = number(time.created);
      const completed = number(time.completed);
      const durationMs = started !== undefined && completed !== undefined && completed >= started ? completed - started : undefined;
      const item: ConversationItem = {
        id: `reasoning:${identity}`,
        type: "reasoning",
        createdAt,
        text: text(part.text),
        status: completed === undefined ? "running" : "completed",
        ...(durationMs === undefined ? {} : { durationMs }),
      };
      return [{ kind: "text", itemId: item.id, identity, mode: "cumulative", text: text(part.text), item }];
    }
    if (part.type === "tool") {
      const time = record(part.time);
      return [normalizeToolPart({
        id: part.id,
        type: "tool",
        name: part.name,
        state: part.state,
        time: { end: time.completed },
      }, createdAt)];
    }
    skipped?.push(optionalString(part.type) ?? "unknown");
    return [];
  });
}

/**
 * One 2.x form field as one structured question. A field with options is a
 * choice (its `custom` flag is the free-form allowance, on unless the field
 * says otherwise — the same rule 1.x's `custom` follows); a `multiselect` is
 * a multiple choice; a boolean is a Yes/No choice; a string without options,
 * a number, or an integer is a free-form answer, validated by the provider
 * before the reply.
 */
/**
 * The fields a form is presented with. An `external` field is answered on
 * another surface (its `url`), a conditional one (`when`) depends on answers
 * the card cannot evaluate, and a hidden one is the provider's to fill; none
 * is a question for the user. One filter for the live event, the recovered
 * list, and the answer fold, so the ordered answers line up with the
 * questions that were asked.
 */
export function supportedFormFields(value: unknown): RecordValue[] {
  return array(value).map(field => record(field)).filter(field =>
    field.type !== "external" && field.hidden !== true && array(field.when).length === 0);
}

export const UNSUPPORTED_FORM_CANCEL = "Cancel this form";

/**
 * What a form's card shows. With supported fields, one question per field.
 * With none (a sign-in on another page, conditional or provider-filled
 * fields only) the card still appears, because the agent is waiting on it
 * and a card is the one place the user can see that; its single option
 * cancels the form so the turn continues, and the external field's URL rides
 * as the link. Completing the form in OpenCode clears the card on its own.
 * A card must carry at least one question: the client refuses an empty
 * list, and a refused item fails the whole conversation load.
 */
export function formPresentation(form: RecordValue): { questions: StructuredQuestion[]; link?: string } {
  const fields = supportedFormFields(form.fields);
  if (fields.length > 0) return { questions: fields.map(formFieldToQuestion) };
  const external = array(form.fields).map(field => record(field)).find(field => field.type === "external");
  const url = optionalString(external?.url);
  const link = url && /^https?:\/\//i.test(url) ? url : undefined;
  return {
    questions: [{
      prompt: "This form can't be completed here",
      header: link ? "Complete it at the link, or cancel it so the agent continues" : "Complete it in OpenCode, or cancel it so the agent continues",
      options: [{ label: UNSUPPORTED_FORM_CANCEL, description: "The agent continues without it" }],
      multiple: false,
      allowFreeForm: false,
    }],
    ...(link ? { link } : {}),
  };
}

export function formFieldToQuestion(field: RecordValue): StructuredQuestion {
  const key = text(field.key);
  const prompt = optionalString(field.title) ?? key;
  const header = optionalString(field.description) ?? "";
  const options = array(field.options).map(option => {
    const item = record(option);
    return { label: optionalString(item.label) ?? text(item.value), description: text(item.description) };
  });
  const required = field.required === true;
  switch (field.type) {
    case "multiselect": {
      // The count the form will accept, on the card: the reply is refused
      // before dispatch when it is missed, so the user must be able to see it.
      const hint = selectionCountHint(number(field.minItems), number(field.maxItems));
      return { prompt, header: hint ? (header ? `${header}. ${hint}` : hint) : header, options, multiple: true, allowFreeForm: field.custom === true, ...(required ? {} : { optional: true }) };
    }
    case "boolean":
      return { prompt, header, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiple: false, allowFreeForm: false, ...(required ? {} : { optional: true }) };
    case "number":
    case "integer": {
      // The accepted range, on the card, for the same reason as the count
      // above: the reply is refused before dispatch when it falls outside.
      const kind = field.type === "integer" ? "Whole number" : "Number";
      const range = numberRangeHint(number(field.minimum), number(field.maximum));
      const typed = range ? `${kind} ${range}` : kind;
      return { prompt, header: header ? (range ? `${header}. ${typed}` : header) : typed, options: [], multiple: false, allowFreeForm: true, ...(required ? {} : { optional: true }) };
    }
    default:
      return options.length > 0
        ? { prompt, header, options, multiple: false, allowFreeForm: field.custom !== false, ...(required ? {} : { optional: true }) }
        : { prompt, header, options: [], multiple: false, allowFreeForm: true, ...(required ? {} : { optional: true }) };
  }
}

export function selectionCountHint(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return min === max ? `Choose ${min}` : `Choose ${min} to ${max}`;
  if (min !== undefined) return `Choose at least ${min}`;
  if (max !== undefined) return `Choose up to ${max}`;
  return "";
}

export function numberRangeHint(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `from ${min} to ${max}`;
  if (min !== undefined) return `of at least ${min}`;
  if (max !== undefined) return `of at most ${max}`;
  return "";
}

function answerValues(value: unknown): string[] {
  if (Array.isArray(value)) return stringArray(value);
  if (value === undefined || value === null) return [];
  return [typeof value === "string" ? value : String(value)];
}

// Public boundary for a 2.x event stream, scoped to one workspace directory.
export function createOpenCodeV2Normalizer(directory: string): (value: unknown, memory?: OpenCodeV2Memory) => NormalizedProviderEvent {
  const mapper = createOpenCodeV2Mapper(directory);
  return (value, memory) => normalizeEventWith(value, mapper, memory);
}

// ---------------------------------------------------------------------------
// Stored 2.x message records (`message.list`), for history and accounting.

import { attachmentIdFromFileUri } from "../../attachment-store";
import { CHAT_ATTACHMENTS_PER_MESSAGE, type MessageAttachment } from "../../types";
import type { StoredMessageAccounting } from "../../provider";
import { boundReplayedName, contractImageMime, errorMessage as storedErrorMessage } from "../normalization";

/**
 * One stored 2.x message as timeline items. Assistant content goes through
 * the same reader the live restatement uses, so a conversation reads back
 * exactly as it streamed; the message's own usage rides its `usage:<id>`
 * carrier, as on 1.x. Idle markers and agent/model/location switches carry
 * nothing for the timeline.
 */
export function normalizeStoredMessage(value: unknown, mintUsageCarrier = true): ConversationItem[] {
  const message = record(value);
  const id = string(message.id, "message id");
  const createdAt = timestamp(record(message.time).created, 0);
  switch (message.type) {
    case "user": {
      const attachments = storedAttachments(message.files);
      return [{ id: `message:${id}`, type: "user_message", createdAt, text: text(message.text), ...(attachments.length ? { attachments } : {}) }];
    }
    case "assistant": {
      const items = assistantContentUpdates(id, array(message.content), createdAt).flatMap(update => {
        if (update.kind === "upsert") return [update.item];
        if (update.kind === "text" && update.item) return [update.item];
        return [];
      });
      const usage = tokensToUsage(message.tokens, message.cost);
      if (usage && mintUsageCarrier) {
        const model = modelSelection(message.model);
        const agent = optionalString(message.agent);
        items.push({ id: `usage:${id}`, type: "assistant_message", createdAt, markdown: "", usage, ...(model ? { model } : {}), ...(agent ? { agent } : {}) });
      }
      // A Stop is stored as an `aborted` error on the record; live, that
      // step is an interruption and not a failure, and a reload must not
      // turn it into one.
      const error = record(message.error).type === "aborted" ? undefined : storedErrorMessage(message.error);
      if (error) items.push({ id: `notice:${id}:error`, type: "notice", createdAt, level: "error", message: error });
      for (const file of stringArray(record(message.snapshot).files)) {
        items.push({ id: `file:${id}:${file}`, type: "file_change", createdAt, path: file, operation: "update" });
      }
      return items;
    }
    case "shell": {
      const exit = number(message.exit);
      const completed = number(record(message.time).completed);
      const finished = message.status !== "running";
      return [{
        id: `command:${optionalString(message.shellID) ?? id}`,
        type: "command",
        createdAt,
        command: text(message.command),
        output: optionalString(record(message.output).output),
        exitCode: exit,
        status: !finished ? "running" : exit === undefined || exit === 0 ? "completed" : "failed",
        ...(completed === undefined ? {} : { completedAt: completed }),
      }];
    }
    case "synthetic":
      // A shell transcript's note to the model is already the command item.
      if (optionalString(record(message.metadata).source) === "shell") return [];
      return [{ id: `notice:${id}`, type: "notice", createdAt, level: "info", message: text(message.text) || "synthetic" }];
    case "system":
      // Provider-owned context with no live counterpart: showing it on a
      // reload would change the transcript and expose the agent's own
      // instructions. Silent, per the history design.
      return [];
    case "compaction":
      if (message.status === "failed") return [{ id: `notice:${id}`, type: "notice", createdAt, level: "warning", message: `Compaction failed: ${storedErrorMessage(message.error) ?? "unknown error"}` }];
      return [{ id: `notice:${id}`, type: "notice", createdAt, level: "info", message: text(message.summary) || (message.status === "running" ? "Compacting conversation context…" : "Conversation context compacted. Earlier turns are summarized.") }];
    default:
      return [];
  }
}

/** A stored assistant record's own accounting; nothing for any other kind. */
export function storedAccounting(value: unknown): StoredMessageAccounting | undefined {
  const message = record(value);
  const messageId = optionalString(message.id);
  if (!messageId || message.type !== "assistant") return undefined;
  const usage = tokensToUsage(message.tokens, message.cost);
  const model = optionalString(record(message.model).id);
  if (usage === undefined && model === undefined) return undefined;
  return { messageId, createdAt: timestamp(record(message.time).created, 0), ...(usage === undefined ? {} : { usage }), ...(model === undefined ? {} : { model }) };
}

/** The id of a stored user record, or nothing: the prompt later assistant records answer. */
export function storedPromptId(value: unknown): string | undefined {
  const message = record(value);
  return message.type === "user" ? optionalString(message.id) : undefined;
}

export function modelSelection(value: unknown): { providerId: string; modelId: string } | undefined {
  const model = record(value);
  const providerId = optionalString(model.providerID);
  const modelId = optionalString(model.id);
  return providerId && modelId ? { providerId, modelId } : undefined;
}

// A stored user record echoes each attachment as `{ data, mime, source, name }`
// where `source` is the `file:` uri we sent, whose basename is the issued
// attachment id. Only the wire contract's image types become references;
// an entry without a recoverable id is an id-less placeholder.
function storedAttachments(value: unknown): MessageAttachment[] {
  return array(value).flatMap((entry): MessageAttachment[] => {
    const file = record(entry);
    const mimeType = contractImageMime(optionalString(file.mime));
    if (mimeType === null) return [];
    const source = record(file.source);
    const id = source.type === "uri" ? attachmentIdFromFileUri(optionalString(source.uri) ?? "") : undefined;
    return [{ ...(id ? { id } : {}), name: boundReplayedName(optionalString(file.name) ?? "attachment"), mimeType }];
  }).slice(0, CHAT_ATTACHMENTS_PER_MESSAGE);
}
