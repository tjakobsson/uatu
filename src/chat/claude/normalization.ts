import { boundedSet } from "../../shared/bounded-map";
import { measureChatWork } from "../performance";
import { claudeWindowAnswer } from "./context-window";
import type { NormalizedProviderEvent, NormalizedProviderUpdate } from "../provider";
import { LOGIN_FAILED_NOTICE_CODE as LOGIN_FAILED_CODE, RATE_LIMIT_ITEM_ID, REAUTHENTICATING_NOTICE_CODE as REAUTHENTICATING_CODE, type BackgroundTaskUsage, type ContextReportItem, type ConversationItem, type MessageAttachment, type ModelSelection, type StructuredQuestion, type TokenUsage } from "../types";
import { foldCommandMarkup, parseTaskNotification, readsAsTaskNotification, readsAsWakeupPrompt, scheduledWakeupPrompt, type TranscriptEntry } from "./transcript";

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
  // `childConversationId`: the subagent run a launching tool use started,
  // learned from the task's start edge before the tool result names it, so a
  // later re-upsert of the row cannot drop it. `resultSeen` says the result
  // has already replaced the row, so nothing may re-emit its launch shape.
  tools: Map<string, { name: string; input?: string; createdAt: number; childConversationId?: string; resultSeen?: boolean }>;
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
  tasks: Map<string, BackgroundTaskMemory>;
  ambientTasks: Set<string>;
  // Agent runs the CLI marks ambient — a skill the model forks, the run a
  // typed command launches — by task id (design D13). They are runs, not
  // housekeeping, but not background work either, so they are kept apart
  // from `tasks`: nothing that reads the background set can see them.
  ambientRuns: Map<string, AmbientRunMemory>;
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
  // The rate-limit standing in force, with the moment the conversation
  // entered it. A standing is a state, not an event: the login restates it
  // on every request, and all those restatements are this one record, so a
  // return to allowed retires one item rather than appending a third notice.
  rateLimit?: { level: "warning" | "rejected"; since: number };
  // The turn failed on the login (an assistant frame named the login
  // error): its failed status then says nothing more, the login notice
  // carries the agent's words.
  loginFailed?: boolean;
  // An `auth_status` notice is on show (the CLI is signing in again).
  authStatus?: boolean;
  // Prompts earlier scheduling calls (ScheduleWakeup, CronCreate) asked to
  // be woken with: how a stored fired wakeup is told from other injected
  // records where the store names no turn origin (D8).
  wakeupPrompts?: Set<string>;
};

/**
 * What a background task is and has done, as the CLI's edges and the
 * launching tool's result report it. Kept on the memory entry so every
 * later edge re-upserts the row with all of it, and mirrored by the
 * provider onto its live list so a reopened conversation's seeded row is
 * as complete as the live one.
 */
export type BackgroundTaskFacts = {
  subagentType?: string;
  prompt?: string;
  usage?: BackgroundTaskUsage;
  outputFile?: string;
  childConversationId?: string;
};

export type BackgroundTaskMemory = BackgroundTaskFacts & {
  description: string;
  taskType?: string;
  toolUseId?: string;
  createdAt: number;
  progress?: string;
  backgrounded?: boolean;
  announced?: boolean;
  settled?: boolean;
};

/**
 * What an ambient agent run's start edge said, so its later edges (which
 * may not repeat the task type) are still recognised as the run's.
 * `toolUseId` is the launching tool use a forked skill has; a typed
 * command's run has none, and is the one that gets a row of its own.
 */
export type AmbientRunMemory = {
  description: string;
  taskType?: string;
  toolUseId?: string;
  subagentType?: string;
  childConversationId?: string;
  createdAt: number;
  progress?: string;
  settled?: boolean;
};

export function createClaudeEventMemory(): ClaudeEventMemory {
  return { tools: new Map(), todoTools: new Set(), tasks: new Map(), ambientTasks: new Set(), ambientRuns: new Map(), streams: new Map(), frameItems: new Map() };
}

/**
 * Whether a `task_started` edge starts an agent run: a `local_agent` task,
 * or — for a task the CLI does not mark ambient — one that names a subagent
 * type. An ambient task must say `local_agent` outright; every other ambient
 * task (a monitor, a watcher) is housekeeping (design D13).
 */
export function startsAgentRun(record: Record<string, unknown>): boolean {
  if (record.task_type === "local_agent") return true;
  const ambient = record.ambient === true || record.skip_transcript === true;
  return !ambient && typeof record.subagent_type === "string" && record.subagent_type !== "";
}


// The assistant-frame errors that mean the login, not the request, failed
// (the SDK's SDKAssistantMessageError).
const LOGIN_ERRORS: ReadonlySet<string> = new Set(["authentication_failed", "oauth_org_not_allowed"]);
// The one item an `auth_status` sequence occupies.
const AUTH_STATUS_ITEM_ID = "notice:auth-status";
const MEMORY_LIMIT = 2_048;

// Message types, and `system` subtypes, the SDK emits that deliberately
// carry nothing for the timeline: progress, telemetry, and control chatter
// whose terminal states are carried elsewhere.
export const INTENTIONALLY_IGNORED: ReadonlySet<string> = new Set([
  "control_request_progress",
  "hook_started",
  "hook_progress",
  "hook_response",
  "plugin_install",
  "background_tasks_changed",
  "thinking_tokens",
  "session_state_changed",
  "worker_shutting_down",
  "commands_changed",
  "tool_use_summary",
  "prompt_suggestion",
  "mirror_error",
  "user_message_replay",
  // A queued command's lifecycle edge. The one that matters here — a fired
  // wakeup's prompt starting — is read from the UserPromptSubmit hook, which
  // carries the prompt this frame does not (claude-scheduled-wakeups, D4).
  "command_lifecycle",
]);

/**
 * The permission updates an "always" reply forwards, and nothing else: the
 * SDK's session-destination suggestions, as a set. An approval uatu brokered
 * must never outlive the session it was given in, so a suggestion bound for
 * a settings file is dropped. Within the session the whole bundle goes:
 * Claude Code's own "always allow" applies its suggestions together, and a
 * bundle that adds an allow while removing or denying something else would
 * leave a more permissive state if only the addition were applied. A
 * suggestion this code cannot describe is dropped whole rather than
 * forwarded unseen. `describeSessionScopedUpdates` renders exactly this
 * list, so the confirmation can never diverge from the reply.
 */
export function sessionScopedSuggestions(suggestions: unknown[] | undefined): unknown[] {
  return sessionScopedUpdates(suggestions).map(update => update.suggestion);
}

