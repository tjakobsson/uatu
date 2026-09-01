import { boundedSet } from "../../shared/bounded-map";
import type { NormalizedProviderEvent, NormalizedProviderUpdate } from "../provider";
import type { ConversationItem, MessageAttachment, ModelSelection, TokenUsage } from "../types";
import type { TranscriptEntry } from "./transcript";

type RecordValue = Record<string, unknown>;

/**
 * Claude Code activity → the shared timeline model, below the seam (D2).
 * Two sources share this normalizer: the live SDK message stream and stored
 * transcript entries — both carry API-shaped `message` payloads, so one
 * block-walker serves both. Differences live in `source`:
 *
 * - "live": typed user prompts are skipped (the provider minted the
 *   user_message at accept time; the stream echo would duplicate it).
 * - "stored": user entries are the only source of user messages, so they
 *   are emitted.
 */
export type ClaudeNormalizationSource = "live" | "stored";

/**
 * What normalizing one message needs to remember from earlier ones, bounded.
 * Tool results arrive as bare `tool_result` blocks; only the earlier
 * `tool_use` block knows the tool's name, input, and start time.
 */
export type ClaudeEventMemory = {
  tools: Map<string, { name: string; input?: string; createdAt: number }>;
  lastModel?: string;
  // Translates a session-reported resolved model id to the catalog's alias
  // id, once the provider has captured the catalog. Identity until then.
  resolveModel?: (id: string) => string;
  // TodoWrite tool uses render as the task-progress surface, not as tool
  // rows; their ids are remembered so the later tool_result is suppressed
  // too. The task list's first-seen time keeps the presentation anchored.
  todoTools: Set<string>;
  taskListCreatedAt?: number;
};

export function createClaudeEventMemory(): ClaudeEventMemory {
  return { tools: new Map(), todoTools: new Set() };
}

const MEMORY_LIMIT = 2_048;

// Message types the SDK emits that deliberately carry nothing for the
// timeline: progress, telemetry, and control chatter whose terminal states
// are carried elsewhere.
const INTENTIONALLY_IGNORED = new Set([
  "stream_event",
  "rate_limit_event",
  "status",
  "api_retry",
  "control_request_progress",
  "local_command_output",
  "hook_started",
  "hook_progress",
  "hook_response",
  "plugin_install",
  "tool_progress",
  "auth_status",
  "task_started",
  "task_updated",
  "task_progress",
  "background_tasks_changed",
  "thinking_tokens",
  "session_state_changed",
  "worker_shutting_down",
  "commands_changed",
  "notification",
  "files_persisted",
  "tool_use_summary",
  "memory_recall",
  "elicitation_complete",
  "permission_denied",
  "prompt_suggestion",
  "mirror_error",
  "informational",
  "conversation_reset",
  "compact_boundary",
  "user_message_replay",
  "task_notification",
]);

export function claudeModelSelection(modelId: string): ModelSelection {
  return { providerId: "anthropic", modelId };
}

/**
 * One SDK stream message → the shared provider-event envelope, minus the
 * conversation id (the owning session stamps it).
 */
