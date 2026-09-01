import { TOKEN_USAGE_COMPONENTS } from "./usage";
import type {
  AgentChatStatus,
  ChatAgentDescriptor,
  ActivityStatus,
  ChatAgent,
  ChatMode,
  ChatAvailability,
  ChatCommand,
  ChatEvent,
  ChatModel,
  ChatStartupDiagnostics,
  ConversationConfiguration,
  ConversationInventoryEvent,
  ConversationItem,
  ConversationSnapshot,
  ConversationStatus,
  ConversationSummary,
  InteractionRequest,
  PermissionRequest,
  QueuedMessage,
  QuestionOutcome,
  QuestionRequest,
  ReversibleHistoryResult,
  ReversibleHistoryState,
  StructuredQuestion,
} from "./types";

const CONVERSATION_STATUSES = new Set<ConversationStatus>([
  "idle",
  "sending",
  "running",
  "completed",
  "interrupted",
  "failed",
]);
const ACTIVITY_STATUSES = new Set<ActivityStatus>(["pending", "running", "completed", "failed", "cancelled"]);

export function parseChatAvailability(value: unknown): ChatAvailability {
  const record = expectRecord(value, "chat availability");
  const state = expectString(record.state, "chat availability state");
  switch (state) {
    case "idle":
    case "starting":
      expectKeys(record, ["state"], "chat availability");
      break;
    case "ready":
      expectKeys(record, ["state", "version", "agent"], "chat availability");
      expectNonEmptyString(record.version, "version");
      // Optional: absent for the moment between the runtime reporting ready
      // and the adapter existing to describe the agent.
      if (record.agent !== undefined) parseChatAgent(record.agent);
      break;
    case "unavailable":
      expectKeys(record, ["state", "reason", "message", "diagnostics"], "chat availability");
      expectOneOf(record.reason, ["not-installed", "startup-failed", "unsupported"], "unavailable reason");
      expectNonEmptyString(record.message, "unavailable message");
      // Optional: present on a failed startup, absent when there is nothing to
      // report (a missing executable never reached a probe).
      if (record.diagnostics !== undefined) parseChatStartupDiagnostics(record.diagnostics);
      break;
    default:
      throw new Error(`invalid chat availability state: ${state}`);
  }
  return value as ChatAvailability;
}

function parseChatStartupDiagnostics(value: unknown): ChatStartupDiagnostics {
  const record = expectRecord(value, "chat startup diagnostics");
  expectKeys(record, [
    "executable",
    "shadowedExecutables",
    "version",
    "endpoint",
    "elapsedMs",
    "probes",
    "lastProbe",
    "stdout",
    "stderr",
  ], "chat startup diagnostics");
  expectNullableString(record.executable, "diagnostics executable");
  expectStringArray(record.shadowedExecutables, "diagnostics shadowed executables", false);
  expectNullableString(record.version, "diagnostics version");
  expectNullableString(record.endpoint, "diagnostics endpoint");
  expectTimestamp(record.elapsedMs, "diagnostics elapsed");
  expectTimestamp(record.probes, "diagnostics probe count");
  expectString(record.stdout, "diagnostics stdout");
  expectString(record.stderr, "diagnostics stderr");

  const probe = expectRecord(record.lastProbe, "diagnostics last probe");
  const kind = expectOneOf(
    probe.kind,
    ["none", "refused", "abandoned", "http-status", "unhealthy-body", "healthy", "unknown"],
    "probe outcome kind",
  );
  if (kind === "http-status" || kind === "unhealthy-body" || kind === "healthy") {
    expectKeys(probe, ["kind", "status"], "diagnostics last probe");
    expectTimestamp(probe.status, "probe status");
  } else if (kind === "unknown") {
    expectKeys(probe, ["kind", "error"], "diagnostics last probe");
    expectString(probe.error, "probe error");
  } else {
    expectKeys(probe, ["kind"], "diagnostics last probe");
  }
  return value as ChatStartupDiagnostics;
}

export function parseChatModel(value: unknown): ChatModel {
  const record = expectRecord(value, "chat model");
  expectKeys(record, ["selection", "provider", "name", "variants", "contextLimit", "imageInput", "detail", "default"], "chat model");
  expectModelSelection(record.selection);
  expectNonEmptyString(record.provider, "model provider");
  expectNonEmptyString(record.name, "model name");
  if (record.variants !== undefined) expectStringArray(record.variants, "model variants", true);
  if (record.contextLimit !== undefined && (typeof record.contextLimit !== "number" || record.contextLimit < 1)) throw new Error("model contextLimit must be a positive number");
  if (record.imageInput !== undefined && typeof record.imageInput !== "boolean") throw new Error("model imageInput must be a boolean");
  if (record.detail !== undefined) expectNonEmptyString(record.detail, "model detail");
  if (record.default !== undefined && typeof record.default !== "boolean") throw new Error("model default must be a boolean");
  return value as ChatModel;
}