/** The forwarded updates, one line each, in Claude Code's own terms. */
export function describeSessionScopedUpdates(suggestions: unknown[] | undefined): string[] {
  return sessionScopedUpdates(suggestions).map(update => update.description);
}

// One pass keeps each forwarded suggestion with its description, so the
// list the card shows and the list the reply sends cannot disagree.
function sessionScopedUpdates(suggestions: unknown[] | undefined): Array<{ suggestion: unknown; description: string }> {
  return (suggestions ?? []).flatMap(suggestion => {
    const description = describeSessionScopedUpdate(suggestion);
    return description === null ? [] : [{ suggestion, description }];
  });
}

// One suggestion → one line in Claude Code's own terms: rules in its
// permission-rule spelling (`Bash(git status:*)`, bare `Read`) under the
// behavior they are added to, replaced in, or removed from; a working
// directory granted or withdrawn; a mode switch. Null when the reply would
// not forward it.
function describeSessionScopedUpdate(suggestion: unknown): string | null {
  if (!suggestion || typeof suggestion !== "object") return null;
  const record = suggestion as Record<string, unknown>;
  if (record.destination !== "session") return null;
  if (record.type === "addRules" || record.type === "replaceRules" || record.type === "removeRules") {
    const behavior = record.behavior === "allow" || record.behavior === "deny" || record.behavior === "ask" ? record.behavior : null;
    if (!behavior) return null;
    const rules = describeRules(record.rules);
    if (!rules) return null;
    const verb = record.type === "addRules" ? RULE_VERBS[behavior] : record.type === "replaceRules" ? `Replace ${behavior} rules with` : `Remove ${behavior} rule`;
    return `${verb}: ${rules}`;
  }
  if (record.type === "addDirectories" || record.type === "removeDirectories") {
    if (!Array.isArray(record.directories) || record.directories.length === 0) return null;
    if (!record.directories.every(directory => typeof directory === "string" && directory.length > 0)) return null;
    return `${record.type === "addDirectories" ? "Working directory" : "Withdraw working directory"}: ${(record.directories as string[]).join(", ")}`;
  }
  if (record.type === "setMode" && typeof record.mode === "string" && record.mode.length > 0) return `Permission mode: ${record.mode}`;
  return null;
}

const RULE_VERBS = { allow: "Allow", deny: "Deny", ask: "Ask before" } as const;

// Every rule must be describable, or the suggestion is not forwarded at all:
// forwarding a rule the card could not show would break the promise that
// the list is exactly what the reply installs.
function describeRules(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rules: string[] = [];
  for (const rule of value) {
    if (!rule || typeof rule !== "object") return null;
    const { toolName, ruleContent } = rule as { toolName?: unknown; ruleContent?: unknown };
    if (typeof toolName !== "string" || toolName.length === 0) return null;
    if (ruleContent !== undefined && (typeof ruleContent !== "string" || ruleContent.length === 0)) return null;
    rules.push(ruleContent === undefined ? toolName : `${toolName}(${ruleContent})`);
  }
  return rules.join(", ");
}

/**
 * What a tool-approval request becomes (D5): `AskUserQuestion` a structured
 * question card, a completed plan (`ExitPlanMode`) its own review card, and
 * every other tool the generic permission card.
 */
export type ClaudeToolInteraction =
  | { kind: "question"; questions: StructuredQuestion[] }
  | { kind: "plan"; plan: string }
  | { kind: "permission" };

export function claudeToolInteraction(toolName: string, input: Record<string, unknown>): ClaudeToolInteraction {
  const questions = toolName === "AskUserQuestion" ? normalizeAskUserQuestions(input) : null;
  if (questions) return { kind: "question", questions };
  if (toolName === "ExitPlanMode" && typeof input.plan === "string") return { kind: "plan", plan: input.plan };
  return { kind: "permission" };
}

/** AskUserQuestion input → the shared structured-question shape. */
export function normalizeAskUserQuestions(input: Record<string, unknown>): StructuredQuestion[] | null {
  if (!Array.isArray(input.questions) || input.questions.length === 0) return null;
  const questions: StructuredQuestion[] = [];
  for (const value of input.questions) {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.question !== "string") return null;
    const options = Array.isArray(record.options)
      ? record.options.flatMap(option => {
        if (!option || typeof option !== "object") return [];
        const optionRecord = option as Record<string, unknown>;
        if (typeof optionRecord.label !== "string") return [];
        return [{ label: optionRecord.label, description: typeof optionRecord.description === "string" ? optionRecord.description : "" }];
      })
      : [];
    questions.push({
      prompt: record.question,
      header: typeof record.header === "string" ? record.header : "",
      options,
      multiple: record.multiSelect === true,
      // Claude Code's "Other" free-form entry is host-provided, not an
      // option in the schema — the host always offers it.
      allowFreeForm: true,
    });
  }
  return questions;
}

export function claudeModelSelection(modelId: string): ModelSelection {
  return { providerId: "anthropic", modelId };
}

/**
 * One SDK stream message → the shared provider-event envelope, minus the
 * conversation id (the owning session stamps it).
 *
 * Public boundary: every failure mode resolves to an outcome rather than an
 * exception, so a recognized message whose payload breaks its case costs one
 * message instead of the session's pump (the OpenCode boundary's rule).
 */
export function normalizeClaudeMessage(
  value: unknown,
  memory: ClaudeEventMemory,
  source: ClaudeNormalizationSource,
  // The owning native session, when known: what a Task completion's child
  // conversation id is derived from (`sub:<parent>:<agentId>`).
  parentSessionId?: string,
): Omit<NormalizedProviderEvent, "conversationId"> {
  try {
    return normalizeMessage(value, memory, source, parentSessionId);
  } catch {
    const type = asRecord(value).type;
    return { updates: [], eventType: typeof type === "string" ? type : "", outcome: "unparseable" };
  }
}

