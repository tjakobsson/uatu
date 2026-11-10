// The context window an OpenCode catalog entry states, shared by both
// generations. OpenCode's model limit carries `context` (the model's total
// capacity, prompt and reply together) and, for many models, `input`: the
// most a prompt may hold. OpenAI's models are the common case — GPT-5.5 is
// 400k of capacity but takes at most 272k of prompt — and `input` is the
// figure OpenCode itself compacts against. The readout measures prompt
// occupancy (input plus cache), so `input` is its window whenever stated;
// the larger capacity stays visible beside it.

import type { ChatModel } from "../types";

export type OpenCodeCatalogLimit = { context?: number; input?: number; output?: number };

const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

export function catalogContextWindow(limit: OpenCodeCatalogLimit | undefined): Pick<ChatModel, "contextLimit" | "contextWindow"> {
  const context = positive(limit?.context);
  const input = positive(limit?.input);
  if (input !== undefined && (context === undefined || input < context)) {
    return {
      contextLimit: input,
      contextWindow: { source: "catalog", freshness: "current", kind: "effective", ...(context !== undefined ? { capacity: context } : {}) },
    };
  }
  if (context === undefined) return {};
  return { contextLimit: context, contextWindow: { source: "catalog", freshness: "current" } };
}