// References only: an attachment on the wire is `{id?, name, mimeType}`, and
// anything byte-shaped (a url, a data field) is a contract violation.
export function parseMessageAttachments(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const entry of value) {
    const record = expectRecord(entry, field);
    expectKeys(record, ["id", "name", "mimeType"], field);
    if (record.id !== undefined) expectIdentity(record.id, `${field} id`);
    expectNonEmptyString(record.name, `${field} name`);
    expectNonEmptyString(record.mimeType, `${field} mimeType`);
  }
}

function expectModelSelection(value: unknown): void {
  const selection = expectRecord(value, "model selection");
  expectKeys(selection, ["providerId", "modelId"], "model selection");
  expectIdentity(selection.providerId, "provider id");
  expectIdentity(selection.modelId, "model id");
}

export function parseConversationConfiguration(value: unknown): ConversationConfiguration {
  const record = expectRecord(value, "conversation configuration");
  expectKeys(record, ["model", "mode", "variant"], "conversation configuration");
  if (record.model !== undefined) expectModelSelection(record.model);
  if (record.mode !== undefined) expectIdentity(record.mode, "configuration mode");
  if (record.variant !== undefined) {
    expectIdentity(record.variant, "configuration variant");
    if (record.model === undefined) throw new Error("configuration variant requires a model");
  }
  return value as ConversationConfiguration;
}

// Capabilities are declared positively, so an unknown name is not an error —
// it is a capability this client does not present. Rejecting it would make a
// newer agent unusable by an older client for no reason.
export function parseChatAgent(value: unknown): ChatAgent {
  const record = expectRecord(value, "chat agent");
  expectKeys(record, ["id", "name", "capabilities"], "chat agent");
  expectIdentity(record.id, "agent id");
  expectNonEmptyString(record.name, "agent name");
  if (!Array.isArray(record.capabilities)) throw new Error("invalid agent capabilities");
  for (const capability of record.capabilities) expectNonEmptyString(capability, "agent capability");
  return value as ChatAgent;
}

export function parseChatMode(value: unknown): ChatMode {
  const record = expectRecord(value, "chat mode");
  expectKeys(record, ["name", "description", "default"], "chat mode");
  expectIdentity(record.name, "mode name");
  expectString(record.description, "mode description");
  if (record.default !== undefined && typeof record.default !== "boolean") throw new Error("mode default must be a boolean");
  return value as ChatMode;
}