function normalizeMessage(
  value: unknown,
  memory: ClaudeEventMemory,
  source: ClaudeNormalizationSource,
  parentSessionId: string | undefined,
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
    if (record.subtype === "init") {
      // An init that names no model has nothing to configure.
      if (!model) return { ...base, outcome: "ignored" };
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
    // A typed command's output, as the store keeps it (design D15). Live,
    // the same output arrived as a `<synthetic>` assistant frame carrying
    // `local_command_source` under this very uuid, so the reopened row is
    // the live one: same id, same text, no model and no usage.
    if (record.subtype === "local_command") {
      const envelope = envelopeIdentity(record);
      if (!envelope) return { ...base, outcome: "unparseable" };
      const output = localCommandOutput(record.content);
      if (!output) return { ...base, outcome: "ignored" };
      return { ...base, outcome: "handled", updates: [{ kind: "upsert", item: {
        id: `message:${envelope.uuid}`,
        type: "assistant_message",
        createdAt: envelope.createdAt,
        markdown: output,
        completedAt: envelope.createdAt,
      } }] };
    }
    // Background work: one row per task, re-upserted in place from start to
    // settling (D8). Ambient housekeeping tasks never become rows (spec).
    if (record.subtype === "task_started" || record.subtype === "task_progress" || record.subtype === "task_updated" || record.subtype === "task_notification") {
      return backgroundTaskUpdate(record, memory, base, parentSessionId);
    }
    // A subtype with no case is dropped on purpose only when the ignore list
    // names it; anything else is new vocabulary, counted under its subtype so
    // the discard metric says which one.
    const subtype = typeof record.subtype === "string" && record.subtype ? record.subtype : "";
    if (INTENTIONALLY_IGNORED.has(subtype)) return { ...base, outcome: "ignored" };
    return { ...base, outcome: "unrecognized", eventType: subtype ? `system.${subtype}` : "system" };
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
  // use set) stays out of the parent's timeline. A known run's stream never
  // gets here: the provider normalizes it, untagged, with the child's own
  // memory (design D8); only an unknown run's reaches this frame.
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
    // One item for the standing, whatever the login says and however often
    // it says it: the onset is kept from the first report so a conversation
    // held at one standing does not restate it, and a level that hardens
    // from warning to rejection updates the same row in place.
    const standing = info.status === "rejected" ? "rejected" as const
      : info.status === "allowed_warning" ? "warning" as const : undefined;
    if (standing) {
      const since = memory.rateLimit?.since ?? envelope.createdAt;
      memory.rateLimit = { level: standing, since };
      const item: ConversationItem = standing === "rejected"
        ? { id: RATE_LIMIT_ITEM_ID, type: "notice", createdAt: since, level: "error", code: "rate-limit-rejected", message: `Rate limit reached for your ${kind} window.`, ...(resetsAt === undefined ? {} : { resetsAt }) }
        : { id: RATE_LIMIT_ITEM_ID, type: "notice", createdAt: since, level: "warning", code: "rate-limit-warning", message: `Approaching your ${kind} rate limit${utilization}.`, ...(resetsAt === undefined ? {} : { resetsAt }) };
      return { ...base, outcome: "handled", updates: [{ kind: "upsert", item }] };
    }
    // Allowed again: the standing ended. A state that ended is retired, not
    // announced as a further row — the surface says so where it showed the
    // standing. An allowed event with nothing in force says nothing at all.
    if (memory.rateLimit) {
      memory.rateLimit = undefined;
      return { ...base, outcome: "handled", updates: [{ kind: "remove", itemId: RATE_LIMIT_ITEM_ID }] };
    }
    return { ...base, outcome: "ignored" };
  }

  // The CLI re-authenticating mid-session: one notice while it runs, kept as
  // a login failure if it fails, retired if it succeeds.
  if (type === "auth_status") {
    const envelope = envelopeIdentity(record);
    if (!envelope) return { ...base, outcome: "unparseable" };
    const output = asArray(record.output).filter((line): line is string => typeof line === "string" && line.trim() !== "").join(" ").trim();
    const error = typeof record.error === "string" ? record.error.trim() : "";
    if (record.isAuthenticating === true || error) {
      memory.authStatus = true;
      const item: ConversationItem = error
        ? { id: AUTH_STATUS_ITEM_ID, type: "notice", createdAt: envelope.createdAt, level: "error", code: LOGIN_FAILED_CODE, message: error }
        : { id: AUTH_STATUS_ITEM_ID, type: "notice", createdAt: envelope.createdAt, level: "info", code: REAUTHENTICATING_CODE, message: output || "Claude Code is signing in again." };
      return { ...base, outcome: "handled", updates: [{ kind: "upsert", item }] };
    }
    if (memory.authStatus) {
      memory.authStatus = false;
      return { ...base, outcome: "handled", updates: [{ kind: "remove", itemId: AUTH_STATUS_ITEM_ID }] };
    }
    return { ...base, outcome: "ignored" };
  }

  if (type === "assistant") {
    const envelope = envelopeIdentity(record);
    if (!envelope) return { ...base, outcome: "unparseable" };
    const message = asRecord(record.message);
    // The login is missing, expired, or refused: the CLI writes a synthetic
    // message saying so. It becomes the login-failure notice, which carries
    // the CLI's words as its detail and which the surface presents with a
    // way to log in, rather than an assistant reply.
    if (typeof record.error === "string" && LOGIN_ERRORS.has(record.error)) {
      memory.loginFailed = true;
      const text = contentBlocks(message.content)
        .flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text.trim()] : [])
        .filter(Boolean)
        .join("\n");
      return {
        ...base,
        outcome: "handled",
        updates: [...resumeAfterTransient(memory), { kind: "upsert", item: {
          id: `notice:login:${envelope.uuid}`,
          type: "notice",
          createdAt: envelope.createdAt,
          level: "error",
          code: LOGIN_FAILED_CODE,
          message: text || "Claude Code has no usable login.",
        } }],
      };
    }
    const raw = typeof message.model === "string" ? message.model : undefined;
    const reported = raw !== undefined ? (memory.resolveModel?.(raw) ?? raw) : undefined;
    // A frame produced inside a subagent (parent tool use set) speaks for
    // the subagent's own window and model, not the conversation's: it
    // neither moves the remembered model nor carries the parent's window
    // fill. Its content still lands where it did before.
    const subagentFrame = typeof record.parent_tool_use_id === "string" && record.parent_tool_use_id !== "";
    // A frame the CLI wrote rather than a model: a typed command's output
    // (`local_command_source`, design D15) or any other `<synthetic>`
    // message. Its text is shown as it always was, but it names no model and
    // spends nothing — its zeroed usage is no API call's accounting, and as
    // a carrier it would read as an empty context window.
    const synthetic = typeof record.local_command_source === "string" || raw === "<synthetic>";
    // The init message names the session's model in its full variant form
    // ("...[1m]"); assistant messages report the resolved base id. Keep the
    // variant id — it is what the catalog keys context windows by, so the
    // usage gauge measures against the window actually in effect.
    // A message that names no model belongs to the session's current one —
    // after a refusal fallback, the fallback model (D11).
    const model = synthetic ? undefined
      : reported === undefined
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
    // A subagent's frame that still reaches the parent's normalizer is one
    // whose run the provider does not know (no task edge named its agent
    // id: a Skill fork on a CLI that names it only at its end, an older
    // CLI) — a known run's frames are normalized
    // untagged with the child's own memory and never come here (design D8,
    // provider `routeSubagentFrame`). Such a frame contributes only its
    // tool blocks, as it did before the query asked for subagent text
    // (forwardSubagentText): its text and thinking are the child
    // transcript's, not the parent's, and are dropped, not shown twice.
    // Dropping this frame's text and thinking is deliberate, not a skip;
    // a block type no walker reads is still counted, whoever's frame it is.
    const content = asArray(message.content);
    const blocks = subagentFrame
      ? content.filter(block => asRecord(block).type === "tool_use")
      : content;
    const skippedBlocks: string[] = subagentFrame ? skippedBlockTypes(content, ASSISTANT_BLOCKS) : [];
    updates.push(...contentBlockUpdates(blocks, envelope, memory, skippedBlocks));
    const usage = subagentFrame || synthetic ? undefined : tokensToUsage(message.usage);
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
    if (!subagentFrame && record.context_usage) {
      const context = asRecord(record.context_usage);
      const reportedModel = typeof context.model === "string" ? memory.resolveModel?.(context.model) ?? context.model : memory.lastModel;
      const report = normalizeContextUsage({ ...context, totalTokens: context.total_tokens }, envelope.createdAt, reportedModel);
      if (report) updates.push({ kind: "upsert", item: report });
    }
    rememberFrameItems(memory, envelope.uuid, updates);
    return {
      ...base,
      outcome: subagentFrame && updates.length === 0 ? "ignored" : "handled",
      updates,
      ...(usage ? { assistantUsage: { messageId: envelope.uuid, usage } } : {}),
      ...(model ? { assistantModel: { messageId: envelope.uuid, model, createdAt: envelope.createdAt } } : {}),
      ...(skippedBlocks.length ? { skippedBlocks } : {}),
    };
  }

  if (type === "user") {
    const envelope = envelopeIdentity(record);
    if (!envelope) return { ...base, outcome: "unparseable" };
    const message = asRecord(record.message);
    const blocks = contentBlocks(message.content);
    // Unknown blocks are reported whatever becomes of the frame — a live
    // echo or an otherwise empty record is dropped, but what it carried
    // that no reader handles is still counted.
    const skipped = skippedBlockTypes(blocks, USER_BLOCKS);
    const frame = { ...base, ...(skipped.length ? { skippedBlocks: skipped } : {}) };
    const results = blocks.filter(block => block.type === "tool_result");
    if (results.length > 0) {
      // The frame's structured result is one object naming no tool use: it
      // describes the frame's result only when there is exactly one. Claude
      // Code writes each result in a frame of its own, parallel calls
      // included; were several ever batched, lending one outcome to all of
      // them would put one run's agent, model, and usage on every row.
      const toolOutcome = results.length === 1 ? asRecord(record.toolUseResult ?? record.tool_use_result) : {};
      const updates = results.flatMap(block => toolResultUpdate(block, envelope, memory, toolOutcome, parentSessionId));
      rememberFrameItems(memory, envelope.uuid, updates);
      return { ...frame, outcome: updates.length > 0 ? "handled" : "ignored", updates };
    }
    if (source === "live") {
      // The provider minted this user message when it accepted the prompt.
      return { ...frame, outcome: "ignored" };
    }
    const rawText = typeof message.content === "string"
      ? message.content
      : blocks.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text as string).join("\n");
    // The prompt a fired wakeup submitted opens that wakeup's turn: it
    // replays as a wakeup header, not as the person's words and not as
    // nothing (D8). No pending row replays with it — the session that held
    // the schedule is gone.
    const turnOrigin = typeof record.turnOrigin === "string" ? record.turnOrigin : undefined;
    if (readsAsWakeupPrompt({ ...(turnOrigin ? { turnOrigin } : {}), ...(record.isMeta === true ? { isMeta: true } : {}) }, rawText, memory.wakeupPrompts ?? new Set())) {
      return { ...frame, outcome: "handled", updates: [{ kind: "upsert", item: { id: `message:${envelope.uuid}`, type: "user_message", createdAt: envelope.createdAt, text: rawText, origin: "wakeup" } }] };
    }
    // A record the CLI wrote on the person's behalf — a skill's preamble,
    // a local-command caveat, an image caption — is not the person's words
    // and gets no bubble (spec: harness-authored records are never
    // presented as the user's messages).
    if (record.isMeta === true) return { ...frame, outcome: "ignored" };
    // The store keeps no task edges; what it keeps of a background task is
    // the notification the model was sent when the task settled, as a
    // user record. That becomes the same settled row the live stream
    // builds from its `task_notification` — never a bubble of markup.
    //
    // Authorship decides, and the envelope's shape only stands in where the
    // store states none: records written before `origin` existed have
    // nothing else to go on. A person who pastes nothing but an envelope —
    // asking what it is, say — is still a person, and their message must
    // not be swallowed and reissued as a task that never ran.
    const authored = typeof record.origin === "string" ? record.origin : undefined;
    if (readsAsTaskNotification(authored, rawText)) {
      const notification = parseTaskNotification(rawText);
      // A notification that fails to parse shows nothing rather than its markup.
      if (!notification) return { ...frame, outcome: "ignored" };
      return backgroundTaskUpdate(storedNotificationRecord(notification, record, memory), memory, frame, parentSessionId);
    }
    // A slash command is stored as tag markup; the bubble shows what was
    // typed, the same fold the session title reads.
    const text = foldCommandMarkup(rawText);
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
    if (!text && attachments.length === 0) return { ...frame, outcome: "ignored" };
    return {
      ...frame,
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
    // A turn that failed on the login already says so in its notice; its
    // status adds nothing but the same words again.
    const loginFailed = memory.loginFailed === true;
    memory.loginFailed = false;
    const message = !failed || loginFailed ? undefined
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
  const finish = measureChatWork("claude-normalize");
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
        ...(entry.content !== undefined ? { content: entry.content } : {}),
        ...(entry.toolUseResult ? { toolUseResult: entry.toolUseResult } : {}),
        ...(entry.origin ? { origin: entry.origin } : {}),
        ...(entry.isMeta ? { isMeta: true } : {}),
        ...(entry.turnOrigin ? { turnOrigin: entry.turnOrigin } : {}),
        ...(entry.error ? { error: entry.error } : {}),
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
  finish();
  return { items, accounting };
}

