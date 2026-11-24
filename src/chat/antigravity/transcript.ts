import { promises as fs } from "node:fs";
import path from "node:path";

import type { StoredMessageAccounting } from "../provider";
import { CHAT_TEXT_SEAL, executionEvidence } from "../turn-liveness";
import type { ConversationItem, ModelSelection, TokenUsage } from "../types";
import { ANTIGRAVITY_PROVIDER_ID } from "./normalization";
import { nativeVisualMessageIdentity } from "../visual-identity";
import { ANTIGRAVITY_AGENT } from "./descriptor";

/**
 * agy's own transcript of a conversation, read to add what `session/load`
 * replay omits (add-antigravity-chat D10): permission outcomes, file-read
 * output, and each turn's tokens and model. Best effort by design: a
 * missing, oversized, truncated, unrecognized or foreign transcript leaves
 * the replayed history as it is. The file is only ever read.
 */

// Larger transcripts are left unread rather than read in part.
export const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
const LEVEL_SUFFIX = /-(?:minimal|low|medium|high|xhigh)$/;

export function transcriptPath(home: string, sessionId: string): string {
  return path.join(home, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
}

type Step = {
  type: string;
  status?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  toolNames: string[];
  thinking?: string;
  content?: string;
  error?: string;
};

export type TranscriptTool = { output?: string; error?: string };
// `request` is what the user asked, as agy recorded it: the turn's identity.
export type TranscriptTurn = { request?: string; model?: string; usage?: TokenUsage; tools: TranscriptTool[] };

/** The user's own words in a recorded input, without agy's request wrapper and metadata. */
export function transcriptRequest(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  return (content.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/)?.[1] ?? content).trim();
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown) => typeof value === "string" ? value : undefined;

/** The steps of a transcript, or why there are none. Never throws. */
export async function readTranscript(file: string, maxBytes = TRANSCRIPT_MAX_BYTES): Promise<{ steps: Step[] } | { skipped: "missing" | "too-large" | "unreadable" | "unrecognized" }> {
  let raw: string;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    // The bound is on what one open handle yields, read to at most one byte
    // past it, not on a size read beforehand that a growing file outruns.
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) return { skipped: "too-large" };
    }
    raw = buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    return { skipped: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const steps: Step[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line); } catch { return { skipped: "unrecognized" }; }
    // Every step names its index and type; anything else is not a format we know.
    if (!value || typeof value !== "object" || typeof value.step_index !== "number" || typeof value.type !== "string") return { skipped: "unrecognized" };
    const toolNames = Array.isArray(value.tool_calls) ? value.tool_calls.map(call => text((call as Record<string, unknown> | null)?.name) ?? "tool") : [];
    steps.push({
      type: value.type, status: text(value.status), model: text(value.model),
      input: count(value.input_tokens), output: count(value.output_tokens), cacheRead: count(value.cache_read_tokens),
      toolNames, thinking: text(value.thinking), content: text(value.content), error: text(value.error),
    });
  }
  return steps.length ? { steps } : { skipped: "unrecognized" };
}

/** Steps grouped into turns, one per user input, with tool results in call order. */
export function transcriptTurns(steps: Step[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const step of steps) {
    if (step.type === "USER_INPUT") { turns.push({ request: transcriptRequest(step.content), tools: [] }); continue; }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (step.type === "PLANNER_RESPONSE") {
      if (step.model) turn.model = step.model;
      if (step.input !== undefined || step.output !== undefined || step.cacheRead !== undefined) {
        const usage = turn.usage ??= {};
        if (step.input !== undefined) usage.input = (usage.input ?? 0) + step.input;
        if (step.output !== undefined) usage.output = (usage.output ?? 0) + step.output;
        if (step.cacheRead !== undefined) usage.cacheRead = (usage.cacheRead ?? 0) + step.cacheRead;
      }
    } else if (step.type === "GENERIC") {
      // A tool's result: agy prefixes it with its timing lines.
      const output = step.content?.split("\n").filter(line => !/^(Created|Completed) At: /.test(line)).join("\n").trim();
      turn.tools.push({ ...(output ? { output } : {}), ...(step.status === "ERROR" && step.error ? { error: step.error } : {}) });
    }
  }
  return turns;
}

/** agy records the level-qualified id (`gemini-4-neon-low`); its family is what is priced and picked. */
export function transcriptModelFamily(model: string, known: (id: string) => boolean): string {
  return known(model) ? model : model.replace(LEVEL_SUFFIX, "");
}

export type Enrichment = { items: ConversationItem[]; accounting: StoredMessageAccounting[] };

/**
 * Replayed items with the transcript's additions, or null when the
 * transcript does not describe this replay (its user turns do not line up,
 * or none of them carries the same words). Only turns whose user message
 * matches the recorded request are enriched; tools are matched by their
 * order within such a turn, and a turn whose tool count differs keeps its
 * replayed tools. Each turn gains a usage carrier with the
 * id a live turn's carrier has.
 */