export function normalizeClaudeMessage(
  value: unknown,
  memory: ClaudeEventMemory,
  source: ClaudeNormalizationSource,
  // The owning native session, when known: what a Task completion's child
  // conversation id is derived from (`sub:<parent>:<agentId>`).
  parentSessionId?: string,
): Omit<NormalizedProviderEvent, "conversationId"> {
  const record = asRecord(value);
  const type = typeof record.type === "string" ? record.type : "";
  const base = { updates: [] as NormalizedProviderUpdate[], eventType: type };
  if (!type) return { ...base, outcome: "unparseable" };

  if (type === "system") {
    // The init message names the session's model; remember it for usage
    // attribution and report it as the conversation's configuration.
    const reportedInit = typeof record.model === "string" ? record.model : undefined;
    const model = reportedInit !== undefined ? (memory.resolveModel?.(reportedInit) ?? reportedInit) : undefined;
    if (record.subtype === "init" && model) {
      memory.lastModel = model;
      return { ...base, outcome: "handled", configuration: { model: claudeModelSelection(model) } };
    }
    return { ...base, outcome: "ignored" };
  }

  if (type === "assistant") {
    const envelope = envelopeIdentity(record);
    if (!envelope) return { ...base, outcome: "unparseable" };
    const message = asRecord(record.message);
    const raw = typeof message.model === "string" ? message.model : undefined;
    const reported = raw !== undefined ? (memory.resolveModel?.(raw) ?? raw) : undefined;
    // The init message names the session's model in its full variant form
    // ("...[1m]"); assistant messages report the resolved base id. Keep the
    // variant id — it is what the catalog keys context windows by, so the
    // usage gauge measures against the window actually in effect.
    const model = reported !== undefined && memory.lastModel?.startsWith(`${reported}[`)
      ? memory.lastModel
      : reported;
    if (model) memory.lastModel = model;
    const updates = contentBlockUpdates(asArray(message.content), envelope, memory);
    const usage = tokensToUsage(message.usage);
    return {
      ...base,
      outcome: "handled",
      updates,
      ...(usage ? { assistantUsage: { messageId: envelope.uuid, usage } } : {}),
      ...(model ? { assistantModel: { messageId: envelope.uuid, model, createdAt: envelope.createdAt } } : {}),
    };
  }

  if (type === "user") {
    const envelope = envelopeIdentity(record);
    if (!envelope) return { ...base, outcome: "unparseable" };
    const message = asRecord(record.message);
    const blocks = contentBlocks(message.content);
    const results = blocks.filter(block => block.type === "tool_result");
    if (results.length > 0) {
      const toolOutcome = asRecord(record.toolUseResult ?? record.tool_use_result);
      const updates = results
        .map(block => toolResultUpdate(block, envelope, memory, toolOutcome, parentSessionId))
        .filter((update): update is NormalizedProviderUpdate => update !== null);
      return { ...base, outcome: updates.length > 0 ? "handled" : "ignored", updates };
    }
    if (source === "live") {
      // The provider minted this user message when it accepted the prompt.
      return { ...base, outcome: "ignored" };
    }
    const text = typeof message.content === "string"
      ? message.content
      : blocks.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text as string).join("\n");
    // Images the prompt carried replay as labeled placeholders: the
    // transcript stores bytes, not the workspace store reference, so the
    // reference is unrecoverable by design (types.ts: absent id).
    const attachments: MessageAttachment[] = blocks
      .filter(block => block.type === "image")
      .map((block, index) => {
        const media = asRecord(block.source).media_type;
        const mimeType = typeof media === "string" ? media : "image/png";
        return { name: `attachment-${index + 1}.${mimeType.split("/")[1] ?? "png"}`, mimeType };
      });
    if (!text && attachments.length === 0) return { ...base, outcome: "ignored" };
    return {
      ...base,
      outcome: "handled",
      updates: [{ kind: "upsert", item: {
        id: `message:${envelope.uuid}`,
        type: "user_message",
        createdAt: envelope.createdAt,
        text,
        ...(attachments.length ? { attachments } : {}),
      } }],
    };
  }

  if (type === "result") {
    const envelope = envelopeIdentity(record);
    if (!envelope) return { ...base, outcome: "unparseable" };
    const failed = record.is_error === true;
    const usage = tokensToUsage(record.usage);
    const updates: NormalizedProviderUpdate[] = [];
    if (usage) {
      // Message-level accounting rides a dedicated empty-markdown carrier,
      // same contract as the OpenCode normalizer.
      updates.push({ kind: "upsert", item: {
        id: `usage:${envelope.uuid}`,
        type: "assistant_message",
        createdAt: envelope.createdAt,
        markdown: "",
        usage,
        ...(memory.lastModel ? { model: claudeModelSelection(memory.lastModel) } : {}),
      } });
    }
    const message = typeof record.result === "string" && failed ? record.result : undefined;
    // Turn status rides the ordered update stream like any other change.
    updates.push(failed
      ? { kind: "status", status: "failed", ...(message ? { message } : {}) }
      : { kind: "status", status: "completed" });
    return {
      ...base,
      outcome: "handled",
      updates,
      ...(usage ? { assistantUsage: { messageId: envelope.uuid, usage } } : {}),
      ...(memory.lastModel && usage ? { assistantModel: { messageId: envelope.uuid, model: memory.lastModel, createdAt: envelope.createdAt } } : {}),
    };
  }

  return { ...base, outcome: INTENTIONALLY_IGNORED.has(type) ? "ignored" : "unrecognized" };
}

