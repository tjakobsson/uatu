// Token-usage arithmetic and merge semantics shared by the server adapter and
// the client projection. Both sides consume the same event stream, so the
// rules for combining usage with what is already held must be written once —
// two copies drifting apart would make the live stream and the snapshot
// disagree about the same conversation.

import type { AssistantMessageItem, TokenUsage } from "./types";

/**
 * Every component a `TokenUsage` can carry, as one list. Summing, comparing,
 * and validating all enumerate the components; a new one the agent starts
 * reporting is added here and every consumer follows, instead of each copy of
 * the list silently missing it.
 */
export const TOKEN_USAGE_COMPONENTS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

/**
 * Everything a usage report says was spent, output and reasoning included.
 * This is a spend figure — unlike the context readout, which asks how full
 * the window is right now and so counts only what occupies it.
 */
export function totalTokens(usage: TokenUsage): number {
  return TOKEN_USAGE_COMPONENTS.reduce((sum, key) => sum + (usage[key] ?? 0), 0);
}

/** Component-by-component equality; absent components must match too. */
export function sameUsage(left: TokenUsage | undefined, right: TokenUsage | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return TOKEN_USAGE_COMPONENTS.every(key => left[key] === right[key]);
}

/**
 * What an assistant-message upsert keeps from the item it replaces. A
 * usage-only upsert (empty markdown is the producer's signal — see
 * `usageUpsert` in normalization.ts) decorates a part that is already on
 * screen: it carries no text and no time of its own. Taking its empty
 * markdown would erase the answer mid-stream; taking its timestamp would
 * resort the timeline, which is ordered by `createdAt`.
 */
export function mergeAssistantMessage(current: AssistantMessageItem, incoming: AssistantMessageItem): AssistantMessageItem {
  const usageOnly = incoming.markdown === "";
  return {
    ...current,
    ...incoming,
    createdAt: usageOnly ? current.createdAt : incoming.createdAt,
    markdown: incoming.markdown || current.markdown,
    ...(current.usage || incoming.usage ? { usage: { ...current.usage, ...incoming.usage } } : {}),
  };
}
