import path from "node:path";

import type { NormalizedProviderEvent, NormalizedProviderUpdate } from "../provider";
import { CHAT_TEXT_SEAL, CHAT_TURN, executionEvidence, type ChatTurnToken } from "../turn-liveness";
import { nativeVisualMessageIdentity } from "../visual-identity";
import type { ActivityStatus, ConversationConfiguration, ConversationItem, MessageAttachment, ModelSelection, TaskProgressEntry } from "../types";
import { ANTIGRAVITY_AGENT } from "./descriptor";

type RecordValue = Record<string, unknown>;

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/**
 * ACP `session/update` → the shared timeline (add-antigravity-chat D5), for
 * one conversation. Two sources share it: `session/load` replay (finished
 * turns, so every reply's token is authoritative and closed) and the live
 * stream of a running prompt (one provisional token per turn, which the
 * provider closes at the turn's end).
 *
 * Identity (D4): agy supplies no message ids, so ids are positions replay
 * reproduces. The k-th user message is `<session>.u<k>`; the j-th reply or
 * thought after it is `<session>.a<k>.<j>` / `<session>.r<k>.<j>`. A steer is
 * just the next user message, so it keeps its id when the conversation is
 * reopened. Tools are keyed by agy's own tool call id.
 */
export type AcpMemory = {
  readonly sessionId: string;
  readonly cwd: string;
  userCount: number;
  blockCount: number;
  // The text or thought block being streamed, until a non-text update or
  // the prompt's end seals it.
  open?: { kind: "text" | "thought"; item: Extract<ConversationItem, { type: "assistant_message" | "reasoning" }> };
  // Replay: the user message just read, while nothing else followed it.
  lastUser?: Extract<ConversationItem, { type: "user_message" }>;
  tools: Map<string, RecordValue>;
  // Tool calls with an open permission request: shown as waiting, not running.
  awaitingPermission: Set<string>;
  // Live only: the running turn's provisional token.
  turn?: ChatTurnToken;
  live: boolean;
  model?: ModelSelection;
};

export function createAcpMemory(sessionId: string, cwd: string): AcpMemory {
  return { sessionId, cwd, userCount: 0, blockCount: 0, tools: new Map(), awaitingPermission: new Set(), live: false };
}

export function userMessageId(memory: AcpMemory, index: number): string {
  return `${memory.sessionId}.u${index}`;
}

/** The next user message's item, advancing the position. */
export function nextUserMessage(memory: AcpMemory, text: string, createdAt: number, extra: { requestId?: string; attachments?: MessageAttachment[] } = {}): Extract<ConversationItem, { type: "user_message" }> {
  memory.userCount += 1;
  memory.blockCount = 0;
  return { id: `message:${userMessageId(memory, memory.userCount)}`, type: "user_message", createdAt, text, ...(extra.requestId ? { requestId: extra.requestId } : {}), ...(extra.attachments?.length ? { attachments: extra.attachments } : {}) };
}

/** Seal the block being streamed: its text is final. */
export function sealOpenBlock(memory: AcpMemory, now: number): NormalizedProviderUpdate[] {
  const open = memory.open;
  if (!open) return [];
  memory.open = undefined;
  if (open.kind === "thought") {
    const item = open.item as Extract<ConversationItem, { type: "reasoning" }>;
    return [{ kind: "upsert", item: { ...item, status: "completed" } }];
  }
  const item = open.item as Extract<ConversationItem, { type: "assistant_message" }>;
  return [{ kind: "upsert", item: { ...item, completedAt: now, [CHAT_TEXT_SEAL]: "ended" } as ConversationItem }];
}

/** A tool's live status, with an open permission shown as waiting for it. */
function toolStatus(memory: AcpMemory, toolCallId: string, status: unknown): ActivityStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (memory.awaitingPermission.has(toolCallId) || status === "pending") return "pending";
  return "running";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function relative(memory: AcpMemory, file: string): string {
  const resolved = path.relative(memory.cwd, file);
  return resolved && !resolved.startsWith("..") && !path.isAbsolute(resolved) ? resolved : file;
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap(entry => {
    const inner = record(record(entry)?.content);
    return record(entry)?.type === "content" && inner?.type === "text" && typeof inner.text === "string" ? [inner.text] : [];
  });
  return parts.length ? parts.join("\n") : undefined;
}

