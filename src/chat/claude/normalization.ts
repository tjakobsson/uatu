import { boundedSet } from "../../shared/bounded-map";
import type { NormalizedProviderEvent, NormalizedProviderUpdate } from "../provider";
import type { ContextReportItem, ConversationItem, MessageAttachment, ModelSelection, TokenUsage } from "../types";
import { foldCommandMarkup, type TranscriptEntry } from "./transcript";

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
  // Background tasks by id: what task_started said, so later progress and
  // the settling notification re-upsert the same row with its description
  // and launch time. Ambient (housekeeping) ids are remembered so their
  // later edges stay out of the timeline too.
  tasks: Map<string, { description: string; taskType?: string; toolUseId?: string; createdAt: number; progress?: string; backgrounded?: boolean; announced?: boolean; settled?: boolean }>;
  ambientTasks: Set<string>;
  // Partial-message streams by API message id: which content block index
  // holds text (from content_block_start), and how many of those the
  // completed per-block assistant messages have consumed, so the completed
  // block replaces exactly the streamed item it grew in (D10).
  streams: Map<string, { createdAt: number; textBlocks: number[]; consumed: number }>;
  // Every timeline item a wire frame minted, by the frame's uuid, so a
  // retraction naming the frame (a refusal fallback's supersede) removes
  // the tool and reasoning rows it produced and not only its text.
  frameItems: Map<string, string[]>;
  currentStream?: string;
  // A named working state the turn is in (retrying, compacting); cleared —
  // with a `running` status — by the next message that shows the turn moved.
  transient?: "retrying" | "compacting";
  // The last rate-limit standing reported, so a return to allowed can
  // retire the badge without a notice for every allowed event.
  rateLimited?: boolean;
};

export function createClaudeEventMemory(): ClaudeEventMemory {
  return { tools: new Map(), todoTools: new Set(), tasks: new Map(), ambientTasks: new Set(), streams: new Map(), frameItems: new Map() };
}

const MEMORY_LIMIT = 2_048;