export function parseChatCommand(value: unknown): ChatCommand {
  const record = expectRecord(value, "chat command");
  expectKeys(record, ["name", "description", "argumentHint", "kind"], "chat command");
  expectIdentity(record.name, "command name");
  if (/\s|\//.test(record.name as string)) throw new Error("command name is invalid");
  expectString(record.description, "command description");
  expectString(record.argumentHint, "command argument hint");
  expectOneOf(record.kind, ["command", "skill", "local-operation"], "command kind");
  return value as ChatCommand;
}

export function parseConversationStatus(value: unknown): ConversationStatus {
  if (typeof value !== "string" || !CONVERSATION_STATUSES.has(value as ConversationStatus)) {
    throw new Error("invalid conversation status");
  }
  return value as ConversationStatus;
}

export function parseActivityStatus(value: unknown): ActivityStatus {
  if (typeof value !== "string" || !ACTIVITY_STATUSES.has(value as ActivityStatus)) {
    throw new Error("invalid activity status");
  }
  return value as ActivityStatus;
}

export function parseChatAgentDescriptor(value: unknown): ChatAgentDescriptor {
  const record = expectRecord(value, "chat agent");
  expectKeys(record, ["id", "name"], "chat agent");
  expectIdentity(record.id, "agent id");
  expectString(record.name, "agent name");
  return value as ChatAgentDescriptor;
}

export function parseAgentChatStatuses(value: unknown): AgentChatStatus[] {
  const record = expectRecord(value, "chat status");
  if (!Array.isArray(record.agents) || record.agents.length === 0) {
    throw new Error("chat status must list at least one agent");
  }
  return record.agents.map(entry => {
    const status = expectRecord(entry, "agent status");
    expectKeys(status, ["agent", "availability"], "agent status");
    return {
      agent: parseChatAgentDescriptor(status.agent),
      availability: parseChatAvailability(status.availability),
    };
  });
}

export function parseConversationSummary(value: unknown): ConversationSummary {
  const record = expectRecord(value, "conversation summary");
  expectKeys(record, ["id", "title", "createdAt", "updatedAt", "status", "agent"], "conversation summary");
  expectIdentity(record.id, "conversation id");
  expectString(record.title, "conversation title");
  expectTimestamp(record.createdAt, "createdAt");
  expectTimestamp(record.updatedAt, "updatedAt");
  parseConversationStatus(record.status);
  // Required on the wire: every conversation names its owner.
  parseChatAgentDescriptor(record.agent);
  return value as ConversationSummary;
}

export function parseInteractionRequest(value: unknown): InteractionRequest {
  const record = expectRecord(value, "interaction request");
  if (record.type === "permission") return parsePermissionRequest(value);
  if (record.type === "question") return parseQuestionRequest(value);
  throw new Error("invalid interaction request type");
}

export function parsePermissionRequest(value: unknown): PermissionRequest {
  const record = expectRecord(value, "permission request");
  expectKeys(
    record,
    ["id", "type", "createdAt", "requestId", "conversationId", "action", "resources", "status", "outcome", "diff", "plan", "choices", "choiceId"],
    "permission request",
  );
  expectOptionalIdentity(record.conversationId, "permission owning conversation");
  expectTimelineBase(record, "permission");
  expectIdentity(record.requestId, "permission request id");
  expectNonEmptyString(record.action, "permission action");
  // Empty is legitimate: a plan approval affects no named resource.
  expectStringArray(record.resources, "permission resources", record.plan === undefined);
  expectOneOf(record.status, ["pending", "resolved"], "permission status");
  if (record.status === "pending" && record.outcome !== undefined) {
    throw new Error("pending permission must not have an outcome");
  }
  if (record.status === "resolved") {
    expectOneOf(record.outcome, ["approved-once", "approved-session", "rejected"], "permission outcome");
  }
  if (record.diff !== undefined) expectString(record.diff, "permission diff");
  if (record.plan !== undefined) expectString(record.plan, "permission plan");
  if (record.choices !== undefined) {
    if (!Array.isArray(record.choices) || record.choices.length === 0) throw new Error("permission choices must be a non-empty array");
    for (const choice of record.choices) {
      const entry = expectRecord(choice, "permission choice");
      expectKeys(entry, ["id", "label", "description"], "permission choice");
      expectIdentity(entry.id, "permission choice id");
      expectNonEmptyString(entry.label, "permission choice label");
      expectOptionalString(entry.description, "permission choice description");
    }
  }
  if (record.choiceId !== undefined) expectIdentity(record.choiceId, "permission choice id");
  return value as PermissionRequest;
}

export function parseQuestionRequest(value: unknown): QuestionRequest {
  const record = expectRecord(value, "question request");
  expectKeys(record, ["id", "type", "createdAt", "requestId", "conversationId", "questions", "status", "outcome"], "question request");
  expectOptionalIdentity(record.conversationId, "question owning conversation");
  expectTimelineBase(record, "question");
  expectIdentity(record.requestId, "question request id");
  if (!Array.isArray(record.questions) || record.questions.length === 0) {
    throw new Error("questions must be a non-empty array");
  }
  record.questions.forEach(parseStructuredQuestion);
  expectOneOf(record.status, ["pending", "resolved"], "question status");
  if (record.status === "pending" && record.outcome !== undefined) {
    throw new Error("pending question must not have an outcome");
  }
  if (record.status === "resolved") parseQuestionOutcome(record.outcome);
  return value as QuestionRequest;
}

/**
 * Token usage, closed like every other item field. Each component is optional
 * because an agent reports what it measures — but an absent component must
 * stay absent, not arrive as some other type, since the readouts do
 * arithmetic on these.
 */
function expectTokenUsage(value: unknown, label: string): void {
  if (value === undefined) return;
  const usage = expectRecord(value, label);
  expectKeys(usage, [...TOKEN_USAGE_COMPONENTS], label);
  for (const key of TOKEN_USAGE_COMPONENTS) {
    expectOptionalCount(usage[key], `${label} ${key}`);
  }
}

export function parseConversationItem(value: unknown): ConversationItem {
  const record = expectRecord(value, "conversation item");
  const type = expectString(record.type, "conversation item type");
  if (type === "permission" || type === "question") return parseInteractionRequest(value);
  expectTimelineBase(record, type);

  switch (type) {
    case "user_message":
      expectKeys(record, ["id", "type", "createdAt", "text", "requestId", "attachments"], type);
      expectString(record.text, "user message text");
      expectOptionalIdentity(record.requestId, "user message request id");
      if (record.attachments !== undefined) parseMessageAttachments(record.attachments, "user message attachment");
      break;
    case "assistant_message":
      expectKeys(record, ["id", "type", "createdAt", "markdown", "completedAt", "usage", "model"], type);
      expectString(record.markdown, "assistant markdown");
      expectOptionalTimestamp(record.completedAt, "completedAt");
      expectTokenUsage(record.usage, "assistant usage");
      if (record.model !== undefined) expectModelSelection(record.model);
      break;
    case "reasoning":
      expectKeys(record, ["id", "type", "createdAt", "text", "status", "durationMs"], type);
      expectString(record.text, "reasoning text");
      parseActivityStatus(record.status);
      // A duration validates like a timestamp: finite, non-negative number.
      expectOptionalTimestamp(record.durationMs, "durationMs");
      break;
    case "tool":
      expectKeys(record, ["id", "type", "createdAt", "name", "status", "input", "output", "error", "childConversationId", "model", "usage"], type);
      expectNonEmptyString(record.name, "tool name");
      parseActivityStatus(record.status);
      expectOptionalString(record.input, "tool input");
      expectOptionalString(record.output, "tool output");
      expectOptionalString(record.error, "tool error");
      expectOptionalString(record.childConversationId, "tool child conversation id");
      expectOptionalString(record.model, "tool model");
      expectTokenUsage(record.usage, "tool usage");
      break;
    case "command":
      expectKeys(record, ["id", "type", "createdAt", "command", "status", "output", "exitCode"], type);
      expectNonEmptyString(record.command, "command");
      parseActivityStatus(record.status);
      expectOptionalString(record.output, "command output");
      if (record.exitCode !== undefined && !Number.isSafeInteger(record.exitCode)) throw new Error("exitCode must be an integer");
      break;
    case "file_change":
      expectKeys(record, ["id", "type", "createdAt", "path", "operation", "additions", "deletions"], type);
      expectNonEmptyString(record.path, "file path");
      expectOneOf(record.operation, ["create", "update", "delete"], "file operation");
      expectOptionalCount(record.additions, "additions");
      expectOptionalCount(record.deletions, "deletions");
      break;
    case "task_progress": {
      expectKeys(record, ["id", "type", "createdAt", "entries"], type);
      if (!Array.isArray(record.entries)) throw new Error("task entries must be an array");
      for (const entry of record.entries) {
        const task = expectRecord(entry, "task entry");
        expectKeys(task, ["text", "status", "activeText"], "task entry");
        expectNonEmptyString(task.text, "task text");
        expectOneOf(task.status, ["pending", "in_progress", "completed"], "task status");
        expectOptionalString(task.activeText, "task active text");
      }
      break;
    }
    case "turn_status":
      expectKeys(record, ["id", "type", "createdAt", "status", "message"], type);
      parseConversationStatus(record.status);
      expectOptionalString(record.message, "turn status message");
      break;
    case "notice":
      expectKeys(record, ["id", "type", "createdAt", "level", "message"], type);
      expectOneOf(record.level, ["info", "warning", "error"], "notice level");
      expectNonEmptyString(record.message, "notice message");
      break;
    default:
      throw new Error(`invalid conversation item type: ${type}`);
  }
  return value as ConversationItem;
}

export function parseConversationSnapshot(value: unknown): ConversationSnapshot {
  const record = expectRecord(value, "conversation snapshot");
  expectKeys(record, ["conversation", "configuration", "generation", "cursor", "items", "queued", "reversibleHistory", "olderCursor"], "conversation snapshot");
  parseConversationSummary(record.conversation);
  parseConversationConfiguration(record.configuration);
  expectIdentity(record.generation, "generation");
  expectNonEmptyString(record.cursor, "cursor");
  if (!Array.isArray(record.items)) throw new Error("snapshot items must be an array");
  record.items.forEach(parseConversationItem);
  if (record.queued !== undefined) parseQueuedMessages(record.queued);
  if (record.reversibleHistory !== undefined) parseReversibleHistoryState(record.reversibleHistory);
  if (record.olderCursor !== undefined) expectNonEmptyString(record.olderCursor, "older cursor");
  return value as ConversationSnapshot;
}

export function parseReversibleHistoryState(value: unknown): ReversibleHistoryState {
  const record = expectRecord(value, "reversible history state");
  expectKeys(record, ["staged", "canUndo", "canRedo", "revertedMessages"], "reversible history state");
  for (const key of ["staged", "canUndo", "canRedo"] as const) {
    if (typeof record[key] !== "boolean") throw new Error(`reversible history ${key} must be a boolean`);
  }
  if (!Array.isArray(record.revertedMessages)) throw new Error("reversible history revertedMessages must be an array");
  for (const value of record.revertedMessages) {
    const message = expectRecord(value, "reverted user message");
    expectKeys(message, ["id", "text"], "reverted user message");
    expectIdentity(message.id, "reverted user message id");
    expectString(message.text, "reverted user message text");
  }
  if (!record.staged && record.canRedo) throw new Error("reversible history cannot redo without a staged boundary");
  if (!record.staged && record.revertedMessages.length > 0) throw new Error("reversible history cannot list reverted messages without a staged boundary");
  return value as ReversibleHistoryState;
}

export function parseReversibleHistoryResult(value: unknown): ReversibleHistoryResult {
  const record = expectRecord(value, "reversible history result");
  expectKeys(record, ["outcome", "state", "restoredDraft"], "reversible history result");
  expectOneOf(record.outcome, ["changed", "nothing-to-undo", "nothing-to-redo"], "reversible history outcome");
  parseReversibleHistoryState(record.state);
  if (record.restoredDraft !== undefined) {
    const draft = expectRecord(record.restoredDraft, "restored draft");
    expectKeys(draft, ["text", "attachments"], "restored draft");
    expectString(draft.text, "restored draft text");
    if (draft.attachments !== undefined) parseMessageAttachments(draft.attachments, "restored draft attachment");
  }
  return value as ReversibleHistoryResult;
}

export function parseQueuedMessages(value: unknown): QueuedMessage[] {
  if (!Array.isArray(value)) throw new Error("queued messages must be an array");
  for (const entry of value) {
    const record = expectRecord(entry, "queued message");
    expectKeys(record, ["id", "text", "queuedAt", "requestId", "attachments"], "queued message");
    expectIdentity(record.id, "queued message id");
    expectString(record.text, "queued message text");
    expectTimestamp(record.queuedAt, "queued message queuedAt");
    if (record.requestId !== undefined) expectIdentity(record.requestId, "queued message requestId");
    if (record.attachments !== undefined) parseMessageAttachments(record.attachments, "queued message attachment");
  }
  return value as QueuedMessage[];
}

export function parseConversationInventoryEvent(value: unknown): ConversationInventoryEvent {
  const record = expectRecord(value, "conversation inventory event");
  expectKeys(record, ["type"], "conversation inventory event");
  if (record.type !== "conversation.inventory") throw new Error("invalid conversation inventory event type");
  return value as ConversationInventoryEvent;
}

export function parseChatEvent(value: unknown): ChatEvent {
  const record = expectRecord(value, "chat event");
  const type = expectString(record.type, "chat event type");
  expectIdentity(record.generation, "event generation");
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0) {
    throw new Error("event sequence must be a non-negative integer");
  }
  expectIdentity(record.conversationId, "event conversation id");

  switch (type) {
    case "item.upsert":
      expectKeys(record, ["generation", "sequence", "conversationId", "type", "item"], "item upsert event");
      parseConversationItem(record.item);
      break;
    case "item.remove":
      expectKeys(record, ["generation", "sequence", "conversationId", "type", "itemId"], "item remove event");
      expectIdentity(record.itemId, "removed item id");
      break;
    case "item.text_delta":
      expectKeys(record, ["generation", "sequence", "conversationId", "type", "itemId", "delta"], "text delta event");
      expectIdentity(record.itemId, "delta item id");
      expectNonEmptyString(record.delta, "text delta");
      break;
    case "conversation.status":
      expectKeys(record, ["generation", "sequence", "conversationId", "type", "status", "message"], "status event");
      parseConversationStatus(record.status);
      expectOptionalString(record.message, "status message");
      break;
    case "conversation.configuration":
      expectKeys(record, ["generation", "sequence", "conversationId", "type", "configuration"], "configuration event");
      parseConversationConfiguration(record.configuration);
      break;
    case "conversation.updated":
      expectKeys(record, ["generation", "sequence", "conversationId", "type", "conversation"], "conversation update event");
      parseConversationSummary(record.conversation);
      if ((record.conversation as ConversationSummary).id !== record.conversationId) throw new Error("updated conversation id does not match event");
      break;
    case "conversation.queue": {
      expectKeys(record, ["generation", "sequence", "conversationId", "type", "queued", "change"], "queue event");
      parseQueuedMessages(record.queued);
      const change = expectRecord(record.change, "queue change");
      expectKeys(change, ["kind", "messageId"], "queue change");
      expectOneOf(change.kind, ["held", "removed", "delivered"], "queue change kind");
      expectIdentity(change.messageId, "queue change message id");
      break;
    }
    case "resync":
      expectKeys(record, ["generation", "sequence", "conversationId", "type", "reason"], "resync event");
      expectOneOf(record.reason, ["generation-changed", "retention-gap", "invalid-cursor", "conversation-rewritten"], "resync reason");
      break;
    default:
      throw new Error(`invalid chat event type: ${type}`);
  }
  return value as ChatEvent;
}