export function enrichReplay(items: ConversationItem[], sessionId: string, turns: TranscriptTurn[], options: {
  family: (model: string) => string;
  price: (usage: TokenUsage, modelId: string | undefined) => number | undefined;
}): Enrichment | null {
  const users = items.filter(item => item.type === "user_message");
  if (users.length !== turns.length) return null;
  // Counts alone prove nothing: a turn is the transcript's only when the
  // user's words match what agy recorded for it. A transcript with no
  // matching turn is another conversation's.
  const matched = new Set(users.flatMap((user, index) => user.type === "user_message" && user.text.trim() !== "" && user.text.trim() === turns[index]!.request ? [index + 1] : []));
  if (matched.size === 0) return null;
  const toolsByTurn = new Map<number, number[]>();
  let turn = 0;
  items.forEach((item, index) => {
    if (item.type === "user_message") turn += 1;
    else if (turn > 0 && (item.type === "tool" || item.type === "command") && item.id.startsWith("tool:")) {
      toolsByTurn.set(turn, [...toolsByTurn.get(turn) ?? [], index]);
    }
  });
  const enriched = [...items];
  for (const [number, indexes] of toolsByTurn) {
    if (!matched.has(number)) continue;
    const recorded = turns[number - 1]!.tools;
    if (recorded.length !== indexes.length) continue;
    indexes.forEach((index, position) => {
      const item = enriched[index]!;
      const tool = recorded[position]!;
      if (item.type === "tool") {
        enriched[index] = { ...item, ...(tool.output && !item.output ? { output: tool.output } : {}), ...(tool.error && !item.error ? { error: tool.error } : {}) };
      } else if (item.type === "command" && tool.error && !item.output) {
        enriched[index] = { ...item, output: tool.error };
      }
    });
  }
  // A usage carrier after each turn's last row, as a live turn leaves it.
  const accounting: StoredMessageAccounting[] = [];
  const result: ConversationItem[] = [];
  let current = 0;
  const closeTurn = (createdAt: number) => {
    const recorded = current > 0 && matched.has(current) ? turns[current - 1] : undefined;
    if (!recorded?.usage) return;
    const modelId = recorded.model ? options.family(recorded.model) : undefined;
    const model: ModelSelection | undefined = modelId ? { providerId: ANTIGRAVITY_PROVIDER_ID, modelId } : undefined;
    const costUsd = options.price(recorded.usage, modelId);
    const usage: TokenUsage = { ...recorded.usage, ...(costUsd !== undefined ? { costUsd } : {}) };
    const messageId = `${sessionId}.t${current}`;
    result.push({ id: `usage:${messageId}`, type: "assistant_message", createdAt, markdown: "", usage, ...(model ? { model } : {}) });
    accounting.push({ messageId, createdAt, usage, ...(modelId ? { model: modelId } : {}) });
  };
  for (const item of enriched) {
    if (item.type === "user_message") {
      closeTurn(result.at(-1)?.createdAt ?? item.createdAt);
      current += 1;
    }
    result.push(item);
  }
  closeTurn(result.at(-1)?.createdAt ?? 0);
  return { items: result, accounting };
}

/**
 * History built from the transcript alone, for a conversation agy will not
 * load (its login has expired): the user's messages, replies, thoughts and
 * tool rows, with the ids replay gives them, so the conversation stays
 * readable. Tool output and tokens come from enrichReplay as usual.
 */
export function historyFromTranscript(steps: Step[], sessionId: string, createdAt: number): ConversationItem[] {
  const items: ConversationItem[] = [];
  let user = 0;
  let block = 0;
  let tool = 0;
  const pendingTools: Array<Extract<ConversationItem, { type: "tool" }>> = [];
  for (const step of steps) {
    if (step.type === "USER_INPUT") {
      user += 1; block = 0;
      items.push({ id: `message:${sessionId}.u${user}`, type: "user_message", createdAt, text: transcriptRequest(step.content) ?? "" });
    } else if (user > 0 && step.type === "PLANNER_RESPONSE") {
      if (step.thinking) {
        block += 1;
        items.push({ id: `reasoning:${sessionId}.r${user}.${block}`, type: "reasoning", createdAt, text: step.thinking, status: "completed" });
      }
      if (step.content) {
        block += 1;
        const id = `${sessionId}.a${user}.${block}`;
        items.push({ id: `message:${id}`, type: "assistant_message", createdAt, markdown: step.content, completedAt: createdAt,
          ...nativeVisualMessageIdentity(ANTIGRAVITY_AGENT.id, id), ...executionEvidence(false), [CHAT_TEXT_SEAL]: "ended" } as ConversationItem);
      }
      for (const name of step.toolNames) {
        tool += 1;
        const item: Extract<ConversationItem, { type: "tool" }> = { id: `tool:${sessionId}.transcript.${tool}`, type: "tool", createdAt, name, status: "completed" };
        items.push(item);
        pendingTools.push(item);
      }
    } else if (user > 0 && step.type === "GENERIC") {
      const item = pendingTools.shift();
      if (item && step.status === "ERROR") items[items.indexOf(item)] = { ...item, status: "failed" };
    }
  }
  return items;
}
