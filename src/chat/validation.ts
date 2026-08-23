import { TOKEN_USAGE_COMPONENTS } from "./usage";
import type {
  ActivityStatus,
  ChatAgent,
  ChatMode,
  ChatAvailability,
  ChatCommand,
  ChatEvent,
  ChatModel,
  ChatStartupDiagnostics,
  ConversationConfiguration,
  ConversationItem,
  ConversationSnapshot,
  ConversationStatus,
  ConversationSummary,
  InteractionRequest,
  PermissionRequest,
  QueuedMessage,
  QuestionOutcome,
  QuestionRequest,
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
  expectKeys(record, ["selection", "provider", "name", "variants", "contextLimit"], "chat model");
  expectModelSelection(record.selection);
  expectNonEmptyString(record.provider, "model provider");
  expectNonEmptyString(record.name, "model name");
  if (record.variants !== undefined) expectStringArray(record.variants, "model variants", true);
  if (record.contextLimit !== undefined && (typeof record.contextLimit !== "number" || record.contextLimit < 1)) throw new Error("model contextLimit must be a positive number");
  return value as ChatModel;
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
  expectKeys(record, ["name", "description"], "chat mode");
  expectIdentity(record.name, "mode name");
  expectString(record.description, "mode description");
  return value as ChatMode;
}

export function parseChatCommand(value: unknown): ChatCommand {
  const record = expectRecord(value, "chat command");
  expectKeys(record, ["name", "description", "argumentHint", "kind"], "chat command");
  expectIdentity(record.name, "command name");
  if (/\s|\//.test(record.name as string)) throw new Error("command name is invalid");
  expectString(record.description, "command description");
  expectString(record.argumentHint, "command argument hint");
  expectOneOf(record.kind, ["command", "skill"], "command kind");
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

export function parseConversationSummary(value: unknown): ConversationSummary {
  const record = expectRecord(value, "conversation summary");
  expectKeys(record, ["id", "title", "createdAt", "updatedAt", "status"], "conversation summary");
  expectIdentity(record.id, "conversation id");
  expectString(record.title, "conversation title");
  expectTimestamp(record.createdAt, "createdAt");
  expectTimestamp(record.updatedAt, "updatedAt");
  parseConversationStatus(record.status);
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
    ["id", "type", "createdAt", "requestId", "conversationId", "action", "resources", "status", "outcome", "diff"],
    "permission request",
  );
  expectOptionalIdentity(record.conversationId, "permission owning conversation");
  expectTimelineBase(record, "permission");
  expectIdentity(record.requestId, "permission request id");
  expectNonEmptyString(record.action, "permission action");
  expectStringArray(record.resources, "permission resources", true);
  expectOneOf(record.status, ["pending", "resolved"], "permission status");
  if (record.status === "pending" && record.outcome !== undefined) {
    throw new Error("pending permission must not have an outcome");
  }
  if (record.status === "resolved") {
    expectOneOf(record.outcome, ["approved-once", "approved-session", "rejected"], "permission outcome");
  }
  if (record.diff !== undefined) expectString(record.diff, "permission diff");
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
      expectKeys(record, ["id", "type", "createdAt", "text", "requestId"], type);
      expectString(record.text, "user message text");
      expectOptionalIdentity(record.requestId, "user message request id");
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
  expectKeys(record, ["conversation", "configuration", "generation", "cursor", "items", "queued", "olderCursor"], "conversation snapshot");
  parseConversationSummary(record.conversation);
  parseConversationConfiguration(record.configuration);
  expectIdentity(record.generation, "generation");
  expectNonEmptyString(record.cursor, "cursor");
  if (!Array.isArray(record.items)) throw new Error("snapshot items must be an array");
  record.items.forEach(parseConversationItem);
  if (record.queued !== undefined) parseQueuedMessages(record.queued);
  if (record.olderCursor !== undefined) expectNonEmptyString(record.olderCursor, "older cursor");
  return value as ConversationSnapshot;
}

export function parseQueuedMessages(value: unknown): QueuedMessage[] {
  if (!Array.isArray(value)) throw new Error("queued messages must be an array");
  for (const entry of value) {
    const record = expectRecord(entry, "queued message");
    expectKeys(record, ["id", "text", "queuedAt", "requestId"], "queued message");
    expectIdentity(record.id, "queued message id");
    expectNonEmptyString(record.text, "queued message text");
    expectTimestamp(record.queuedAt, "queued message queuedAt");
    if (record.requestId !== undefined) expectIdentity(record.requestId, "queued message requestId");
  }
  return value as QueuedMessage[];
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
      expectOneOf(record.reason, ["generation-changed", "retention-gap", "invalid-cursor"], "resync reason");
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