function parseStructuredQuestion(value: unknown): StructuredQuestion {
  const record = expectRecord(value, "structured question");
  expectKeys(record, ["prompt", "header", "options", "multiple", "allowFreeForm"], "structured question");
  expectNonEmptyString(record.prompt, "question prompt");
  expectNonEmptyString(record.header, "question header");
  if (!Array.isArray(record.options)) throw new Error("question options must be an array");
  for (const option of record.options) {
    const optionRecord = expectRecord(option, "question option");
    expectKeys(optionRecord, ["label", "description"], "question option");
    expectNonEmptyString(optionRecord.label, "option label");
    expectString(optionRecord.description, "option description");
  }
  if (typeof record.multiple !== "boolean" || typeof record.allowFreeForm !== "boolean") {
    throw new Error("question flags must be boolean");
  }
  if (record.options.length === 0 && !record.allowFreeForm) {
    throw new Error("question must offer an option or free-form answer");
  }
  return value as StructuredQuestion;
}

function parseQuestionOutcome(value: unknown): QuestionOutcome {
  const record = expectRecord(value, "question outcome");
  if (record.kind === "rejected") {
    expectKeys(record, ["kind"], "rejected question outcome");
  } else if (record.kind === "answered") {
    expectKeys(record, ["kind", "answers"], "answered question outcome");
    if (!Array.isArray(record.answers) || !record.answers.every(answer => Array.isArray(answer) && answer.every(item => typeof item === "string"))) {
      throw new Error("question answers must be string arrays");
    }
  } else {
    throw new Error("invalid question outcome");
  }
  return value as QuestionOutcome;
}