type Envelope = { uuid: string; createdAt: number; reportedAt?: number };

function envelopeIdentity(record: RecordValue): Envelope | null {
  const uuid = typeof record.uuid === "string" && record.uuid ? record.uuid : null;
  if (!uuid) return null;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp)
    : typeof record.timestamp === "number" ? record.timestamp : Date.now();
  const reportedAt = record.timestamp !== undefined && Number.isFinite(timestamp) && timestamp >= 0
    && (typeof record.timestamp === "string" || typeof record.timestamp === "number") ? timestamp : undefined;
  return { uuid, createdAt: Number.isNaN(timestamp) ? Date.now() : timestamp, ...(reportedAt === undefined ? {} : { reportedAt }) };
}

type Block = { type?: string } & RecordValue;

function contentBlocks(content: unknown): Block[] {
  return asArray(content).filter((block): block is Block => Boolean(block) && typeof block === "object");
}

// Block types each role's walker reads. Anything else inside a recognized
// message is skipped and reported by type (never payload), so an unknown
// block is measured the way an unknown message is.
const ASSISTANT_BLOCKS: ReadonlySet<string> = new Set(["text", "thinking", "tool_use"]);
const USER_BLOCKS: ReadonlySet<string> = new Set(["text", "image", "tool_result"]);