/** Stored transcript entries → timeline items, in entry order. */
export function normalizeTranscriptEntries(entries: TranscriptEntry[], parentSessionId?: string): {
  items: ConversationItem[];
  accounting: Array<{ messageId: string; createdAt: number; usage?: TokenUsage; model?: string }>;
} {
  const memory = createClaudeEventMemory();
  const items: ConversationItem[] = [];
  const accounting: Array<{ messageId: string; createdAt: number; usage?: TokenUsage; model?: string }> = [];
  for (const entry of entries) {
    const normalized = normalizeClaudeMessage(
      { type: entry.kind, uuid: entry.uuid, timestamp: entry.timestamp, message: entry.message, ...(entry.toolUseResult ? { toolUseResult: entry.toolUseResult } : {}) },
      memory,
      "stored",
      parentSessionId,
    );
    for (const update of normalized.updates) {
      if (update.kind !== "upsert") continue;
      const existingIndex = items.findIndex(item => item.id === update.item.id);
      if (existingIndex >= 0) items[existingIndex] = update.item;
      else items.push(update.item);
    }
    if (normalized.assistantUsage) {
      accounting.push({
        messageId: normalized.assistantUsage.messageId,
        createdAt: entry.timestamp,
        usage: normalized.assistantUsage.usage,
        ...(normalized.assistantModel ? { model: normalized.assistantModel.model } : {}),
      });
    }
    // A stored assistant message that reported usage also carries the
    // window-fill carrier the timeline reads (live turns get it from the
    // result message, which transcripts do not record).
    if (normalized.assistantUsage && entry.kind === "assistant") {
      items.push({
        id: `usage:${entry.uuid}`,
        type: "assistant_message",
        createdAt: entry.timestamp,
        markdown: "",
        usage: normalized.assistantUsage.usage,
        ...(normalized.assistantModel ? { model: claudeModelSelection(normalized.assistantModel.model) } : {}),
      });
    }
  }
  return { items, accounting };
}

type Envelope = { uuid: string; createdAt: number };

function envelopeIdentity(record: RecordValue): Envelope | null {
  const uuid = typeof record.uuid === "string" && record.uuid ? record.uuid : null;
  if (!uuid) return null;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp)
    : typeof record.timestamp === "number" ? record.timestamp : Date.now();
  return { uuid, createdAt: Number.isNaN(timestamp) ? Date.now() : timestamp };
}

type Block = { type?: string } & RecordValue;

function contentBlocks(content: unknown): Block[] {
  return asArray(content).filter((block): block is Block => Boolean(block) && typeof block === "object");
}

function contentBlockUpdates(content: unknown[], envelope: Envelope, memory: ClaudeEventMemory): NormalizedProviderUpdate[] {
  const updates: NormalizedProviderUpdate[] = [];
  const texts: string[] = [];
  let reasoningIndex = 0;
  for (const value of content) {
    const block = asRecord(value);
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      updates.push({ kind: "upsert", item: {
        id: `reasoning:${envelope.uuid}:${reasoningIndex++}`,
        type: "reasoning",
        createdAt: envelope.createdAt,
        text: block.thinking,
        status: "completed",
      } });
      continue;
    }
    if (block.type === "tool_use" && typeof block.id === "string") {
      const name = typeof block.name === "string" ? block.name : "tool";
      // The agent's own todo tracking is the task-progress surface (D9):
      // one item updated in place, never a tool row per write.
      if (name === "TodoWrite") {
        memory.todoTools.add(block.id);
        if (memory.todoTools.size > MEMORY_LIMIT) memory.todoTools.clear();
        const entries = todoEntries(asRecord(block.input));
        if (entries) {
          memory.taskListCreatedAt ??= envelope.createdAt;
          updates.push({ kind: "upsert", item: {
            id: "task-progress",
            type: "task_progress",
            createdAt: memory.taskListCreatedAt,
            entries,
          } });
        }
        continue;
      }
      const input = block.input === undefined ? undefined : stringify(block.input);
      boundedSet(memory.tools, block.id, { name, ...(input === undefined ? {} : { input }), createdAt: envelope.createdAt }, MEMORY_LIMIT);
      updates.push({ kind: "upsert", item: {
        id: `tool:${block.id}`,
        type: "tool",
        createdAt: envelope.createdAt,
        name,
        status: "running",
        ...(input === undefined ? {} : { input }),
      } });
    }
  }
  if (texts.length > 0) {
    updates.push({ kind: "upsert", item: {
      id: `message:${envelope.uuid}`,
      type: "assistant_message",
      createdAt: envelope.createdAt,
      markdown: texts.join("\n\n"),
      completedAt: envelope.createdAt,
    } });
  }
  return updates;
}