// Message types the SDK emits that deliberately carry nothing for the
// timeline: progress, telemetry, and control chatter whose terminal states
// are carried elsewhere.
const INTENTIONALLY_IGNORED = new Set([
  "control_request_progress",
  "local_command_output",
  "hook_started",
  "hook_progress",
  "hook_response",
  "plugin_install",
  "auth_status",
  "background_tasks_changed",
  "thinking_tokens",
  "session_state_changed",
  "worker_shutting_down",
  "commands_changed",
  "notification",
  "files_persisted",
  "tool_use_summary",
  "elicitation_complete",
  "permission_denied",
  "prompt_suggestion",
  "mirror_error",
  "informational",
  "conversation_reset",
  "user_message_replay",
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
    if (record.subtype === "api_retry") {
      const attempt = typeof record.attempt === "number" ? record.attempt : undefined;
      const max = typeof record.max_retries === "number" ? record.max_retries : undefined;
      const status = typeof record.error_status === "number" ? record.error_status : undefined;
      const parts = [attempt !== undefined && max !== undefined ? `attempt ${attempt} of ${max}` : attempt !== undefined ? `attempt ${attempt}` : "", status !== undefined ? `HTTP ${status}` : ""].filter(Boolean);
      memory.transient = "retrying";
      // The retried request streams under a new API message id: whatever
      // the abandoned one had streamed is not going to be completed, so its
      // open items leave the timeline now rather than lingering forever.
      const updates: NormalizedProviderUpdate[] = abandonCurrentStream(memory);
      updates.push({ kind: "status", status: "retrying", ...(parts.length ? { message: parts.join(", ") } : {}) });
      return { ...base, outcome: "handled", updates };
    }
    if (record.subtype === "status") {
      const envelope = envelopeIdentity(record);
      if (record.status === "compacting") {
        memory.transient = "compacting";
        return { ...base, outcome: "handled", updates: [{ kind: "status", status: "compacting" }] };
      }
      const updates: NormalizedProviderUpdate[] = resumeAfterTransient(memory);
      if (record.compact_result === "failed" && envelope) {
        const error = typeof record.compact_error === "string" && record.compact_error ? `: ${record.compact_error}` : "";
        updates.push({ kind: "upsert", item: { id: `notice:compaction:${envelope.uuid}`, type: "notice", createdAt: envelope.createdAt, level: "warning", message: `Context compaction failed${error}.` } });
      }
      return { ...base, outcome: updates.length ? "handled" : "ignored", updates };
    }
    if (record.subtype === "model_refusal_fallback") {
      const envelope = envelopeIdentity(record);
      if (!envelope) return { ...base, outcome: "unparseable" };
      const original = typeof record.original_model === "string" && record.original_model ? record.original_model : "the model";
      const fallbackRaw = typeof record.fallback_model === "string" && record.fallback_model ? record.fallback_model : undefined;
      // A session-scoped fallback swaps the model later usage is attributed
      // to; a local one (a subagent's) leaves the session model alone.
      if (fallbackRaw && record.scope !== "local") memory.lastModel = memory.resolveModel?.(fallbackRaw) ?? fallbackRaw;
      const category = typeof record.api_refusal_category === "string" && record.api_refusal_category ? ` (${record.api_refusal_category})` : "";
      const message = fallbackRaw
        ? `${original} declined this request${category}; the turn continues on ${fallbackRaw}.`
        : `${original} declined this request${category}.`;
      // The refused leg's messages are retracted (SDK: the complete audit
      // record for the turn); an assistant frame's `supersedes` evicts the
      // same ids earlier, so both paths remove idempotently.
      const updates: NormalizedProviderUpdate[] = evictFrames(record.retracted_message_uuids, memory);
      updates.push({ kind: "upsert", item: { id: `notice:refusal:${envelope.uuid}`, type: "notice", createdAt: envelope.createdAt, level: "warning", code: "refusal-fallback", message } });
      return { ...base, outcome: "handled", updates };
    }
    if (record.subtype === "memory_recall") {
      const envelope = envelopeIdentity(record);
      if (!envelope) return { ...base, outcome: "unparseable" };
      const memories = asArray(record.memories).map(value => asRecord(value)).filter(entry => typeof entry.path === "string");
      if (memories.length === 0) return { ...base, outcome: "ignored" };
      const text = memories.map(entry => {
        const scope = typeof entry.scope === "string" ? `[${entry.scope}] ` : "";
        const content = typeof entry.content === "string" && entry.content.trim() ? entry.content.trim() : undefined;
        return content ? `${scope}${entry.path}\n${content}` : `${scope}${entry.path}`;
      }).join("\n\n");
      return { ...base, outcome: "handled", updates: [{ kind: "upsert", item: { id: `memory:${envelope.uuid}`, type: "reasoning", createdAt: envelope.createdAt, text, status: "completed", label: "Recalled from memory" } }] };
    }
    // Compaction is a point in the timeline: a marker with the CLI's own
    // pre/post figures, and — when it states the post-compaction size — a
    // context report from it, so the readout drops to the compacted window
    // instead of waiting for the next model call (spec: the presented fill
    // reflects the post-compaction figure).
    if (record.subtype === "compact_boundary") {
      const envelope = envelopeIdentity(record);
      if (!envelope) return { ...base, outcome: "unparseable" };
      // The live message spells the figures snake_case; the transcript's
      // record of the same boundary spells them camelCase.
      const metadata = asRecord(record.compact_metadata ?? record.compactMetadata);
      const trigger = metadata.trigger === "manual" || metadata.trigger === "auto" ? metadata.trigger : undefined;
      const preTokens = typeof metadata.pre_tokens === "number" ? metadata.pre_tokens : typeof metadata.preTokens === "number" ? metadata.preTokens : undefined;
      const postTokens = typeof metadata.post_tokens === "number" ? metadata.post_tokens : typeof metadata.postTokens === "number" ? metadata.postTokens : undefined;
      const updates: NormalizedProviderUpdate[] = [{ kind: "upsert", item: {
        id: `compaction:${envelope.uuid}`,
        type: "compaction",
        createdAt: envelope.createdAt,
        ...(trigger ? { trigger } : {}),
        ...(preTokens === undefined ? {} : { preTokens }),
        ...(postTokens === undefined ? {} : { postTokens }),
      } }];
      if (postTokens !== undefined) {
        updates.push({ kind: "upsert", item: {
          id: `context:${envelope.uuid}`,
          type: "context_report",
          createdAt: envelope.createdAt,
          total: postTokens,
          ...(memory.lastModel ? { model: claudeModelSelection(memory.lastModel) } : {}),
        } });
      }
      return { ...base, outcome: "handled", updates };
    }
    // Background work: one row per task, re-upserted in place from start to
    // settling (D8). Ambient housekeeping tasks never become rows (spec).
    if (record.subtype === "task_started" || record.subtype === "task_progress" || record.subtype === "task_updated" || record.subtype === "task_notification") {
      return backgroundTaskUpdate(record, memory, base);
    }
    return { ...base, outcome: "ignored" };
  }

  // A heartbeat for a tool still running without output: the row gains an
  // elapsed-time readout in place (spec: a running tool reports elapsed
  // time). Only a tool this memory launched can be updated; reasoning rows
  // are untouched.
  if (type === "tool_progress") {
    const toolUseId = typeof record.tool_use_id === "string" ? record.tool_use_id : "";
    const known = memory.tools.get(toolUseId);
    const seconds = typeof record.elapsed_time_seconds === "number" && Number.isFinite(record.elapsed_time_seconds) ? record.elapsed_time_seconds : undefined;
    if (!known || seconds === undefined || memory.todoTools.has(toolUseId)) return { ...base, outcome: "ignored" };
    return { ...base, outcome: "handled", updates: [{ kind: "upsert", item: {
      id: `tool:${toolUseId}`,
      type: "tool",
      createdAt: known.createdAt,
      name: known.name,
      status: "running",
      ...(known.input === undefined ? {} : { input: known.input }),
      elapsedMs: Math.max(0, Math.round(seconds * 1000)),
    } }] };
  }

  // A streamed frame: text deltas grow the current block's item in place
  // (D10). Thinking deltas are deliberately not streamed — the reasoning row
  // appears when its block completes — and a subagent's stream (parent tool
  // use set) stays out of the parent's timeline.
  if (type === "stream_event") {
    const envelope = envelopeIdentity(record);
    if (!envelope) return { ...base, outcome: "unparseable" };
    if (record.parent_tool_use_id) return { ...base, outcome: "ignored" };
    const event = asRecord(record.event);
    const resumed = resumeAfterTransient(memory);
    if (event.type === "message_start") {
      const messageId = typeof asRecord(event.message).id === "string" ? asRecord(event.message).id as string : "";
      if (messageId) boundedSet(memory.streams, messageId, { createdAt: envelope.createdAt, textBlocks: [], consumed: 0 }, MEMORY_LIMIT);
      memory.currentStream = messageId || undefined;
      return { ...base, outcome: resumed.length ? "handled" : "ignored", updates: resumed };
    }
    const stream = memory.currentStream ? memory.streams.get(memory.currentStream) : undefined;
    const index = typeof event.index === "number" ? event.index : undefined;
    if (!stream || index === undefined) return { ...base, outcome: resumed.length ? "handled" : "ignored", updates: resumed };
    const itemId = `message:stream:${memory.currentStream}:${index}`;
    if (event.type === "content_block_start" && asRecord(event.content_block).type === "text") {
      stream.textBlocks.push(index);
      return { ...base, outcome: "handled", updates: [...resumed, { kind: "upsert", item: { id: itemId, type: "assistant_message", createdAt: envelope.createdAt, markdown: "" } }] };
    }
    if (event.type === "content_block_delta" && asRecord(event.delta).type === "text_delta" && typeof asRecord(event.delta).text === "string" && stream.textBlocks.includes(index)) {
      const text = asRecord(event.delta).text as string;
      if (!text) return { ...base, outcome: "ignored", updates: resumed };
      return { ...base, outcome: "handled", updates: [...resumed, {
        kind: "text", itemId, identity: itemId, mode: "incremental", text,
        item: { id: itemId, type: "assistant_message", createdAt: stream.createdAt, markdown: "" },
      }] };
    }
    return { ...base, outcome: resumed.length ? "handled" : "ignored", updates: resumed };
  }

  // Routine session signals surface as named states and notices, never as
  // silence (D11).
  if (type === "rate_limit_event") {
    const envelope = envelopeIdentity(record);
    if (!envelope) return { ...base, outcome: "unparseable" };
    const info = asRecord(record.rate_limit_info);
    const kind = typeof info.rateLimitType === "string" ? rateLimitKindLabel(info.rateLimitType) : "plan";
    const resetsAt = typeof info.resetsAt === "number" ? normalizeEpoch(info.resetsAt) : undefined;
    // The reset time travels as an epoch (resetsAt) and is formatted where
    // it is shown: the server's clock zone is not the reader's.
    const utilization = typeof info.utilization === "number" ? ` (${Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1))}% used)` : "";
    if (info.status === "rejected") {
      memory.rateLimited = true;
      return { ...base, outcome: "handled", updates: [{ kind: "upsert", item: { id: `notice:rate-limit:${envelope.uuid}`, type: "notice", createdAt: envelope.createdAt, level: "error", code: "rate-limit-rejected", message: `Rate limit reached for your ${kind} window.`, ...(resetsAt === undefined ? {} : { resetsAt }) } }] };
    }
    if (info.status === "allowed_warning") {
      // A warning is a standing too: the later plain "allowed" retires it.
      memory.rateLimited = true;
      return { ...base, outcome: "handled", updates: [{ kind: "upsert", item: { id: `notice:rate-limit:${envelope.uuid}`, type: "notice", createdAt: envelope.createdAt, level: "warning", code: "rate-limit-warning", message: `Approaching your ${kind} rate limit${utilization}.`, ...(resetsAt === undefined ? {} : { resetsAt }) } }] };
    }
    if (memory.rateLimited) {
      memory.rateLimited = false;
      return { ...base, outcome: "handled", updates: [{ kind: "upsert", item: { id: `notice:rate-limit:${envelope.uuid}`, type: "notice", createdAt: envelope.createdAt, level: "info", code: "rate-limit-cleared", message: "Rate limit cleared; requests are allowed again." } }] };
    }
    return { ...base, outcome: "ignored" };
  }

  if (type === "assistant") {
    const envelope = envelopeIdentity(record);
    if (!envelope) return { ...base, outcome: "unparseable" };
    const message = asRecord(record.message);
    const raw = typeof message.model === "string" ? message.model : undefined;
    const reported = raw !== undefined ? (memory.resolveModel?.(raw) ?? raw) : undefined;
    // A frame produced inside a subagent (parent tool use set) speaks for
    // the subagent's own window and model, not the conversation's: it
    // neither moves the remembered model nor carries the parent's window
    // fill. Its content still lands where it did before.
    const subagentFrame = typeof record.parent_tool_use_id === "string" && record.parent_tool_use_id !== "";
    // The init message names the session's model in its full variant form
    // ("...[1m]"); assistant messages report the resolved base id. Keep the
    // variant id — it is what the catalog keys context windows by, so the
    // usage gauge measures against the window actually in effect.
    // A message that names no model belongs to the session's current one —
    // after a refusal fallback, the fallback model (D11).
    const model = reported === undefined
      ? memory.lastModel
      : memory.lastModel?.startsWith(`${reported}[`) ? memory.lastModel : reported;
    if (model && !subagentFrame) memory.lastModel = model;
    const updates: NormalizedProviderUpdate[] = resumeAfterTransient(memory);
    // A frame that supersedes earlier messages (a refusal fallback's
    // canonical replacement) evicts them on arrival.
    updates.push(...evictFrames(record.supersedes, memory));
    // The completed text block is the truth: it replaces the item its text
    // streamed into (D10). The Nth completed text block of an API message
    // is the Nth text block the stream started.
    const stream = typeof message.id === "string" ? memory.streams.get(message.id) : undefined;
    if (stream) {
      for (const block of contentBlocks(message.content)) {
        if (block.type !== "text") continue;
        const index = stream.textBlocks[stream.consumed];
        if (index === undefined) break;
        stream.consumed += 1;
        updates.push({ kind: "remove", itemId: `message:stream:${message.id}:${index}` });
      }
    }
    updates.push(...contentBlockUpdates(asArray(message.content), envelope, memory));
    const usage = subagentFrame ? undefined : tokensToUsage(message.usage);
    // Each assistant message's usage is ONE API call's accounting, and its
    // input + cache read + cache write is the window occupancy after that
    // call. It rides a dedicated empty-markdown carrier (same contract as
    // the OpenCode normalizer) so the readout's tail scan finds the latest
    // single-call figure. The turn's `result` usage is deliberately not a
    // carrier: it sums every call of the turn and would read as several
    // times the window (D1). The CLI emits one frame per completed content
    // block, all sharing message.id: each frame's carrier is keyed by its
    // own uuid (the accounting join needs that) and the occupancy figure is
    // the same request-side count on every block, so the newest wins.
    if (usage) {
      updates.push({ kind: "upsert", item: {
        id: `usage:${envelope.uuid}`,
        type: "assistant_message",
        createdAt: envelope.createdAt,
        markdown: "",
        usage,
        ...(model ? { model: claudeModelSelection(model) } : {}),
      } });
    }
    rememberFrameItems(memory, envelope.uuid, updates);
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
      rememberFrameItems(memory, envelope.uuid, updates);
      return { ...base, outcome: updates.length > 0 ? "handled" : "ignored", updates };
    }
    if (source === "live") {
      // The provider minted this user message when it accepted the prompt.
      return { ...base, outcome: "ignored" };
    }
    // A slash command is stored as tag markup; the bubble shows what was
    // typed, the same fold the session title reads.
    const text = foldCommandMarkup(typeof message.content === "string"
      ? message.content
      : blocks.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text as string).join("\n"));
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
    // The result's usage is the turn's SUM over every API call ("MAIN AGENT
    // LOOP ONLY … per-turn" in the SDK's words). It is neither a window
    // occupancy nor one message's accounting, so nothing here reports it:
    // the per-message carriers above already hold each call's figure.
    // An error result names its cause in `errors` (a rejected model id, a
    // budget cap) or, for some subtypes, in `result`; either is the turn's
    // failed status message, so a bad choice fails visibly rather than
    // silently falling back (spec: the CLI's error, not silence).
    const errors = asArray(record.errors).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
    // The turn is over, whatever it was in the middle of: a later frame
    // must not "resume" a retry or a compaction into a running status.
    memory.transient = undefined;
    const message = !failed ? undefined
      : typeof record.result === "string" && record.result.trim() ? record.result
        : errors.length > 0 ? errors.join("; ") : undefined;
    // Turn status rides the ordered update stream like any other change.
    return {
      ...base,
      outcome: "handled",
      updates: [failed
        ? { kind: "status", status: "failed", ...(message ? { message } : {}) }
        : { kind: "status", status: "completed" }],
    };
  }

  return { ...base, outcome: INTENTIONALLY_IGNORED.has(type) ? "ignored" : "unrecognized" };
}