/** The timeline rows of one tool call's merged state. */
export function toolItems(memory: AcpMemory, toolCallId: string, now: number): ConversationItem[] {
  const state = memory.tools.get(toolCallId)!;
  const status = toolStatus(memory, toolCallId, state.status);
  const createdAt = typeof state.createdAt === "number" ? state.createdAt : now;
  const completedAt = status === "completed" || status === "failed" ? (typeof state.completedAt === "number" ? state.completedAt : now) : undefined;
  if (completedAt !== undefined) state.completedAt = completedAt;
  const title = text(state.title) ?? text(state.name) ?? "Tool";
  const rawOutput = record(state.rawOutput);
  const items: ConversationItem[] = [];
  if (state.kind === "execute") {
    const output = text(rawOutput?.output) ?? contentText(state.content);
    const exitCode = typeof rawOutput?.exit_code === "number" ? rawOutput.exit_code : undefined;
    items.push({ id: `tool:${toolCallId}`, type: "command", createdAt, command: title, status, ...(completedAt !== undefined ? { completedAt } : {}), ...(output !== undefined ? { output } : {}), ...(exitCode !== undefined ? { exitCode } : {}) });
  } else {
    const rawInput = state.rawInput ?? (Array.isArray(state.locations) ? { locations: state.locations.flatMap(location => typeof record(location)?.path === "string" ? [relative(memory, record(location)!.path as string)] : []) } : undefined);
    const output = contentText(state.content) ?? text(state.output);
    items.push({
      id: `tool:${toolCallId}`, type: "tool", createdAt, name: text(state.name) ?? text(state.kind) ?? "tool", status,
      ...(completedAt !== undefined ? { completedAt } : {}),
      input: rawInput !== undefined ? JSON.stringify(rawInput) : title,
      ...(output !== undefined ? { output } : {}),
    });
  }
  if (Array.isArray(state.content)) {
    state.content.forEach((entry, index) => {
      const diff = record(entry);
      if (diff?.type !== "diff" || typeof diff.path !== "string") return;
      const operation = state.kind === "delete" ? "delete" : diff.oldText === undefined || diff.oldText === null ? "create" : "update";
      items.push({ id: `file:${toolCallId}:${index}`, type: "file_change", createdAt, path: relative(memory, diff.path), operation });
    });
  }
  return items;
}

const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

type Normalized = Omit<NormalizedProviderEvent, "conversationId">;

/**
 * One `session/update` notification's params. Unknown kinds are reported as
 * unrecognized, so the caller counts them and the coverage report shows them.
 */
