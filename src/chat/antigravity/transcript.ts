import { promises as fs } from "node:fs";
import path from "node:path";

import type { StoredMessageAccounting } from "../provider";
import type { ConversationItem, ModelSelection, TokenUsage } from "../types";
import { ANTIGRAVITY_PROVIDER_ID } from "./normalization";

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
  toolCalls: number;
  content?: string;
  error?: string;
};

export type TranscriptTool = { output?: string; error?: string };
export type TranscriptTurn = { model?: string; usage?: TokenUsage; tools: TranscriptTool[] };

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown) => typeof value === "string" ? value : undefined;

/** The steps of a transcript, or why there are none. Never throws. */
export async function readTranscript(file: string, maxBytes = TRANSCRIPT_MAX_BYTES): Promise<{ steps: Step[] } | { skipped: "missing" | "too-large" | "unreadable" | "unrecognized" }> {
  let raw: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { skipped: "unreadable" };
    if (stat.size > maxBytes) return { skipped: "too-large" };
    raw = await fs.readFile(file, { encoding: "utf8", flag: "r" });
  } catch (error) {
    return { skipped: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  const steps: Step[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line); } catch { return { skipped: "unrecognized" }; }
    // Every step names its index and type; anything else is not a format we know.
    if (!value || typeof value !== "object" || typeof value.step_index !== "number" || typeof value.type !== "string") return { skipped: "unrecognized" };
    const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls.length : 0;
    steps.push({
      type: value.type, status: text(value.status), model: text(value.model),
      input: count(value.input_tokens), output: count(value.output_tokens), cacheRead: count(value.cache_read_tokens),
      toolCalls, content: text(value.content), error: text(value.error),
    });
  }
  return steps.length ? { steps } : { skipped: "unrecognized" };
}

/** Steps grouped into turns, one per user input, with tool results in call order. */
export function transcriptTurns(steps: Step[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const step of steps) {
    if (step.type === "USER_INPUT") { turns.push({ tools: [] }); continue; }
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
 * transcript does not describe this replay (its user turns do not line up).
 * Tools are matched by their order within a turn; a turn whose tool count
 * differs keeps its replayed tools. Each turn gains a usage carrier with the
 * id a live turn's carrier has.
 */
export function enrichReplay(items: ConversationItem[], sessionId: string, turns: TranscriptTurn[], options: {
  family: (model: string) => string;
  price: (usage: TokenUsage, modelId: string | undefined) => number | undefined;
}): Enrichment | null {
  const users = items.filter(item => item.type === "user_message");
  if (users.length !== turns.length) return null;
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
    const recorded = current > 0 ? turns[current - 1] : undefined;
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