function skippedBlockTypes(blocks: unknown[], known: ReadonlySet<string>): string[] {
  return blocks.flatMap(value => {
    const type = asRecord(value).type;
    const name = typeof type === "string" && type ? type : "unknown";
    return known.has(name) ? [] : [name];
  });
}

function contentBlockUpdates(content: unknown[], envelope: Envelope, memory: ClaudeEventMemory, skipped: string[]): NormalizedProviderUpdate[] {
  const updates: NormalizedProviderUpdate[] = [];
  const texts: string[] = [];
  let reasoningIndex = 0;
  skipped.push(...skippedBlockTypes(content, ASSISTANT_BLOCKS));
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
      const wakeupPrompt = scheduledWakeupPrompt(name, block.input);
      if (wakeupPrompt !== undefined) {
        memory.wakeupPrompts ??= new Set();
        if (memory.wakeupPrompts.size >= MEMORY_LIMIT) memory.wakeupPrompts.clear();
        memory.wakeupPrompts.add(wakeupPrompt);
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

function toolResultUpdate(block: Block, envelope: Envelope, memory: ClaudeEventMemory, toolOutcome: RecordValue = {}, parentSessionId?: string): NormalizedProviderUpdate[] {
  const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
  if (!toolUseId) return [];
  // A TodoWrite result confirms a surface the task-progress item already
  // shows; a row for it would be exactly the per-update spam D9 forbids.
  if (memory.todoTools.has(toolUseId)) return [];
  const known = memory.tools.get(toolUseId);
  const failed = block.is_error === true;
  const output = block.content === undefined ? undefined : resultOutput(block.content);
  // A Task completion names its subagent run: the child transcript becomes
  // an openable drill-down, and the store's own accounting lands as the
  // launching row's attribution (spec: the row states model and tokens).
  // A backgrounded Agent's result is complete at launch (spike): the same
  // `agentId` arrives with `isAsync`, so the row is openable from the start.
  // The task's start edge may already have named the run (see
  // `launchingRowUpdate`); this result re-upserts the whole row, so it takes
  // the id from memory where its own payload does not carry one — a foreground
  // Agent result that reports no `agentId` must not un-open the row.
  const agentId = typeof toolOutcome.agentId === "string" && toolOutcome.agentId ? toolOutcome.agentId : undefined;
  const childConversationId = (agentId && parentSessionId ? `sub:${parentSessionId}:${agentId}` : undefined) ?? known?.childConversationId;
  if (known) boundedSet(memory.tools, toolUseId, { ...known, resultSeen: true, ...(childConversationId ? { childConversationId } : {}) }, MEMORY_LIMIT);
  const attributedModel = typeof toolOutcome.resolvedModel === "string" && toolOutcome.resolvedModel ? toolOutcome.resolvedModel : undefined;
  const attributedUsage = tokensToUsage(toolOutcome.usage);
  const updates: NormalizedProviderUpdate[] = [{ kind: "upsert", item: {
    id: `tool:${toolUseId}`,
    type: "tool",
    // The launch time, when remembered: a completion re-upserts the whole
    // row and must not move it in the timeline.
    createdAt: known?.createdAt ?? envelope.createdAt,
    name: known?.name ?? "tool",
    status: failed ? "failed" : "completed",
    // This user frame contains the result for tool_use_id, not the call or
    // the turn's aggregate result. Older SDK emitters omit its timestamp.
    ...(envelope.reportedAt === undefined ? {} : { completedAt: envelope.reportedAt }),
    ...(known?.input === undefined ? {} : { input: known.input }),
    ...(output === undefined ? {} : failed ? { error: output } : { output }),
    ...(childConversationId ? { childConversationId } : {}),
    ...(attributedModel ? { model: attributedModel } : {}),
    ...(attributedUsage ? { usage: attributedUsage } : {}),
  } }];
  // The launching result is the first thing to name where a background
  // task's output goes: a backgrounded shell command says so in its text
  // (the structured BashOutput carries only the id), a backgrounded Agent in
  // its async AgentOutput (`outputFile`, `prompt`, `agentId` = task id).
  const launched = launchedTaskFacts(block, toolOutcome, parentSessionId);
  if (launched) updates.push(...rememberLaunchedTask(launched.taskId, launched.facts, known?.input, toolUseId, envelope, memory));
  return updates;
}

// The wording the CLI uses at launch, and when a timed-out or manually
// backgrounded command is moved to the background: "Output is being written
// to: <path>. You will be notified…". The path ends at the sentence's
// period, so a dot inside the path (its `.output` suffix) is not a stop.
const OUTPUT_PATH_SENTENCE = /Output is being written to:\s*(.+?)\.(?:\s|$)/g;

/**
 * The output file the CLI's own launch sentence names for `taskId`, if it
 * names one. A result moved to the background can carry the command's
 * stdout ahead of that sentence, and a command can print anything — so the
 * sentence that counts is the LAST one (the CLI appends its own after any
 * output), and only if it names this task's file (`<taskId>.output`, the
 * CLI's layout). A sentence naming another file is not this task's; the
 * notification's structured `output_file` can still name it later.
 */
function launchOutputFile(text: string, taskId: string): string | undefined {
  const named = [...text.matchAll(OUTPUT_PATH_SENTENCE)].at(-1)?.[1]?.trim();
  if (!named) return undefined;
  const basename = named.slice(Math.max(named.lastIndexOf("/"), named.lastIndexOf("\\")) + 1);
  return basename === `${taskId}.output` ? named : undefined;
}

/** What a tool result says about the background task it launched, if it launched one. */
function launchedTaskFacts(block: Block, toolOutcome: RecordValue, parentSessionId?: string): { taskId: string; facts: BackgroundTaskFacts } | null {
  const backgroundTaskId = typeof toolOutcome.backgroundTaskId === "string" && toolOutcome.backgroundTaskId ? toolOutcome.backgroundTaskId : undefined;
  if (backgroundTaskId) {
    const outputFile = launchOutputFile(resultText(block.content), backgroundTaskId);
    return { taskId: backgroundTaskId, facts: outputFile ? { outputFile } : {} };
  }
  const agentId = typeof toolOutcome.agentId === "string" && toolOutcome.agentId ? toolOutcome.agentId : undefined;
  if (!agentId || (toolOutcome.isAsync !== true && toolOutcome.status !== "async_launched")) return null;
  const outputFile = typeof toolOutcome.outputFile === "string" && toolOutcome.outputFile ? toolOutcome.outputFile : undefined;
  const prompt = typeof toolOutcome.prompt === "string" && toolOutcome.prompt ? toolOutcome.prompt : undefined;
  return { taskId: agentId, facts: {
    ...(outputFile ? { outputFile } : {}),
    ...(prompt ? { prompt } : {}),
    ...(parentSessionId ? { childConversationId: `sub:${parentSessionId}:${agentId}` } : {}),
  } };
}

/**
 * Facts learned from a launching tool result land on the task's memory
 * entry, so every later edge carries them; a row already announced is
 * re-upserted with them now. A result that beats its start edge leaves a
 * silent entry the edge then names and shows.
 */
function rememberLaunchedTask(taskId: string, facts: BackgroundTaskFacts, launcherInput: string | undefined, toolUseId: string, envelope: Envelope, memory: ClaudeEventMemory): NormalizedProviderUpdate[] {
  if (Object.keys(facts).length === 0 || memory.ambientTasks.has(taskId) || memory.ambientRuns.has(taskId)) return [];
  const known = memory.tasks.get(taskId);
  const entry: BackgroundTaskMemory = known
    ? { ...known, ...facts }
    : { description: toolDescription(launcherInput) ?? "Background task", toolUseId, createdAt: envelope.createdAt, ...facts };
  boundedSet(memory.tasks, taskId, entry, MEMORY_LIMIT);
  if (!entry.backgrounded || !entry.announced || entry.settled) return [];
  return [{ kind: "upsert", item: backgroundTaskItem(taskId, entry, "running") }];
}

/**
 * What a tool result shows as its output. The API gives a result's content
 * either as a string or as the content-block array the model is sent, and
 * stringifying the array printed the envelope — `[ { "type": "text", "text":
 * "…" } ]` — where a settled Agent row should read as the subagent's prose.
 * An all-text array is that prose with a wrapper around it, so it is unwrapped;
 * anything else (an image block, a shape we do not know) keeps the JSON view,
 * where nothing is lost. A result whose text IS JSON — a tool that answers in
 * it — is a string either way and reads exactly as before.
 */
function resultOutput(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = contentBlocks(content);
  if (blocks.length > 0 && blocks.every(block => block.type === "text" && typeof block.text === "string")) {
    return blocks.map(block => block.text as string).join("\n");
  }
  return stringify(content);
}

/** The text of a tool result's content: a string as is, text blocks joined. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return contentBlocks(content).filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text as string).join("\n");
}

/**
 * The optional facts an entry holds, as spread-ready item fields — from
 * normalizer memory, a session's live task, or a task row alike.
 */
export function taskFacts(entry: Partial<BackgroundTaskFacts> | undefined): BackgroundTaskFacts {
  if (!entry) return {};
  return {
    ...(entry.subagentType ? { subagentType: entry.subagentType } : {}),
    ...(entry.prompt ? { prompt: entry.prompt } : {}),
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.outputFile ? { outputFile: entry.outputFile } : {}),
    ...(entry.childConversationId ? { childConversationId: entry.childConversationId } : {}),
  };
}

/** The one `task:<id>` row, built from what memory holds about the task. */
function backgroundTaskItem(taskId: string, entry: BackgroundTaskMemory, status: "running" | "completed" | "failed" | "stopped", summary?: string): ConversationItem {
  return {
    id: `task:${taskId}`,
    type: "background_task",
    createdAt: entry.createdAt,
    taskId,
    description: entry.description,
    ...(entry.taskType ? { taskType: entry.taskType } : {}),
    ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
    status,
    ...(status === "running" && entry.progress ? { progress: entry.progress } : {}),
    ...(summary ? { summary } : {}),
    ...taskFacts(entry),
  };
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
function backgroundTaskUpdate(record: RecordValue, memory: ClaudeEventMemory, base: { updates: NormalizedProviderUpdate[]; eventType: string }, parentSessionId?: string): Omit<NormalizedProviderEvent, "conversationId"> {
  const taskId = typeof record.task_id === "string" && record.task_id ? record.task_id : "";
  if (!taskId) return { ...base, outcome: "unparseable" };
  const envelope = envelopeIdentity(record) ?? { uuid: taskId, createdAt: Date.now() };
  // An agent run the CLI marks ambient is a run all the same (design D13):
  // its edges take their own path, and never reach the background state.
  if (memory.ambientRuns.has(taskId) || ((record.ambient === true || record.skip_transcript === true) && startsAgentRun(record))) {
    return ambientRunUpdate(taskId, record, envelope, memory, base, parentSessionId);
  }
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
  // What the edges say the task is and has done, kept from edge to edge:
  // the start names the subagent type and prompt, progress and the
  // notification carry cumulative usage, the notification names the output
  // file (a shell task's was already learned from its launch result).
  const subagentType = typeof record.subagent_type === "string" && record.subagent_type ? record.subagent_type : known?.subagentType;
  const prompt = typeof record.prompt === "string" && record.prompt ? record.prompt : known?.prompt;
  const usage = taskUsage(record.usage) ?? known?.usage;
  const outputFile = typeof record.output_file === "string" && record.output_file ? record.output_file : known?.outputFile;
  // An agent task's id IS its subagent's agent id (spike, D8), so the child
  // transcript is addressable from the start edge, not only from the tool
  // result that ends the run.
  const agentTask = taskType === "local_agent" || subagentType !== undefined;
  const childConversationId = known?.childConversationId ?? (agentTask && parentSessionId ? `sub:${parentSessionId}:${taskId}` : undefined);
  const facts = taskFacts({ subagentType, prompt, usage, outputFile, childConversationId });
  const identity = { description: finalDescription, ...(taskType ? { taskType } : {}), ...(toolUseId ? { toolUseId } : {}), createdAt, ...facts };
  // The launching tool row is where the timeline and the subagents track look
  // for a run's child transcript, and until now it learned the child only from
  // the tool result — which for a FOREGROUND agent arrives when the run is
  // over, so the run was openable only after it ended. The start edge already
  // knows it: a `local_agent` task's id IS its subagent's agent id (spike, D8),
  // backgrounded or not. So the row is opened here for both kinds at once,
  // which is also why this runs before the foreground branch below.
  const launchingRow = record.subtype === "task_started" && agentTask && toolUseId && childConversationId
    ? launchingRowUpdate(memory, toolUseId, childConversationId)
    : [];
  if (!backgrounded) {
    // Foreground so far: keep what the edge said so a later promotion or
    // the level signal can name the task, but show nothing of the task
    // itself — only the launching row's new child id, where there is one.
    boundedSet(memory.tasks, taskId, identity, MEMORY_LIMIT);
    return { ...base, outcome: launchingRow.length > 0 ? "handled" : "ignored", updates: launchingRow };
  }
  // Progress note: the model-written summary while running (asked for with
  // agentProgressSummaries), else the last tool an agent task used. A shell
  // task reports no progress at all (spike): its row keeps whatever it had,
  // and the reader sees elapsed time instead of a tool it never named.
  const progress = record.subtype === "task_progress"
    ? (typeof record.summary === "string" && record.summary ? record.summary
      : taskType !== "local_bash" && typeof record.last_tool_name === "string" && record.last_tool_name ? `Using ${record.last_tool_name}` : known?.progress)
    : known?.progress;
  let status: "running" | "completed" | "failed" | "stopped" = "running";
  let summary: string | undefined;
  if (record.subtype === "task_notification") {
    status = settledTaskStatus(record.status);
    summary = typeof record.summary === "string" && record.summary ? record.summary : undefined;
  } else if (record.subtype === "task_updated") {
    if (patch.status === "failed") status = "failed";
    else if (patch.status === "killed") status = "stopped";
    else if (patch.status === "completed") status = "completed";
    if (typeof patch.error === "string" && patch.error) summary = patch.error;
  }
  // `announced`: a row for this task has been emitted, so the level signal
  // need not mint one.
  const entry: BackgroundTaskMemory = { ...identity, ...(progress ? { progress } : {}), backgrounded: true, announced: true, ...(status !== "running" ? { settled: true } : {}) };
  boundedSet(memory.tasks, taskId, entry, MEMORY_LIMIT);
  return { ...base, outcome: "handled", updates: [...launchingRow, { kind: "upsert", item: backgroundTaskItem(taskId, entry, status, summary) }] };
}

/**
 * An ambient agent run's edges (design D13). The run is followed like any
 * subagent — its child `sub:<parent>:<taskId>` is named at the start edge,
 * since a `local_agent` task's id is its agent id — but it is not background
 * work, so nothing here touches `memory.tasks` or mints a background row.
 *
 * A run with a launching tool use (a skill the model forked) is that tool
 * row's run: the row gains its child id at the start edge, exactly as a
 * foreground Agent's does, and the row speaks for the run from there. A run
 * with none (the review a typed command launches) has no row in the
 * timeline at all, so it gets one of its own: a `foreground` task row,
 * running from the start edge and settled by the notification, which the
 * subagents track lists and opens.
 */
function ambientRunUpdate(taskId: string, record: RecordValue, envelope: Envelope, memory: ClaudeEventMemory, base: { updates: NormalizedProviderUpdate[]; eventType: string }, parentSessionId?: string): Omit<NormalizedProviderEvent, "conversationId"> {
  const known = memory.ambientRuns.get(taskId);
  const description = typeof record.description === "string" && record.description ? record.description : known?.description;
  // A stray edge for a run never seen to start, naming nothing: nothing to show.
  if (!description) return { ...base, outcome: "ignored" };
  const taskType = typeof record.task_type === "string" && record.task_type ? record.task_type : known?.taskType;
  const toolUseId = typeof record.tool_use_id === "string" && record.tool_use_id ? record.tool_use_id : known?.toolUseId;
  const subagentType = typeof record.subagent_type === "string" && record.subagent_type ? record.subagent_type : known?.subagentType;
  const childConversationId = known?.childConversationId ?? (parentSessionId ? `sub:${parentSessionId}:${taskId}` : undefined);
  const progress = record.subtype === "task_progress"
    ? (typeof record.summary === "string" && record.summary ? record.summary
      : typeof record.last_tool_name === "string" && record.last_tool_name ? `Using ${record.last_tool_name}` : known?.progress)
    : known?.progress;
  let status: "running" | "completed" | "failed" | "stopped" = "running";
  if (record.subtype === "task_notification") status = settledTaskStatus(record.status);
  else if (record.subtype === "task_updated") {
    const patch = asRecord(record.patch);
    if (patch.status === "failed") status = "failed";
    else if (patch.status === "killed") status = "stopped";
    else if (patch.status === "completed") status = "completed";
  }
  // A settled run stays settled: a late edge must not reopen it.
  if (known?.settled && status === "running") return { ...base, outcome: "ignored" };
  const entry: AmbientRunMemory = {
    description,
    ...(taskType ? { taskType } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(childConversationId ? { childConversationId } : {}),
    createdAt: known?.createdAt ?? envelope.createdAt,
    ...(progress ? { progress } : {}),
    ...(status !== "running" ? { settled: true } : {}),
  };
  boundedSet(memory.ambientRuns, taskId, entry, MEMORY_LIMIT);
  if (toolUseId) {
    const updates = record.subtype === "task_started" && childConversationId ? launchingRowUpdate(memory, toolUseId, childConversationId) : [];
    return { ...base, outcome: updates.length > 0 ? "handled" : "ignored", updates };
  }
  const summary = status !== "running" && typeof record.summary === "string" && record.summary ? record.summary : undefined;
  return { ...base, outcome: "handled", updates: [{ kind: "upsert", item: {
    id: `task:${taskId}`,
    type: "background_task",
    createdAt: entry.createdAt,
    taskId,
    description,
    ...(taskType ? { taskType } : {}),
    status,
    ...(status === "running" && progress ? { progress } : {}),
    ...(summary ? { summary } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(childConversationId ? { childConversationId } : {}),
    foreground: true,
  } }] };
}

/**
 * Every foreground run row still running, settled: the turn that ran it has
 * ended, or the process has, without the run reporting its own end. A
 * typed command's run cannot outlive the command — its notification comes
 * before the command's result — so a row still running past that point would
 * only ever read as work that is not happening.
 */
export function settleForegroundRuns(memory: ClaudeEventMemory, summary: string): NormalizedProviderUpdate[] {
  const updates: NormalizedProviderUpdate[] = [];
  for (const [taskId, run] of memory.ambientRuns) {
    if (run.settled || run.toolUseId) continue;
    run.settled = true;
    updates.push({ kind: "upsert", item: {
      id: `task:${taskId}`,
      type: "background_task",
      createdAt: run.createdAt,
      taskId,
      description: run.description,
      ...(run.taskType ? { taskType: run.taskType } : {}),
      status: "stopped",
      summary,
      ...(run.subagentType ? { subagentType: run.subagentType } : {}),
      ...(run.childConversationId ? { childConversationId: run.childConversationId } : {}),
      foreground: true,
    } });
  }
  return updates;
}

/**
 * The launching tool row, re-upserted with the child conversation its task
 * just named. Everything but that id is what the `tool_use` block itself
 * emitted, held in this memory — a row is never invented here: a tool use
 * the timeline has no record of gets nothing, because an upsert replaces the
 * item and a bare row would be a tool call with no name, input, or place.
 * Nor is a row that its result has already settled re-opened: that result
 * carried the same `agentId`, so the row is openable already.
 */
function launchingRowUpdate(memory: ClaudeEventMemory, toolUseId: string, childConversationId: string): NormalizedProviderUpdate[] {
  const known = memory.tools.get(toolUseId);
  if (!known || known.childConversationId === childConversationId) return [];
  boundedSet(memory.tools, toolUseId, { ...known, childConversationId }, MEMORY_LIMIT);
  if (known.resultSeen) return [];
  return [{ kind: "upsert", item: {
    id: `tool:${toolUseId}`,
    type: "tool",
    createdAt: known.createdAt,
    name: known.name,
    status: "running",
    ...(known.input === undefined ? {} : { input: known.input }),
    childConversationId,
  } }];
}

/**
 * The output a stored local command record holds: the text inside its
 * `<local-command-stdout>` (and `<local-command-stderr>`) markup, which is
 * what the live frame's text carries unwrapped. A record that holds no
 * output markup — the TUI also files the command's own invocation under
 * this subtype — shows nothing, and neither does anything outside the
 * markup (a forked skill's launch note, say).
 */
function localCommandOutput(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  const parts = [...content.matchAll(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/g)]
    .map(match => match[1]!.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** The CLI's cumulative task usage (`total_tokens`, `tool_uses`, `duration_ms`), when the edge carries a complete one. */
function taskUsage(value: unknown): BackgroundTaskUsage | undefined {
  const usage = asRecord(value);
  const figures = [usage.total_tokens, usage.tool_uses, usage.duration_ms];
  if (!figures.every(figure => typeof figure === "number" && Number.isFinite(figure) && figure >= 0)) return undefined;
  return { totalTokens: usage.total_tokens as number, toolUses: usage.tool_uses as number, durationMs: usage.duration_ms as number };
}

/** A notification's reported status as the row's outcome: anything not a failure or a stop settled as completed. */
function settledTaskStatus(status: unknown): "completed" | "failed" | "stopped" {
  return status === "failed" ? "failed" : status === "stopped" || status === "killed" ? "stopped" : "completed";
}

/**
 * A stored notification as the `task_notification` frame the live stream
 * would have carried, so one code path settles the row either way. The
 * store never saw the task start, so the row is named from the tool that
 * launched it — a Bash or Agent call's own `description` — the same name
 * the live start edge carries; the flag says the task ran in the
 * background, which is the only kind the CLI notifies about.
 */
function storedNotificationRecord(notification: { taskId: string; toolUseId?: string; status?: string; summary?: string }, record: RecordValue, memory: ClaudeEventMemory): RecordValue {
  const launcher = notification.toolUseId ? memory.tools.get(notification.toolUseId) : undefined;
  const description = launcher ? toolDescription(launcher.input) : undefined;
  const taskType = launcher?.name === "Agent" || launcher?.name === "Task" ? "local_agent" : launcher?.name === "Workflow" ? "local_workflow" : undefined;
  return {
    type: "system",
    subtype: "task_notification",
    uuid: record.uuid,
    timestamp: record.timestamp,
    task_id: notification.taskId,
    is_backgrounded: true,
    ...(notification.toolUseId ? { tool_use_id: notification.toolUseId } : {}),
    ...(notification.status ? { status: notification.status } : {}),
    ...(notification.summary ? { summary: notification.summary } : {}),
    ...(description ? { description } : {}),
    ...(taskType ? { task_type: taskType } : {}),
  };
}

/** The `description` a tool call's remembered input carried, when it parses as one. */
function toolDescription(input: string | undefined): string | undefined {
  if (!input) return undefined;
  try {
    const parsed = JSON.parse(input) as unknown;
    const description = asRecord(parsed).description;
    return typeof description === "string" && description.trim() ? description.trim() : undefined;
  } catch {
    return undefined;
  }
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
      ...taskFacts(known),
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
  const answer = claudeWindowAnswer(record);
  const max = answer?.limit;
  const categories = asArray(record.categories).flatMap(entry => {
    const category = asRecord(entry);
    if (typeof category.name !== "string" || !category.name || typeof category.tokens !== "number" || category.tokens < 0) return [];
    const kind = category.kind === "used" || category.kind === "free" || category.kind === "buffer" || category.kind === "deferred" ? category.kind
      : category.isDeferred === true || /\(deferred\)/i.test(category.name) ? "deferred" as const
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
    ...(answer && (answer.details.kind === "compaction" || answer.details.compactionThreshold !== undefined) ? { window: { source: "session" as const, freshness: "current" as const, observedAt: createdAt, ...answer.details } } : {}),
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