function expectTimelineBase(record: Record<string, unknown>, type: string): void {
  expectIdentity(record.id, `${type} item id`);
  if (record.type !== type) throw new Error(`expected ${type} item`);
  expectTimestamp(record.createdAt, `${type} createdAt`);
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function expectKeys(record: Record<string, unknown>, allowed: string[], field: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).find(key => !allowedKeys.has(key));
  if (unknown) throw new Error(`unknown ${field} field: ${unknown}`);
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function expectNonEmptyString(value: unknown, field: string): string {
  const result = expectString(value, field);
  if (result.length === 0) throw new Error(`${field} must not be empty`);
  return result;
}

function expectIdentity(value: unknown, field: string): string {
  const result = expectNonEmptyString(value, field);
  if (result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function expectOptionalIdentity(value: unknown, field: string): void {
  if (value !== undefined) expectIdentity(value, field);
}

function expectTimestamp(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a timestamp`);
}

function expectOptionalTimestamp(value: unknown, field: string): void {
  if (value !== undefined) expectTimestamp(value, field);
}

function expectNullableString(value: unknown, field: string): void {
  if (value !== null) expectNonEmptyString(value, field);
}

function expectOptionalString(value: unknown, field: string): void {
  if (value !== undefined) expectString(value, field);
}

function expectOptionalCount(value: unknown, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function expectStringArray(value: unknown, field: string, nonEmpty: boolean): void {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || !value.every(item => typeof item === "string" && item.length > 0)) {
    throw new Error(`${field} must be ${nonEmpty ? "a non-empty " : "an "}array of strings`);
  }
}

function expectOneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`invalid ${field}`);
  return value as T;
}