/** Stored transcript entries → timeline items, in entry order. */
export function normalizeTranscriptEntries(entries: TranscriptEntry[], parentSessionId?: string, resolveModel?: (id: string) => string): {
  items: ConversationItem[];
  accounting: Array<{ messageId: string; createdAt: number; usage?: TokenUsage; model?: string }>;
} {
  const memory = createClaudeEventMemory();
  // Stored history joins on the same catalog aliases as the live stream —
  // otherwise a resync would swap a translated model id for the raw one and
  // detach the context gauge from its window.
  if (resolveModel) memory.resolveModel = resolveModel;
  const items: ConversationItem[] = [];
  const accounting: Array<{ messageId: string; createdAt: number; usage?: TokenUsage; model?: string }> = [];
  for (const entry of entries) {
    const normalized = normalizeClaudeMessage(
      {
        type: entry.kind,
        uuid: entry.uuid,
        timestamp: entry.timestamp,
        message: entry.message,
        ...(entry.subtype ? { subtype: entry.subtype } : {}),
        ...(entry.compactMetadata ? { compactMetadata: entry.compactMetadata } : {}),
        ...(entry.toolUseResult ? { toolUseResult: entry.toolUseResult } : {}),
      },
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
    // The window-fill carrier for a stored assistant message rides its
    // updates, exactly as it does live — one producer for both sources.
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

/** The turn moved on from a retry or a compaction: back to plain running. */
function resumeAfterTransient(memory: ClaudeEventMemory): NormalizedProviderUpdate[] {
  if (!memory.transient) return [];
  memory.transient = undefined;
  return [{ kind: "status", status: "running" }];
}

/** Removes for every item the named frames minted (text, reasoning, tool rows); an unknown frame's text id as a fallback. */
function evictFrames(value: unknown, memory: ClaudeEventMemory): NormalizedProviderUpdate[] {
  // A tool row is minted by its call frame and again by its result frame:
  // one removal per item across the whole retraction.
  const itemIds = new Set<string>();
  for (const uuid of asArray(value)) {
    if (typeof uuid !== "string" || uuid.trim() === "") continue;
    for (const itemId of memory.frameItems.get(uuid) ?? [`message:${uuid}`]) itemIds.add(itemId);
    memory.frameItems.delete(uuid);
  }
  return [...itemIds].map(itemId => ({ kind: "remove" as const, itemId }));
}

/** Records which items a frame minted, so a later retraction of the frame can remove them all. */
function rememberFrameItems(memory: ClaudeEventMemory, uuid: string, updates: NormalizedProviderUpdate[]): void {
  const ids = updates.flatMap(update => update.kind === "upsert" && !update.item.id.startsWith("usage:") ? [update.item.id] : []);
  if (ids.length === 0) return;
  const known = memory.frameItems.get(uuid) ?? [];
  boundedSet(memory.frameItems, uuid, [...new Set([...known, ...ids])], MEMORY_LIMIT);
}

/** Removes for the current stream's text blocks no completed message has consumed; forgets the stream. */
function abandonCurrentStream(memory: ClaudeEventMemory): NormalizedProviderUpdate[] {
  const id = memory.currentStream;
  const stream = id ? memory.streams.get(id) : undefined;
  memory.currentStream = undefined;
  if (!id || !stream) return [];
  memory.streams.delete(id);
  return stream.textBlocks.slice(stream.consumed).map(index => ({ kind: "remove" as const, itemId: `message:stream:${id}:${index}` }));
}

function rateLimitKindLabel(kind: string): string {
  return ({ five_hour: "5-hour", seven_day: "7-day", seven_day_opus: "7-day Opus", seven_day_sonnet: "7-day Sonnet", seven_day_overage_included: "7-day (overage included)", overage: "overage" } as Record<string, string>)[kind] ?? kind.replaceAll("_", " ");
}

/** Epoch seconds and milliseconds both arrive on the wire; normalize to ms. */
function normalizeEpoch(value: number): number {
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

/**
 * task_started / task_progress / task_updated / task_notification → the one
 * `task:<id>` row. The start remembers the description and launch time;
 * progress and patches re-upsert with the latest note; the notification
 * settles the row with its outcome and summary. An edge for a task this
 * memory never saw start (a level-only CLI, a reopen) still gets a row from
 * what the edge itself carries.
 */
function backgroundTaskUpdate(record: RecordValue, memory: ClaudeEventMemory, base: { updates: NormalizedProviderUpdate[]; eventType: string }): Omit<NormalizedProviderEvent, "conversationId"> {
  const taskId = typeof record.task_id === "string" && record.task_id ? record.task_id : "";
  if (!taskId) return { ...base, outcome: "unparseable" };
  const envelope = envelopeIdentity(record) ?? { uuid: taskId, createdAt: Date.now() };
  if (record.ambient === true || record.skip_transcript === true) {
    memory.ambientTasks.add(taskId);
    if (memory.ambientTasks.size > MEMORY_LIMIT) memory.ambientTasks.clear();
    return { ...base, outcome: "ignored" };
  }
  if (memory.ambientTasks.has(taskId)) return { ...base, outcome: "ignored" };
  const known = memory.tasks.get(taskId);
  const description = typeof record.description === "string" && record.description ? record.description : known?.description;
  const patch = asRecord(record.patch);
  // Only work the agent actually sent to the background is a background
  // task: a blocking command or a foreground subagent emits the same edges
  // with `is_backgrounded` false and is already shown as its tool row. The
  // flag arrives on the start edge, on a later patch (a foreground task
  // moved to the background), or through the level signal (see
  // markTasksBackgrounded); until then the edges are remembered but silent.
  const backgrounded = record.is_backgrounded === true || patch.is_backgrounded === true || known?.backgrounded === true;
  const patchedDescription = typeof patch.description === "string" && patch.description ? patch.description : undefined;
  const taskType = typeof record.task_type === "string" && record.task_type ? record.task_type : known?.taskType;
  const toolUseId = typeof record.tool_use_id === "string" && record.tool_use_id ? record.tool_use_id : known?.toolUseId;
  const createdAt = known?.createdAt ?? envelope.createdAt;
  const finalDescription = patchedDescription ?? description ?? (backgrounded && record.subtype === "task_notification" ? "Background task" : undefined);
  // An unnamed edge for work never known to run in the background says
  // nothing (a stray notification); an unnamed background edge is malformed.
  if (!finalDescription) return { ...base, outcome: backgrounded ? "unparseable" : "ignored" };
  if (!backgrounded) {
    // Foreground so far: keep what the edge said so a later promotion or
    // the level signal can name the task, but show nothing.
    boundedSet(memory.tasks, taskId, { description: finalDescription, ...(taskType ? { taskType } : {}), ...(toolUseId ? { toolUseId } : {}), createdAt }, MEMORY_LIMIT);
    return { ...base, outcome: "ignored" };
  }
  // Progress note: a summary while running, else the last tool it used.
  const progress = record.subtype === "task_progress"
    ? (typeof record.summary === "string" && record.summary ? record.summary
      : typeof record.last_tool_name === "string" && record.last_tool_name ? `Using ${record.last_tool_name}` : known?.progress)
    : known?.progress;
  let status: "running" | "completed" | "failed" | "stopped" = "running";
  let summary: string | undefined;
  if (record.subtype === "task_notification") {
    status = record.status === "failed" ? "failed" : record.status === "stopped" ? "stopped" : "completed";
    summary = typeof record.summary === "string" && record.summary ? record.summary : undefined;
  } else if (record.subtype === "task_updated") {
    if (patch.status === "failed") status = "failed";
    else if (patch.status === "killed") status = "stopped";
    else if (patch.status === "completed") status = "completed";
    if (typeof patch.error === "string" && patch.error) summary = patch.error;
  }
  // `announced`: a row for this task has been emitted, so the level signal
  // need not mint one.
  boundedSet(memory.tasks, taskId, { description: finalDescription, ...(taskType ? { taskType } : {}), ...(toolUseId ? { toolUseId } : {}), createdAt, ...(progress ? { progress } : {}), backgrounded: true, announced: true, ...(status !== "running" ? { settled: true } : {}) }, MEMORY_LIMIT);
  return { ...base, outcome: "handled", updates: [{ kind: "upsert", item: {
    id: `task:${taskId}`,
    type: "background_task",
    createdAt,
    taskId,
    description: finalDescription,
    ...(taskType ? { taskType } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    status,
    ...(status === "running" && progress ? { progress } : {}),
    ...(summary ? { summary } : {}),
  } }] };
}

/**
 * The level signal's word on what runs in the background: every listed
 * non-ambient id is a background task from here on, whether or not its
 * start edge said so (the level precedes the edges in practice).
 */
export function markTasksBackgrounded(memory: ClaudeEventMemory, tasks: Array<{ taskId: string; description?: string; taskType?: string }>, createdAt: number): void {
  for (const task of tasks) {
    // The level names it as user work now, whatever an earlier edge said.
    memory.ambientTasks.delete(task.taskId);
    const known = memory.tasks.get(task.taskId);
    boundedSet(memory.tasks, task.taskId, {
      description: known?.description ?? task.description ?? "Background task",
      ...(known?.taskType ?? task.taskType ? { taskType: known?.taskType ?? task.taskType! } : {}),
      ...(known?.toolUseId ? { toolUseId: known.toolUseId } : {}),
      createdAt: known?.createdAt ?? createdAt,
      ...(known?.progress ? { progress: known.progress } : {}),
      backgrounded: true,
      ...(known?.announced ? { announced: true } : {}),
      ...(known?.settled ? { settled: true } : {}),
    }, MEMORY_LIMIT);
  }
}

/**
 * The control channel's `get_context_usage` answer → a context report item.
 * Categories keep the CLI's own names; `kind` is derived so the readout can
 * list what occupies the window (`used`) and leave the free remainder and
 * deferred tool schemas out of the sum — the used rows add up to the total
 * the CLI states (spec: the breakdown's total matches the presented fill).
 */
export function normalizeContextUsage(value: unknown, createdAt: number, model?: string): ContextReportItem | null {
  const record = asRecord(value);
  if (typeof record.totalTokens !== "number" || !Number.isFinite(record.totalTokens) || record.totalTokens < 0) return null;
  const max = typeof record.maxTokens === "number" && record.maxTokens > 0 ? record.maxTokens
    : typeof record.rawMaxTokens === "number" && record.rawMaxTokens > 0 ? record.rawMaxTokens : undefined;
  const categories = asArray(record.categories).flatMap(entry => {
    const category = asRecord(entry);
    if (typeof category.name !== "string" || !category.name || typeof category.tokens !== "number" || category.tokens < 0) return [];
    const kind = category.isDeferred === true || /\(deferred\)/i.test(category.name) ? "deferred" as const
      : /free space/i.test(category.name) ? "free" as const
        : /buffer/i.test(category.name) ? "buffer" as const
          : "used" as const;
    return [{ name: category.name, tokens: Math.round(category.tokens), kind }];
  });
  return {
    // Two reports in the same millisecond say the same thing; one id per
    // instant keeps the projection from accumulating duplicates.
    id: `context:report:${createdAt}`,
    type: "context_report",
    createdAt,
    total: Math.round(record.totalTokens),
    ...(max === undefined ? {} : { max: Math.round(max) }),
    ...(model ? { model: claudeModelSelection(model) } : {}),
    ...(categories.length > 0 ? { categories } : {}),
  };
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