function todoEntries(input: RecordValue): ConversationItem extends never ? never : Array<{ text: string; status: "pending" | "in_progress" | "completed"; activeText?: string }> | null {
  if (!Array.isArray(input.todos)) return null;
  const entries: Array<{ text: string; status: "pending" | "in_progress" | "completed"; activeText?: string }> = [];
  for (const value of input.todos) {
    if (!value || typeof value !== "object") return null;
    const todo = value as RecordValue;
    if (typeof todo.content !== "string" || !todo.content) return null;
    const status = todo.status === "in_progress" || todo.status === "completed" ? todo.status : "pending";
    entries.push({
      text: todo.content,
      status,
      ...(typeof todo.activeForm === "string" && todo.activeForm ? { activeText: todo.activeForm } : {}),
    });
  }
  return entries;
}

function toolResultUpdate(block: Block, envelope: Envelope, memory: ClaudeEventMemory, toolOutcome: RecordValue = {}, parentSessionId?: string): NormalizedProviderUpdate | null {
  const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
  // A TodoWrite result confirms a surface the task-progress item already
  // shows; a row for it would be exactly the per-update spam D9 forbids.
  if (memory.todoTools.has(toolUseId)) return null;
  const known = memory.tools.get(toolUseId);
  const failed = block.is_error === true;
  const output = block.content === undefined ? undefined : stringify(block.content);
  // A Task completion names its subagent run: the child transcript becomes
  // an openable drill-down, and the store's own accounting lands as the
  // launching row's attribution (spec: the row states model and tokens).
  const agentId = typeof toolOutcome.agentId === "string" && toolOutcome.agentId ? toolOutcome.agentId : undefined;
  const childConversationId = agentId && parentSessionId ? `sub:${parentSessionId}:${agentId}` : undefined;
  const attributedModel = typeof toolOutcome.resolvedModel === "string" && toolOutcome.resolvedModel ? toolOutcome.resolvedModel : undefined;
  const attributedUsage = tokensToUsage(toolOutcome.usage);
  return { kind: "upsert", item: {
    id: `tool:${toolUseId}`,
    type: "tool",
    // The launch time, when remembered: a completion re-upserts the whole
    // row and must not move it in the timeline.
    createdAt: known?.createdAt ?? envelope.createdAt,
    name: known?.name ?? "tool",
    status: failed ? "failed" : "completed",
    ...(known?.input === undefined ? {} : { input: known.input }),
    ...(output === undefined ? {} : failed ? { error: output } : { output }),
    ...(childConversationId ? { childConversationId } : {}),
    ...(attributedModel ? { model: attributedModel } : {}),
    ...(attributedUsage ? { usage: attributedUsage } : {}),
  } };
}

export function tokensToUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  const read = (key: string): number | undefined => (typeof record[key] === "number" ? record[key] as number : undefined);
  const usage: TokenUsage = {};
  const input = read("input_tokens");
  const output = read("output_tokens");
  const cacheRead = read("cache_read_input_tokens");
  const cacheWrite = read("cache_creation_input_tokens");
  if (input !== undefined) usage.input = input;
  if (output !== undefined) usage.output = output;
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  const details = asRecord(record.output_tokens_details);
  if (typeof details.thinking_tokens === "number" && details.thinking_tokens > 0) usage.reasoning = details.thinking_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 1) ?? String(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