export function normalizeAcpUpdate(params: unknown, memory: AcpMemory, now: number): Normalized {
  const update = record(record(params)?.update);
  const kind = text(update?.sessionUpdate) ?? "";
  const eventType = kind || "session/update";
  if (!update || !kind) return { updates: [], outcome: "unparseable", eventType };
  const content = record(update.content);
  if (kind !== "user_message_chunk") memory.lastUser = undefined;
  switch (kind) {
    case "user_message_chunk": {
      // Live prompts are minted by the provider at acceptance; only replay
      // carries the user's messages. Each text chunk is one message (a steer
      // replays as a second chunk right after the first); an image chunk
      // belongs to the message before it.
      if (memory.live) return { updates: [], outcome: "ignored", eventType };
      const updates = sealOpenBlock(memory, now);
      if (content?.type === "image") {
        // An image after the message's text joins it; an image with no
        // message before it is a message of its own (an image-only prompt),
        // which keeps every later message at its live position.
        const attachment: MessageAttachment = { name: "image", mimeType: text(content.mimeType) ?? "image/png" };
        memory.lastUser = memory.lastUser
          ? { ...memory.lastUser, attachments: [...memory.lastUser.attachments ?? [], attachment] }
          : nextUserMessage(memory, "", now, { attachments: [attachment] });
        updates.push({ kind: "upsert", item: memory.lastUser });
        return { updates, outcome: "handled", eventType };
      }
      const value = text(content?.text);
      if (value === undefined) return { updates, outcome: "ignored", eventType, skippedBlocks: content ? [String(content.type)] : [] };
      memory.lastUser = nextUserMessage(memory, value, now);
      updates.push({ kind: "upsert", item: memory.lastUser });
      return { updates, outcome: "handled", eventType };
    }
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const value = text(content?.text);
      if (value === undefined) return { updates: [], outcome: "ignored", eventType, skippedBlocks: content ? [String(content.type)] : [] };
      const blockKind = kind === "agent_message_chunk" ? "text" : "thought";
      const updates = memory.open && memory.open.kind !== blockKind ? sealOpenBlock(memory, now) : [];
      if (!memory.open) {
        memory.blockCount += 1;
        const position = `${memory.userCount}.${memory.blockCount}`;
        memory.open = blockKind === "text"
          ? { kind: "text", item: {
              id: `message:${memory.sessionId}.a${position}`, type: "assistant_message", createdAt: now, markdown: "",
              ...nativeVisualMessageIdentity(ANTIGRAVITY_AGENT.id, `${memory.sessionId}.a${position}`),
              ...(memory.live ? (memory.turn ? { [CHAT_TURN]: memory.turn } : {}) : executionEvidence(false)),
            } as Extract<ConversationItem, { type: "assistant_message" }> }
          : { kind: "thought", item: { id: `reasoning:${memory.sessionId}.r${position}`, type: "reasoning", createdAt: now, text: "", status: memory.live ? "running" : "completed" } };
      }
      const open = memory.open;
      if (open.kind === "text") {
        const item = open.item as Extract<ConversationItem, { type: "assistant_message" }>;
        open.item = { ...item, markdown: item.markdown + value };
      } else {
        const item = open.item as Extract<ConversationItem, { type: "reasoning" }>;
        open.item = { ...item, text: item.text + value };
      }
      // Replay rows are finished: their text is sealed as it arrives.
      const item: ConversationItem = memory.live || open.kind !== "text" ? open.item : Object.assign({}, open.item, { [CHAT_TEXT_SEAL]: "ended" as const });
      updates.push({ kind: "upsert", item });
      return { updates, outcome: "handled", eventType };
    }
    case "tool_call":
    case "tool_call_update": {
      const toolCallId = text(update.toolCallId);
      if (!toolCallId) return { updates: [], outcome: "unparseable", eventType };
      const updates = sealOpenBlock(memory, now);
      const previous = memory.tools.get(toolCallId) ?? { createdAt: now };
      const merged: RecordValue = { ...previous };
      for (const [key, value] of Object.entries(update)) if (key !== "sessionUpdate" && value !== undefined && value !== null) merged[key] = value;
      memory.tools.set(toolCallId, merged);
      for (const item of toolItems(memory, toolCallId, now)) updates.push({ kind: "upsert", item });
      return { updates, outcome: "handled", eventType };
    }
    case "plan": {
      const entries: TaskProgressEntry[] = Array.isArray(update.entries) ? update.entries.flatMap(entry => {
        const value = record(entry);
        const status = text(value?.status);
        return typeof value?.content === "string" ? [{ text: value.content, status: status && PLAN_STATUSES.has(status) ? status as TaskProgressEntry["status"] : "pending" }] : [];
      }) : [];
      return { updates: [...sealOpenBlock(memory, now), { kind: "upsert", item: { id: `plan:${memory.sessionId}.${memory.userCount}`, type: "task_progress", createdAt: now, entries } }], outcome: "handled", eventType };
    }
    case "usage_update": {
      const used = typeof update.used === "number" ? update.used : undefined;
      const size = typeof update.size === "number" ? update.size : undefined;
      if (used === undefined) return { updates: [], outcome: "unparseable", eventType };
      return { updates: [{ kind: "upsert", item: { id: `context:${memory.sessionId}`, type: "context_report", createdAt: now, total: used, ...(size !== undefined ? { max: size } : {}), ...(memory.model ? { model: memory.model } : {}) } }], outcome: "handled", eventType };
    }
    case "session_info_update": {
      const title = text(update.title);
      if (!title) return { updates: [], outcome: "ignored", eventType };
      return { updates: [], outcome: "handled", eventType, sessionLifecycle: { kind: "updated", id: memory.sessionId, directory: memory.cwd, title, sparse: true } };
    }
    case "current_mode_update": {
      const mode = text(update.currentModeId);
      return mode ? { updates: [], outcome: "handled", eventType, configuration: { mode } } : { updates: [], outcome: "unparseable", eventType };
    }
    case "config_option_update": {
      const configuration = configurationFromOptions(update.configOptions);
      return { updates: [], outcome: "handled", eventType, configuration, catalogsChanged: true, ...(configuration.model && !configuration.variant ? { replaceModel: true } : {}) };
    }
    case "available_commands_update":
      return { updates: [], outcome: "handled", eventType, catalogsChanged: true };
    default:
      return { updates: [], outcome: "unrecognized", eventType };
  }
}

/** The model, thinking level and mode a session's config options say are current. */
export function configurationFromOptions(options: unknown): ConversationConfiguration {
  const configuration: ConversationConfiguration = {};
  if (!Array.isArray(options)) return configuration;
  for (const option of options) {
    const value = record(option);
    const current = text(value?.currentValue);
    if (!current) continue;
    const id = text(value?.category) ?? text(value?.id);
    if (id === "model") configuration.model = { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: current };
    else if (id === "thought_level") configuration.variant = current;
    else if (id === "mode") configuration.mode = current;
  }
  if (!configuration.model) delete configuration.variant;
  return configuration;
}
